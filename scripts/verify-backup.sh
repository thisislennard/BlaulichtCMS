#!/usr/bin/env bash
# Prüft eine Volume-Sicherung auf Wiederherstellbarkeit (#113) – ohne die laufende Instanz anzufassen.
#
#   scripts/verify-backup.sh <archiv> [--voll] [--ohne-pruefsumme]
#
# Standard (schnell, täglich nach jeder Sicherung in backup-cron.sh):
#   Prüfsumme, vollständiges Entschlüsseln (Schlüssel, Echtheit, Vollständigkeit) und Lesen des tar-Archivs;
#   Datenbank (postgres/PG_VERSION) und Schlüsselmaterial (secrets/) müssen enthalten sein.
# --voll (wöchentlich in backup-cron.sh, vierteljährlich zusätzlich von Hand empfohlen):
#   echte Wiederherstellung in ein Wegwerf-Volume und Start einer Wegwerf-Instanz OHNE Netzwerk (keine Mails,
#   keine Veröffentlichungen, keine Verbindungen nach außen); bestanden, wenn /healthz bereit meldet und der
#   Selbsttest durchläuft. Volume und Container werden danach entfernt.
#
# Exit 0 = Sicherung wiederherstellbar. Sicherungsschlüssel: BLAULICHTCMS_BACKUP_KEY_FILE (Standard /etc/blaulichtcms/backup.key).
set -euo pipefail
umask 077
ARCHIVE=""; FULL=0; NO_SUM=0
for a in "$@"; do
  case "$a" in
    --voll) FULL=1 ;;
    --ohne-pruefsumme) NO_SUM=1 ;;
    -*) echo "Unbekannte Option: $a" >&2; exit 2 ;;
    *) ARCHIVE="$a" ;;
  esac
done
[ -n "$ARCHIVE" ] || { echo "Aufruf: scripts/verify-backup.sh <archiv> [--voll] [--ohne-pruefsumme]" >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "Archiv nicht gefunden: $ARCHIVE" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
IMAGE="${BLAULICHTCMS_IMAGE:-$(sed -n 's/^BLAULICHTCMS_IMAGE=//p' .env 2>/dev/null | tail -1)}"
IMAGE="${IMAGE:-blaulichtcms:local}"
KEY_FILE="${BLAULICHTCMS_BACKUP_KEY_FILE:-/etc/blaulichtcms/backup.key}"
DIR="$(cd "$(dirname "$ARCHIVE")" && pwd)"
NAME="$(basename "$ARCHIVE")"
fail() { echo "PRÜFUNG FEHLGESCHLAGEN: $*" >&2; exit 1; }

# 1. Prüfsumme
if [ -f "$DIR/$NAME.sha256" ]; then
  ( cd "$DIR" && sha256sum -c "$NAME.sha256" >/dev/null 2>&1 ) || fail "Prüfsumme von $NAME stimmt nicht."
elif [ "$NO_SUM" != 1 ]; then
  fail "Prüfsummendatei $NAME.sha256 fehlt (bewusst übergehen: --ohne-pruefsumme)."
fi

# 2. Entschlüsseln und Inhaltsverzeichnis lesen (im Container: Node.js und tar sind in jedem BlaulichtCMS-Image)
MOUNTS=(-v "$DIR":/backup:ro)
case "$NAME" in
  *.enc)
    [ -f "$KEY_FILE" ] || fail "Sicherungsschlüssel fehlt: $KEY_FILE"
    KEY_FILE="$(cd "$(dirname "$KEY_FILE")" && pwd)/$(basename "$KEY_FILE")"
    MOUNTS+=(-v "$KEY_FILE":/run/blaulichtcms-backup.key:ro -v "$SCRIPT_DIR/volume-crypt.mjs":/run/volume-crypt.mjs:ro)
    READ='{ node /run/volume-crypt.mjs decrypt /run/blaulichtcms-backup.key < "/backup/$1" || echo fehler > /tmp/lesefehler; } | tar -tzf - || echo fehler > /tmp/lesefehler; [ ! -e /tmp/lesefehler ]' ;;
  *)
    READ='tar -tzf "/backup/$1"' ;;
