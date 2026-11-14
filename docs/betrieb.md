# Betrieb

LifeLink läuft als **ein Container** mit **einem Webport** und **einem persistenten Volume** unter `/data`.

| Bestandteil | Im Container | Daten |
|---|---|---|
| Supervisor | startet und stoppt alle Prozesse in fester Reihenfolge | – |
| PostgreSQL 18 | nur Unix-Socket, kein TCP-Port | `/data/postgres` |
| Webdienst (API, Oberfläche, PWA) | Port 7310 | – |
| Worker (Medienprüfung, Wartung, Sicherung) | Hintergrundprozess | – |
| Medien | private Ablage | `/data/media` (`quarantine`, `originals`, `previews`, `public`) |
| Schlüsselmaterial | Master-Schlüssel | `/data/secrets/master.key` |
| Datenbanksicherungen | verschlüsselt | `/data/backups` |

## Starten

```bash
git clone <repository-url> lifelink && cd lifelink
cp .env.example .env            # optional
docker compose up -d --build
docker compose logs lifelink | grep Einrichtungsschlüssel
```

Danach `http://<host>:7310/einrichtung` öffnen (im Echtbetrieb über den Reverse Proxy per HTTPS).

Reihenfolge beim Start: PostgreSQL (bei leerem Volume `initdb`) → API (führt Migrationen aus) → Worker.
Reihenfolge beim Stopp (`docker compose stop`): Worker (laufende Aufträge max. 20 s) → API → PostgreSQL (Fast Shutdown).
`stop_grace_period` ist auf 60 s gesetzt.

## Gesundheit

`GET /healthz` (ohne Anmeldung) liefert **200** nur, wenn LifeLink Aufträge annehmen kann:

| Prüfung | bereit, wenn |
|---|---|
| `database` | PostgreSQL antwortet |
| `schema` | alle Migrationen angewendet |
| `worker` | ein Worker hat sich in den letzten 45 s gemeldet |
| `storage` | mehr freier Speicher als „Mindestens frei halten“ (Einstellungen → Medien) |

Sonst **503** mit den Einzelergebnissen. Der Docker-Healthcheck nutzt diesen Endpunkt.

```bash
curl -s http://localhost:7310/healthz | jq
docker compose exec lifelink node server/dist/cli.js self-check
```

## Umgebungsvariablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `LIFELINK_PORT` | `7310` | Port auf dem Docker-Host |
| `LIFELINK_BIND` | `0.0.0.0` | Schnittstelle; hinter einem Proxy auf demselben Host `127.0.0.1` |
| `TRUST_PROXY` | `false` | `true` hinter einem Reverse Proxy (echte Client-IP für Sperren und Audit) |
| `COOKIE_SECURE` | `true` in Produktion | Cookies nur über HTTPS; für einen lokalen Test ohne HTTPS `false` |
| `PUBLIC_URL` | – | Vorschlag für den Assistenten; maßgeblich ist die im Erstsetup gesetzte Adresse |
| `LIFELINK_MASTER_KEY` | – | Master-Schlüssel extern vorgeben; sonst wird `/data/secrets/master.key` erzeugt |

## Sicherung

Ein konsistenter Stand umfasst **Datenbank, Medien und Schlüsselmaterial**. Alles liegt im Volume.
Für den Ernstfall gehört eine Kopie **außerhalb** des aktiven Volumes (anderer Datenträger oder Host).

### Vollständige Sicherung (empfohlen vor Updates)

```bash
docker compose stop lifelink
docker run --rm -v lifelink_lifelink-data:/data:ro -v "$PWD/backup":/backup debian:trixie-slim \
  tar -czf /backup/lifelink-$(date +%F-%H%M).tar.gz -C /data .
docker compose start lifelink
```

Der Stopp dauert wenige Sekunden und garantiert, dass Datenbank und Medien zusammenpassen.
Ein Skript dafür liegt unter `scripts/backup-volume.sh`.

