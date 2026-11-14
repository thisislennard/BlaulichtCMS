# Testprotokoll

Damit die Arbeit nach einer Unterbrechung direkt weitergehen kann: Befehle, letzte Ergebnisse und offene Prüfungen.

## Befehle

```bash
npm ci
npm run typecheck                                                                   # Server + Oberfläche
TEST_DATABASE_URL=postgresql://lifelink:lifelink@127.0.0.1:5442/lifelink_test npm test   # Unit + Integration
npm run build
docker compose build                                                                # Image lifelink:local
node test/e2e/m1-flow.mjs                                                           # Abnahme M1 (setzt Volumes zurück!)
node test/e2e/m2-flow.mjs                                                           # Abnahme M2
node test/e2e/m3-flow.mjs                                                           # Abnahme M3 (lokales Test-Postfach auf Port 2525)
```

## Letzte Ergebnisse (14.11.2026)

| Prüfung | Ergebnis |
|---|---|
| Typprüfung Server und Oberfläche | ✅ ohne Fehler |
| Server-Tests (Vitest gegen PostgreSQL 16) | ✅ 30/30 |
| Oberfläche bauen (Vite) | ✅ |
| PHP-Syntax der LifeLink Bridge (`php -l`, PHP 8.3) | ✅ |
| Image bauen | ✅ (Basis `postgres:18-trixie`, Node 26, ffmpeg 7.1.1) |
| Frischer Container auf leerem Volume bis `/healthz` 200 | ✅ ca. 4 s |
| **Abnahmetest M1** (`test/e2e/m1-flow.mjs`) | ✅ **34/34** |

### Abnahmetest M1 im Detail

Umgebung: LifeLink-Container (Docker), WordPress 6.9.4 mit MariaDB 11 als separates
Zielsystem, Chromium (Playwright) als Desktop (1360×900), Pixel 7 (Bediener) und iPhone 14 (Upload ohne Konto).

| # | Schritt | | Ergebnis |
|---|---|---|---|
| 1 | Frischer Container auf leerem Volume | ✅ | healthz ok, 2/2 Migrationen |
| 2 | WordPress-Testsystem bereitstellen | ✅ | 6.9.4 |
| 3 | Erstsetup: Admin, Organisation, Basisadresse, Zeitzone | ✅ | Dashboard erreicht |
| 4 | Zweites Setup wird abgewiesen | ✅ | HTTP 403 |
| 5 | Bediener einladen (Redaktion + Medienverwaltung + Veröffentlichung) | ✅ | http://localhost:7310/einladung/… |
| 6 | Bediener nimmt Einladung am Handy an | ✅ | angemeldet |
| 7 | Einladungslink ist danach verbraucht | ✅ | HTTP 404 |
| 8 | Bediener legt Beitrag an und erzeugt „Fotos und Videos sammeln“ | ✅ | http://localhost:7310/u/… |
| 9 | Aushang-Druckansicht enthält QR-Code, Zweck und lesbare Adresse | ✅ | PDF test/e2e/out/aushang.pdf |
| 10 | Foto-Link am Handy ohne Konto öffnen und Foto hochladen | ✅ | Upload bestätigt |
| 11 | Upload liegt zuerst in Quarantäne und wird geprüft (Standortdaten entfernt) | ✅ | geprüft, GPS im Original erkannt, öffentliche Fassung ohne EXIF |
| 12 | Bild sichten und auswählen (Handy) | ✅ | ausgewählt |
| 13 | Beitrag schreiben, Bild übernehmen, zur Freigabe einreichen | ✅ | eingereicht |
| 14 | Bediener darf nicht selbst freigeben (Recht fehlt, auch per API) | ✅ | HTTP 403, kein Button |
| 15 | Admin gibt frei (intern, ohne WordPress) | ✅ | intern freigegeben |
| 16 | LifeLink Bridge als ZIP aus LifeLink herunterladen und in WordPress installieren | ✅ | 0.1.0 |
| 17 | Website per einmaligem Code koppeln (WordPress-Oberfläche) | ✅ | Code CA…, gekoppelt |
| 18 | Kopplungscode ist danach verbraucht | ✅ | HTTP 401 |
| 19 | Zielkanal wählen erzeugt neue Fassung – alte Freigabe gilt nicht mehr | ✅ | neue Fassung, Status Entwurf → eingereicht |
| 20 | Admin gibt die neue Fassung frei, Bediener veröffentlicht | ✅ | Auftrag erstellt |
| 21 | Bridge holt per Host-Cron ab und meldet zurück | ✅ | Success: 1 Auftrag/Aufträge verarbeitet. |
| 22 | LifeLink zeigt die bestätigte URL | ✅ | http://localhost:8080/2026/11/ubung-am-wochenende/ |
| 23 | Auf der Testwebsite erscheint genau ein Beitrag (mit Bild, ohne Standortdaten) | ✅ | WordPress-ID 5 |
| 24 | Erneutes Abholen und doppelte Rückmeldung erzeugen keinen zweiten Beitrag | ✅ | weiterhin genau 1 Beitrag und 1 Anhang |
| 25 | Direkte Zugriffe ohne Anmeldung werden abgewiesen | ✅ | 401,401,401,401,401,401 |
| 26 | Bediener ohne Admin-Recht: Benutzerverwaltung und Website-Kopplung gesperrt | ✅ | 403, 403 |
| 27 | Abgelaufener Upload-Link wird abgewiesen | ✅ | Seite „Link nicht mehr gültig“, HTTP 410 |
| 28 | Widerrufener Upload-Link wird abgewiesen (UI-Widerruf) | ✅ | HTTP 410 link_revoked |
| 29 | Widerrufene Website-Kopplung wird abgewiesen | ✅ | HTTP 401 |
| 30 | Zweiter Beitrag: interne Freigabe ganz ohne Zielkanal | ✅ | freigegeben, keine Veröffentlichung |
| 31 | Audit enthält Rollen, Freigaben und Veröffentlichungen mit Person und Zeit | ✅ | 7 relevante Einträge |
| 32 | Teststand außerhalb des aktiven Volumes sichern | ✅ | lifelink-2026-11-14-134733.tar.gz (7082 KB) – Sicherung geschrieben: /home/user/LifeLink2/test/e2e/out/backup/lifelink-2026-11-14-134733.tar |
| 33 | Frische Instanz aus der Sicherung wiederherstellen | ✅ | Volume neu angelegt und wiederhergestellt |
| 34 | Nach Wiederherstellung: Anmeldung, Beitrag, URL, Medien, Freigaben vorhanden | ✅ | Login ok, Beitrag veröffentlicht, Vorschau 200, 3 Freigaben, Bridge-Abruf ok |

