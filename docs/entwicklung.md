# Entwicklung

## Voraussetzungen

- Node.js ≥ 24 (Image: 26), npm
- PostgreSQL ≥ 16 für Entwicklung und Tests (im Image: 18)
- ffmpeg/ffprobe für Videoprüfung (im Betrieb optional – ohne werden Videos abgewiesen; für die Tests nötig)
- pdftotext (poppler-utils) für die PDF-Tests
- Docker für Image-Build, Abnahmetest und WordPress-Testsystem
- Playwright mit Chromium für den Abnahmetest

## Lokal starten (Hot Reload)

```bash
npm install
createdb blaulichtcms_dev        # oder per psql
cat > .env <<'ENV'
DATABASE_URL=postgresql://blaulichtcms:blaulichtcms@127.0.0.1:5432/blaulichtcms_dev
BLAULICHTCMS_MASTER_KEY=<node server/dist/cli.js gen-master-key bzw. openssl rand -base64 32>
COOKIE_SECURE=false
ENV
npm run dev:server   # API        → http://127.0.0.1:7310
npm run dev:worker   # Worker     (Medienprüfung, Wartung)
npm run dev:web      # Oberfläche → http://localhost:5173 (leitet /api an die API weiter)
```

Ohne `BLAULICHTCMS_EMBEDDED_DB` nutzt BlaulichtCMS die Datenbank aus `DATABASE_URL`. Der eingebettete Betrieb (Supervisor
startet PostgreSQL) ist für den Container gedacht, funktioniert aber auch lokal:
`BLAULICHTCMS_EMBEDDED_DB=true BLAULICHTCMS_PG_BIN=/usr/lib/postgresql/16/bin node server/dist/main.js`.

## Tests

| Ebene | Befehl | Inhalt |
|---|---|---|
| Typprüfung | `npm run typecheck` | Server und Oberfläche |
| Unit + Integration | `TEST_DATABASE_URL=… npm test` | 90 Tests: Rechte, Krypto, SSRF, Fassungen, Upload, Warnentwürfe, Verbindungen, Import, Sicherheit – braucht ffmpeg und pdftotext |
| Fokus-Test | `node test/e2e/focus-check.mjs` | Tippen in alle Textfelder und Dialoge ohne Fokusverlust (laufende Instanz nötig) |
| Dashboard anpassen | `node test/e2e/dashboard-dnd.mjs` | Verschieben mit Maus, Finger (Touch-Emulation) und Tastatur, Abbrechen, Speichern, Vorlagen (Instanz mit den Testdaten des Fokus-Tests nötig) |
| Abnahme M1 | `node test/e2e/m1-flow.mjs` | 34 Schritte über Container, Browser (Desktop + Handy) und WordPress inkl. Sicherung/Wiederherstellung |

> [!WARNING]
> Die Test-Datenbank wird bei jedem Lauf vollständig geleert. Nie auf eine echte Datenbank zeigen lassen.

Eine Test-Datenbank ohne Installation, z. B. mit Docker:

```bash
docker run -d --name bc-testdb -p 5442:5432 -e POSTGRES_USER=blaulichtcms -e POSTGRES_PASSWORD=blaulichtcms -e POSTGRES_DB=blaulichtcms_test postgres:18
TEST_DATABASE_URL=postgresql://blaulichtcms:blaulichtcms@127.0.0.1:5442/blaulichtcms_test npm test
```

`TEST_DATABASE_URL` muss ein Superuser sein: Die Tests richten wie der Container die Datenbankrollen `blaulichtcms_owner`
und `blaulichtcms_app` ein (`BLAULICHTCMS_DB_ROLES=true` in `server/test/setup.ts`) und prüfen deren Rechte. Die Rollen gelten
für den ganzen Cluster – deshalb nur einen Wegwerf-Cluster verwenden.

## Abnahmetest M1

```bash
docker compose build                       # Image blaulichtcms:local
node test/e2e/m1-flow.mjs                  # Ergebnis: test/e2e/out/report.json
DOC_SHOTS=1 node test/e2e/m1-flow.mjs      # zusätzlich Screenshots für die Doku (2-fache Pixeldichte)
```

Der Test setzt **beide Volumes zurück** (`docker compose down -v`) – nicht auf einer Instanz mit echten Daten ausführen.
WordPress läuft dabei separat über `test/wordpress/compose.yaml` (Port 8080) und erreicht BlaulichtCMS über
`host.docker.internal:7310`.

## Fokus-Test der Textfelder

`test/e2e/focus-check.mjs` besucht alle Seiten, öffnet die über Schaltflächen und Menüs erreichbaren Dialoge und tippt
in jedes sichtbare Textfeld. Danach muss der Fokus noch im Feld liegen und der Text vollständig angekommen sein –
auch während Live-Ereignisse eintreffen und alle Abfragen neu geladen werden (Regressionstest für 0.2.1).

Der Test braucht eine **frische, laufende Instanz** (Ersteinrichtung offen; er legt Testdaten an), z. B. lokal ohne
Docker mit Wegwerf-Datenbank (`npm run build`, dann `node --env-file=… server/dist/api.js` und `… worker.js`):

```bash
BLAULICHTCMS_URL=http://localhost:7310 SETUP_TOKEN_FILE=<Datenverzeichnis>/setup-token.txt node test/e2e/focus-check.mjs
```

`SETUP_TOKEN=…` statt der Datei geht auch. `FOCUS_ONLY=<RegExp>` beschränkt auf passende Seiten, `FOCUS_REUSE=1`
wiederholt den Test gegen dieselbe Instanz mit den Testdaten des letzten Laufs (`test/e2e/out/focus-state.json`),
`FOCUS_DEBUG=1` protokolliert jeden Klick, `CHROMIUM_PATH` wählt ein vorhandenes Chromium. Ergebnis: `test/e2e/out/focus-report.json`, Exit-Code 1 bei Fehlern.

## Dashboard anpassen (Drag-and-drop)

`test/e2e/dashboard-dnd.mjs` läuft gegen dieselbe Instanz **nach** dem Fokus-Test (er meldet sich mit dessen Testdaten
aus `test/e2e/out/focus-state.json` an). Er verschiebt Kacheln, Kennzahlen und Spalten mit der Maus, mit echten
Touch-Ereignissen (Tablet und Handy) und mit der Tastatur, prüft „Abbrechen“ (exakt der alte Stand), Escape,
Spaltenbreite, Hinzufügen/Löschen von Spalten, Speichern in einem Aufruf, Vorlagen und dass nichts waagerecht überläuft.

```bash
BLAULICHTCMS_URL=http://localhost:7310 node test/e2e/dashboard-dnd.mjs
DND_SHOTS=/pfad/fuer/bilder BLAULICHTCMS_URL=… node test/e2e/dashboard-dnd.mjs   # zusätzlich Bildschirmfotos (hell, dunkel, Handy)
```

## Image hinter einem TLS-Proxy bauen

```bash
docker build --secret id=build_ca,src=/pfad/proxy-ca.pem --build-arg HTTPS_PROXY=http://proxy:3128 --network host -t blaulichtcms:local .
```

## Konventionen

- Texte in der Oberfläche auf Deutsch, neutral formuliert, ohne organisationsspezifische Namen.
- Neue Rechte in `server/src/auth/permissions.ts` registrieren; jede Route prüft serverseitig.
- Migrationen additiv; eine neue Datei je Änderung (`server/migrations/NNN_name.sql`).
- Audit-Einträge ohne Tokens oder vertrauliche Inhalte.