### Laufende Datenbanksicherung

Zusätzlich erstellt LifeLink täglich (Einstellungen → Sicherung) eine mit dem Master-Schlüssel verschlüsselte
Datenbanksicherung unter `/data/backups`. Sie ist praktisch zum Herunterladen, ersetzt aber nicht die
Kopie außerhalb des Volumes, weil Medien nicht enthalten sind.

## Wiederherstellung

In einer frischen Instanz (neuer Host oder leeres Volume):

```bash
docker volume create lifelink_lifelink-data
docker run --rm -v lifelink_lifelink-data:/data -v "$PWD/backup":/backup debian:trixie-slim \
  sh -c 'tar -xzf /backup/lifelink-2026-11-14-0300.tar.gz -C /data && chown -R 1000:1000 /data'
docker compose up -d
```

Skript: `scripts/restore-volume.sh <archiv>`.

**Prüfliste nach der Wiederherstellung**

- [ ] `/healthz` meldet 200
- [ ] Anmeldung mit bestehendem Konto funktioniert (inkl. Zwei-Faktor)
- [ ] Benutzer und Rollen vollständig
- [ ] Beiträge mit Fassungen, Freigaben und Veröffentlichungen vorhanden
- [ ] Medien: Vorschauen sichtbar, Original-Download funktioniert
- [ ] offene Veröffentlichungsaufträge werden von der Bridge abgeholt
- [ ] Upload-Links: aktive funktionieren, widerrufene bleiben gesperrt

## Updates

1. Systemstatus prüfen (freier Speicher, letzte Sicherung, keine wartenden Veröffentlichungen).
2. Vollständige Sicherung außerhalb des Volumes anlegen.
3. Neues Image am Docker-Host:

   ```bash
   git pull
   docker compose up -d --build
   ```

4. Die API führt beim Start fehlende Migrationen aus (jede in eigener Transaktion, unter Sperre).
   Schlägt eine Migration fehl, startet die API nicht, der Healthcheck bleibt rot und das Protokoll nennt die Migration.
5. Rückweg: vorheriges Image starten **und** die Sicherung von Schritt 2 wiederherstellen.

Es gibt kein In-App-Update, das Programmcode austauscht. Updates bleiben eine bewusste Entscheidung am Docker-Host.

### PostgreSQL-Hauptversion

Der Supervisor vergleicht `/data/postgres/PG_VERSION` mit der PostgreSQL-Version im Image und **startet nicht**,
wenn sie abweichen. Ein Hauptversionswechsel läuft geplant über Export und Import:

```bash
# Mit dem ALTEN Image: logische Sicherung
docker compose exec lifelink sh -c 'pg_dumpall -h /tmp/lifelink-pg -U lifelink' > lifelink-pgdumpall.sql
# Vollständige Volume-Sicherung anlegen (siehe oben), dann Datenbankverzeichnis beiseitelegen
docker compose stop lifelink
docker run --rm -v lifelink_lifelink-data:/data debian:trixie-slim mv /data/postgres /data/postgres-alt
# NEUES Image starten (legt leeren Cluster an), dann einspielen
docker compose up -d
docker compose exec -T lifelink sh -c 'psql -h /tmp/lifelink-pg -U lifelink -d postgres' < lifelink-pgdumpall.sql
```

Dieser Weg ist dokumentiert, aber noch **nicht mit einem echten Versionswechsel getestet** (siehe `docs/testprotokoll.md`).

## Notfall-Befehle

```bash
docker compose exec lifelink node server/dist/cli.js password-link admin@example.org   # Passwort-Link (24 h)
docker compose exec lifelink node server/dist/cli.js reset-mfa admin@example.org       # Zwei-Faktor zurücksetzen
docker compose exec lifelink node server/dist/cli.js self-check                        # Bereitschaft prüfen
docker compose exec lifelink node server/dist/cli.js backup-decrypt <datei> <ziel>     # Datenbanksicherung entschlüsseln
```