## Abnahmekriterien Meilenstein 1

| Kriterium | Status | Nachweis |
|---|---|---|
| Kompletter Ablauf auf leerem Volume | ✅ | Schritte 1–23 |
| Ohne WordPress lässt sich ein Beitrag intern freigeben | ✅ | Schritte 15 und 30, Integrationstest |
| Direkte Zugriffe ohne Rechte werden abgewiesen | ✅ | Schritte 14, 25, 26, Integrationstest „weist direkte Zugriffe ohne Recht ab“ |
| Abgelaufene und widerrufene Links werden abgewiesen | ✅ | Schritte 7, 18, 27–29, Integrationstests |
| Genau ein Beitrag auf der Testwebsite, LifeLink zeigt die bestätigte URL | ✅ | Schritte 22–24 |
| Teststand außerhalb des Volumes gesichert und in frischer Instanz wiederhergestellt | ✅ | Schritte 32–34 |

## Offene Prüfungen

| Thema | Was fehlt | Wo |
|---|---|---|
| WordPress produktionsnah | Bridge auf der echten Testwebsite über HTTPS mit der produktiven LifeLink-Adresse; WP-Cron ohne Host-Cron; Seitencache | #13, #21, `docs/integrationen.md` |
| Echte Geräte | Upload-Link und gedruckter QR-Code mit echtem Android- und iOS-Gerät (bisher emuliert bzw. PDF geprüft); Banner mit echten Cache-Plugins (WP Super Cache, LiteSpeed) | #18 |
| Reverse Proxy | Betrieb hinter HTTPS-Proxy mit `TRUST_PROXY=true` und großen Uploads | #8 |
| Große Videos | Upload und Verarbeitung großer Videos, Verbindungsabbruch (fortsetzbarer Upload folgt in M2) | #16 |
| PostgreSQL-Hauptversion | dokumentierter Weg (`pg_dumpall`/Import) noch nicht mit echtem Versionswechsel getestet | #37 |
| Fehlgeschlagene Migration | Wiederherstellung nach absichtlich fehlerhafter Migration | #37 |
| LiFeOS | Quellcode liegt nicht vor; Abgleich Sicherheit/Updates und Import offen | #1, #35 |

## Testumgebung dieser Sitzung

- Docker 29 ohne direkten Internetzugang im Build: Image mit `--network host`, Proxy-Build-Argument und
  `--secret id=build_ca` gebaut (siehe `docs/entwicklung.md`). Debian-/PGDG-Paketquellen waren gesperrt, daher das
  Image-Konzept ohne `apt` (Architekturentscheidung E3).
- Server-Tests lokal gegen PostgreSQL 16; im Container läuft PostgreSQL 18.

## Meilenstein 2 (14.11.2026)

