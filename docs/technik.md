# Technischer Aufbau

Aufbau, Sicherheit, Teststand und Entwicklung von BlaulichtCMS. Installation und Betrieb beschreibt
[installation.md](installation.md).

## Aufbau

```mermaid
flowchart LR
    B["🌐 Browser / Handy<br/>(App, installierbar)"] -->|HTTPS| P["Reverse Proxy"]
    P -->|"http://blaulichtcms:7310"| API
    subgraph C["Container blaulichtcms"]
      S["Supervisor"] --> PG[("PostgreSQL 18<br/>nur Unix-Socket")]
      S --> API["API (Fastify)"]
      S --> W["Worker<br/>Medien, Jobs, Fristen"]
      API --- PG
      W --- PG
    end
    C --- V[("Volume<br/>Datenbank, Medien, Schlüssel")]
    WP["WordPress + BlaulichtCMS Bridge"] -->|"HTTPS, holt Aufträge ab"| P
    W -->|"Graph API, SMTP, Warn-Feeds"| EXT["Facebook / Instagram,<br/>Mailserver, amtliche Warnungen"]
    FE2["FE2"] -->|"HTTPS mit Schlüssel"| P
    W -->|"HTTPS-Abruf mit API-Key"| FS["Feuersoftware Connect"]
```

| Baustein | Technik |
|---|---|
| Server | TypeScript, Node.js, Fastify; Worker für Medienverarbeitung (sharp, ffmpeg), Hintergrundaufträge und Löschfristen |
| Datenbank | PostgreSQL 18 im selben Container, nur über Unix-Socket; getrennte Rollen für Migrationen und Anwendung |
| Oberfläche | React 19, Vite, Tailwind 4, TanStack Query; installierbare Web-App (PWA), Live-Aktualisierung per Server-Sent Events |
| WordPress | Plugin „BlaulichtCMS Bridge“ (PHP) – holt Aufträge per HTTPS ab, BlaulichtCMS öffnet keinen Eingang zur Website |
| Betrieb | ein Container, ein Volume, ein Port; Supervisor startet Datenbank, Migrationen, API und Worker und schaltet bei Updates um |
| Updates | signierte Releases (Ed25519) aus GitHub, Sicherung vorab, automatischer Rückweg |

Die Architekturentscheidungen mit Begründung stehen in [architektur.md](architektur.md).

---

## Verbindungen

Alle Verbindungen sind optional und laufen unter *Kanäle → Verbindungen* nach dem Muster
**Verbinden → Testen → Vorschau → Aktivieren**.

| Verbindung | Wofür | Geprüft |
|---|---|---|
| WordPress (Bridge) | Beiträge, Banner, Einsatzübersicht; Updates mit Ed25519-Signatur | echtes WordPress mit HTTPS |
| FE2 | interner Entwurf je Einsatz; Feldzuordnung je Instanz | mit nachgebildeten Meldungen |
| Feuersoftware Connect | regelmäßiger Abruf der Öffentlichen Connect Schnittstelle (60–300 s, Retry-After), Filter nach RIC und Stichwort, derselbe Entwurf wie bei FE2 (nur Ort, keine Adresse) | gegen nachgebildete Connect-Schnittstelle |
| Amtliche Warnungen | Warn-App-Schnittstelle des Bundes (Kreis-ARS) oder CAP, Banner mit Quellenvermerk | echte Schnittstelle |
| Facebook / Instagram | Veröffentlichung und Zurückziehen je Kanal mit eigenem Status (Graph API v26.0) | gegen nachgebildete Graph API |
| E-Mail (Warnentwurf) | PDF-Versand an die zuständige Stelle, STARTTLS/TLS | Mailserver mit TLS |
| Medienimport | einmalige Übernahme von Medien und gültigen Upload-Links aus einem Altsystem (Austauschformat; Exportskript für LiFeOS) | mit fiktiven Daten |

Details und Einrichtung: [docs/integrationen.md](integrationen.md), Hilfe → *Verbindungen*.

---

## Sicherheit