esac
# Als root im Container (#275): Archiv und Schlüssel gehören root (0600) – der Benutzer des Images könnte sie nicht lesen
LIST="$(docker run --rm -u 0 --network none "${MOUNTS[@]}" --entrypoint sh "$IMAGE" -c "$READ" _ "$NAME")" \
  || fail "$NAME lässt sich nicht vollständig entschlüsseln bzw. lesen (beschädigt, verändert oder falscher Schlüssel)."
printf '%s\n' "$LIST" | grep -qE '^(\./)?postgres/PG_VERSION$' || fail "$NAME enthält keine Datenbank (postgres/PG_VERSION fehlt)."
if ! printf '%s\n' "$LIST" | grep -qE '^(\./)?secrets/master\.key$'; then
  grep -q '^BLAULICHTCMS_MASTER_KEY=.' .env 2>/dev/null || fail "$NAME enthält keinen Master-Schlüssel (secrets/master.key) und .env gibt keinen vor."
fi
FILES="$(printf '%s\n' "$LIST" | grep -vc '/$' || true)"
echo "Prüfung bestanden: $NAME – Prüfsumme, Entschlüsselung und Archiv in Ordnung ($FILES Dateien)."
[ "$FULL" = 1 ] || exit 0

# 3. Wiederherstellung in eine Wegwerf-Instanz
STAMP="$(date +%Y%m%d%H%M%S)"
TEST_VOL="blaulichtcms-restoretest_${STAMP}"
TEST_CT="blaulichtcms-restoretest-${STAMP}"
cleanup() {
  docker rm -f "$TEST_CT" >/dev/null 2>&1 || true
  docker volume rm -f "$TEST_VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT
echo "Wiederherstellungstest: $NAME → Wegwerf-Volume $TEST_VOL"
SUM_OPT=(); [ "$NO_SUM" = 1 ] && SUM_OPT=(--ohne-pruefsumme)
BLAULICHTCMS_VOLUME="$TEST_VOL" BLAULICHTCMS_IMAGE="$IMAGE" "$SCRIPT_DIR/restore-volume.sh" "$ARCHIVE" "${SUM_OPT[@]}" >/dev/null \
  || fail "Einspielen in das Wegwerf-Volume fehlgeschlagen."
ENV_OPT=(); [ -f .env ] && ENV_OPT=(--env-file .env)
# Ohne Netzwerk: die Wegwerf-Instanz kann weder Mails senden noch veröffentlichen oder Verbindungen aufbauen
# Grenzen wie in compose.yaml: die Wegwerf-Instanz soll den laufenden Betrieb nicht ausbremsen
CPUS="${BLAULICHTCMS_CPUS:-$(sed -n 's/^BLAULICHTCMS_CPUS=//p' .env 2>/dev/null | tail -1)}"
CPUS="${CPUS:-$(n=$(nproc 2>/dev/null || echo 2); [ "$n" -lt 2 ] && echo "$n" || echo 2)}"
docker run -d --name "$TEST_CT" --network none --tmpfs /tmp:size=1g --memory "${BLAULICHTCMS_MEM_LIMIT:-4g}" --cpus "$CPUS" \
  "${ENV_OPT[@]}" -v "$TEST_VOL":/data "$IMAGE" >/dev/null || fail "Wegwerf-Instanz startet nicht."
ready=0
for i in $(seq 1 90); do
  if docker exec "$TEST_CT" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7310)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  docker logs --tail 30 "$TEST_CT" >&2 2>&1 || true
  fail "Die wiederhergestellte Instanz meldet nicht bereit (Protokoll oben)."
fi
docker exec "$TEST_CT" node server/dist/cli.js self-check >/dev/null || fail "Selbsttest der wiederhergestellten Instanz fehlgeschlagen."
echo "Wiederherstellungstest bestanden: $NAME startet als eigene Instanz, /healthz bereit, Selbsttest in Ordnung."