| Prüfung | Ergebnis |
|---|---|
| Server-Tests | ✅ 42/42 (u. a. Chunk-Upload mit Abbruch, ZIP-Export, Kanaltexte, Termin, Zurückziehen, Banner, RSS mit ETag, SSE, Dashboard-Vorlagen) |
| Abnahmetest M1 nach den Änderungen | ✅ 34/34 |
| **Abnahmetest M2** (`node test/e2e/m2-flow.mjs`) | ✅ **13/13** |

| Abnahmekriterium M2 | Nachweis |
|---|---|
| Unterbrochene Uploads | 21-MB-Video im Browser (Pixel 7), Abbruch im 2. Teil, automatisch fortgesetzt, genau 1 Datei, Prüfsumme gleich; öffentliche Fassung ohne Standort |
| Gedruckte QR-Codes | A4-PDF erzeugt; **Scan mit echten Android-/iOS-Geräten offen** |
| Banner mit Cache und getrennter Verbindung | Banner live → LifeLink gestoppt → Banner läuft auf der Website trotzdem ab; zwischengespeichertes HTML blendet es per Skript aus; nach Wiederverbindung fehlerfreier Abgleich |
| RSS-Import | Vorschau, Import, Themenidee mit Quelle, erneuter Abruf ohne Duplikate (WordPress-Feed als Quelle, interner Host ausdrücklich freigegeben) |
| Dashboard nach Wiederverbindung | Browser offline → „Unterbrochen“ → Einreichung während der Unterbrechung → nach Wiederverbindung sichtbar, „Live“ wieder aktiv; mobile Reihenfolge geprüft |

## Meilenstein 3 (14.11.2026)

| Prüfung | Ergebnis |
|---|---|
| Server-Tests | ✅ 54/54 (davon 12 für Warnentwürfe und Warnstufen-Assistent) |
| **Abnahmetest M3** (`node test/e2e/m3-flow.mjs`) | ✅ **9/9** – Handy (Pixel 7) für den Wizard, Desktop für die Pflege |

Versand ausschließlich an einen **lokalen Test-Mailserver** im Testskript; keine Mail an operative Empfänger.
Alle Stichwörter, Fragen, Regeln und Lagen sind fiktiv.

| Abnahmekriterium | Nachweis |
|---|---|
| Wizard am Handy (Erstmeldung, Aktualisierung, Entwarnung; speichern und fortsetzen) | Stichwort per Alias gesucht, Lage beantwortet, Felder ausgefüllt; jeder Schrittwechsel speichert eine Fassung |
| Ausgeliefert ohne aktive Regeln | `warning_rules` nach Erstinstallation leer; Stichwort ohne Regel → „Keine eindeutige Empfehlung – fachlich prüfen“ |
| Dasselbe Stichwort, zwei Lagebilder | Rauch ohne Evakuierung → Stufe 3; Evakuierung → Stufe 2, jeweils mit Begründung und Regelversion |
| Unbekanntes Stichwort, fehlende Angaben, widersprüchliche Regeln | jeweils kein Vorschlag mit Grund; „unbekannt“ zählt als fehlend; Regel auf nicht freigegebene Frage trifft nie zu |
| Manuelle Änderung | Abweichung ohne Begründung abgelehnt (API und Oberfläche); mit Begründung gespeichert inkl. Vorschlag, Regelversion, Person, Zeit |
| Geänderte Lage | neue Antworten → Bestätigung verfällt; reine Textänderung behält sie |
| Aktualisierung | zeigt bisherige Stufe, Stufe muss neu bestätigt werden |
| Entwarnung | eigener Vorgang ohne Stufe, PDF mit „ENTWARNUNG“, keine Stufe 3 |
| Bestätigte Stufe im richtigen PDF | Freigabe erzeugt PDF mit SHA-256; Text „Warnstufe 2 … (bestätigt)“ und Vorgangs-ID per `pdftotext` geprüft; Entwurfs-PDF trägt „ENTWURF“ |
| Vorschlag allein löst nichts aus | nach Vorschlag weder Versandauftrag noch Mail noch Veröffentlichung |
| Getrennte Rechte | Entwurf kann Stufe nicht bestätigen (403), nicht versenden (403); Regel-/Fragenfreigabe durch die anlegende Person abgelehnt |
| Testmodus | Mail nur an das Testpostfach, Betreff `[TEST]`, vorgesehene Empfänger nur im Text, PDF-Prüfsumme im Mailkopf |
| Versandfehler | 550-Ablehnung → „fehlgeschlagen“, erneuter Versand möglich und angenommen |
| Unbekannter Zustellstatus | Abbruch nach DATA → „unbekannt – prüfen“; Neuversand gesperrt (409), erst nach Prüfung „nicht angekommen“ wieder möglich |
| Vorlagenänderung | neue Vorlagenversion; Entwurfs-PDF eines bestehenden Vorgangs byte-gleich, neuer Vorgang nutzt die neue Version |

