#!/usr/bin/env bash
# ============================================================================================================
#  BlaulichtCMS – Host-Helfer für Image-Updates aus der App (#226)
#
#  Wird von install.sh als systemd-Dienst eingerichtet (blaulichtcms-update.path + .service) und läuft als root –
#  aber nur für genau diesen festen Ablauf. Der Container bekommt dafür keinerlei zusätzliche Rechte (kein
#  docker.sock): Die App legt im Datenvolume eine Anfrage-Datei ab (host-update/request.json, nur Version, Zeitpunkt,
#  Kennungen – keine Befehle), der Helfer prüft sie streng und startet den bekannten Update-Ablauf von install.sh
#  nicht-interaktiv. Fortschritt und Ergebnis schreibt er nach host-update/status.json, das die App anzeigt.
#
#    scripts/host-update-helper.sh run        Anfrage verarbeiten (systemd-Dienst)
#    scripts/host-update-helper.sh announce   Helfer in der App bekannt machen (host-update/helper.json)
#    scripts/host-update-helper.sh retract    Bekanntmachung entfernen (beim Abschalten)
#
#  Schutzmaßnahmen:
#    - Alles, was im Datenvolume gelesen oder geschrieben wird, läuft mit der Benutzerkennung des Volumes (setpriv),
#      nie als root – symbolische Links oder Dateitricks aus dem Container erreichen so nichts außerhalb.
#    - Anfrage: höchstens 1 KB, genau ein festes JSON-Schema (Regex über die ganze Datei), höchstens 15 Minuten alt.
#    - Die Version aus der Anfrage ist nur die Erwartung: Der Helfer ermittelt selbst den neuesten Release-Tag, prüft
#      dessen Echtheit (Ed25519-Signatur des Release-Pakets gegen den angehefteten Schlüssel, Commit im signierten
#      Manifest = Commit des Tags; zusätzlich SSH-/GPG-Signatur des Tags, wenn allowed_signers hinterlegt ist) und
#      bricht ab, wenn er nicht genau der erwarteten, neueren Version entspricht. Nie ein Downgrade.
#    - Höchstens ein Lauf je 10 Minuten, Sperre gegen parallele Läufe (auch gegen ein gleichzeitiges install.sh).
# ============================================================================================================
set -euo pipefail
umask 077
# Bytegenau arbeiten (Prüfungen und Textmuster unabhängig von der Sprache des Hosts)
export LC_ALL=C

HELPER_VERSION=1
APP_DIR="${BLAULICHTCMS_DIR:-/opt/apps/blaulichtcms}"
EXCHANGE="${BLAULICHTCMS_HELPER_EXCHANGE:-}"
STATE_DIR="${BLAULICHTCMS_HELPER_STATE:-/var/lib/blaulichtcms-update}"
LOG="${BLAULICHTCMS_HELPER_LOG:-/var/log/blaulichtcms-update.log}"
LOCK_DIR="${BLAULICHTCMS_HELPER_LOCKDIR:-/run/lock}"
BRANCH="${BLAULICHTCMS_BRANCH:-main}"
SIGNERS="${BLAULICHTCMS_ALLOWED_SIGNERS:-/etc/blaulichtcms/allowed_signers}"
RELEASE_BASE="${BLAULICHTCMS_HELPER_RELEASE_BASE:-https://github.com}"
MIN_INTERVAL="${BLAULICHTCMS_HELPER_MIN_INTERVAL:-600}"
MAX_AGE=900
REQUEST_MAX=1024

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { # Abbruch; eine liegengebliebene Anfrage entfernen, damit systemd nicht erneut auslöst (als Benutzer des Volumes)
  say "FEHLER: $*" >&2
  [ -n "${RUN_UID:-}" ] && [ ! -L "$EXCHANGE" ] && as_vol rm -f -- "$EXCHANGE/request.json" 2>/dev/null
  exit 1
}
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
envget() { [ -f "$APP_DIR/.env" ] || return 0; sed -n "s/^$1=//p" "$APP_DIR/.env" | tail -1; }
# a > b (Versionen X.Y.Z)
ver_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

