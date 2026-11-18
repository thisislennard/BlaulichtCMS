#!/usr/bin/env bash
# ============================================================================================================
#  Update-Wege mit echtem Docker (#275) – für die CI (.github/workflows/ci.yml, Jobs „update-helfer“ und
#  „update-handweg“) auf einem Wegwerf-Host mit systemd, Docker und sudo.
#
#  ACHTUNG: verändert /opt/apps/blaulichtcms, /opt/apps/blaulichtcms-sicherungen, /etc/blaulichtcms, systemd-Units und
#  Docker-Volumes – nie auf einem Host mit echten Daten ausführen.
#
#    test/docker/update-wege.sh <schritt>
#
#  vorbereiten   Testquelle /srv/blaulichtcms-upstream aus dieser Arbeitskopie (Zweig citest auf v0.7.0)
#  install-070   Erstinstallation 0.7.0 mit install.sh 0.7.0 (von Hand, umask 022) samt Update-Helfer; Datenstand
#  release       Folge-Release v0.7.99 = geprüfter Stand + Versionssprung (VERSION, package.json, Lock), Tag SSH-signiert
#                und /etc/blaulichtcms/allowed_signers – so prüfen Helfer und install.sh die Echtheit
#  helfer        Image-Update über den Update-Helfer unter systemd (UMask=0077) wie aus der App angestoßen:
#                Helfer 0.7.0 → install.sh 0.7.0 → Checkout v0.7.99 unter umask 077 → neues install.sh → Erfolg
#  rueckweg      update.sh auf ein Image, das nicht startet; Sicherung und Schlüssel root-eigen 0600 → Exit 4,
#                Datenstand von vor dem Update, Protokoll des Containers in der Ausgabe
#  pruefung      wie rueckweg, die Sicherung besteht die Prüfung aber nicht (Schlüssel getauscht) → Exit 5, Volume
#                bleibt; danach die ausgegebene Anleitung „Rückweg von Hand“ ausführen → bisheriges Image gesund
#  selbsttest    update.sh auf ein Image mit für den Laufzeitbenutzer unlesbarer Datei → Exit 3, nichts geändert
#  handweg       install.sh 0.7.0 von Hand mit umask 077 auf v0.7.99; ein fehlerhaftes Image mit dem Ziel-Namen
#                existiert schon (wie nach dem Vorfall) → wird ohne Cache neu gebaut, Update erfolgreich
# ============================================================================================================
# SC1111: deutsche Anführungszeichen in Meldungen sind gewollt; SC2024: Protokolle gehören dem CI-Benutzer
# shellcheck disable=SC1111,SC2024
set -euo pipefail
STEP="${1:?Aufruf: test/docker/update-wege.sh <schritt>}"
WS="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="${RUNNER_TEMP:-/tmp}/update-wege"
mkdir -p "$TMP"
APP=/opt/apps/blaulichtcms
UP=/srv/blaulichtcms-upstream
SICH=/opt/apps/blaulichtcms-sicherungen
KEY=/etc/blaulichtcms/backup.key
BASE=v0.7.0
REL=0.7.99