**Befund und Korrektur während der Abnahme:** Nodemailer meldet einen Socket-Timeout nach DATA mit `command: CONN`. Die
Einordnung ist deshalb konservativ: Nur eindeutige Fehler (Serverantwort, Verbindungsaufbau, Anmeldung) gelten als
„fehlgeschlagen“, jeder Abbruch einer bestehenden Verbindung als „unbekannt“. Außerdem überlappten im PDF
Metadatenkasten und Warnstufen-Balken; das Layout arbeitet jetzt mit gemessenen Zeilenhöhen.

**Offen (#30):** Abstimmung von Feldsatz, PDF-Aufbau, Empfängern und Rückmeldeweg mit der zuständigen Stelle; Versand über
den echten Mailserver an ein abgestimmtes Testpostfach.

## Meilenstein 4 (14.11.2026)

| Prüfung | Ergebnis |
|---|---|
| Server-Tests | ✅ 72/72 (davon 18 für M4: Verbindungsrahmen, FE2, Facebook, Instagram, OAuth, Export, Warnfeeds, Bridge-Updates, Wartungsmodus, Migrationen, Import, Sicherheit) |
| **Abnahmetest M4** (`node test/e2e/m4-flow.mjs`) | ✅ **7/7** |

Alle Verbindungen gegen lokale Ersatzdienste (Graph-API-Ersatz, CAP-Testquelle, FE2-Testmeldungen per HTTP) bzw. die
lokale WordPress-Testseite. Keine echten Veröffentlichungen, keine Daten an Anbieter.

| Abnahmekriterium | Nachweis |
|---|---|
| Restore auf frischem Volume mit realistischen Mengen | 90 Fotos (2400 × 1600) + 3 Full-HD-Videos, 197 MB Upload; Sicherungsarchiv 403 MB; `docker compose down -v` → Wiederherstellung → gesund |
| Benutzer, Rechte, Medien, Freigaben, geplante Aufträge nach Restore | Mengen identisch, Anmeldung inkl. Zwei-Faktor, Redaktion weiterhin ohne Freigaberecht (403), Originale byte-gleich (SHA-256-Stichprobe), geplanter Auftrag weiterhin in der Warteschlange |
| Wiederherstellung nach fehlgeschlagener Migration | Image mit fehlerhafter Migration → Start gesperrt (Sperrseite und `/healthz` nennen die Migration) → `scripts/update.sh --rollback` stellt altes Image und Sicherung wieder her, Datenstand identisch, keine halbe Migration |
| Rückkehr nach inkompatibler Migration | Nach erfolgreichem Update startet das alte Image nicht („Datenstand neuer als dieses Programm“); Rückweg über die Sicherung von vor dem Update |
| PostgreSQL-Hauptversionswechsel | Datenbestand in PostgreSQL 16 → dokumentierter Export/Import → Image mit PostgreSQL 18: Mengen identisch, gesund |
| Bridge-Updates über WordPress | 0.3.9 → 0.4.0 per `wp plugin update` erst im Test-Kanal angeboten, Prüfsumme geprüft, Kopplung erhalten; Freigabe für alle erst nach Rückmeldung der Testwebsite |
| FE2 | Testmeldung nur als Vorschau, nach Aktivierung genau ein Entwurf je Einsatz, Wiederholung erkannt, Alarmtext verworfen, Container-Protokolle ohne Inhalte |
| Testmatrix je Verbindung | siehe [integrationen.md](integrationen.md) |

**Befunde während der Abnahme und Prüfung (behoben):**
- Videos: öffentliche Fassung übernahm alle Spuren inkl. möglicher GPS-Datenspuren → nur Bild und Ton; Länge/Auflösung begrenzt.
- OAuth-Rückweg von Meta kam ohne Sitzungs-Cookie an (`SameSite=Strict`) → einmaliger `state`.
- Update-Paket der Bridge: Adresse aus Sicht der Website (gekoppelte Adresse) statt öffentlicher Adresse; eigener Download statt `download_url()` (lässt nur Standardports zu).
- Wartungsbefehle per `docker compose exec … cli.js` fanden die interne Datenbank nicht.
- Erneutes „Veröffentlichen“ nach Fehlschlag legte einen zweiten Auftrag für denselben Kanal an → nur gezieltes Wiederholen.
- Leere Banner-Liste im Wartungsmodus hätte Banner auf Websites entfernt → Antwort ohne Banner-Liste.

**Offen (extern):** Tests mit echten Anbieterkonten (Meta, FE2, Warn-App-Schnittstelle, Mailserver), produktionsnahe
WordPress-Website, LiFeOS-Exportformat, Lizenz, externer Penetrationstest, Lasttest auf Zielhardware.
