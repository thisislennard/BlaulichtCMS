# Entwicklung

## Voraussetzungen

- Node.js ≥ 24 (Image: 26), npm
- PostgreSQL ≥ 16 für Entwicklung und Tests (im Image: 18)
- ffmpeg/ffprobe für Videoprüfung (im Betrieb optional – ohne werden Videos abgewiesen; für die Tests nötig)
- pdftotext (poppler-utils) für die PDF-Tests
- Docker für Image-Build, Abnahmetest und WordPress-Testsystem
- Playwright mit Chromium für die Browsertests: eigener Lock in `test/e2e` (feste Version, nicht Teil des Images) –
  `npm ci --prefix test/e2e`, dann `cd test/e2e && npx playwright install chromium`
- Unter **Linux x64** vor `npm ci` `export ONNXRUNTIME_NODE_INSTALL=skip` setzen: sonst lädt das Installationsskript von
  `onnxruntime-node` (Gesichtsvorschläge, #214) zusätzlich CUDA-Bibliotheken von NuGet. Gebraucht wird nur die
  mitgelieferte CPU-Fassung (Windows, macOS und Linux arm64 laden ohnehin nichts nach).

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
| Unit + Integration | `TEST_DATABASE_URL=… npm test` | rund 600 Tests: Rechte, Krypto, SSRF, Fassungen, Upload, Warnentwürfe, Verbindungen, Workflows, Kalender, Presse, Einsatzliste, Import, Sicherheit – braucht ffmpeg und pdftotext |
| Kernabläufe | `node test/e2e/core-flows.mjs` | Ersteinrichtung mit Zwei-Faktor, Anmeldung mit Code, Beitrag anlegen → einreichen → freigeben (Vier-Augen), Workflow aus Vorlage anlegen und testen (frische Instanz nötig; läuft in der CI) |
| Fokus-Test | `node test/e2e/focus-check.mjs` | Tippen in alle Textfelder und Dialoge ohne Fokusverlust (laufende Instanz nötig) |
| Dashboard anpassen | `node test/e2e/dashboard-dnd.mjs` | Verschieben mit Maus, Finger (Touch-Emulation) und Tastatur, Abbrechen, Speichern, Vorlagen (Instanz mit den Testdaten des Fokus-Tests nötig) |
| Sichtung (Layout) | `node test/e2e/review-layout.mjs` | „Überspringen / Zurückstellen / Auswählen“ ohne Scrollen sichtbar bei 1366 × 768, 1440 × 900 und 390 × 844 für Quer-, Hochformat und Video; Tastatur und Wischen (nach dem Fokus-Test auf derselben Instanz; `REVIEW_SHOTS=<Ordner>` für Bildschirmfotos) |
| Rollen-Kurztest | `node test/e2e/roles-smoke.mjs` | Eingeschränkte eigene Rolle im Browser: nur erlaubte Navigation und Schaltflächen, „Kein Zugriff“, keine abgelehnten Anfragen (nach dem Fokus-Test auf derselben Instanz) |
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

## Browsertests in der CI

Der Job `browser` in `.github/workflows/ci.yml` läuft bei jedem Push und Pull Request parallel zu den Server-Tests
(Ziel unter 10 Minuten, harte Grenze 20). Er baut Server und Oberfläche, installiert Playwright samt Chromium in der
Version aus `test/e2e/package-lock.json` und startet gegen einen PostgreSQL-18-Dienst **zwei frische Instanzen**
(API + Worker mit gebauter Oberfläche, je eigene Datenbank und eigenes Datenverzeichnis):

| Instanz | Port | Tests |
|---|---|---|
| Kernabläufe | 7310 | `core-flows.mjs` (Einrichtung über die Einrichtungsseite – braucht eine eigene, noch nicht eingerichtete Instanz) |
| Fokus | 7311 | `focus-check.mjs` mit `FOCUS_ONLY` auf wichtige Ansichten (Einrichtung, Anmeldung mit Zwei-Faktor, Dashboard, Beiträge samt Editor, Freigaben, Medien, Workflows samt Editor; etwa 2 Minuten), danach `roles-smoke.mjs`, `dashboard-dnd.mjs` und `review-layout.mjs` mit dessen Testdaten |

Schlägt ein Schritt fehl, laufen die übrigen trotzdem; der Job lädt dann `test/e2e/out/` als Artefakt
`browsertests` hoch (Berichte als JSON, Bildschirmfotos und Playwright-Traces der Kernabläufe, Protokolle von API und
Worker). Einen Trace ansehen: `cd test/e2e && npx playwright show-trace out/core-<schritt>.zip`.

Lokal genauso (Git Bash unter Windows mit `MSYS_NO_PATHCONV=1`):

```bash
npm run build && npm ci --prefix test/e2e && (cd test/e2e && npx playwright install chromium)
node --env-file=<env-datei> server/dist/api.js &      # frische Datenbank, eigenes BLAULICHTCMS_DATA_DIR
node --env-file=<env-datei> server/dist/worker.js &
BLAULICHTCMS_URL=http://localhost:7310 SETUP_TOKEN_FILE=<Datenverzeichnis>/setup-token.txt node test/e2e/core-flows.mjs
```

Neue Kernabläufe gehören in `core-flows.mjs` (je Ablauf ein `run('…')`-Schritt, Auswahl über Rollen und
Beschriftungen wie ein Mensch, keine CSS-Klassen). Der vollständige Fokus-Check über alle Ansichten bleibt lokal (er gibt je Ansicht die Dauer aus – Sammlungen, Einstellungen
und Profil brauchen einzeln mehrere Minuten und sind deshalb nicht in der CI-Auswahl).

## Versionsprüfung und bekannte Schwachstellen

Statt Pull Requests von Dependabot prüft der Workflow „Versionsprüfung“ (`.github/workflows/versions.yml`) jeden
Montag und auf Knopfdruck (*Actions → Versionsprüfung → Run workflow*) alle festgelegten Versionen mit
`scripts/check-versions.mjs`:

- npm-Pakete von Wurzel, Server und Oberfläche (Version aus `package-lock.json`, auch Hauptversionen) und der
  Browsertests (`test/e2e`, Playwright – Chromium kommt fest mit der Playwright-Version)
- Node.js (`node-version` der Workflows; die Hauptversion muss zum Node-Image im `Dockerfile` passen)
- Container-Images aus `Dockerfile`, `compose.yaml`, `test/wordpress/compose.yaml` und den Workflows – neuer Tag
  derselben Variante oder neuer Digest desselben Tags; darüber auch die PostgreSQL-Hauptversion
- GitHub Actions: neue Version samt Commit-SHA, Warnung, wenn die gepinnte SHA nicht zum Tag im Kommentar passt

Gibt es Neues, öffnet bzw. aktualisiert der Lauf genau **ein** Issue „Neue Versionen verfügbar“ (Label `claude`) mit
einer Tabelle *festgelegt → neu*; ist alles aktuell, schließt er es. Branches oder Pull Requests entstehen nicht.
Lokal: `node scripts/check-versions.mjs` (mit `GITHUB_TOKEN` gegen das Abfragelimit der GitHub-API).

Bekannte Schwachstellen melden die Dependabot-Warnungen des Repositorys (*Settings → Advanced Security*: „Dependabot
alerts“ an, „Dependabot security updates“ aus – also ohne Pull Requests) und der Workflow „Sicherheitsprüfung“
(`npm audit` für Laufzeit, Entwicklung und Browsertests, Trivy-Imagescan, Secret-Scan; bei jedem Push und wöchentlich).

## Image hinter einem TLS-Proxy bauen

```bash
docker build --secret id=build_ca,src=/pfad/proxy-ca.pem --build-arg HTTPS_PROXY=http://proxy:3128 --network host -t blaulichtcms:local .
```

## Konventionen

- Texte in der Oberfläche auf Deutsch, neutral formuliert, ohne organisationsspezifische Namen.
- Neue Rechte in `server/src/auth/permissions.ts` registrieren (Bereich, Stufe, Beschreibung, Voraussetzungen) und
  danach `node scripts/rechte-tabelle.mjs` ausführen (Tabelle in der Hilfe). Jede Route unter `/api/v1` nennt genau
  ein Recht per `requireAuth('…')` – oder `requireAnyAuth(…)`, wenn der Handler je Aktion prüft – oder steht in
  `PUBLIC_ROUTES` (`server/src/auth/route-access.ts`); sonst scheitert `server/test/roles.test.ts`.
- In der Oberfläche jede Schaltfläche, jeden Reiter und jede Abfrage mit `can('…')` an das Recht der Route binden:
  Was man nicht darf, wird nicht angezeigt. `test/e2e/roles-smoke.mjs` prüft das mit einer eingeschränkten Rolle.
- Migrationen additiv; eine neue Datei je Änderung (`server/migrations/NNN_name.sql`).
- Audit-Einträge ohne Tokens oder vertrauliche Inhalte.
