# Betrieb von LifeLink 2

## Bestandteile

| Container | Aufgabe |
|---|---|
| `lifelink` | Supervisor (PID 1 über tini) startet **API** (Port 7310) und **Worker** (Ausführung, Zeitpläne, MQTT, IMAP/iCal-Abfragen, Wartung, Sicherungen, Update-Prüfung). Abgestürzte Prozesse werden neu gestartet. |
| `lifelink-db` | PostgreSQL 18. Enthält Konfiguration, Workflows, Läufe, Warteschlange und Audit. |

Volumes: `lifelink-data` (`/data`: installierte Updates, Sicherungen, Einrichtungsschlüssel) und `lifelink-pg`.
Der Container läuft als Benutzer `node`, mit schreibgeschütztem Dateisystem (außer `/data` und `/tmp`),
ohne Capabilities und mit `no-new-privileges`.

## Umgebungsvariablen (.env)

| Variable | Bedeutung |
|---|---|
| `POSTGRES_PASSWORD` | Datenbankpasswort (Pflicht) |
| `LIFELINK_MASTER_KEY` | 32 Byte Base64, verschlüsselt Zugangsdaten, 2FA-Geheimnisse und Sicherungen (Pflicht). **Getrennt aufbewahren.** |
| `PUBLIC_URL` | Öffentliche Adresse (Webhook-URLs, Einladungslinks) |
| `LIFELINK_PORT` / `LIFELINK_BIND` | Port und Schnittstelle auf dem Host (Standard 7310 / alle) |
| `TRUST_PROXY` | `true`, wenn ein Reverse-Proxy davor läuft (echte Client-IP) |
| `COOKIE_SECURE` | Sitzungs-Cookies nur über HTTPS (Standard `true`) |
| `WORKER_CONCURRENCY` | Gleichzeitige Ausführungen (zusätzlich in den Einstellungen) |

## TLS / Reverse-Proxy

LifeLink selbst spricht HTTP. Für den Betrieb im Internet einen TLS-Proxy (Nginx, Caddy, Traefik, Nginx Proxy
Manager) davorsetzen, `LIFELINK_BIND=127.0.0.1` (oder nur das Proxy-Netz) und `TRUST_PROXY=true` setzen.
Beispiel Caddy:

```
lifelink.example.de {
  reverse_proxy 127.0.0.1:7310
}
```

Webhooks (`/hooks/...`) müssen von außen erreichbar sein, die Oberfläche (`/`, `/api/...`) kann zusätzlich per
Proxy auf interne Netze beschränkt werden.

## Updates

- **In der App** (Plattform-Admin): Updates → „Update installieren“ lädt das neueste GitHub-Release, prüft SHA-256 und
  Ed25519-Signatur, legt die neue Version in `/data/releases/<version>` ab und schaltet um. Startet die neue Version
  nicht innerhalb von 2 Minuten, schaltet der Supervisor automatisch zurück.
- **Image-Update** (Node-Version, Systempakete, Compose-Änderungen): `git pull && docker compose up -d --build`.
  Ein neueres Image hat Vorrang vor älteren In-App-Updates.
- Datenbankmigrationen laufen beim Start automatisch (nur additiv, damit ein Rollback möglich bleibt).

## Sicherung und Wiederherstellung

Automatisch täglich (Einstellungen → Sicherung), verschlüsselt in `/data/backups`. Herunterladen in der App.
Der Master-Schlüssel wird zum Entschlüsseln gebraucht – getrennt aufbewahren.

Wiederherstellen:

```bash
docker compose cp ./lifelink-2026-10-29-03-00.llbk lifelink:/data/restore.llbk
docker compose exec lifelink node server/dist/cli.js backup-decrypt /data/restore.llbk /data/restore.dump
docker compose cp lifelink:/data/restore.dump ./restore.dump
docker compose exec lifelink rm /data/restore.llbk /data/restore.dump
docker compose stop lifelink
docker compose exec -T lifelink-db pg_restore --clean --if-exists --no-owner -U lifelink -d lifelink < ./restore.dump
docker compose start lifelink
rm ./restore.dump   # enthält Klartextdaten
```

Die Wiederherstellung regelmäßig auf einem Testsystem üben.

## Notfall-Befehle

```bash
docker compose exec lifelink node server/dist/cli.js password-link admin@example.de   # Link zum Passwort-Neusetzen
docker compose exec lifelink node server/dist/cli.js reset-mfa admin@example.de       # 2FA zurücksetzen
docker compose exec lifelink node server/dist/cli.js migrate                           # Schema prüfen/aktualisieren
```

## Überwachung

- `GET /healthz` (ohne Anmeldung) – Lebenszeichen und Version, wird vom Docker-Healthcheck genutzt.
- Systemstatus in der App: Worker-Lebenszeichen, Warteschlangenalter, Trigger-Fehler, Verbindungen, letzte Sicherung.
- Fehlgeschlagene Produktivläufe erzeugen Benachrichtigungen (in der App, optional per E-Mail).
