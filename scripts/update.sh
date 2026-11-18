#!/usr/bin/env bash
# Update von BlaulichtCMS am Docker-Host: Sichern → Wechseln → Prüfen → (bei Fehler) Wiederherstellen.
#
#   scripts/update.sh <neues-image> [sicherungsordner] [--rollback]
#   z. B. scripts/update.sh ghcr.io/<organisation>/blaulichtcms:0.5.0 /srv/blaulichtcms-sicherungen
#
# Ablauf:
#   S. Selbsttest des neuen Images (scripts/image-selftest.sh: ohne Netz, als Benutzer des Images, #275)
#   0. Platz für die Sicherung prüfen (vor dem Wartungsmodus)
#   1. Vorabprüfung im laufenden Container, Wartungsmodus an (keine neuen schreibenden Vorgänge, keine neuen Aufträge)
#   2. warten, bis laufende Aufträge fertig sind
#   3. vollständige Sicherung des Volumes außerhalb des Volumes (scripts/backup-volume.sh)
#   4. Image wechseln (BLAULICHTCMS_IMAGE in .env), Container neu starten, Schema-Migration mit Startprüfung
#   5. Healthcheck und Selbsttest; Wartungsmodus aus
#   Bricht Schritt S–3 ab: Wartungsmodus wird wieder beendet, der bisherige Stand läuft weiter.
#   Ist der Container gestoppt, entfallen Schritt 1 und 2; Sicherung, Wechsel und Rückweg laufen wie sonst (#155).
#   Schlägt Schritt 4/5 fehl: Protokoll des neuen Containers ausgeben, dann vorheriges Image + Sicherung aus Schritt 3
#   wiederherstellen (automatisch mit --rollback). Das Volume wird erst ersetzt, wenn die Sicherung geprüft ist
#   (scripts/verify-backup.sh); scheitert die Prüfung, bleibt es unverändert und der neue Container angehalten (#275).
#
# Wartezeit auf einen gesunden Start (neues Image, nach einem Rückweg das bisherige): BLAULICHTCMS_HEALTH_TIMEOUT
# Sekunden (Standard 180).
#
# Aufbewahrung im Sicherungsordner (#117): nach jeder neuen Sicherung bleiben die letzten BLAULICHTCMS_KEEP_PRE_UPDATE
# (Standard 3) Stände; Stände älter als BLAULICHTCMS_PRE_UPDATE_MAX_DAYS (Standard 90) Tage entfernt backup-cron.sh.
#
# Exit-Codes (für install.sh):
#   0  Update erfolgreich
#   3  vor dem Wechsel abgebrochen – bisheriger Stand läuft weiter, Wartungsmodus beendet
#   4  Wechsel fehlgeschlagen, automatischer Rückweg erfolgreich (altes Image, Datenstand von vor dem Update)
#   5  Wechsel fehlgeschlagen ohne (erfolgreichen) Rückweg – Handeln nötig (Anleitung in der Ausgabe); auch, wenn die
#      Sicherung vor dem Rückweg die Prüfung nicht besteht (Datenvolume dann unverändert)
set -euo pipefail
NEW_IMAGE="${1:?Aufruf: scripts/update.sh <neues-image> [sicherungsordner] [--rollback]}"
BACKUP_DIR="${2:-./sicherungen}"
AUTO_ROLLBACK=0
for a in "$@"; do [ "$a" = "--rollback" ] && AUTO_ROLLBACK=1; done
cd "$(dirname "$0")/.."
VOLUME="${BLAULICHTCMS_VOLUME:-blaulichtcms_data}"
KEEP_PRE_UPDATE="${BLAULICHTCMS_KEEP_PRE_UPDATE:-3}"
case "$KEEP_PRE_UPDATE" in ''|*[!0-9]*|0) echo "BLAULICHTCMS_KEEP_PRE_UPDATE muss eine Zahl ab 1 sein." >&2; exit 2 ;; esac
HEALTH_TIMEOUT="${BLAULICHTCMS_HEALTH_TIMEOUT:-180}"
case "$HEALTH_TIMEOUT" in ''|*[!0-9]*) echo "BLAULICHTCMS_HEALTH_TIMEOUT muss eine Zahl (Sekunden) sein." >&2; exit 2 ;; esac
[ "$HEALTH_TIMEOUT" -ge 10 ] || HEALTH_TIMEOUT=10
KEY_FILE="${BLAULICHTCMS_BACKUP_KEY_FILE:-/etc/blaulichtcms/backup.key}"
# Gesundheitsprüfung im Container (#71): unabhängig von BLAULICHTCMS_PORT/BLAULICHTCMS_BIND in .env
health() { docker compose exec -T blaulichtcms node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7310)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; }
health_text() { docker compose exec -T blaulichtcms node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7310)+'/healthz').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log(String(e)))"; }
cli() { docker compose exec -T blaulichtcms node server/dist/cli.js "$@"; }
wait_health() { local i; for i in $(seq 1 $((HEALTH_TIMEOUT / 2))); do health && return 0; sleep 2; done; return 1; }
# Zugangsdaten in Adressen und den Einrichtungsschlüssel nie in Ausgabe und Protokolle (wie der Update-Helfer)
redact() { sed -E -e 's#(://)[^/@[:space:]]+@#\1***@#g' -e 's#(Authorization:)[^[:space:]]*.*#\1 ***#I' -e 's#(Einrichtungsschlüssel:) *[^ ]+#\1 ***#g'; }
# Protokoll des neuen Containers sichern, bevor der Rückweg ihn entfernt (#275) – landet in der Ausgabe, beim
# Update-Helfer damit im Protokoll und als Auszug in der App
container_logs() {
  echo "--- Protokoll des neuen Containers (letzte 150 Zeilen) ---"
  docker compose logs --no-color --tail 150 blaulichtcms 2>&1 | redact | cut -c1-500 || true
  echo "--- Ende des Protokolls ---"
}
envset() { # Schlüssel in .env setzen
  touch .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
# Eigene temporäre Dateien (mktemp, nur für root lesbar) statt fester Namen in /tmp (#126)
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/blaulichtcms-update.XXXXXXXX")"

# Abbruch an jeder Stelle sauber behandeln (#120): Phase bestimmt, was beim Verlassen zu tun ist
#   vorbereitung – noch nichts verändert
#   wartung      – Wartungsmodus an, altes Image läuft → Wartungsmodus wieder aus
#   wechsel      – .env zeigt auf das neue Image → Rückweg (oder Anleitung)
#   rueckweg     – Rückweg läuft; Abbruch hier = Handeln nötig
#   fertig       – regulär beendet
PHASE=vorbereitung
ARCHIVE=""
OLD_IMAGE=""
# Rückweg von Hand (#275): als root im Installationsordner. Erst wird die Sicherung geprüft, nur dann das Volume
# ersetzt. Die eingerückten Zeilen sind genau so ausführbar (die CI führt sie aus).
rollback_help() {
  local img="${OLD_IMAGE:-<bisheriges-image>}" arc="${ARCHIVE:-<sicherung-von-vor-dem-update>}" q_arc pre
  q_arc="$(printf '%q' "$arc")"
  {
    [ -n "${1:-}" ] && echo "$1"
    echo "Rückweg von Hand – als root, Befehle der Reihe nach (das Volume wird erst nach bestandener Prüfung der Sicherung ersetzt):"
    printf '  cd %q\n' "$PWD"
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      echo "  # Das bisherige Image $img fehlt: den bisherigen Stand auschecken und mit genau diesem Namen bauen (docker build -t $img .)"
    fi
    # Umgebung nur je Aufruf, nicht exportieren: ein exportiertes BLAULICHTCMS_IMAGE ginge späteren Compose-Aufrufen vor .env
    pre="$(printf 'BLAULICHTCMS_IMAGE=%q BLAULICHTCMS_BACKUP_KEY_FILE=%q' "$img" "$KEY_FILE")"
    [ "$VOLUME" = blaulichtcms_data ] || pre="$pre $(printf 'BLAULICHTCMS_VOLUME=%q' "$VOLUME")"
    # Ein einziger, mit && verketteter Befehl: scheitert ein Schritt, unterbleiben alle folgenden (auch beim Einfügen
    # des ganzen Blocks auf einmal)
    printf '  %s scripts/verify-backup.sh %s \\\n' "$pre" "$q_arc"
    printf '    && docker compose down && docker volume rm -f %q \\\n' "$VOLUME"
    printf '    && %s scripts/restore-volume.sh %s \\\n' "$pre" "$q_arc"
    printf "    && sed -i 's|^BLAULICHTCMS_IMAGE=.*|BLAULICHTCMS_IMAGE=%s|' .env \\\\\n" "$img"
    echo "    && docker compose up -d --no-build"
    echo '  # Die Sicherung entstand im Wartungsmodus: beenden, sobald der Container bereit ist'
    echo '  for i in $(seq 1 60); do docker compose exec -T blaulichtcms node server/dist/cli.js maintenance off && break; sleep 5; done'
    echo
  } >&2
}
on_exit() {
  local code=$?
  rm -rf "$TMP_DIR"
  [ "$PHASE" = fertig ] && exit "$code"
  [ "$code" = 0 ] && exit 0
  case "$PHASE" in
    vorbereitung)
      echo "!! Update abgebrochen, bevor etwas geändert wurde – BlaulichtCMS läuft unverändert weiter." >&2
      exit 3 ;;
    wartung)
      echo "!! Update vor dem Imagewechsel abgebrochen – Wartungsmodus wird beendet." >&2
      # backup-volume.sh startet den Container nach einem Abbruch wieder; erst wenn er bereit ist, greift die CLI
      for i in $(seq 1 90); do health && break; sleep 2; done
      if cli maintenance off >&2; then
        echo "!! BlaulichtCMS läuft weiter mit dem bisherigen Stand ($OLD_IMAGE)." >&2
        exit 3
      fi
      echo "!! Wartungsmodus ließ sich nicht beenden. Von Hand: docker compose exec blaulichtcms node server/dist/cli.js maintenance off" >&2
      exit 5 ;;
    wechsel|rueckweg)
      echo "!! Update abgebrochen, nachdem .env bereits auf das neue Image zeigte (Phase $PHASE)." >&2
      rollback_help
      exit 5 ;;
  esac
  exit "$code"
}
trap on_exit EXIT

