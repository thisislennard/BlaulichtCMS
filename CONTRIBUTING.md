# Mitarbeit an BlaulichtCMS

Danke für das Interesse! Fehlerberichte, Verbesserungsvorschläge und Pull Requests sind willkommen.

## Fehler und Wünsche

- **Fehler** als Issue mit Version (`VERSION` bzw. *Verwaltung → Systemstatus*), Schritten zum Nachstellen und
  erwartetem Verhalten. Keine echten personenbezogenen Daten, Tokens oder Schlüssel in Issues, Logs oder Screenshots.
- **Sicherheitslücken nicht als Issue**, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.

## Entwicklung

Einrichtung, auch ohne Docker unter Windows: [docs/entwicklung.md](docs/entwicklung.md). Kurzfassung:

```bash
npm ci
npm run typecheck
cd server && npx vitest run test/units.test.ts
# Integrationstests gegen eine Wegwerf-Datenbank (UTF8), laufen nur als ganze Datei:
TEST_DATABASE_URL=postgresql://blaulichtcms@127.0.0.1:5442/blaulichtcms_test npx vitest run test/integration.test.ts
```

Die CI führt alle Tests (inklusive ffmpeg), den Build, einen Probelauf mit Docker Compose und Sicherheitsscans aus.

## Regeln für Änderungen

- **Texte** der Oberfläche auf Deutsch, neutral und ohne organisationsspezifische Namen. Farben nur über die
  Design-Tokens ([docs/design-leitstand.md](docs/design-leitstand.md)).
- **Datenbank:** Migrationen nur additiv, eine neue Datei je Änderung (`server/migrations/NNN_name.sql`). Neue Tabellen
  bekommen ihre Rechte für die Anwendungsrolle automatisch ([docs/betrieb.md](docs/betrieb.md), Datenbankrollen).
- **Rechte** werden serverseitig geprüft; neue Routen brauchen eine passende Berechtigung und einen Test.
- **WordPress-Plugin:** Version an allen Stellen erhöhen (Kopf und Konstante in `blaulichtcms-bridge.php`, `readme.txt`,
  Tests). Signiert wird das Plugin von den Betreuern ([docs/bridge-signatur.md](docs/bridge-signatur.md)); bis dahin
  meldet die CI bei einem Pull Request mit Plugin-Änderungen eine fehlende Signatur – das ist erwartet.
- **Doku und Hilfe** (`docs/`, `web/src/pages/help/content/`) anpassen, wenn sich Verhalten ändert.
- Abhängigkeiten auf aktuellem Stand halten; Base-Images und GitHub Actions bleiben per Digest bzw. Commit-SHA fixiert.

## Lizenz

Mit einem Beitrag stimmst du zu, dass er unter der Lizenz des Projekts steht: GPL-3.0-or-later, für das
WordPress-Plugin GPL-2.0-or-later.
