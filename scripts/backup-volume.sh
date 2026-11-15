#!/usr/bin/env bash
# Vollständige, konsistente Sicherung von BlaulichtCMS außerhalb des aktiven Volumes:
# Datenbank, Medien, Schlüsselmaterial und Konfiguration (alles unter /data).
#
#   scripts/backup-volume.sh /pfad/zum/sicherungsordner [--nur-platz]
#   --nur-platz   nur prüfen, ob der Platz im Ziel reicht (ohne Sicherung, ohne Stopp)
#
# Das Archiv wird verschlüsselt (AES-256-GCM, scripts/volume-crypt.mjs) mit dem Sicherungsschlüssel aus
# BLAULICHTCMS_BACKUP_KEY_FILE (Standard /etc/blaulichtcms/backup.key). Der Schlüssel liegt NICHT im Volume und nicht
# im Sicherungsziel; eine Kopie gehört getrennt verwahrt (Passwortmanager/Tresor) – ohne ihn ist keine
# Wiederherstellung möglich. Archiv und Prüfsumme sind nur für den Eigentümer lesbar (0600, Ordner 0700).
# Unverschlüsselt nur ausdrücklich: BLAULICHTCMS_BACKUP_UNENCRYPTED=1 (nicht empfohlen).
#
# Der Container wird dafür kurz angehalten (wenige Sekunden) und danach wieder gestartet.
set -euo pipefail
umask 077
TARGET="${1:?Aufruf: scripts/backup-volume.sh <zielordner> [--nur-platz]}"
ONLY_SPACE=0
[ "${2:-}" = "--nur-platz" ] && ONLY_SPACE=1
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VOLUME="${BLAULICHTCMS_VOLUME:-blaulichtcms_data}"
# Image: Umgebung, sonst BLAULICHTCMS_IMAGE aus .env (laufender Stand), sonst blaulichtcms:local
IMAGE="${BLAULICHTCMS_IMAGE:-$(sed -n 's/^BLAULICHTCMS_IMAGE=//p' .env 2>/dev/null | tail -1)}"
IMAGE="${IMAGE:-blaulichtcms:local}"
KEY_FILE="${BLAULICHTCMS_BACKUP_KEY_FILE:-/etc/blaulichtcms/backup.key}"
UNENCRYPTED="${BLAULICHTCMS_BACKUP_UNENCRYPTED:-0}"

if [ "$UNENCRYPTED" != 1 ] && [ ! -f "$KEY_FILE" ]; then
  cat >&2 <<HILFE
Sicherungsschlüssel fehlt: $KEY_FILE
Anlegen (einmalig, danach eine Kopie getrennt verwahren – ohne ihn keine Wiederherstellung):
  sudo install -d -m 700 $(dirname "$KEY_FILE")
  head -c 32 /dev/urandom | base64 | sudo tee $KEY_FILE >/dev/null && sudo chmod 600 $KEY_FILE
Anderer Ort: BLAULICHTCMS_BACKUP_KEY_FILE=… setzen. (install.sh legt den Schlüssel automatisch an.)
HILFE
  exit 1
fi

[ "$UNENCRYPTED" = 1 ] || KEY_FILE="$(cd "$(dirname "$KEY_FILE")" && pwd)/$(basename "$KEY_FILE")"

# Zielordner nur für den Eigentümer (#93); bestehende, zu offene Ordner einschränken
mkdir -p "$TARGET"   # umask 077 → 0700
TARGET="$(cd "$TARGET" && pwd)"
chmod 700 "$TARGET" 2>/dev/null || echo "Hinweis: Rechte von $TARGET ließen sich nicht auf 700 setzen (Netzlaufwerk?) – Freigabe prüfen." >&2
STAMP="$(date +%Y-%m-%d-%H%M%S)"
if [ "$UNENCRYPTED" = 1 ]; then FILE="blaulichtcms-${STAMP}.tar.gz"; else FILE="blaulichtcms-${STAMP}.tar.gz.enc"; fi

need=$(docker run --rm --network none -v "$VOLUME":/data:ro --entrypoint du "$IMAGE" -sb /data | cut -f1)
free=$(df -B1 --output=avail "$TARGET" | tail -1)
if [ "$free" -lt $((need + need / 5)) ]; then
  echo "Zu wenig Platz im Ziel: benötigt ca. $((need / 1048576)) MB, frei $((free / 1048576)) MB." >&2
  exit 1
fi
# Nur prüfen (update.sh vor dem Wartungsmodus, #120)
if [ "$ONLY_SPACE" = 1 ]; then
  echo "Platz im Ziel reicht: benötigt ca. $((need / 1048576)) MB, frei $((free / 1048576)) MB."
  exit 0
fi

was_running=$(docker compose ps -q blaulichtcms 2>/dev/null || true)
[ -n "$was_running" ] && docker compose stop blaulichtcms >/dev/null
trap 'rm -f "$TARGET/$FILE.part"; [ -n "$was_running" ] && docker compose start blaulichtcms >/dev/null' EXIT

if [ "$UNENCRYPTED" = 1 ]; then
  echo "WARNUNG: unverschlüsselte Sicherung (BLAULICHTCMS_BACKUP_UNENCRYPTED=1) – enthält Master-Schlüssel und alle Daten im Klartext." >&2
  docker run --rm -u 0 --network none -v "$VOLUME":/data:ro -v "$TARGET":/backup --entrypoint sh "$IMAGE" -c '
    umask 077
    tar -czf "/backup/$1.part" -C /data . && mv "/backup/$1.part" "/backup/$1" && chown "$2" "/backup/$1"' _ "$FILE" "$(id -u):$(id -g)"
else
  # tar | Verschlüsselung im Container (Node.js ist in jedem BlaulichtCMS-Image); der Schlüssel wird nur lesend eingebunden,
  # nicht über die Umgebung übergeben (wäre in „docker inspect“ sichtbar). Ein Fehler von tar bricht ebenfalls ab.
  docker run --rm -u 0 --network none -v "$VOLUME":/data:ro -v "$TARGET":/backup \
    -v "$KEY_FILE":/run/blaulichtcms-backup.key:ro -v "$SCRIPT_DIR/volume-crypt.mjs":/run/volume-crypt.mjs:ro \
    --entrypoint sh "$IMAGE" -c '
    umask 077
    { tar -czf - -C /data . || echo fehler > /tmp/tar-fehler; } | node /run/volume-crypt.mjs encrypt /run/blaulichtcms-backup.key > "/backup/$1.part" || exit 1
    [ ! -e /tmp/tar-fehler ] || { echo "tar ist fehlgeschlagen" >&2; exit 1; }
    mv "/backup/$1.part" "/backup/$1" && chown "$2" "/backup/$1"' _ "$FILE" "$(id -u):$(id -g)"
fi
( cd "$TARGET" && sha256sum "$FILE" > "$FILE.sha256" )
chmod 600 "$TARGET/$FILE" "$TARGET/$FILE.sha256"
echo "Sicherung geschrieben: $TARGET/$FILE"