OLD_IMAGE="$(docker compose config --images | head -1)"
# Das Image des bestehenden Containers fest benennen (#121): Zeigt der Tag aus .env inzwischen auf ein anderes Image
# (z. B. blaulichtcms:local, neu gebaut), liefe der Rückweg sonst mit dem NEUEN Code.
OLD_CID="$(docker compose ps -a -q blaulichtcms 2>/dev/null | head -1 || true)"
if [ -n "$OLD_CID" ]; then
  OLD_ID="$(docker inspect -f '{{.Image}}' "$OLD_CID")"
  if [ "$(docker image inspect -f '{{.Id}}' "$OLD_IMAGE" 2>/dev/null || true)" != "$OLD_ID" ]; then
    PINNED="blaulichtcms:rollback-$(date +%Y%m%d-%H%M%S)"
    docker tag "$OLD_ID" "$PINNED"
    echo "== $OLD_IMAGE zeigt nicht mehr auf das Image des Containers – bisheriges Image gesichert als $PINNED"
    OLD_IMAGE="$PINNED"
  fi
fi
echo "== Aktuell: $OLD_IMAGE  →  Neu: $NEW_IMAGE"
docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || docker pull "$NEW_IMAGE"
# Selbsttest vor allem anderen (#275): Ein Image, dessen Dateien der Laufzeitbenutzer nicht lesen kann oder dessen
# Programm nicht lädt, kommt gar nicht erst bis zu Wartungsmodus, Sicherung und Wechsel
echo "== Selbsttest des neuen Images (ohne Netz, als Benutzer des Images)"
if ! selftest_out="$(bash scripts/image-selftest.sh "$NEW_IMAGE")"; then
  printf '%s\n' "$selftest_out" | tail -n 20 | sed 's/^/   /' >&2
  echo "Das neue Image $NEW_IMAGE besteht den Selbsttest nicht – Update abgebrochen." >&2
  exit 1
