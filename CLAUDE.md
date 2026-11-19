# BlaulichtCMS – Hinweise für die Arbeit am Repo

CMS für Öffentlichkeitsarbeit und Krisenkommunikation (Foto-Links, Sichtung, Beiträge mit Fassungen und Freigabe,
WordPress über die BlaulichtCMS Bridge, Warnentwurf, Verbindungen).

## Orientierung

Funktionsübersicht: `README.md`; Installation und Betrieb: `docs/installation.md`; Aufbau, Teststand und Grenzen: `docs/technik.md`. Architekturentscheidungen: `docs/architektur.md`. Design-Regeln:
`docs/design-leitstand.md` (verbindlich). Offene Aufgaben stehen als GitHub-Issues, nicht in Dateien.

## Betrieb

Installation und Update am Docker-Host mit einem Skript: `sudo bash install.sh` (Ziel `/opt/apps/blaulichtcms`). Compose:
externes Netz `proxy-net` (Nginx Proxy Manager → `blaulichtcms:7310`), Port nur `127.0.0.1`,
Log-Rotation, Limits. Bei Änderungen an Compose/Skripten den Ablauf von `install.sh` mitdenken (Trockentest mit Docker-Stellvertreter möglich).

## Arbeitsweise

- Änderungen direkt auf `main`; GitHub-Issues nach Abschluss kommentieren und schließen.
- Die CI auf GitHub führt alle Server-Tests aus. Lokal nicht ungefragt die gesamte Suite starten; gezielt
  `npx vitest run test/units.test.ts` (Integrationstests bauen aufeinander auf und laufen nur als ganze Datei).
- Texte der Oberfläche deutsch, neutral, ohne organisationsspezifische Namen. Farben nur über Tokens.
- WordPress-Plugin ändern ⇒ Version in `blaulichtcms-bridge.php` (Kopf + Konstante), `readme.txt` (Stable tag,
  Changelog), `server/test/integration.test.ts`, `test/e2e/m4-flow.mjs` und README-Badge mitziehen, dann neu
  signieren (`node scripts/bridge-signing.mjs sign C:/Users/thisi/Documents/VScode/BlaulichtCMS-bridge-signing.pem`,
  dann `node scripts/bridge-signing.mjs verify`, siehe `docs/bridge-signatur.md`) – sonst scheitert die CI. Der private Schlüssel gehört nie ins Repository.
- Migrationen additiv, eine neue Datei je Änderung (`server/migrations/NNN_name.sql`).
- **Vor jedem Release die README aktualisieren** (verbindlich). Die README ist bewusst knapp und hat genau diese
  Abschnitte: Projektumfang, Idee, Schnittstellen, Workflows, Technische Umsetzung. Neue Module, Schnittstellen oder
  Workflow-Bausteine dort ergänzen (Tabelle bzw. Liste) und die Grafiken in `docs/grafik/` mitziehen: Inhalte stehen
  oben in `scripts/readme-grafiken.mjs`, danach `node scripts/readme-grafiken.mjs` (erzeugt hell + dunkel). Dazu
  Versions-Badge und Hinweis, Zahlen (Rechte aus `server/src/auth/permissions.ts`, Hilfe-Kapitel unter
  `web/src/pages/help/content/`), Screenshots in `docs/bilder/` neu aufnehmen, wenn sich die Oberfläche sichtbar
  geändert hat (Testinstanz mit fiktiven Daten, keine echten Namen, keine Schlüssel/Codes im Bild, heller Modus, WebP).
  Sicherheit und Datenschutz in der README nur als Aussage („DSGVO-konform und nach BSI IT-Grundschutz geprüft“),
  keine Einzelheiten – die stehen in `docs/`.

## Lokal ohne Docker (Windows)

- PostgreSQL 18 als Wegwerf-Cluster, z. B. Port 5442 (Testdatenbank mit `createdb -E UTF8 -T template0`, sonst
  scheitert Migration 009 unter WIN1252); `.env` mit `DATABASE_URL`, `BLAULICHTCMS_MASTER_KEY`,
  `COOKIE_SECURE=false`, `BLAULICHTCMS_DATA_DIR` außerhalb des Repos.
- `npm run dev:server`, `npm run dev:worker`, `npm run dev:web` (Oberfläche auf http://localhost:5173).
- Git Bash: Argumente mit führendem `/` werden umgeschrieben – `MSYS_NO_PATHCONV=1` setzen.
- Kontosperre nach Fehlversuchen greift auch bei wiederverwendeten TOTP-Codes (Sitzung wiederverwenden).
- WordPress-Test ohne Docker: PHP (scoop) + WordPress + SQLite-Plugin + WP-CLI, `php -S` mit Router; Ablauf und
  Ergebnis in `docs/integrationen.md`.
