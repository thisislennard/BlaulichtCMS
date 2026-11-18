#!/usr/bin/env bash
# Stellt eine mit backup-volume.sh erstellte Sicherung in ein LEERES Volume wieder her.
#
#   docker compose down            # Container stoppen
#   scripts/restore-volume.sh /pfad/blaulichtcms-2026-11-14-030000.tar.gz.enc [--ohne-pruefsumme]
#   docker compose up -d
#
# Verschlüsselte Archive (.tar.gz.enc) brauchen den Sicherungsschlüssel (BLAULICHTCMS_BACKUP_KEY_FILE, Standard
# /etc/blaulichtcms/backup.key). Das Archiv wird vor dem Auspacken vollständig geprüft (Prüfsumme und Authentizität);
# ein verändertes oder abgeschnittenes Archiv wird nicht eingespielt. Ältere, unverschlüsselte .tar.gz gehen weiterhin.
# Fehlt die .sha256-Datei, bricht das Skript ab – außer mit --ohne-pruefsumme (bewusste Entscheidung).
set -euo pipefail
ARCHIVE=""
NO_SUM=0
for a in "$@"; do
  case "$a" in
    --ohne-pruefsumme) NO_SUM=1 ;;
    -*) echo "Unbekannte Option: $a" >&2; exit 2 ;;
    *) ARCHIVE="$a" ;;
  esac
done
[ -n "$ARCHIVE" ] || { echo "Aufruf: scripts/restore-volume.sh <archiv.tar.gz.enc> [--ohne-pruefsumme]" >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "Archiv nicht gefunden: $ARCHIVE" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VOLUME="${BLAULICHTCMS_VOLUME:-blaulichtcms_data}"
# Image: Umgebung, sonst BLAULICHTCMS_IMAGE aus .env (laufender Stand), sonst blaulichtcms:local
IMAGE="${BLAULICHTCMS_IMAGE:-$(sed -n 's/^BLAULICHTCMS_IMAGE=//p' .env 2>/dev/null | tail -1)}"
IMAGE="${IMAGE:-blaulichtcms:local}"
KEY_FILE="${BLAULICHTCMS_BACKUP_KEY_FILE:-/etc/blaulichtcms/backup.key}"
DIR="$(cd "$(dirname "$ARCHIVE")" && pwd)"
NAME="$(basename "$ARCHIVE")"

# Prüfsumme: fehlende .sha256 ist ein Fehler (#113), außer ausdrücklich übergangen
if [ -f "$DIR/$NAME.sha256" ]; then
  ( cd "$DIR" && sha256sum -c "$NAME.sha256" >/dev/null ) || { echo "Prüfsumme stimmt nicht – Abbruch." >&2; exit 1; }
elif [ "$NO_SUM" = 1 ]; then
  echo "Hinweis: keine Prüfsummendatei – wird auf ausdrücklichen Wunsch übergangen (--ohne-pruefsumme)." >&2
else
  echo "Prüfsummendatei $NAME.sha256 fehlt – Abbruch. Bewusst ohne Prüfsumme: --ohne-pruefsumme anhängen." >&2
  exit 1
fi

ENCRYPTED=0
case "$NAME" in *.enc) ENCRYPTED=1 ;; esac
if [ "$ENCRYPTED" = 1 ]; then
  [ -f "$KEY_FILE" ] || { echo "Sicherungsschlüssel fehlt: $KEY_FILE (BLAULICHTCMS_BACKUP_KEY_FILE setzen)." >&2; exit 1; }
  KEY_FILE="$(cd "$(dirname "$KEY_FILE")" && pwd)/$(basename "$KEY_FILE")"
fi

# Nur das Volume der laufenden Instanz verlangt einen gestoppten Container (Wiederherstellungstest nutzt ein eigenes)
if [ "$VOLUME" = blaulichtcms_data ] && docker compose ps -q blaulichtcms 2>/dev/null | grep -q .; then
  echo "BlaulichtCMS läuft noch. Bitte zuerst 'docker compose down' ausführen." >&2
  exit 1
fi

CRYPT_MOUNTS=()
if [ "$ENCRYPTED" = 1 ]; then
  CRYPT_MOUNTS=(-v "$KEY_FILE":/run/blaulichtcms-backup.key:ro -v "$SCRIPT_DIR/volume-crypt.mjs":/run/volume-crypt.mjs:ro)
  # Erst vollständig prüfen (Schlüssel, Authentizität, Vollständigkeit), dann auspacken – nie halb einspielen.
  # Als root im Container (#275): Archiv und Schlüssel gehören root (0600), der Benutzer des Images liest sie nicht.
  docker run --rm -u 0 --network none -v "$DIR":/backup:ro "${CRYPT_MOUNTS[@]}" --entrypoint sh "$IMAGE" -c \
    'node /run/volume-crypt.mjs verify /run/blaulichtcms-backup.key < "/backup/$1"' _ "$NAME" \
    || { echo "Archiv lässt sich nicht entschlüsseln oder ist verändert – Abbruch, nichts eingespielt." >&2; exit 1; }
fi

# Mit Compose-Labels anlegen, damit „docker compose“ das Volume als eigenes erkennt
docker volume create --label com.docker.compose.project="${VOLUME%%_*}" --label com.docker.compose.volume="${VOLUME#*_}" "$VOLUME" >/dev/null
# Leer? Als root und mit eigenem Fehlerfall (#275): ein nicht lesbares Volume gilt nicht als leer
content="$(docker run --rm -u 0 --network none -v "$VOLUME":/data --entrypoint ls "$IMAGE" -A /data)" \
  || { echo "Inhalt des Volumes $VOLUME ließ sich nicht prüfen – Abbruch, nichts eingespielt." >&2; exit 1; }
if [ -n "$content" ]; then
  echo "Das Volume $VOLUME ist nicht leer. Zum Überschreiben zuerst entfernen: docker volume rm $VOLUME" >&2
  exit 1
fi
if [ "$ENCRYPTED" = 1 ]; then
  docker run --rm -u 0 --network none -v "$VOLUME":/data -v "$DIR":/backup:ro "${CRYPT_MOUNTS[@]}" --entrypoint sh "$IMAGE" -c '
    { node /run/volume-crypt.mjs decrypt /run/blaulichtcms-backup.key < "/backup/$1" || echo fehler > /tmp/entschluesseln-fehler; } | tar -xzf - -C /data || exit 1
    [ ! -e /tmp/entschluesseln-fehler ] || { echo "Entschlüsseln fehlgeschlagen" >&2; exit 1; }
    chown -R 1000:1000 /data' _ "$NAME"
else
  docker run --rm -u 0 --network none -v "$VOLUME":/data -v "$DIR":/backup:ro --entrypoint sh "$IMAGE" -c 'tar -xzf "/backup/$1" -C /data && chown -R 1000:1000 /data' _ "$NAME"
fi
echo "Wiederhergestellt in Volume $VOLUME. Jetzt: docker compose up -d"