| Bereich | Umsetzung |
|---|---|
| Rechte | serverseitig bei jeder API, jeder Datei und jeder Aktion; Standard „verweigert“; Rollen kombinierbar; Vier-Augen-Prinzip für Beiträge, Banner und Warnentwürfe |
| Anmeldung | Argon2id, Zwei-Faktor (TOTP) mit Wiederherstellungscodes, erneute Bestätigung für kritische Aktionen, Sperre nach Fehlversuchen ohne Aussperren bekannter Geräte, CSRF-Schutz |
| Uploads | nur über befristete, widerrufbare Links in genau eine Sammlung; Größen- und Mengengrenzen je Link und Sammlung; erlaubte Typen je Link; optional Passwort (Argon2id, Freigabe als signiertes, pfadgebundenes Cookie, Fehlversuche gedrosselt und protokolliert); Quarantäne; Inhaltsprüfung; optional Virenscan (ClamAV); Drosselung je IP |
| Medien | privat außerhalb des Webservers; Standort- und Kameradaten werden entfernt; Unkenntlichmachen für die öffentliche Fassung; Verschieben behält die Medien-ID (Freigaben bleiben an genau diese Datei gebunden), Kopien übernehmen die Datenschutz-Entscheidungen; `metadaten.csv` im ZIP gegen Formel-Injektion abgesichert |
| Websites | Schlüssel je Website (nur Prüfsumme gespeichert), sofort widerrufbar; die Bridge ruft nur aus, nur per HTTPS |
| Datenbank | nur über Unix-Socket im Container; die Anwendung arbeitet mit einer Rolle ohne Superuser- und DDL-Rechte |
| Audit | Hash-Kette gegen nachträgliche Änderungen, optional an Syslog weitergeleitet; Alarmierung bei Sicherheitsereignissen; eigenes Protokoll der Sicherheitsereignisse der Upload-Seiten (gekürzter IP-Hash, gedrosselt) |
| Inhaltsprüfung | Typ am Dateiinhalt, Bilder vollständig dekodiert mit Pixelgrenze, Videos: Codec-Liste, Länge, Auflösung und Dekodierprüfung (Anfang Bild für Bild, danach Schlüsselbilder) – alle Grenzen einstellbar |
| Prüfbefunde | Dateien mit Befund werden gesperrt (Quarantäne, nie ausgeliefert, erneut prüfbar); „Trotzdem freigeben“ nur für Videos mit reinem Dekodierbefund und nur mit „Medien administrieren“, Begründung, Audit und Sicherheitsmeldung; Schadsoftware wird sofort gelöscht |
| Sicherungen | verschlüsselt (AES-256-GCM) mit eigenem Schlüssel, regelmäßige Probe-Wiederherstellung |
| Updates | Releases mit Ed25519 signiert (privater Schlüssel nie auf dem Server), geprüft gegen den Schlüssel der laufenden Version; Sicherung vorab und automatischer Rückweg; Bridge-Updates ebenso signiert |
| Container | unprivilegierter Benutzer, schreibgeschütztes Dateisystem, keine Capabilities, Grenzen für Speicher, CPU und Prozesse, Port standardmäßig nur lokal |

Ergebnis der Sicherheitsprüfung (BSI IT-Grundschutz): [docs/sicherheitspruefung.md](sicherheitspruefung.md),
Datenschutz: [docs/datenschutz.md](datenschutz.md). **Sicherheitslücken bitte nicht als öffentliches Issue
melden** – Vorgehen in [SECURITY.md](../SECURITY.md).

---

## Leistung

- Seiten werden einzeln nachgeladen, der Build ist mit Brotli vorkomprimiert. Der erste Aufruf am Handy lädt rund 180 KB, danach kommt fast alles aus dem Browser-Cache.
- Die Sichtung reagiert sofort und lädt das nächste Bild vor. Uploads laufen in Teilen, zwei parallel, und lassen sich ohne Doppelanlage wiederholen.
- Beitragsliste und Dashboard brauchen je eine Datenbankabfrage. PostgreSQL ist für SSD eingestellt.
- Lasttest (Produktions-Build, 50 gleichzeitige Verbindungen): Dashboard rund 1 000 Anfragen/s bei p99 52 ms, Startseite rund 3 750 Anfragen/s, ohne Fehler ([docs/betrieb.md](betrieb.md)).

---

## Teststand und Grenzen

**Automatisiert (bei jedem Push in der CI):** Typprüfung, rund 200 Server-Tests gegen echtes PostgreSQL (inklusive
Video-Verarbeitung mit ffmpeg), Build, PHP-Lint des Plugins, Probelauf mit Docker Compose (Rollen, Schlüsselwechsel,
Audit-Kette), Abhängigkeits-, Image- und Secret-Scan. Dazu kommen Abnahmetests über Browser, Container und ein
Test-WordPress (`test/e2e/`, Foto-Link bis Website, fortsetzbarer Upload, Warnentwurf, fehlgeschlagenes Update mit
Rückweg, Wiederherstellung, PostgreSQL-Upgrade). Das Update aus der App ist mit dem echten Supervisor durchgespielt
(Aktivierung, Rückweg bei fehlerhafter Migration und bei Absturz der neuen Version).

