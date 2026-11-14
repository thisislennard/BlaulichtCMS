# Entwicklung

## Voraussetzungen

- Node.js ≥ 24 (Image: 26), npm
- PostgreSQL ≥ 16 für Entwicklung und Tests (im Image: 18)
- ffmpeg/ffprobe für Videoprüfung (optional; ohne werden Videos abgewiesen)
- Docker für Image-Build, Abnahmetest und WordPress-Testsystem
- Playwright mit Chromium für den Abnahmetest

## Lokal starten (Hot Reload)

```bash
npm install
createdb lifelink_dev        # oder per psql
cat > .env <<'ENV'
DATABASE_URL=postgresql://lifelink:lifelink@127.0.0.1:5432/lifelink_dev
LIFELINK_MASTER_KEY=<node server/dist/cli.js gen-master-key bzw. openssl rand -base64 32>
COOKIE_SECURE=false
ENV
npm run dev:server   # API        → http://127.0.0.1:7310
npm run dev:worker   # Worker     (Medienprüfung, Wartung)
npm run dev:web      # Oberfläche → http://localhost:5173 (leitet /api an die API weiter)
```

Ohne `LIFELINK_EMBEDDED_DB` nutzt LifeLink die Datenbank aus `DATABASE_URL`. Der eingebettete Betrieb (Supervisor
startet PostgreSQL) ist für den Container gedacht, funktioniert aber auch lokal:
`LIFELINK_EMBEDDED_DB=true LIFELINK_PG_BIN=/usr/lib/postgresql/16/bin node server/dist/main.js`.

## Tests

| Ebene | Befehl | Inhalt |
|---|---|---|
| Typprüfung | `npm run typecheck` | Server und Oberfläche |
| Unit + Integration | `TEST_DATABASE_URL=… npm test` | 30 Tests: Rechte, Krypto, SSRF, Fassungs-Prüfsumme, kompletter M1-Ablauf über die API inkl. Fehlerfällen |
| Abnahme M1 | `node test/e2e/m1-flow.mjs` | 34 Schritte über Container, Browser (Desktop + Handy) und WordPress inkl. Sicherung/Wiederherstellung |

> [!WARNING]
> Die Test-Datenbank wird bei jedem Lauf vollständig geleert. Nie auf eine echte Datenbank zeigen lassen.

Eine Test-Datenbank ohne Installation, z. B. mit Docker:

```bash
docker run -d --name ll-testdb -p 5442:5432 -e POSTGRES_USER=lifelink -e POSTGRES_PASSWORD=lifelink -e POSTGRES_DB=lifelink_test postgres:18
TEST_DATABASE_URL=postgresql://lifelink:lifelink@127.0.0.1:5442/lifelink_test npm test
```

## Abnahmetest M1

```bash
docker compose build                       # Image lifelink:local
node test/e2e/m1-flow.mjs                  # Ergebnis: test/e2e/out/report.json
DOC_SHOTS=1 node test/e2e/m1-flow.mjs      # zusätzlich Screenshots für die Doku (2-fache Pixeldichte)
```

Der Test setzt **beide Volumes zurück** (`docker compose down -v`) – nicht auf einer Instanz mit echten Daten ausführen.
WordPress läuft dabei separat über `test/wordpress/compose.yaml` (Port 8080) und erreicht LifeLink über
`host.docker.internal:7310`.

## Image hinter einem TLS-Proxy bauen

```bash
docker build --secret id=build_ca,src=/pfad/proxy-ca.pem --build-arg HTTPS_PROXY=http://proxy:3128 --network host -t lifelink:local .
```

## Konventionen

- Texte in der Oberfläche auf Deutsch, neutral formuliert, ohne organisationsspezifische Namen.
- Neue Rechte in `server/src/auth/permissions.ts` registrieren; jede Route prüft serverseitig.
- Migrationen additiv; eine neue Datei je Änderung (`server/migrations/NNN_name.sql`).
- Audit-Einträge ohne Tokens oder vertrauliche Inhalte.
