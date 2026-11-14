#!/usr/bin/env bash
# Update von LifeLink am Docker-Host: Sichern → Wechseln → Prüfen → (bei Fehler) Wiederherstellen.
#
#   scripts/update.sh <neues-image> [sicherungsordner]
#   z. B. scripts/update.sh ghcr.io/<organisation>/lifelink:0.5.0 /srv/lifelink-sicherungen
#
# Ablauf:
#   1. Vorabprüfung im laufenden Container, Wartungsmodus an (keine neuen schreibenden Vorgänge, keine neuen Aufträge)
#   2. warten, bis laufende Aufträge fertig sind
#   3. vollständige Sicherung des Volumes außerhalb des Volumes (scripts/backup-volume.sh)
#   4. Image wechseln (LIFELINK_IMAGE in .env), Container neu starten, Schema-Migration mit Startprüfung
#   5. Healthcheck und Selbsttest; Wartungsmodus aus
#   Schlägt Schritt 4/5 fehl: vorheriges Image + Sicherung aus Schritt 3 wiederherstellen (automatisch mit --rollback).
set -euo pipefail
NEW_IMAGE="${1:?Aufruf: scripts/update.sh <neues-image> [sicherungsordner] [--rollback]}"
BACKUP_DIR="${2:-./sicherungen}"
AUTO_ROLLBACK=0
for a in "$@"; do [ "$a" = "--rollback" ] && AUTO_ROLLBACK=1; done
cd "$(dirname "$0")/.."
PORT="${LIFELINK_PORT:-7310}"
cli() { docker compose exec -T lifelink node server/dist/cli.js "$@"; }
envset() { # Schlüssel in .env setzen
  touch .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
OLD_IMAGE="$(docker compose config --images | head -1)"
echo "== Aktuell: $OLD_IMAGE  →  Neu: $NEW_IMAGE"
docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || docker pull "$NEW_IMAGE"

echo "== 1. Vorabprüfung und Wartungsmodus"
cli maintenance on "Update auf $NEW_IMAGE"
echo "== 2. Warten, bis laufende Vorgänge abgeschlossen sind"
for i in $(seq 1 60); do
  if cli preflight >/tmp/lifelink-preflight.txt 2>&1; then break; fi
  [ "$i" = 60 ] && { cat /tmp/lifelink-preflight.txt; echo "Nicht bereit – Update abgebrochen, Wartungsmodus bleibt an (cli maintenance off)." >&2; exit 1; }
  sleep 5
done
cat /tmp/lifelink-preflight.txt

echo "== 3. Vollständige Sicherung außerhalb des Volumes"
LIFELINK_IMAGE="$OLD_IMAGE" scripts/backup-volume.sh "$BACKUP_DIR" | tee /tmp/lifelink-backup.txt
ARCHIVE="$(sed -n 's/^Sicherung geschrieben: //p' /tmp/lifelink-backup.txt | tail -1)"
[ -f "$ARCHIVE" ] || { echo "Sicherung fehlt – Abbruch." >&2; exit 1; }

echo "== 4. Image wechseln"
envset LIFELINK_IMAGE "$NEW_IMAGE"
docker compose up -d --no-build

echo "== 5. Prüfen"
ok=0
for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" = 1 ] && cli self-check; then
  cli maintenance off
  echo "== Update erfolgreich: $NEW_IMAGE (Sicherung: $ARCHIVE)"
  exit 0
fi

echo "!! Das neue Image startet nicht sauber:" >&2
curl -sS "http://127.0.0.1:$PORT/healthz" >&2 || true
echo >&2
if [ "$AUTO_ROLLBACK" = 1 ]; then
  echo "== Rückweg: vorheriges Image und Sicherung wiederherstellen"
  docker compose down
  docker volume rm "${LIFELINK_VOLUME:-lifelink_lifelink-data}"
  LIFELINK_IMAGE="$OLD_IMAGE" scripts/restore-volume.sh "$ARCHIVE"
  envset LIFELINK_IMAGE "$OLD_IMAGE"
  docker compose up -d --no-build
  for i in $(seq 1 90); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 2; done
  cli maintenance off
  echo "== Zurück auf $OLD_IMAGE mit dem Datenstand vor dem Update."
else
  cat >&2 <<HILFE
Rückweg (Daten von vor dem Update):
  docker compose down
  docker volume rm ${LIFELINK_VOLUME:-lifelink_lifelink-data}
  LIFELINK_IMAGE=$OLD_IMAGE scripts/restore-volume.sh $ARCHIVE
  sed -i 's|^LIFELINK_IMAGE=.*|LIFELINK_IMAGE=$OLD_IMAGE|' .env && docker compose up -d --no-build
  docker compose exec lifelink node server/dist/cli.js maintenance off
HILFE
fi
exit 1
