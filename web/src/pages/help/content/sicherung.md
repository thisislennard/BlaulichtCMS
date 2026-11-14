## Was gesichert werden muss

Ein vollständiger Stand besteht aus:

1. **Datenbank** (Benutzer, Rechte, Beiträge, Fassungen, Freigaben, Aufträge, Audit)
2. **Medien** unter `/data/media`
3. **Schlüsselmaterial** unter `/data/secrets` (bzw. `LIFELINK_MASTER_KEY`)

Ohne Master-Schlüssel sind verschlüsselte Inhalte einer Sicherung nicht lesbar.

## Sicherung ohne Unterbrechung

Unter **Einstellungen → Sicherung** erstellt LifeLink täglich eine verschlüsselte Datenbanksicherung unter `/data/backups`. Sie liegt im selben Volume – für den Ernstfall gehört eine Kopie **außerhalb** des Volumes.

## Vollständige Sicherung außerhalb des Volumes

Konsistent und einfach: Container kurz anhalten und das ganze Volume archivieren.

```
docker compose stop lifelink
docker run --rm -v lifelink_lifelink-data:/data -v "$PWD":/backup debian:trixie-slim \
  tar -czf /backup/lifelink-$(date +%F).tar.gz -C /data .
docker compose start lifelink
```

## Wiederherstellen in einer frischen Instanz

```
docker volume create lifelink_lifelink-data
docker run --rm -v lifelink_lifelink-data:/data -v "$PWD":/backup debian:trixie-slim \
  sh -c 'tar -xzf /backup/lifelink-2026-11-14.tar.gz -C /data && chown -R 1000:1000 /data'
docker compose up -d
```

Danach anmelden und prüfen: Benutzer, Beiträge, Medien, Freigaben und offene Aufträge sind wieder da. Die ausführliche Anleitung (inkl. Prüfliste) steht in `docs/betrieb.md`.
