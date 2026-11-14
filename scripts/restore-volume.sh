#!/usr/bin/env bash
# Stellt eine mit backup-volume.sh erstellte Sicherung in ein LEERES Volume wieder her.
#
#   docker compose down            # Container stoppen
#   scripts/restore-volume.sh /pfad/lifelink-2026-11-14-030000.tar.gz
#   docker compose up -d
set -euo pipefail
ARCHIVE="${1:?Aufruf: scripts/restore-volume.sh <archiv.tar.gz>}"
VOLUME="${LIFELINK_VOLUME:-lifelink_lifelink-data}"
IMAGE="${LIFELINK_IMAGE:-lifelink:local}"
DIR="$(cd "$(dirname "$ARCHIVE")" && pwd)"
NAME="$(basename "$ARCHIVE")"

if [ -f "$DIR/$NAME.sha256" ]; then
  ( cd "$DIR" && sha256sum -c "$NAME.sha256" >/dev/null ) || { echo "Prüfsumme stimmt nicht – Abbruch." >&2; exit 1; }
fi
if docker compose ps -q lifelink 2>/dev/null | grep -q .; then
  echo "LifeLink läuft noch. Bitte zuerst 'docker compose down' ausführen." >&2
  exit 1
fi
docker volume create "$VOLUME" >/dev/null
if [ -n "$(docker run --rm -v "$VOLUME":/data --entrypoint ls "$IMAGE" -A /data)" ]; then
  echo "Das Volume $VOLUME ist nicht leer. Zum Überschreiben zuerst entfernen: docker volume rm $VOLUME" >&2
  exit 1
fi
docker run --rm -u 0 -v "$VOLUME":/data -v "$DIR":/backup:ro --entrypoint sh "$IMAGE" -c "tar -xzf /backup/$NAME -C /data && chown -R 1000:1000 /data"
echo "Wiederhergestellt in Volume $VOLUME. Jetzt: docker compose up -d"