say() { echo; echo "### $*"; }
fail() { echo "FEHLER: $*" >&2; exit 1; }
dc() { (cd "$APP" && sudo docker compose "$@"); }
health_ok() { dc exec -T blaulichtcms node -e "fetch('http://127.0.0.1:7310/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; }
wait_healthy() {
  local i
  for i in $(seq 1 90); do health_ok && return 0; sleep 2; done
  dc logs --tail 60 blaulichtcms || true
  return 1
}
psqlc() { dc exec -T blaulichtcms psql -h /tmp/blaulichtcms-pg -U blaulichtcms -d blaulichtcms -tAc "$1"; }
envimg() { sudo sed -n 's/^BLAULICHTCMS_IMAGE=//p' "$APP/.env" | tail -1; }
archives() { sudo find "$SICH/vor-update" -maxdepth 1 -type f -name 'blaulichtcms-*.tar.gz.enc' | sort; }
# Datenstand: Datei im Volume und Zeile in der Datenbank
check_data() { # check_data <erwarteter-marker>
  local m r
  m="$(dc exec -T blaulichtcms cat /data/ci-marker.txt)"
  [ "$m" = "$1" ] || fail "Marker im Volume ist „$m“, erwartet „$1“"
  r="$(psqlc "SELECT value #>> '{}' FROM settings WHERE key = 'ci.marker'")"
  [ "$r" = vor-update ] || fail "Zeile ci.marker in der Datenbank fehlt oder abweichend: „$r“"
  echo "Datenstand in Ordnung (Marker „$m“, Datenbankzeile vorhanden)"
}
check_maintenance_off() {
  local v
  v="$(psqlc "SELECT coalesce((SELECT value::text FROM settings WHERE key = 'system.maintenance'), 'null')")"
  [ "$v" = null ] || fail "Wartungsmodus ist noch an: $v"
  echo "Wartungsmodus aus"
}
# Versionierte Dateien im Installationsordner: alle 0644/0755 (#275), .env bleibt 0600
check_modes() {
  local bad
  bad="$(cd "$APP" && sudo git ls-files -z | sudo xargs -0 stat -c '%a %n' | awk '$1 != "644" && $1 != "755"' | head -20)"
  [ -z "$bad" ] || { echo "$bad"; fail "Versionierte Dateien in $APP mit anderen Rechten als 0644/0755 (siehe oben)"; }
  bad="$(cd "$APP" && sudo git ls-tree -r -d -z --name-only HEAD | sudo xargs -0 stat -c '%a %n' | awk '$1 != "755"' | head -20)"
  [ -z "$bad" ] || { echo "$bad"; fail "Ordner in $APP mit anderen Rechten als 0755 (siehe oben)"; }
  [ "$(sudo stat -c %a "$APP/.env")" = 600 ] || fail ".env ist nicht mehr 0600"
  echo "Rechte in $APP: versionierte Dateien 0644/0755, Ordner 0755, .env 0600"
}
check_backup_modes() {
  local a
  a="$(archives | tail -1)"
  [ -n "$a" ] || fail "keine Sicherung in $SICH/vor-update"
  sudo stat -c '%a %U %n' "$SICH" "$SICH/vor-update" "$a" "$a.sha256" "$KEY"
  [ "$(sudo stat -c '%a %U' "$a")" = "600 root" ] || fail "Sicherung ist nicht root-eigen 0600"
  [ "$(sudo stat -c '%a %U' "$KEY")" = "600 root" ] || fail "Schlüssel ist nicht root-eigen 0600"
  [ "$(sudo stat -c '%a' "$SICH/vor-update")" = 700 ] || fail "Sicherungsordner ist nicht 0700"
}
# update.sh wie install.sh es aufruft: als root, hier mit umask 077 (wie unter dem Update-Helfer)
run_update() { # run_update <image> <protokoll>
  local rc=0
  sudo env BLAULICHTCMS_HEALTH_TIMEOUT=90 bash -c 'umask 077; cd "$1" && scripts/update.sh "$2" "$3" --rollback' _ "$APP" "$1" "$SICH/vor-update" >"$2" 2>&1 || rc=$?
  cat "$2"
  return "$rc"
}
derived_image() { # derived_image <name> <dockerfile-zeilen nach FROM>
  local d="$TMP/img-$1"
  rm -rf "$d"; mkdir -p "$d"
  printf 'FROM %s\n%s\n' "$(envimg)" "$2" > "$d/Dockerfile"
  sudo docker build -q -t "$1" "$d" >/dev/null
  echo "Image $1 gebaut (aus $(envimg))"
}

case "$STEP" in
  vorbereiten)
    say "Testquelle $UP (Zweig citest auf $BASE, geprüfter Stand als ci-head)"
    git -C "$WS" rev-parse --verify -q "$BASE^{commit}" >/dev/null || fail "Tag $BASE fehlt – Checkout mit fetch-depth: 0"
    rm -rf "$TMP/upstream"
    git clone -q --no-local "$WS" "$TMP/upstream"
    git -C "$TMP/upstream" branch -f ci-head "$(git -C "$WS" rev-parse HEAD)"
    git -C "$TMP/upstream" checkout -q -B citest "$BASE"
    sudo rm -rf "$UP"; sudo mkdir -p "$(dirname "$UP")"
    sudo mv "$TMP/upstream" "$UP"
    sudo chown -R root:root "$UP"
    sudo git -C "$UP" config user.name "BlaulichtCMS CI"
    sudo git -C "$UP" config user.email ci@example.invalid
    sudo git -C "$UP" log -1 --format='citest: %h %s' citest
    sudo git -C "$UP" log -1 --format='ci-head: %h %s' ci-head ;;

  install-070)
    say "Erstinstallation $BASE mit install.sh $BASE (wie von Hand: sudo, umask 022) samt Update-Helfer"
    sudo git -C "$UP" show "$BASE:install.sh" > "$TMP/install-070.sh"
    sudo env BLAULICHTCMS_REPO="$UP" BLAULICHTCMS_BRANCH=citest BLAULICHTCMS_PUBLIC_URL=http://localhost \
      BLAULICHTCMS_PROXY_MODE=2 bash "$TMP/install-070.sh" --yes --no-cron --with-helper
    wait_healthy || fail "$BASE startet nicht"
    systemctl is-enabled blaulichtcms-update.path
    grep -E '^(UMask|ExecStart)=' /etc/systemd/system/blaulichtcms-update.service
    say "Datenstand anlegen"
    dc exec -T blaulichtcms sh -c 'echo vor-update > /data/ci-marker.txt'
    psqlc "INSERT INTO settings (key, value) VALUES ('ci.marker', '\"vor-update\"'::jsonb)"
    check_data vor-update
    echo "läuft: $(envimg), Stand $(sudo git -C "$APP" describe --tags)" ;;

  release)
    say "Folge-Release v$REL: geprüfter Stand + Versionssprung, Tag SSH-signiert"
    rm -f "$TMP/ci-sign" "$TMP/ci-sign.pub"
    ssh-keygen -q -t ed25519 -N '' -C ci@example.invalid -f "$TMP/ci-sign"
    sudo install -d -m 700 /etc/blaulichtcms
    printf 'ci@example.invalid %s\n' "$(cut -d' ' -f1,2 "$TMP/ci-sign.pub")" | sudo tee /etc/blaulichtcms/allowed_signers >/dev/null
    sudo git -C "$UP" checkout -q -B citest ci-head
    # Wie ein echter Versions-Commit: auch server/package.json ändert sich – genau die Datei, die beim Vorfall mit 0600
    # ausgecheckt wurde und im Container nicht lesbar war
    sudo python3 - "$UP" "$REL" <<'PY'