**Mit echten Systemen geprüft:** WordPress 7.1 / PHP 8.5 mit HTTPS, WP-Cron, Host-Cron und Seitencache; die
Warn-App-Schnittstelle des Bundes; Mailversand mit STARTTLS/TLS; QR-Aushänge unter erschwerten Bedingungen.
Ergebnisse je Verbindung: [docs/integrationen.md](integrationen.md).

**Noch nicht geprüft bzw. vor dem Echtbetrieb zu klären:**

- Betrieb auf einem Zielhost mit echten Datenmengen (Wiederherstellung, PostgreSQL-Upgrade, Last), externer Penetrationstest
- Meta-App mit App-Prüfung (Facebook/Instagram), FE2-Meldungen einer echten Instanz
- Warnentwurf: Die mitgelieferte Vorlage ist ein **nicht abgestimmtes Beispiel**, Warnstufen-Regeln gibt es ab Werk
  keine. Vorlage, Empfänger und Rückmeldeweg mit der zuständigen Stelle abstimmen, Regeln fachlich freigeben. Die
  Weiterverwendung amtlicher Warninhalte (MoWaS) vor dem Einschalten automatischer Banner mit dem BBK klären.
- Datenschutz: Angaben unter *Einstellungen → Datenschutz* ausfüllen, Verarbeitungsverzeichnis und DSFA mit den
  Vorlagen in [docs/datenschutz.md](datenschutz.md) erstellen.

---

## Entwicklung und Tests

```bash
npm ci
npm run typecheck && npm run build
# Server-Tests gegen eine Wegwerf-Datenbank (wird bei jedem Lauf geleert!), Datenbank mit UTF8 anlegen
TEST_DATABASE_URL=postgresql://blaulichtcms:blaulichtcms@127.0.0.1:5442/blaulichtcms_test npm test
npm run dev:server & npm run dev:worker & npm run dev:web                     # http://localhost:5173
```

**Release erstellen:** `VERSION` sowie `server/package.json` und `web/package.json` erhöhen (bei Änderungen am Image
auch `MIN_IMAGE_VERSION`), Versionshinweise in `release-notes/v<version>.md` schreiben, committen, CI abwarten und den
Tag `v<version>` pushen. Der Workflow *Release* baut das Paket, signiert es in einem getrennten Job (Secret
`BLAULICHTCMS_UPDATE_SIGNING_KEY`) und legt das GitHub-Release an; Installationen sehen es unter *Einstellungen → Updates*.

Die Abnahmetests (`test/e2e/`) brauchen Docker, Playwright und ein Test-WordPress. Lokale Umgebung, auch ohne Docker
unter Windows: [docs/entwicklung.md](entwicklung.md). Beiträge sind willkommen: [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Projektstruktur

| Ordner / Datei | Inhalt |
|---|---|
| `install.sh` | Installation und Update am Docker-Host |
| `compose.yaml`, `Dockerfile`, `.env.example` | Dienst `blaulichtcms` (ein Container), Netz `proxy-net`, Konfiguration |
| `server/` | TypeScript, Fastify: API, Worker, Supervisor mit internem PostgreSQL, Medienprüfung, Updates aus GitHub-Releases (`src/updates/`), CLI |
| `server/migrations/` | SQL-Migrationen (laufen beim Start, mit Startprüfung) |
| `server/test/` | Unit- und Integrationstests gegen echtes PostgreSQL |
| `web/` | Oberfläche und App: React 19, Vite, Tailwind 4, TanStack Query |
| `web/src/pages/help/content/` | Kapitel des Hilfe-Centers (Markdown) |
| `wordpress-plugin/blaulichtcms-bridge/` | WordPress-Plugin BlaulichtCMS Bridge (PHP) |
| `scripts/` | Sicherung (`backup-volume.sh`, `backup-cron.sh`, Verschlüsselung `volume-crypt.mjs`, Prüfung `verify-backup.sh`), Wiederherstellung, Update am Host, Release-Paket (`build-release.mjs`), Signaturen (`update-signing.mjs`, `bridge-signing.mjs`), LiFeOS-Export |
| `release-notes/`, `VERSION`, `MIN_IMAGE_VERSION` | Versionshinweise je Release, aktuelle Version, Mindestversion des Images für Updates aus der App |
| `.github/workflows/` | CI (Tests, Build, Docker-Probelauf), Sicherheitsprüfung (Abhängigkeiten, Image, Secrets), Release (bauen, signieren, veröffentlichen) |
| `test/e2e/`, `test/wordpress/` | Abnahmetests über Container, Browser und ein Test-WordPress |
