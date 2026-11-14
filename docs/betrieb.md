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

Ablauf: **Sichern → Wechseln → Prüfen → Wiederherstellen** (nur im Fehlerfall). Programmcode wird nie aus der
Anwendung heraus ausgetauscht; ein Update ist immer ein bewusster Imagewechsel am Docker-Host.

### Mit dem Update-Skript (empfohlen)

```bash
scripts/update.sh <neues-image> /srv/lifelink-sicherungen            # z. B. ghcr.io/<organisation>/lifelink:0.5.0
scripts/update.sh <neues-image> /srv/lifelink-sicherungen --rollback # bei Fehler automatisch zurück
```

Das Skript

1. schaltet den **Wartungsmodus** ein: keine neuen schreibenden Vorgänge, keine neuen Hintergrundaufträge, die Bridge
   erhält keine neuen Aufträge (bestehende Banner auf der Website bleiben unverändert);
2. wartet, bis die **Vorabprüfung** bereit meldet (keine laufenden Aufträge, kein Versand und keine Veröffentlichung in
   der Schwebe, genug Speicher);
3. legt eine **vollständige Sicherung außerhalb des Volumes** an (`scripts/backup-volume.sh`, mit Prüfsumme);
4. setzt `LIFELINK_IMAGE` in `.env` und startet den Container mit dem neuen Image;
5. wartet auf den Healthcheck und den Selbsttest und beendet den Wartungsmodus.

Die Vorabprüfung gibt es auch in der Oberfläche (Einstellungen → Sicherung → „Update vorbereiten“) und auf der
Kommandozeile: `docker compose exec lifelink node server/dist/cli.js preflight`.

### Schema-Migration mit Startprüfung

Der Supervisor führt fehlende Migrationen **vor** dem Start der API als eigenen Schritt aus (jede Migration in einer
eigenen Transaktion, unter Sperre). Zuvor prüft er, ob der Datenstand **neuer als das Programm** ist (die Datenbank
kennt Migrationen, die das Image nicht enthält – typisch nach einer Rückkehr zu einem älteren Image ohne passende
Sicherung).

Schlägt einer der beiden Schritte fehl, **startet LifeLink nicht**: PostgreSQL läuft weiter (für Sicherung und
Wiederherstellung), der Webport zeigt eine Sperrseite mit dem Grund und `/healthz` antwortet mit 503. Eine
fehlgeschlagene Migration wird vollständig zurückgerollt; die Daten bleiben unverändert.

### Rückweg nach fehlgeschlagenem Update

```bash
docker compose down
docker volume rm lifelink_lifelink-data
LIFELINK_IMAGE=<altes-image> scripts/restore-volume.sh /srv/lifelink-sicherungen/lifelink-<zeitpunkt>.tar.gz
sed -i 's|^LIFELINK_IMAGE=.*|LIFELINK_IMAGE=<altes-image>|' .env && docker compose up -d --no-build
docker compose exec lifelink node server/dist/cli.js maintenance off
```

Image **und** passender Datenstand gehören zusammen: Nach einer erfolgreichen Migration lässt sich das alte Image
nicht einfach wieder starten (Startprüfung). Der Rückweg führt immer über die Sicherung von vor dem Update.
Beide Wege – fehlgeschlagene Migration mit automatischem Rückweg und verweigerte Rückkehr zum alten Image – sind in
der Abnahme M4 getestet (`test/e2e/m4-flow.mjs`).

### Versionierte Images

`compose.yaml` verwendet `image: ${LIFELINK_IMAGE:-lifelink:local}`. Für den Betrieb feste Versionen verwenden
(`…/lifelink:0.5.0`), nie `latest`, damit der Rückweg eindeutig ist.

### PostgreSQL-Hauptversion

Der Supervisor vergleicht `/data/postgres/PG_VERSION` mit der PostgreSQL-Version im Image und **startet nicht**,
wenn sie abweichen. Ein Hauptversionswechsel läuft geplant über Export und Import:

```bash
# 1. Mit dem ALTEN Image: Wartungsmodus, logische Sicherung, vollständige Volume-Sicherung
docker compose exec lifelink node server/dist/cli.js maintenance on "PostgreSQL-Wechsel"
docker compose exec -T lifelink sh -c 'pg_dump -h /tmp/lifelink-pg -U lifelink --no-owner --no-privileges lifelink' > lifelink.sql
scripts/backup-volume.sh /srv/lifelink-sicherungen
# 2. Alten Cluster beiseitelegen, NEUES Image starten (legt einen leeren Cluster an)
docker compose stop lifelink
docker run --rm -u 0 -v lifelink_lifelink-data:/data --entrypoint sh <neues-image> -c 'mv /data/postgres /data/postgres-alt'
docker compose up -d --no-build
# 3. Leere Datenbank ersetzen und den Export einspielen
docker compose exec -T lifelink sh -c "psql -h /tmp/lifelink-pg -U lifelink -d postgres -c 'DROP DATABASE lifelink WITH (FORCE)' -c 'CREATE DATABASE lifelink OWNER lifelink'"
docker compose exec -T lifelink sh -c 'psql -q -h /tmp/lifelink-pg -U lifelink -d lifelink' < lifelink.sql
docker compose restart lifelink
docker compose exec lifelink node server/dist/cli.js maintenance off
# 4. Nach erfolgreicher Prüfung: /data/postgres-alt entfernen
```

In der Abnahme M4 getestet mit einem Datenbestand aus **PostgreSQL 16**, eingespielt in das Image mit
**PostgreSQL 18**: alle Benutzer, Medien, Freigaben und geplanten Aufträge vollständig, Anwendung gesund.

## Notfall-Befehle

```bash
docker compose exec lifelink node server/dist/cli.js password-link admin@example.org   # Passwort-Link (24 h)
docker compose exec lifelink node server/dist/cli.js reset-mfa admin@example.org       # Zwei-Faktor zurücksetzen
docker compose exec lifelink node server/dist/cli.js self-check                        # Bereitschaft prüfen
docker compose exec lifelink node server/dist/cli.js preflight                         # Update-Vorabprüfung
docker compose exec lifelink node server/dist/cli.js maintenance on|off                # Wartungsmodus
docker compose exec lifelink node server/dist/cli.js backup-decrypt <datei> <ziel>     # Datenbanksicherung entschlüsseln
```