fi
printf '%s\n' "$selftest_out" | tail -n 1 | sed 's/^/   /'
# Image für Sicherung und Rückweg; fehlt das bisherige Image ganz, sichert das neue (nur tar) und der Rückweg
# bleibt Handarbeit
BACKUP_IMAGE="$OLD_IMAGE"
if ! docker image inspect "$OLD_IMAGE" >/dev/null 2>&1; then
  echo "== Bisheriges Image $OLD_IMAGE ist nicht vorhanden – Sicherung mit dem neuen Image, kein automatischer Rückweg."
  BACKUP_IMAGE="$NEW_IMAGE"
  AUTO_ROLLBACK=0
fi
# Gestoppter Container (#155): trotzdem sichern und mit Rückweg wechseln – nur ohne Wartungsmodus und Vorabprüfung
# (beides braucht den laufenden Container; ohne laufenden Container gibt es auch keine laufenden Vorgänge)
RUNNING="$(docker compose ps -q blaulichtcms 2>/dev/null || true)"

# Sicherungsschlüssel (#93): Beim ersten Update nach Einführung der Verschlüsselung läuft noch das alte install.sh,
# das ihn nicht anlegt – dann hier erzeugen, statt das Update scheitern zu lassen.
if [ "${BLAULICHTCMS_BACKUP_UNENCRYPTED:-0}" != 1 ] && [ ! -f "$KEY_FILE" ]; then
  ( umask 077; mkdir -p "$(dirname "$KEY_FILE")" && head -c 32 /dev/urandom | base64 > "$KEY_FILE" )
  chmod 600 "$KEY_FILE"
  echo "== Sicherungsschlüssel neu erzeugt: $KEY_FILE – Kopie getrennt verwahren (sudo cat $KEY_FILE), ohne ihn keine Wiederherstellung."
fi