import json, re, sys
up, rel = sys.argv[1], sys.argv[2]
open(f'{up}/VERSION', 'w').write(rel + '\n')
for f in ('server/package.json', 'web/package.json'):
    p = f'{up}/{f}'
    s = open(p, encoding='utf-8').read()
    open(p, 'w', encoding='utf-8').write(re.sub(r'"version": "[^"]+"', f'"version": "{rel}"', s, count=1))
p = f'{up}/package-lock.json'
lock = json.load(open(p, encoding='utf-8'))
for ws in ('server', 'web'):
    lock['packages'][ws]['version'] = rel
open(p, 'w', encoding='utf-8').write(json.dumps(lock, indent=2, ensure_ascii=False) + '\n')
PY
    sudo git -C "$UP" commit -qam "CI: Testrelease $REL"
    sudo git -C "$UP" -c gpg.format=ssh -c user.signingkey="$TMP/ci-sign" tag -s "v$REL" -m "CI-Testrelease $REL"
    sudo git -C "$UP" -c gpg.ssh.allowedSignersFile=/etc/blaulichtcms/allowed_signers verify-tag "v$REL"
    sudo git -C "$UP" diff --stat "$BASE" "v$REL" -- server/package.json install.sh Dockerfile scripts | tail -3 ;;

  helfer)
    say "Image-Update über den Update-Helfer (systemd, UMask=0077), angestoßen wie aus der App"
    mp="$(sudo docker volume inspect -f '{{.Mountpoint}}' blaulichtcms_data)"
    req_id="$(cat /proc/sys/kernel/random/uuid)"
    line="$(printf '{"v":1,"id":"%s","version":"%s","requestedAt":"%s","userId":""}' "$req_id" "$REL" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)")"
    # Atomar wie die App (sonst könnte der Helfer eine halb geschriebene Datei lesen)
    printf '%s\n' "$line" | dc exec -T blaulichtcms sh -c 'cat > /data/host-update/.anfrage && mv /data/host-update/.anfrage /data/host-update/request.json'
    state=""
    for i in $(seq 1 300); do
      st="$(sudo cat "$mp/host-update/status.json" 2>/dev/null || true)"
      case "$st" in *"\"requestId\":\"$req_id\""*) state="$(printf '%s' "$st" | sed -n 's/.*"state":"\([a-z_]*\)".*/\1/p')" ;; esac
      case "$state" in success|rolled_back|aborted|failed|rejected) break ;; esac
      sleep 5
    done
    echo "--- /var/lib/blaulichtcms-update/last-run.log ---"; sudo cat /var/lib/blaulichtcms-update/last-run.log || true
    echo "--- /var/log/blaulichtcms-update.log ---"; sudo cat /var/log/blaulichtcms-update.log || true
    echo "--- status.json ---"; sudo cat "$mp/host-update/status.json" || true; echo
    [ "$state" = success ] || fail "Helfer-Lauf endete mit „${state:-ohne Ergebnis}“"
    run="$(sudo cat /var/lib/blaulichtcms-update/last-run.log)"
    # Die Kette: install.sh 0.7.0 holt v0.7.99 und startet das neue install.sh, das Rechte richtet und das Image prüft
    grep -q 'install.sh wurde aktualisiert – weiter mit der neuen Fassung' <<<"$run" || fail "install.sh hat sich nicht mit der neuen Fassung neu gestartet"
    grep -q 'Selbsttest bestanden' <<<"$run" || fail "Selbsttest in install.sh fehlt"
    grep -q '^== Selbsttest des neuen Images' <<<"$run" || fail "Selbsttest in update.sh fehlt"
    [ "$(envimg)" = "blaulichtcms:$REL-$(sudo git -C "$APP" rev-parse --short HEAD)" ] || fail "BLAULICHTCMS_IMAGE ist $(envimg)"
    wait_healthy || fail "v$REL ist nach dem Update nicht gesund"
    [ "$(dc exec -T blaulichtcms cat /app/VERSION)" = "$REL" ] || fail "Container meldet nicht Version $REL"
    check_data vor-update
    check_maintenance_off
    check_modes
    check_backup_modes ;;

  rueckweg)
    say "update.sh auf ein Image, das nicht startet: automatischer Rückweg mit root-eigener Sicherung"
    old="$(envimg)"
    derived_image blaulichtcms:ci-startet-nicht 'ENTRYPOINT ["sh", "-c", "echo neu > /data/ci-marker.txt; echo CI-Testimage: Start absichtlich abgebrochen >&2; exit 1"]'
    n0="$(archives | wc -l)"
    rc=0; run_update blaulichtcms:ci-startet-nicht "$TMP/rueckweg.log" || rc=$?
    [ "$rc" = 4 ] || fail "update.sh endete mit $rc, erwartet 4 (Rückweg erfolgreich)"
    grep -q 'CI-Testimage: Start absichtlich abgebrochen' "$TMP/rueckweg.log" || fail "Protokoll des neuen Containers fehlt in der Ausgabe"
    grep -q '^Prüfung bestanden' "$TMP/rueckweg.log" || fail "Sicherung wurde vor dem Rückweg nicht geprüft"
    [ "$(archives | wc -l)" -gt "$n0" ] || fail "keine neue Sicherung"
    check_backup_modes
    [ "$(envimg)" = "$old" ] || fail "BLAULICHTCMS_IMAGE ist $(envimg), erwartet $old"
    wait_healthy || fail "bisheriges Image nach dem Rückweg nicht gesund"
    check_data vor-update
    check_maintenance_off ;;

  pruefung)
    say "Rückweg, bei dem die Sicherung die Prüfung nicht besteht: Volume bleibt, danach Rückweg von Hand"
    old="$(envimg)"
    sudo cp -p "$KEY" /root/ci-backup.key.orig
    rc=0
    sudo env BLAULICHTCMS_HEALTH_TIMEOUT=90 bash -c 'umask 077; cd "$1" && scripts/update.sh "$2" "$3" --rollback' _ "$APP" blaulichtcms:ci-startet-nicht "$SICH/vor-update" >"$TMP/pruefung.log" 2>&1 &
    pid=$!
    # Nach der Sicherung und dem Wechsel den Schlüssel tauschen: Die Prüfung vor dem Rückweg muss dann scheitern
    for _ in $(seq 1 300); do grep -q '^== 4\. Image wechseln' "$TMP/pruefung.log" && break; sleep 2; done
    grep -q '^== 4\. Image wechseln' "$TMP/pruefung.log" || { cat "$TMP/pruefung.log"; fail "update.sh kam nicht bis zum Wechsel"; }
    head -c 32 /dev/urandom | base64 | sudo tee "$KEY" >/dev/null
    wait "$pid" || rc=$?
    cat "$TMP/pruefung.log"
    [ "$rc" = 5 ] || fail "update.sh endete mit $rc, erwartet 5"
    sudo docker volume inspect blaulichtcms_data >/dev/null || fail "Datenvolume wurde entfernt"
    grep -q 'besteht die Prüfung nicht' "$TMP/pruefung.log" || fail "Meldung zur gescheiterten Prüfung fehlt"
    vol="$(sudo docker run --rm -u 0 --network none -v blaulichtcms_data:/data --entrypoint sh "$old" -c 'cat /data/ci-marker.txt; test -f /data/postgres/PG_VERSION && echo pg-ok')"
    echo "Volume nach Exit 5: $(echo "$vol" | tr '\n' ' ')"
    grep -q pg-ok <<<"$vol" || fail "Datenbank im Volume fehlt"
    [ -z "$(dc ps -q --status running blaulichtcms)" ] || fail "neuer Container läuft noch"
    say "Ursache beheben (richtigen Schlüssel zurück) und die ausgegebene Anleitung ausführen"
    sudo cp -p /root/ci-backup.key.orig "$KEY"
    awk '/^Rückweg von Hand/{f=1; next} f && /^  /{sub(/^  /, ""); print; next} f{exit}' "$TMP/pruefung.log" > "$TMP/von-hand.sh"
    echo "--- ausgegebene Anleitung ---"; cat "$TMP/von-hand.sh"
    grep -q 'scripts/verify-backup.sh' "$TMP/von-hand.sh" || fail "Anleitung prüft die Sicherung nicht zuerst"
    sudo bash -e "$TMP/von-hand.sh"
    [ "$(envimg)" = "$old" ] || fail "BLAULICHTCMS_IMAGE ist $(envimg), erwartet $old"
    wait_healthy || fail "bisheriges Image nach dem Rückweg von Hand nicht gesund"
    check_data vor-update
    check_maintenance_off ;;

  selbsttest)
    say "update.sh auf ein Image mit unlesbarer Programmdatei: Abbruch vor jeder Änderung"
    old="$(envimg)"
    cid="$(dc ps -q blaulichtcms)"
    derived_image blaulichtcms:ci-unlesbar $'USER root\nRUN chmod 600 /app/server/package.json\nUSER blaulichtcms'
    n0="$(archives | wc -l)"
    rc=0; run_update blaulichtcms:ci-unlesbar "$TMP/selbsttest.log" || rc=$?
    [ "$rc" = 3 ] || fail "update.sh endete mit $rc, erwartet 3"
    grep -q 'besteht den Selbsttest nicht' "$TMP/selbsttest.log" || fail "Meldung zum Selbsttest fehlt"
    grep -q '/app/server/package.json' "$TMP/selbsttest.log" || fail "Selbsttest nennt die unlesbare Datei nicht"
    ! grep -q '^== 1\. ' "$TMP/selbsttest.log" || fail "Wartungsmodus wurde eingeschaltet"
    [ "$(archives | wc -l)" = "$n0" ] || fail "trotzdem gesichert"
    [ "$(dc ps -q blaulichtcms)" = "$cid" ] || fail "Container wurde ersetzt"
    [ "$(envimg)" = "$old" ] || fail ".env geändert"
    health_ok || fail "BlaulichtCMS läuft nicht mehr"
    check_maintenance_off ;;

  handweg)
    say "install.sh $BASE von Hand mit umask 077 auf v$REL; fehlerhaftes Image mit dem Ziel-Namen existiert schon"
    sudo systemctl stop blaulichtcms-update.path   # wie am Produktivhost nach dem Vorfall
    target="blaulichtcms:$REL-$(sudo git -C "$UP" rev-parse --short "v$REL^{commit}")"
    derived_image "$target" $'USER root\nRUN chmod 600 /app/server/package.json\nUSER blaulichtcms'
    rc=0
    # Zweig der Testquelle (am Produktivhost main, Standard)
    sudo env BLAULICHTCMS_BRANCH=citest bash -c 'umask 077; cd /; bash "$1/install.sh" --yes --no-cron' _ "$APP" >"$TMP/handweg.log" 2>&1 || rc=$?
    cat "$TMP/handweg.log"
    [ "$rc" = 0 ] || fail "install.sh endete mit $rc"
    grep -q 'install.sh wurde aktualisiert – weiter mit der neuen Fassung' "$TMP/handweg.log" || fail "kein Neustart mit dem neuen install.sh"
    grep -q 'besteht den Selbsttest nicht – es wird entfernt und ohne Cache neu gebaut' "$TMP/handweg.log" || fail "vorhandenes fehlerhaftes Image wurde nicht erkannt"
    [ "$(envimg)" = "$target" ] || fail "BLAULICHTCMS_IMAGE ist $(envimg), erwartet $target"
    bash "$WS/scripts/image-selftest.sh" "$target"
    wait_healthy || fail "v$REL nicht gesund"
    [ "$(dc exec -T blaulichtcms cat /app/VERSION)" = "$REL" ] || fail "Container meldet nicht Version $REL"
    check_data vor-update
    check_maintenance_off
    check_modes
    check_backup_modes
    echo "Update-Helfer nach install.sh: $(systemctl is-active blaulichtcms-update.path || true)" ;;

  *) fail "Unbekannter Schritt: $STEP" ;;
esac
echo "### $STEP: bestanden"