# ------------------------------------------------------------------------ Austauschordner im Datenvolume
[ -n "$EXCHANGE" ] || fail "BLAULICHTCMS_HELPER_EXCHANGE fehlt (Einrichtung über install.sh)."
case "$EXCHANGE" in /*/host-update) ;; *) fail "Austauschordner muss absolut sein und auf /host-update enden: $EXCHANGE" ;; esac
VOLROOT="${EXCHANGE%/host-update}"
[ -d "$VOLROOT" ] && [ ! -L "$VOLROOT" ] || fail "Datenvolume nicht gefunden: $VOLROOT"
RUN_UID="$(stat -c %u "$VOLROOT")"
RUN_GID="$(stat -c %g "$VOLROOT")"
[ "$RUN_UID" != 0 ] || fail "Das Datenvolume gehört root – erwartet ist der Benutzer des Containers. Abbruch."

# Befehl mit der Kennung des Volumes ausführen (ohne Zusatzgruppen, ohne neue Rechte)
as_vol() { setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups --no-new-privs -- "$@"; }
# Der Austauschordner darf kein symbolischer Link sein und muss genau dort liegen (Prüfung vor jedem Zugriff)
exchange_ok() {
  [ -L "$EXCHANGE" ] && return 1
  [ -d "$EXCHANGE" ] || as_vol mkdir -p -- "$EXCHANGE" 2>/dev/null || return 1
  [ "$(realpath -e -- "$EXCHANGE" 2>/dev/null)" = "$(realpath -e -- "$VOLROOT")/host-update" ]
}
# Datei atomar im Austauschordner ablegen (Inhalt von stdin) – mit der Kennung des Volumes
put_file() {
  exchange_ok || { cat >/dev/null; return 1; }
  as_vol sh -c 'umask 022; t="$1/.$2.$$"; cat > "$t" && mv -fT "$t" "$1/$2" || { rm -f "$t"; exit 1; }' sh "$EXCHANGE" "$1"
}

json_str() { # JSON-String (ohne Anführungszeichen) – Steuerzeichen entfernt
  printf '%s' "$1" | tr -d '\000-\010\013-\037\177' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | awk 'BEGIN{ORS=""} NR>1{print "\\n"} {print}'
}
# Zugangsdaten in Adressen (Proxy, Repo) nie in die App
redact() { sed -E -e 's#(://)[^/@[:space:]]+@#\1***@#g' -e 's#(Authorization:)[^[:space:]]*.*#\1 ***#I'; }

case "${1:-}" in
  announce)
    printf '{"v":1,"helperVersion":%s,"installedAt":"%s","appDir":"%s"}\n' "$HELPER_VERSION" "$(now_iso)" "$(json_str "$APP_DIR")" | put_file helper.json || fail "helper.json ließ sich nicht schreiben."
    say "Helfer in der App bekannt gemacht ($EXCHANGE/helper.json)"
    exit 0 ;;
  retract)
    if exchange_ok; then as_vol rm -f -- "$EXCHANGE/helper.json" "$EXCHANGE/request.json"; fi
    say "Bekanntmachung entfernt"
    exit 0 ;;
  run) ;;
  *) echo "Aufruf: $0 run|announce|retract" >&2; exit 2 ;;
esac

# ------------------------------------------------------------------------ Lauf
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
RUNLOG="$STATE_DIR/last-run.log"
# Protokoll begrenzen (eine Vorgängerdatei)
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 5242880 ]; then mv -f "$LOG" "$LOG.1"; fi
exec >>"$LOG" 2>&1

# Sperre: nie zwei Läufe gleichzeitig
if command -v flock >/dev/null; then
  exec 8>"$LOCK_DIR/blaulichtcms-update-helper.lock"
  flock -n 8 || { say "Es läuft bereits ein Helfer-Lauf – Auslösung ignoriert."; exit 0; }
fi

REQ_ID=""; REQ_USER=""; REQ_VERSION=""; STATE=running; PHASE=verify; STEP="Anfrage prüfen"; MESSAGE=""
FROM_VERSION=""; TARGET=""; IMAGE_NEW=""; BACKUP_FILE=""; STARTED="$(now_iso)"; FINISHED=""

write_status() {
  local tail=""
  [ -f "$RUNLOG" ] && tail="$(tail -n 40 "$RUNLOG" | redact)"
  if [ "$PHASE" = build ] && [ -f "$APP_DIR/build.log" ]; then
    tail="$tail
--- build.log (Auszug) ---
$(tail -n 12 "$APP_DIR/build.log" | cut -c1-300 | redact)"
  fi
  tail="$(printf '%s' "$tail" | tail -c 12000)"
  printf '{"v":1,"helperVersion":%s,"requestId":"%s","userId":"%s","state":"%s","phase":"%s","step":"%s","targetVersion":"%s","fromVersion":"%s","image":"%s","backupFile":"%s","message":"%s","startedAt":"%s","updatedAt":"%s","finishedAt":"%s","logTail":"%s"}\n' \
    "$HELPER_VERSION" "$REQ_ID" "$REQ_USER" "$STATE" "$PHASE" "$(json_str "$STEP")" "$TARGET" "$(json_str "$FROM_VERSION")" "$(json_str "$IMAGE_NEW")" \
    "$(json_str "$BACKUP_FILE")" "$(json_str "$MESSAGE")" "$STARTED" "$(now_iso)" "$FINISHED" "$(json_str "$tail")" \
    | put_file status.json || say "Hinweis: status.json ließ sich gerade nicht schreiben (Volume im Wechsel?)."
}
finish() { # finish <state> <meldung>
  STATE="$1"; MESSAGE="$2"; PHASE="done"; FINISHED="$(now_iso)"
  say "Ergebnis: $STATE – $MESSAGE"
  write_status
  exit 0
}
reject() { say "Abgelehnt: $*" | tee -a "$RUNLOG"; finish rejected "$*"; }

say "=== Auslösung durch $EXCHANGE/request.json"
exchange_ok || fail "Austauschordner unsicher oder nicht anlegbar: $EXCHANGE"
# Anfrage lesen (als Benutzer des Volumes, nur reguläre Datei, Größe begrenzt, Zeitlimit gegen FIFOs) und sofort
# entfernen – jede Anfrage wird genau einmal verarbeitet
if [ ! -e "$EXCHANGE/request.json" ] && [ ! -L "$EXCHANGE/request.json" ]; then say "Keine Anfrage vorhanden."; exit 0; fi
: > "$RUNLOG"
REQ=""
if [ -f "$EXCHANGE/request.json" ] && [ ! -L "$EXCHANGE/request.json" ]; then
  REQ="$(as_vol timeout 10 head -c $((REQUEST_MAX + 1)) -- "$EXCHANGE/request.json" 2>/dev/null || true)"
fi
as_vol rm -f -- "$EXCHANGE/request.json" || true
[ "${#REQ}" -le "$REQUEST_MAX" ] || reject "Anfrage zu groß."
REQ="$(printf '%s' "$REQ" | tr -d '\n')"
UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
RE="^\{\"v\":1,\"id\":\"($UUID)\",\"version\":\"([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6})\",\"requestedAt\":\"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z)\",\"userId\":\"($UUID)?\"\}$"
[[ "$REQ" =~ $RE ]] || reject "Anfrage hat nicht das erwartete Format – ignoriert."
REQ_ID="${BASH_REMATCH[1]}"; REQ_VERSION="${BASH_REMATCH[2]}"; REQ_AT="${BASH_REMATCH[3]}"; REQ_USER="${BASH_REMATCH[5]}"
say "Anfrage $REQ_ID: Version $REQ_VERSION, gestellt $REQ_AT" | tee -a "$RUNLOG"

# Alter der Anfrage (alte Anfragen, z. B. nach einem Neustart des Hosts, werden nicht nachgeholt)
req_epoch="$(date -u -d "$REQ_AT" +%s 2>/dev/null || echo 0)"
age=$(( $(date +%s) - req_epoch ))
[ "$age" -le "$MAX_AGE" ] && [ "$age" -ge -300 ] || reject "Anfrage ist älter als 15 Minuten oder liegt in der Zukunft (Uhrzeit von Host und Container prüfen)."

# Höchstens ein Lauf je 10 Minuten
if [ -f "$STATE_DIR/last-run" ]; then
  since=$(( $(date +%s) - $(stat -c %Y "$STATE_DIR/last-run") ))
  [ "$since" -ge "$MIN_INTERVAL" ] || reject "Der letzte Lauf ist erst $((since / 60)) Minuten her – höchstens ein Lauf je $((MIN_INTERVAL / 60)) Minuten."
fi
touch "$STATE_DIR/last-run"
# Läuft gerade ein install.sh von Hand?
if command -v flock >/dev/null && [ -e "$LOCK_DIR/blaulichtcms-install.lock" ]; then
  flock -n "$LOCK_DIR/blaulichtcms-install.lock" true || reject "Am Host läuft gerade install.sh – bitte später erneut anstoßen."
fi
write_status

# ------------------------------------------------------------------------ Release ermitteln und prüfen
[ -d "$APP_DIR/.git" ] || reject "$APP_DIR ist keine Installation von install.sh."
cd "$APP_DIR"
CHANNEL="${BLAULICHTCMS_UPDATE_CHANNEL:-$(envget BLAULICHTCMS_UPDATE_CHANNEL)}"
[ "$CHANNEL" != main ] || reject "Update-Kanal „main“: Der Helfer installiert nur freigegebene Release-Tags. Updates bitte am Host mit install.sh."
CUR_IMAGE="$(envget BLAULICHTCMS_IMAGE)"
FROM_VERSION="$(printf '%s' "$CUR_IMAGE" | sed -nE 's/^blaulichtcms:([0-9]+\.[0-9]+\.[0-9]+)(-.*)?$/\1/p')"
[ -n "$FROM_VERSION" ] || FROM_VERSION="$(tr -d '[:space:]' < VERSION 2>/dev/null || echo 0.0.0)"
STEP="Neuesten Release-Tag holen"; write_status
# Ohne --force: ein verschobener Tag lässt den Abruf scheitern (wie install.sh)
if ! out="$(GIT_TERMINAL_PROMPT=0 git fetch --tags origin "$BRANCH" 2>&1)"; then
  printf '%s\n' "$out" | redact >> "$RUNLOG"
  reject "Abruf des Repositorys fehlgeschlagen (verschobener Tag oder keine Verbindung) – Ausgabe im Protokoll."
fi
TAG="$(git tag -l 'v[0-9]*' --merged "origin/$BRANCH" --sort=-v:refname | head -1)"
[ -n "$TAG" ] || reject "Im Repository gibt es keinen Release-Tag."
TARGET="${TAG#v}"
printf '%s' "$TARGET" | grep -qE '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$' || reject "Tag $TAG ist keine Version."
[ "$TARGET" = "$REQ_VERSION" ] || reject "Das neueste Release ist $TARGET, angefragt war $REQ_VERSION – in der App erneut prüfen."
ver_gt "$TARGET" "$FROM_VERSION" || reject "Version $TARGET ist nicht neuer als das laufende Image ($FROM_VERSION) – kein Downgrade, keine Neuinstallation."
COMMIT="$(git rev-parse "refs/tags/$TAG^{commit}")"
say "Neuester Release-Tag: $TAG ($COMMIT), laufendes Image $FROM_VERSION" | tee -a "$RUNLOG"

STEP="Echtheit von $TAG prüfen"; write_status
checks=0
# a) Tag-Signatur (SSH allowed_signers bzw. GPG), wenn hinterlegt – wie install.sh
if [ -f "$SIGNERS" ] || [ "${BLAULICHTCMS_REQUIRE_SIGNED:-0}" = 1 ]; then
  if [ -f "$SIGNERS" ]; then vt=(git -c gpg.ssh.allowedSignersFile="$SIGNERS" verify-tag "$TAG"); else vt=(git verify-tag "$TAG"); fi
  "${vt[@]}" >/dev/null 2>&1 || reject "Die Signatur von $TAG ist ungültig oder unbekannt – Update abgelehnt."
  say "Signatur des Tags $TAG geprüft" | tee -a "$RUNLOG"; checks=$((checks + 1))
fi
# b) Ed25519-Signatur des Release-Pakets (wie In-App-Updates) und Commit im signierten Manifest
SLUG="$(git config --get remote.origin.url 2>/dev/null | sed -nE 's#^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$#\1#p' | sed 's/\.git$//')"
if [ -n "$SLUG" ]; then
  WORK="$STATE_DIR/verify"
  rm -rf "$WORK"; mkdir -p "$WORK"; chmod 755 "$WORK"
  zip="blaulichtcms-update-$TAG.zip"
  for f in "$zip" "$zip.sig"; do
    curl -fsSL --proto '=https' --proto-redir '=https' --max-time 600 --max-filesize 314572800 -o "$WORK/${f/$zip/release.zip}" "$RELEASE_BASE/$SLUG/releases/download/$TAG/$f" \
      || reject "Release-Datei $f zu $TAG nicht abrufbar – ohne signiertes Release-Paket kein Update."
  done
  cp scripts/host-update-verify.mjs "$WORK/verify.mjs"
  cp server/update-signing-key.pub "$WORK/key.pub"
  chmod 644 "$WORK"/*
  # Prüfung im bisherigen Image (Node.js, ohne Netz, ohne Rechte); Schlüssel und Prüfskript aus dem installierten Stand
  VIMG="${CUR_IMAGE:-blaulichtcms:local}"
  docker image inspect "$VIMG" >/dev/null 2>&1 || VIMG=blaulichtcms:local
  if ! vout="$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 \
      --memory 512m --pids-limit 64 -v "$WORK":/check:ro --entrypoint node "$VIMG" /check/verify.mjs /check/release.zip /check/release.zip.sig /check/key.pub "$TARGET" "$COMMIT" 2>&1)"; then
    printf '%s\n' "$vout" | tail -5 >> "$RUNLOG"
    rm -rf "$WORK"
    reject "Signaturprüfung des Release-Pakets $TAG fehlgeschlagen – Update abgelehnt."
  fi
  rm -rf "$WORK"
  say "Release-Paket $TAG: Ed25519-Signatur gültig, Manifest nennt Commit ${COMMIT:0:12}" | tee -a "$RUNLOG"; checks=$((checks + 1))
fi
[ "$checks" -gt 0 ] || reject "Für $TAG ist keine Echtheitsprüfung möglich (kein GitHub-Release und keine allowed_signers) – Update abgelehnt."

# ------------------------------------------------------------------------ install.sh nicht-interaktiv
say "Starte install.sh --unattended für $TAG" | tee -a "$RUNLOG"
PHASE=prepare; STEP="Programmcode holen"; write_status
# Ohne Terminal (stdin /dev/null): install.sh fragt nichts, --unattended installiert nichts nach und richtet nichts neu ein
BLAULICHTCMS_EXPECT_TAG="$TAG" bash "$APP_DIR/install.sh" --unattended </dev/null >>"$RUNLOG" 2>&1 &
pid=$!
last_write=0
phase_of() { # Phase aus der letzten Schrittmeldung von install.sh bzw. scripts/update.sh
  case "$1" in
    "== "[1-5]/8*) echo prepare ;;
    "== 6/8"*) echo build ;;
    "== 7/8 Update"*|"== 0. "*|"== 1. "*|"== 1./2. "*|"== 2. "*|"== 3. "*) echo backup ;;
    "== 7/8"*|"== 4. "*) echo switch ;;
    "== 5. "*) echo check ;;
    "== Rückweg"*|"== Zurück auf"*) echo rollback ;;
    "== 8/8"*|"== Update erfolgreich"*|"== Reverse Proxy"*) echo finish ;;
    *) echo "" ;;
  esac
}
while kill -0 "$pid" 2>/dev/null; do
  sleep 5
  line="$(grep -E '^== ([1-8]/8|[0-5]\. |1\./2\. |Rückweg|Zurück auf|Update erfolgreich|Reverse Proxy)' "$RUNLOG" | tail -1 || true)"
  p="$(phase_of "$line")"
  changed=0
  if [ -n "$p" ] && { [ "$p" != "$PHASE" ] || [ "${line#== }" != "$STEP" ]; }; then PHASE="$p"; STEP="${line#== }"; changed=1; fi
  if [ "$changed" = 1 ] || [ $(( $(date +%s) - last_write )) -ge 30 ]; then write_status; last_write=$(date +%s); fi
done
rc=0; wait "$pid" || rc=$?

IMAGE_NEW="$(sed -nE 's/^== Aktuell: .*  →  Neu: (.*)$/\1/p' "$RUNLOG" | tail -1)"
BACKUP_FILE="$(sed -n 's/^Sicherung geschrieben: //p' "$RUNLOG" | tail -1)"; BACKUP_FILE="${BACKUP_FILE##*/}"
reason="$(sed -n "s/^.*✘ //p" "$RUNLOG" | tail -1 | sed "s/ (Ausgabe oben)//")"
now_image="$(envget BLAULICHTCMS_IMAGE)"
case "$rc" in
  0) finish success "Update auf Version $TARGET abgeschlossen (Image $now_image)." ;;
  3) finish aborted "${reason:-Update vor dem Imagewechsel abgebrochen – es läuft weiter Version $FROM_VERSION.}" ;;
  4) finish rolled_back "${reason:-Das neue Image startete nicht sauber – automatischer Rückweg erfolgreich.}" ;;
  5) finish failed "${reason:-Update fehlgeschlagen und nicht automatisch zurückgenommen.} Handeln am Host nötig: Protokoll $LOG." ;;
  *)
    case "$now_image" in
      "blaulichtcms:$TARGET-"*) finish success "Update auf Version $TARGET abgeschlossen; danach meldete install.sh einen Fehler: ${reason:-Exit-Code $rc}" ;;
    esac
    if grep -q '^== 4\. Image wechseln' "$RUNLOG"; then
      finish failed "${reason:-install.sh endete mit Exit-Code $rc} – Zustand am Host prüfen (Protokoll $LOG)."
    fi
    finish aborted "${reason:-install.sh endete mit Exit-Code $rc} Es läuft weiter Version $FROM_VERSION." ;;
esac
