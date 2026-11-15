#!/usr/bin/env bash
# Tägliche Volume-Sicherung mit Aufbewahrung – für Cron (install.sh richtet /etc/cron.d/blaulichtcms ein).
#
#   scripts/backup-cron.sh <zielordner>
#
# Legt unter <zielordner>/taeglich eine vollständige, verschlüsselte Sicherung an (scripts/backup-volume.sh,
# Container hält dafür wenige Sekunden an) und kopiert sonntags einen Stand nach <zielordner>/woechentlich.
# Aufbewahrung: BLAULICHTCMS_KEEP_DAILY (Standard 14) und BLAULICHTCMS_KEEP_WEEKLY (Standard 8) Stände; Sicherungen vor
# Updates unter <zielordner>/vor-update höchstens BLAULICHTCMS_PRE_UPDATE_MAX_DAYS (Standard 90) Tage.
# Sicherungsschlüssel: BLAULICHTCMS_BACKUP_KEY_FILE (Standard /etc/blaulichtcms/backup.key).
# Jede neue Sicherung wird geprüft (scripts/verify-backup.sh: Prüfsumme, Entschlüsseln, Archiv lesen); eine echte
# Wiederherstellung in eine Wegwerf-Instanz ohne Netz läuft nach BLAULICHTCMS_RESTORE_TEST: woechentlich (Standard,
# sonntags), taeglich oder aus. Ergebnis und Fehler meldet das Skript an BlaulichtCMS (Systemprotokoll, Benachrichtigung
# an „System verwalten“) und mit Exit-Code ≠ 0 an Cron (MAILTO in /etc/cron.d/blaulichtcms setzen für eine Mail).
# Ziel möglichst auf einem anderen Datenträger oder Host (z. B. eingebundenes NAS).
set -euo pipefail
umask 077
TARGET="${1:?Aufruf: scripts/backup-cron.sh <zielordner>}"
KEEP_DAILY="${BLAULICHTCMS_KEEP_DAILY:-14}"
KEEP_WEEKLY="${BLAULICHTCMS_KEEP_WEEKLY:-8}"
PRE_UPDATE_MAX_DAYS="${BLAULICHTCMS_PRE_UPDATE_MAX_DAYS:-90}"
RESTORE_TEST="${BLAULICHTCMS_RESTORE_TEST:-woechentlich}"
cd "$(dirname "$0")/.."

# Ergebnis an BlaulichtCMS melden (best effort: der Container startet nach der Sicherung gerade neu)
report() {
  local i
  for i in $(seq 1 40); do
    docker compose exec -T blaulichtcms node server/dist/cli.js backup-report "$@" >/dev/null 2>&1 && return 0
    sleep 3
  done
  echo "Hinweis: Ergebnis ließ sich nicht an BlaulichtCMS melden (Container nicht bereit)." >&2
}
STEP="Vorbereitung"
on_exit() {
  local code=$?
  if [ "$code" != 0 ]; then
    echo "$(date '+%F %T') FEHLER bei: $STEP (Exit $code)" >&2
    report fehler "Tägliche Sicherung: Fehler bei „$STEP“ – Protokoll /var/log/blaulichtcms-backup.log am Docker-Host."
  fi
}
trap on_exit EXIT
mkdir -p "$TARGET/taeglich" "$TARGET/woechentlich"   # umask 077 → 0700
# Rechte des Ziels nicht zu weit (#93): Ordner 0700, vorhandene Archive (auch ältere) 0600
chmod 700 "$TARGET" "$TARGET/taeglich" "$TARGET/woechentlich" 2>/dev/null || echo "Hinweis: Rechte von $TARGET ließen sich nicht einschränken – Freigabe prüfen." >&2
find "$TARGET" -maxdepth 3 -type f -name 'blaulichtcms-*' -perm /077 -exec chmod 600 {} + 2>/dev/null || true

STEP="Sicherung"
out="$(scripts/backup-volume.sh "$TARGET/taeglich")"
echo "$out"
file="$(printf '%s\n' "$out" | sed -n 's/^Sicherung geschrieben: //p' | tail -1)"
[ -f "$file" ] || { echo "Sicherung fehlgeschlagen" >&2; exit 1; }

# Wiederherstellbarkeit prüfen (#113), bevor ein Stand als wöchentlicher übernommen wird
STEP="Prüfung der Sicherung"
VERIFY_OPT=()
case "$RESTORE_TEST" in
  taeglich) VERIFY_OPT=(--voll) ;;
  woechentlich) [ "$(date +%u)" = "7" ] && VERIFY_OPT=(--voll) ;;
  aus) ;;
  *) echo "BLAULICHTCMS_RESTORE_TEST muss woechentlich, taeglich oder aus sein." >&2; exit 2 ;;
esac
[ ${#VERIFY_OPT[@]} -gt 0 ] && STEP="Wiederherstellungstest"
scripts/verify-backup.sh "$file" "${VERIFY_OPT[@]}"

STEP="Aufbewahrung"
if [ "$(date +%u)" = "7" ]; then
  cp -p "$file" "$file.sha256" "$TARGET/woechentlich/"
fi

# Älteste Stände über der Aufbewahrung entfernen (nach Namen sortiert = nach Datum; verschlüsselt und ältere
# unverschlüsselte Archive gemeinsam)
# (find statt ls: ein leeres Muster ließe die Pipeline unter pipefail scheitern)
archives() { find "$1" -maxdepth 1 -type f \( -name 'blaulichtcms-*.tar.gz' -o -name 'blaulichtcms-*.tar.gz.enc' \) | sort; }
prune() {
  local dir="$1" keep="$2"
  archives "$dir" | head -n "-$keep" | while read -r old; do
    rm -f "$old" "$old.sha256"
  done
}
prune "$TARGET/taeglich" "$KEEP_DAILY"
prune "$TARGET/woechentlich" "$KEEP_WEEKLY"
# Sicherungen vor Updates (update.sh, Ordner vor-update): Anzahl begrenzt update.sh, das Alter dieser Lauf (#117) –
# sonst blieben gelöschte Daten bei seltenen Updates monatelang erhalten. 0 = nicht nach Alter löschen.
if [ -d "$TARGET/vor-update" ] && [ "$PRE_UPDATE_MAX_DAYS" -gt 0 ]; then
  find "$TARGET/vor-update" -maxdepth 1 -type f \( -name 'blaulichtcms-*.tar.gz' -o -name 'blaulichtcms-*.tar.gz.enc' \) \
    -mtime "+$PRE_UPDATE_MAX_DAYS" | while read -r old; do
      rm -f "$old" "$old.sha256" && echo "Sicherung vor Update älter als $PRE_UPDATE_MAX_DAYS Tage entfernt: $(basename "$old")"
    done
fi
count() { archives "$1" | wc -l; }
summary="$(count "$TARGET/taeglich") täglich, $(count "$TARGET/woechentlich") wöchentlich"
echo "Aufbewahrung: $summary"
if [ ${#VERIFY_OPT[@]} -gt 0 ]; then
  report ok "$(basename "$file") erstellt, geprüft und testweise wiederhergestellt ($summary)."
else
  report ok "$(basename "$file") erstellt und geprüft ($summary)."
fi
