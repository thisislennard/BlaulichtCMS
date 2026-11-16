# Architektur und Entscheidungen

Hier stehen Aufbau und technische Entscheidungen von BlaulichtCMS – jeweils mit Grund und, wo es eine gibt, der
bewussten Abweichung von einer Empfehlung samt Ausgleich.

## Überblick

```
┌────────────────────── BlaulichtCMS-Container ──────────────────────┐
│  Supervisor (server/src/main.ts, PID 1 hinter tini)                │
│   ├─ PostgreSQL 18  (Unix-Socket /tmp/blaulichtcms-pg, kein TCP)   │
│   ├─ API + Oberfläche + PWA  (Fastify, Port 7310)                  │
│   └─ Worker  (Medienprüfung, Wartung, Sicherung)                   │
│                                                                    │
│  /data  postgres/ · media/ · secrets/ · backups/ · setup-token.txt │
└────────────────────────────────────────────────────────────────────┘
        ▲ HTTPS über Reverse Proxy                 ▲ HTTPS (ausgehend von WordPress)
   Redaktion, Handy (Upload-Link)            BlaulichtCMS Bridge (WordPress-Plugin)
```

## Entscheidungen

### E1 – Technische Grundlage

Stack: Node.js, TypeScript, Fastify, PostgreSQL, React, Vite, Tailwind. Bausteine: Anmeldung (Argon2id, TOTP, Sitzungen, CSRF, Login-Sperre), Rechte-Registry,
Audit, Maskierung, AES-256-GCM-Geheimnisse, SSRF-Schutz, PostgreSQL-Warteschlange mit Lease und Idempotenz,
verschlüsselte Datenbanksicherung, Notfall-CLI, UI-Bausteine, Hilfe-Center, CI.
Bewusst nicht enthalten: IMAP, MQTT, Teams, allgemeine Webhooks. Updates siehe E9, Workflows (seit 0.3.0, bis dahin „Automationen“) siehe E17.

### E2 – Ein Container mit internem PostgreSQL

