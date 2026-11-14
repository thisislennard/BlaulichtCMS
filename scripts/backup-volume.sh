#!/usr/bin/env bash
# Vollständige, konsistente Sicherung von LifeLink außerhalb des aktiven Volumes:
# Datenbank, Medien, Schlüsselmaterial und Konfiguration (alles unter /data).
#
#   scripts/backup-volume.sh /pfad/zum/sicherungsordner
#
# Der Container wird dafür kurz angehalten (wenige Sekunden) und danach wieder gestartet.
set -euo pipefail
TARGET="${1:?Aufruf: scripts/backup-volume.sh <zielordner>}"
VOLUME="${LIFELINK_VOLUME:-lifelink_lifelink-data}"
IMAGE="${LIFELINK_IMAGE:-lifelink:local}"
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
FILE="lifelink-${STAMP}.tar.gz"

need=$(docker run --rm -v "$VOLUME":/data:ro --entrypoint du "$IMAGE" -sb /data | cut -f1)
free=$(df -B1 --output=avail "$TARGET" | tail -1)
if [ "$free" -lt $((need + need / 5)) ]; then
  echo "Zu wenig Platz im Ziel: benötigt ca. $((need / 1048576)) MB, frei $((free / 1048576)) MB." >&2
  exit 1
fi

was_running=$(docker compose ps -q lifelink 2>/dev/null || true)
[ -n "$was_running" ] && docker compose stop lifelink >/dev/null
trap '[ -n "$was_running" ] && docker compose start lifelink >/dev/null' EXIT

docker run --rm -u 0 -v "$VOLUME":/data:ro -v "$TARGET":/backup --entrypoint sh "$IMAGE" -c "tar -czf /backup/$FILE -C /data . && chown $(id -u):$(id -g) /backup/$FILE"
( cd "$TARGET" && sha256sum "$FILE" > "$FILE.sha256" )
echo "Sicherung geschrieben: $TARGET/$FILE"