echo "== 0. Platz für die Sicherung prüfen"
BLAULICHTCMS_IMAGE="$BACKUP_IMAGE" scripts/backup-volume.sh "$BACKUP_DIR" --nur-platz

if [ -n "$RUNNING" ]; then
  echo "== 1. Vorabprüfung und Wartungsmodus"
  PHASE=wartung
  cli maintenance on "Update auf $NEW_IMAGE"
  echo "== 2. Warten, bis laufende Vorgänge abgeschlossen sind"
  for i in $(seq 1 60); do
    if cli preflight >"$TMP_DIR/preflight.txt" 2>&1; then break; fi
    [ "$i" = 60 ] && { cat "$TMP_DIR/preflight.txt"; echo "Nicht bereit – Update abgebrochen." >&2; exit 1; }
    sleep 5
  done
  cat "$TMP_DIR/preflight.txt"
else
  echo "== 1./2. Container läuft nicht – Update ohne Wartungsmodus und Vorabprüfung, aber mit Sicherung und Rückweg"
fi

echo "== 3. Vollständige Sicherung außerhalb des Volumes"
# Ausgabe in eine Variable statt über eine Datei: der Archivpfad wird beim Rückweg als root eingespielt
BACKUP_OUT="$(BLAULICHTCMS_IMAGE="$BACKUP_IMAGE" scripts/backup-volume.sh "$BACKUP_DIR")"
printf '%s\n' "$BACKUP_OUT"
ARCHIVE="$(printf '%s\n' "$BACKUP_OUT" | sed -n 's/^Sicherung geschrieben: //p' | tail -1)"
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || { echo "Sicherung fehlt – Abbruch." >&2; exit 1; }
# Ältere Stände rotieren (#117): die neuesten KEEP_PRE_UPDATE behalten (die eben geschriebene ist immer dabei)
find "$(dirname "$ARCHIVE")" -maxdepth 1 -type f \( -name 'blaulichtcms-*.tar.gz' -o -name 'blaulichtcms-*.tar.gz.enc' \) | sort \
  | head -n "-$KEEP_PRE_UPDATE" | while read -r old; do
    [ "$old" = "$ARCHIVE" ] && continue
    rm -f "$old" "$old.sha256" && echo "   ältere Sicherung entfernt: $(basename "$old")"
  done

echo "== 4. Image wechseln"
PHASE=wechsel
envset BLAULICHTCMS_IMAGE "$NEW_IMAGE"
ok=0
# Fehler beim Start gehören in die Rückweg-Logik, nicht zum Skriptende per set -e
if docker compose up -d --no-build; then
  echo "== 5. Prüfen"
  if wait_health; then ok=1; fi
fi
if [ "$ok" = 1 ] && cli self-check; then
  cli maintenance off
  PHASE=fertig
  echo "== Update erfolgreich: $NEW_IMAGE (Sicherung: $ARCHIVE)"
  exit 0
fi

echo "!! Das neue Image startet nicht sauber:" >&2
health_text >&2 || true
echo >&2
container_logs >&2
if [ "$AUTO_ROLLBACK" = 1 ]; then
  echo "== Rückweg: vorheriges Image und Sicherung wiederherstellen"
  PHASE=rueckweg
  # Erst prüfen, dann ersetzen (#275): Prüfsumme, vollständiges Entschlüsseln, Archiv lesbar, Datenbank und Schlüssel
  # enthalten – mit dem bisherigen Image, als root im Container (Archiv und Schlüssel gehören root, 0600)
  echo "   Sicherung prüfen, bevor das Datenvolume ersetzt wird"
  if ! BLAULICHTCMS_IMAGE="$OLD_IMAGE" scripts/verify-backup.sh "$ARCHIVE"; then
    echo "!! Die Sicherung $ARCHIVE besteht die Prüfung nicht – das Datenvolume $VOLUME bleibt unverändert, der neue Container wird angehalten." >&2
    docker compose stop blaulichtcms >&2 || true
    rollback_help "Zuerst die Ursache beheben (Sicherungsschlüssel $KEY_FILE vorhanden und passend? Archiv und .sha256 vollständig?), dann:"
    PHASE=fertig
    exit 5
  fi
  docker compose down
  docker volume rm "$VOLUME"
  BLAULICHTCMS_IMAGE="$OLD_IMAGE" scripts/restore-volume.sh "$ARCHIVE"
  envset BLAULICHTCMS_IMAGE "$OLD_IMAGE"
  docker compose up -d --no-build
  wait_health || { echo "!! Das bisherige Image wird nach dem Rückweg nicht gesund." >&2; exit 1; }
  cli maintenance off
  PHASE=fertig
  echo "== Zurück auf $OLD_IMAGE mit dem Datenstand vor dem Update."
  exit 4
fi
rollback_help
PHASE=fertig
exit 5