Der Supervisor startet PostgreSQL selbst (`initdb` beim ersten Start in `/data/postgres`), wartet auf Bereitschaft,
legt die Datenbank an und startet dann API und Worker. PostgreSQL hört nur auf einem Unix-Socket in einem
`0700`-Verzeichnis des BlaulichtCMS-Benutzers (`listen_addresses = ''`, `local all all trust`). Ein Absturz von PostgreSQL
hält API und Worker an und startet alles in Reihenfolge neu. Beim Stopp: Worker → API → PostgreSQL (`SIGINT`, Fast Shutdown).
Datenbankrollen (#102): Der Bootstrap-Superuser `blaulichtcms` dient nur Supervisor, Migrationsschritt und Wartung;
Migrationen laufen als Eigentümerrolle `blaulichtcms_owner`, API und Worker als `blaulichtcms_app` ohne Superuser und nur mit DML
(Einrichtung und Umstellung bestehender Installationen automatisch beim Start, `server/src/db/roles.ts`,
`docs/betrieb.md`, „Datenbankrollen“).

**Bewusste Abweichung von BSI SYS.1.6.A11 (ein Dienst je Container), #135.** PostgreSQL, API und Worker laufen in
einem Container unter derselben Benutzerkennung (UID 1000), zusammen mit dem Master-Schlüssel im Volume.

Gründe:

- Betrieb durch kleine Teams ohne Container-Orchestrierung: ein Image, ein Volume, ein Befehl für Installation, Update,
  Sicherung und Wiederherstellung (`install.sh`, `scripts/backup-volume.sh`). Datenbank, Medien und Schlüssel bilden
  einen konsistenten Stand; die Volume-Sicherung hält den Container dafür nur Sekunden an.
- Feste Start- und Stoppreihenfolge (PostgreSQL → API → Worker und umgekehrt), Migrationen mit Startprüfung und ein
  einziger Rückweg (vorheriges Image + Sicherung) – ohne Abstimmung zwischen mehreren Containern und Versionen.
- Die Datenbank ist nicht über das Netz erreichbar (nur Unix-Socket im Container), es gibt keine Zugangsdaten zwischen
  Containern, die verwaltet oder rotiert werden müssten.

Ausgleichende Maßnahmen:

| Maßnahme | Wirkung |
|---|---|
| Getrennte Datenbankrollen (#102) | API und Worker arbeiten als `blaulichtcms_app` ohne Superuser und nur mit DML: kein `COPY … TO PROGRAM`, kein Dateizugriff über SQL, Audit-Trigger nicht abschaltbar |
| Gehärteter Container | unprivilegierter Benutzer, `read_only`, `cap_drop: ALL`, `no-new-privileges`, nur `/tmp` (tmpfs) und `/data` beschreibbar |
| Ressourcengrenzen | `mem_limit`, `pids_limit`, `cpus` (`BLAULICHTCMS_CPUS`, Standard 2) – Videoverarbeitung kann den Host nicht auslasten; ffmpeg zusätzlich mit Zeitgrenzen und Auflösungsgrenze |
| Eingangsprüfung der Uploads | Dateityp nach Magic Bytes, Größen- und Auflösungsgrenzen, optional ClamAV vor jedem Decoder (#133), Medienverarbeitung als Auftrag in Quarantäne |
| Netz | nur ein Webport, am Host standardmäßig `127.0.0.1`; PostgreSQL ohne TCP |
| Schlüssel | Master-Schlüssel `0600` in `/data/secrets` (`0700`), wechselbar (`cli.js rotate-master-key`, #134); Volume-Sicherungen mit eigenem Schlüssel außerhalb des Volumes (#93) |
| Erkennung | Audit mit Hash-Kette und optionaler Weiterleitung an eine zentrale Protokollierung, Sicherheitsmeldungen (#101, #112) |
| Basis-Images | per Digest fixiert, Schwachstellenscan in der CI, wöchentliche Prüfung (#104, #105) |

Restrisiko: Wer Code im Container ausführen kann – etwa über eine Lücke in ffmpeg oder sharp bei der Verarbeitung
eines anonymen Uploads –, hat dieselben Rechte wie alle BlaulichtCMS-Prozesse: Lesezugriff auf `/data/postgres`, den
Master-Schlüssel und alle Medien und über den Socket auch auf den Datenbank-Superuser (`local all all trust`). Die
Rollentrennung schützt gegen Fehler und Injection in SQL, nicht gegen eine Übernahme des Containers. Eine Trennung
der Medienverarbeitung (eigene UID oder eigener Container ohne Zugriff auf `/data/secrets` und `/data/postgres`) wäre
der nächste Schritt; sie ist bewusst zurückgestellt, weil sie einen zweiten Container bzw. Root-Rechte für den
Benutzerwechsel im Container erfordert und den Betrieb (Update, Sicherung, Rückweg) deutlich komplizierter macht.
Das Restrisiko ist durch die Eingangsprüfung, ClamAV (optional), die Grenzen und die zeitnahe Aktualisierung der
Basis-Images (monatlich bzw. bei Sicherheitsupdates, `install.sh --rebuild`) begrenzt und wird mit dem Betreiber
abgestimmt.

### E3 – Image ohne Paketquellen

Laufzeitbasis ist `postgres:18-trixie` (offiziell), Node.js wird aus `node:26-trixie-slim` kopiert, ffmpeg/ffprobe aus
`mwader/static-ffmpeg:7.1.1` (statisch gebaut). Der Build braucht damit nur Docker Hub und die npm-Registry.
Grund: einfache, reproduzierbare Builds auch in Netzen ohne Zugriff auf Debian-/PGDG-Spiegel. Alle Basis-Images sind
per Build-Argument austauschbar.

### E4 – Master-Schlüssel

Wird `BLAULICHTCMS_MASTER_KEY` nicht gesetzt, erzeugt der Supervisor beim ersten Start `/data/secrets/master.key` (0600).
So hat jede Installation eigene Geheimnisse, ohne Pflicht zur manuellen Erzeugung. Wer den Schlüssel getrennt vom
Volume halten will, setzt die Umgebungsvariable. Der Schlüssel gehört zur Sicherung (separat aufbewahren).
Wechsel: `cli.js rotate-master-key --ja` verschlüsselt alle Felder in einer Transaktion neu (#134). Eine Schlüssel-ID
im Chiffrat ist dafür nicht nötig, weil es nach dem Wechsel keinen gemischten Bestand gibt; ein Chiffrat mit falschem
Schlüssel meldet „falscher Master-Schlüssel oder veränderte Daten“ (`docs/betrieb.md`, „Master-Schlüssel wechseln“).

### E5 – Fassungen und Freigabe

Jede inhaltliche Änderung erzeugt eine neue, unveränderliche Zeile in `post_revisions` mit SHA-256 über
`[Titel, Text, Kurzfassung, Medien-IDs in Reihenfolge, Titelbild, Zielkanal]`. Eine Freigabe speichert diese Prüfsumme;
gültig ist sie nur, solange Fassung und Prüfsumme die aktuellen sind. Veröffentlichen verlangt Fassungsnummer und
Prüfsumme im Request (Schutz gegen veraltete Oberflächen). Optimistische Sperre über `baseRevision` beim Speichern.

### E6 – Veröffentlichung als Auftrag mit Abholprinzip

Eine Veröffentlichung ist eine Zeile in `publications` (Fassung × Website), eindeutig über einen partiellen Unique-Index.
Die Bridge holt ab (`queued → sent`), meldet `published` oder `failed`. Ohne Rückmeldung nach 15 Minuten → `unknown`,
erneute Auslieferung, Abgleich über `blaulichtcms_post_id` in WordPress. Damit genau ein Beitrag. Einen Push von
BlaulichtCMS an WordPress (eingehende Verbindung zur Website) gibt es nicht.

### E7 – Medienablage und Prüfung

Uploads werden gestreamt (Größenlimit hart im Stream), in `media/tmp` geschrieben, per Transaktion in die Quarantäne
verschoben und als Auftrag `media.process` eingeplant. Prüfung anhand der Magic Bytes (`file-type`), Dekodierung mit
`sharp` (max. 40 Megapixel) bzw. `ffprobe`. Öffentliche Fassung: Bild als JPEG ohne Metadaten, Video umverpackt mit
`-map_metadata -1`. HEIC wird angenommen, aber ohne Vorschau/öffentliche Fassung (kein lizenzfreier Decoder).
Wiederholte Uploads mit gleichem Client-Schlüssel werden erkannt (Unique-Index `collection_id, client_key`).

### E8 – Upload-Links

Token 18 Byte zufällig, gespeichert als SHA-256 **und** verschlüsselt (AES-GCM, zweckgebunden), damit Link und QR-Code
später erneut angezeigt werden können. Ablauf, Widerruf, Dateigrenze, Dateianzahl je Link, Umfang je Sammlung und
Mindest-Speicher werden serverseitig geprüft. Antworten unterscheiden „ungültig“ (404) und „abgelaufen/widerrufen“ (410),
damit Hochladende eine verständliche Meldung erhalten.

### E9 – Updates: Image am Docker-Host und signierte In-App-Updates (geändert)

Ursprünglich waren Updates nur Image-Wechsel am Host. Auf Wunsch des Betriebs gibt es zusätzlich In-App-Updates – wie in LiFeOS über Einstellungen → Updates aus GitHub-Releases, aber ohne dessen
Schwächen (Überschreiben am Ort, keine Sicherung, kein Rückweg, erneute Installation derselben Version, übersprungene
Migrationen, Token-Pflicht). Ablauf und Bedienung: `docs/betrieb.md`, „In-App-Update“.

**Aufteilung:** Das Image (Basis-Images, Node.js, PostgreSQL, ffmpeg, Laufzeit-Abhängigkeiten, Supervisor,
Compose/Skripte) kommt weiterhin nur über `install.sh`. Ein In-App-Update tauscht ausschließlich Programmdateien,
Oberfläche, Migrationen und das WordPress-Plugin. Braucht ein Release mehr (`minImageVersion`, andere
Laufzeit-Abhängigkeiten), lehnt die laufende Version es ab und verweist auf den Host.

**Warum die Anwendung hier ihren eigenen Code ersetzen darf:**

- **Signatur mit einem Schlüssel, der nicht auf dem Server liegt.** Pakete entstehen in der CI und werden in einem
  eigenen Job mit dem Secret `BLAULICHTCMS_UPDATE_SIGNING_KEY` signiert (Ed25519 über Kontext + SHA-256). Wer den Server
  oder die API-Adresse/den Token übernimmt, kann kein installierbares Paket erzeugen.
- **Angehefteter Schlüssel der laufenden Version.** Geprüft wird gegen `server/update-signing-key.pub` des gerade
  laufenden Codes, nicht gegen einen Schlüssel aus dem Paket; ohne Schlüssel keine Installation. Kein Downgrade und
  keine erneute Installation derselben Version – ein altes, signiertes Paket mit bekannter Lücke lässt sich nicht
  wieder einspielen.
- **Kein Überschreiben am Ort.** Das Release wird geprüft (Pfade, Symlinks, Pflichtdateien, Rauchtest) in einen
  eigenen Ordner unter `/data/releases` entpackt; das Image bleibt unverändert und schreibgeschützt.
- **Sicherung und Rückweg.** Vor dem Umschalten Wartungsmodus, Vorabprüfung und Datenbanksicherung; der Supervisor
  (aus dem Image) migriert, startet, prüft und kehrt bei jedem Fehler mit zurückgespielter Sicherung zur vorigen
  Version zurück. Der Zeiger auf ein Release gilt nur, solange es neuer als das Image ist – `install.sh` bleibt immer
  der Weg zurück auf einen bekannten Stand.
- **Bestätigung und Nachvollziehbarkeit.** Recht „Updates einstellen und installieren“, frische Passwortbestätigung, Audit (Quelle,
  Prüfsumme, Sicherung, Ergebnis), Sicherheitsmeldung bei Start, Einstellungsänderung und Rückweg, Update-Protokoll.

**Restrisiko:** Gelangt der private Signaturschlüssel (GitHub-Secret oder Tresor) oder ein GitHub-Konto mit
Schreibrecht auf Workflows in falsche Hände, lässt sich ein Paket signieren, das jede Installation mit In-App-Updates
annimmt; die Hürde ist dann nur noch die Bestätigung durch eine Administratorin bzw. einen Administrator. Gegenmittel:
Schreibrechte und Secrets im Repository eng halten, Tags signieren, Release-Workflow nur mit geschützten Tags, bei
Verdacht Schlüsselwechsel (`docs/betrieb.md`) und Verteilung des neuen Schlüssels über `install.sh`. Weiter gilt: Code
im Volume läuft mit denselben Rechten wie der Code im Image (Benutzer `blaulichtcms`, keine Capabilities) – ein
In-App-Update erweitert die Rechte nicht, macht aber `/data` zu einem Ort, an dem ausführbarer Code liegt (Volume ohne
`noexec`). Der Supervisor selbst wird nie aus dem Volume geladen.

### E10 – Rollen

Rollen liegen in der Tabelle `roles` (seit 0.3.0): neun mitgelieferte Rollen – `platform_admin` (Anzeige
„Administration“), `media_manager`, `editor`, `approver`, `publisher`, `warning_author`, `warning_approver`,
`warning_sender`, `viewer` – und beliebig viele eigene. Rechte sind fein je Funktion registriert
(`server/src/auth/permissions.ts`, über 70 Rechte in zehn Bereichen, mit Voraussetzungen wie „Ändern setzt Ansehen
voraus“), Rollen kombinierbar.

- **Vorgaben statt Kopien.** Mitgelieferte Rollen speichern `permissions = NULL` und folgen der Vorgabe des Programms;
  erst eine Änderung speichert die Rechte ausdrücklich („Auf Standard zurücksetzen“ stellt `NULL` wieder her). So
  kommen Rechte künftiger Versionen bei unveränderten Rollen von selbst an.
- **Administration ist fest.** `platform_admin` hat immer alle Rechte, auch künftige, und ist weder änderbar noch
  löschbar; mindestens ein aktives Konto mit dieser Rolle bleibt. Eine eigene Rolle mit allen Rechten ersetzt sie nicht.
- **Keine Rechte in der Sitzung.** Jede Anfrage rechnet die Rechte aus den Rollen des Kontos und dem Rollenstand im
  Arbeitsspeicher (`auth/roles.ts`). Der ändernde Prozess lädt sofort neu, andere Prozesse über NOTIFY bzw. nach
  höchstens 3 Sekunden. Änderungen gelten damit ab der nächsten Anfrage, ohne neue Anmeldung.
- **Keine Rechteausweitung.** Rollen zuweisen, entziehen, anlegen und ändern kann man nur innerhalb der eigenen
  Rechte; Konten mit mehr Rechten lassen sich nicht übernehmen (Passwort-Link, Zwei-Faktor zurücksetzen), sperren
  oder löschen. Rollenpflege verlangt eine frische Passwortbestätigung und ist per API-Schlüssel nicht möglich.
- **Zugriffsangabe je Route.** `requireAuth('recht')` ist zugleich die Deklaration; `app.routeAccess` listet alle
  Routen. Tests schlagen fehl, wenn eine Route weder ein Recht nennt noch in `PUBLIC_ROUTES` steht, und prüfen für
  jede Route 401 ohne Anmeldung, 403 ohne Rechte und 403 mit allen Rechten außer dem genannten.
- **Alte Bezeichnungen.** Die groben Rechte bis 0.2 (`media.manage`, `system.manage` …) bleiben als
  Sammelbezeichnungen gültig (`LEGACY_PERMISSIONS`): Sie gelten nur, wenn alle enthaltenen feinen Rechte vorhanden
  sind. Alte Benachrichtigungen und Prüfungen funktionieren weiter, ohne mehr zu erlauben.
- **Zwei-Faktor-Pflicht über Rechte.** `security.require_2fa_admins` gilt für Konten mit Verwaltungsrechten (im
  Katalog markiert), `security.require_2fa_media` für „Originale herunterladen“. Erhält eine Rolle solche Rechte,
  werden ihre Konten ohne zweiten Faktor abgemeldet und richten ihn bei der nächsten Anmeldung ein.

Vier-Augen-Prinzip optional (Einstellung `editorial.four_eyes`) für Beiträge, Banner und Warnentwürfe: nicht durch die
einreichende Person (`post_revisions.submitted_by`, `banners.submitted_by`, `warning_revisions.submitted_by`) und nicht
durch Personen, die bis zur geprüften Fassung Inhalte geschrieben haben (Beiträge: Text, Kanaltexte, Medien, Titelbild –
Termin, Zielkanal und soziale Kanäle zählen nicht; Banner ohne Fassungshistorie: anlegende und zuletzt ändernde Person).

### E11 – Öffentliche Adresse aus dem Erstsetup

Maßgeblich ist die Einstellung `general.public_url` (Erstsetup). `PUBLIC_URL` dient nur als Vorschlag/Fallback.

### E12 – Leistung

Beitragsstatus wird für Listen in einer SQL-Abfrage berechnet (`POST_STATE_SQL`, gleiche Logik wie `postState()`),
Indizes in `003_performance.sql`. Statische Dateien kommen vorkomprimiert (`web/scripts/compress.mjs`,
`@fastify/static preCompressed`), API-Antworten über `@fastify/compress` (nur JSON/SVG/Text, ab 1 KB).
Medien-Varianten sind je ID unveränderlich und daher langfristig privat cachebar. Optimistische Anzeige nur bei der
Sichtung – Freigaben und Veröffentlichungen bleiben serverbestätigt.

### E13 – Gestaltung (Übergang bis zum endgültigen Design)

Sachlicher Behörden-/Einsatz-Look: hell als Standard (Lesbarkeit draußen), Marineblau für Bedienung und Seitenleiste,
Signalrot nur als Akzent (Marke, aktive Navigation, Dringliches), Status immer mit Farbe und Text, kleine Radien.
Alles über Tokens in `web/src/theme/tokens.css` – das endgültige Design lässt sich dort zentral austauschen.

### E14 – Warnentwürfe und Warnstufen-Assistent (M3, #41)

- **Vorgang ≠ Fassung:** Ein Vorgang (`warnings`, Art Erstmeldung/Aktualisierung/Entwarnung, Bezug über `parent_id`/`root_id`)
  hat unveränderliche Fassungen (`warning_revisions`). Die Prüfsumme umfasst Vorlage, Art, Felder, Zuständigkeiten,
  Stichwort, Antworten und die Stufenentscheidung – die Freigabe gilt genau für diese Fassung.
- **Vorschlag ist nur Hilfe:** `warnings/levels.ts` wertet nur fachlich freigegebene Regeln auf freigegebene Fragen aus.
  Kein Vorschlag bei unbekanntem Stichwort, fehlenden Angaben, Widerspruch oder wenn eine unvollständige Regel zu einer
  anderen Stufe führen könnte. Ein Vorschlag erzeugt nie einen Auftrag.
- **Bestätigung als eigenes Recht** (`warning.level`), Abweichung nur mit Begründung; gespeichert werden Vorschlag,
  Regel-IDs und -Versionen, Person und Zeit. Ändern sich Stichwort oder Antworten, verfällt die Bestätigung.
- **Regeln versioniert** (Linie + Version); Freigabe durch eine andere Person setzt ältere Versionen außer Kraft.
- **PDF bei Freigabe fixiert** (pdfkit, deterministische Metadaten), Datei unter `/data/warnings/<id>/` mit SHA-256.
  Vorlagen sind versioniert; ein Vorgang behält seine Vorlagenversion.
- **Versand genau einmal:** Auftrag `warning.send` mit `max_attempts = 1`. Status `accepted` (Mailserver-Annahme,
  keine fachliche Bestätigung), `failed` (sicher nicht angenommen) oder `unknown` (Abbruch einer bestehenden
  Verbindung, auch nach Neustart während „sending“). `unknown` sperrt jeden Neuversand bis zur menschlichen Prüfung.
  Testmodus ab Werk: nur an das Testpostfach.

### E15 – Optionale Verbindungen (M4)

- Einheitlicher Zustandsautomat `draft → tested → active ⇄ disabled → revoked`; aktivierbar nur nach bestandenem Test.
  Ein Test enthält immer einen echten Funktionsschritt (Facebook: unveröffentlichter Beitrag + Löschen; Instagram:
  Container ohne Veröffentlichung; FE2: empfangene Testmeldung; Warnfeed: Abruf + Gebietsfilter).
- Geheimnisse je Verbindung als verschlüsseltes JSON in `secrets` (neue Version bei jeder Änderung in einer Transaktion
  unter Zeilensperre, alte widerrufen; Versionen je Besitzer unter Advisory-Sperre). Auch das SMTP-Passwort widerruft
  beim Ändern die alte Version; widerrufene Geheimnisse löscht der Worker nach 30 Tagen endgültig.
- Soziale Kanäle sind Teil der Fassung (`post_revisions.social_targets`, in der Prüfsumme). Je Kanal und Fassung genau ein
  Auftrag (`social_publications`, eindeutiger Index); ein Versuch je Anstoß; „unbekannt“ wird vor jedem neuen Versuch
  über den Text-Marker beim Anbieter geprüft.
- Meta ruft Medien über befristete, tokenisierte URLs `/api/v1/m/<token>` ab (24 h, nur öffentliche Fassungen).
- Private Ziele (SSRF-Schutz) nur nach Freigabe durch die Plattform-Administration, gebunden an den Host.

### E16 – Betrieb: Updates und Rückweg (M4)

- Schema-Migration als eigener Supervisor-Schritt vor der API; Startprüfung „Datenstand neuer als Programm“.
  Bei Fehler bleibt PostgreSQL erreichbar und der Webport zeigt eine Sperrseite (503).
- Wartungsmodus als Einstellung: API lehnt ändernde Anfragen ab (außer Anmeldung und Wartung), Worker beginnt keine
  neuen Aufträge, Bridge erhält keine neuen Aufträge und keine Banner-Liste.
- Image und Datenstand gehören zusammen; der Rückweg führt immer über die Volume-Sicherung von vor dem Update.
- In-App-Updates (E9): Programmstand und Datenstand gehören ebenso zusammen; der automatische Rückweg spielt die
  Datenbanksicherung von unmittelbar vor der Umschaltung zurück, sobald Migrationen der neuen Version liefen.

### E17 – Automationen: Abläufe als Daten, Entwurf → Test → Version, Direktversand je Automation (0.3.0)

**Name:** In der Oberfläche heißen sie seit 0.3.1 **Workflows** (geführte Ansicht „Wenn → Nur wenn → Dann“, Vorlagen); im Code, in der API, der Datenbank und den Rechte-IDs bleibt `automation(s)` – so braucht die Umbenennung keine Migration.

**Aufbau** (`server/src/automations/`, Migration `060_automations.sql`):

- **Eingänge** (`automation_inputs`: FE2, Feuersoftware, amtliche Warnung, RSS, Uploads, Zeitplan, manueller Start) und
  **Ausgänge** (`automation_outputs`: Banner, Beitrag, E-Mail, App-Benachrichtigung, Warnentwurf vorbereiten) sind
  wiederverwendbare Bausteine mit serverseitig geprüften Einstellungen (`configs.ts`). Jede Eingangsart deklariert ihre
  Felder (`catalog.ts`) – sie sind die einzige Grundlage für Platzhalter und Bedingungen.
- **Ablauf** (`automations.graph`): Knoten und Kanten als JSON. Verarbeitungsknoten: Bedingung (Feld – Operator – Wert,
  UND/ODER, eine Ebene Untergruppen), Verzweigung, Felder setzen (`{{feld}}`-Vorlagen), Warten (≤ 24 h), Einmal je
  Vorgang (Schlüssel aus Feldern, Zeitfenster), Freigabe anfordern, Zusammenführen. **Kein Code, keine Ausdrücke,
  kein eval** – Vorlagen ersetzen nur Platzhalter durch Text, Bedingungen vergleichen mit festen Werten.
- **Prüfung** (`graph.ts`, ohne Datenbank): Kreise, Pflicht-Anschlüsse, Ports, Grenzen (60 Knoten, 150 Kanten) und ob
  jedes verwendete Feld an der jeweiligen Stelle vorhanden ist (Schnittmenge über alle eingehenden Wege).
- **Versionen:** Aktivieren geht nur, wenn genau dieser Stand einen erfolgreichen Testlauf hatte (`tested_hash` =
  Prüfsumme über Ablauf **und** Einstellungen der verwendeten Ein-/Ausgänge, ohne Positionen). Die Aktivierung speichert
  eine unveränderliche Momentaufnahme (`automation_versions`); Läufe arbeiten nur auf Momentaufnahmen. Wie bei den
  Verbindungen (E15) gilt „aktiv nur nach bestandenem Test“.
- **Ereignisse:** Die Quellen rufen nur eine kleine Funktion auf (`events.ts`: `emitIncident` in `handleIncident`,
  `emitOfficialWarning` im Warnfeed-Abruf, `emitRssItem` beim regulären RSS-Abruf, `emitUpload` nach der Medienprüfung).
  In Transaktionen der Quelle läuft das Anlegen unter einem Savepoint; ein Fehler stört den Empfang nie. Zeitpläne
  startet der Worker-Leader (alle 30 s, keine Nachholung > 10 min, nie vor der Aktivierung).
- **Ausführung** (`engine.ts`): Auftrag `automation.run` in der Warteschlange, Advisory-Lock je Lauf (nie parallel),
  topologische Reihenfolge, ein Schritt je Knoten (`automation_steps`, eindeutig je Lauf und Knoten). Ausgänge schreiben
  Ergebnis und Schritt in **einer** Transaktion – Wiederholung und Fortsetzung legen nichts doppelt an. Ein Ereignis
  startet je Automation genau einen Lauf (eindeutiger `event_key`). Vorübergehende Fehler: bis zu 4 Versuche mit
  Backoff; E-Mail mit unklarem Ergebnis wird nie automatisch neu gesendet (wie `warning.send`). Warten und Freigabe
  halten den Lauf an und setzen ihn über einen neuen Auftrag fort.
- **Testläufe** laufen direkt in der Anfrage (ohne Worker) als Trockenlauf: Ausgänge beschreiben, was sie tun würden.
- **Grenzen:** Läufe je Automation und Minute (`automations.max_runs_per_minute`, Standard 20; darüber verworfen,
  protokolliert, Verwaltung benachrichtigt), globaler Schalter `automations.enabled`, Notbremse „Deaktivieren“ (offene
  Läufe und Freigaben werden abgebrochen), Löschfrist `privacy.automation_run_days` (30 Tage).
- **Rechte:** `automation.read` (Administration, Redaktion, Freigabe), `automation.manage` und `automation.publish`
  (Administration). Freigaben aus Abläufen entscheidet „Fassungen freigeben“; mit `editorial.four_eyes` nicht, wer die
  Automation zuletzt geändert oder die laufende Version aktiviert hat.
- **Ausgänge und Vier-Augen:** Banner und Beiträge entstehen als Entwürfe (wahlweise eingereicht); App-Benachrichtigungen
  und E-Mails an Konten (Rollen) gehen sofort – sie verlassen BlaulichtCMS nicht bzw. nur an hinterlegte Konten; E-Mails
  an Zuständigkeiten nur nach Freigabe; Warnentwürfe werden nur vorbereitet. Keine sozialen Netzwerke, keine Webhooks.

**Bewusste Abweichung: Direktversand ohne menschliche Freigabe, je Automation wählbar (Entscheidung des Betriebs).**
Eine Automation kann „Darf direkt veröffentlichen/versenden“ erhalten. Dann veröffentlichen **nur im Editor markierte**
Banner- und Beitrags-Ausgänge direkt (Banner freigegeben und als Auftrag für die Bridge; Beitrag mit Freigabe ohne
Person und Veröffentlichungsauftrag) bzw. senden E-Mails an Zuständigkeiten ohne Freigabe. Das hebt für diese Ausgänge
das Vier-Augen-Prinzip (E10) auf.

Ausgleich:

| Maßnahme | Wirkung |
|---|---|
| Eigenes Recht `automation.publish` (nur Administration) | Markieren, Erlauben und Aktivieren einer Version mit markierten Ausgängen; „Verwalten“ allein genügt nicht |
| Frische Passwortbestätigung (#109, ≤ 10 min) | Erlauben und Aktivieren mit Direktversand; API-Schlüssel können das nie |
| Pflicht-Testlauf des aktuellen Stands | Erlauben und Aktivieren nur mit `tested_hash` des aktuellen Ablaufs samt Ein-/Ausgängen |
| Doppelte Bedingung zur Laufzeit | direkt nur, wenn die Version mit Direktversand aktiviert wurde **und** die Automation ihn jetzt noch hat – Entziehen wirkt sofort, auch für wartende Läufe |
| Sichtbarkeit | Kennzeichnung „Direktversand“ in Liste und Editor, „Direkt“ am Knoten, Versionen „mit Direktversand“ |
| Nachvollziehbarkeit | Audit (`automation.direct_enabled/disabled`, `automation.activated` mit Zahl der Direkt-Ausgänge, `automation.post_published`, `automation.banner_published`, `automation.mail_sent`) und Sicherheitsmeldung `automation_direct_publish` |
| Begrenzung | nur Banner, Beitrag (nur mit gekoppeltem Zielkanal), E-Mail an gepflegte Zuständigkeiten; nie Warnentwürfe, nie soziale Netzwerke; Testmodus des Mailversands gilt weiter |

Restrisiko: Eine fehlerhaft gebaute Bedingung oder eine manipulierte Quelle (z. B. gefälschter Feed, falls interne
Ziele freigegeben sind) kann ungeprüfte Inhalte auf die Website bringen. Gegenmittel: Direktversand nur für eng
gefasste Abläufe mit geprüften Quellen, Banner mit kurzer Dauer, Laufprotokolle prüfen, im Zweifel entziehen. Die
automatischen Banner amtlicher Warnungen (E15, fachliche Prüfung je Verbindung) bleiben davon unabhängig.

## Offene Architekturpunkte

- Medienverarbeitung (sharp, ffmpeg) unter eigener UID oder in eigenem Container ohne Zugriff auf Schlüssel und
  Datenbank – nächster Schritt zur weiteren Trennung, siehe E2.

## Lizenz

GPL-3.0-or-later; das WordPress-Plugin BlaulichtCMS Bridge GPL-2.0-or-later.
