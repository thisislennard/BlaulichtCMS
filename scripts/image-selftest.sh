#!/usr/bin/env bash
# Selbsttest eines BlaulichtCMS-Images vor dem Wechsel (#275) – ohne Netz, ohne Datenvolume, als Benutzer des Images.
#
#   scripts/image-selftest.sh <image>
#
# Prüft, was sonst erst beim Start des neuen Containers auffiele (dann schon im Wartungsmodus und nach dem Wechsel):
#   - alle Dateien und Ordner unter /app sind für den Laufzeitbenutzer lesbar bzw. durchsuchbar
#   - Node.js lädt die Programmdateien samt Paketkonfiguration und nativen Modulen (cli.js self-check --release,
#     derselbe Rauchtest wie bei In-App-Updates; braucht keine Datenbank)
# Aufgerufen von install.sh (nach dem Build bzw. für ein schon vorhandenes Image) und scripts/update.sh (vor dem
# Wartungsmodus). Exit 0 = bestanden; sonst die ersten nicht lesbaren Pfade bzw. die Fehlermeldung von Node.js.
set -euo pipefail
IMAGE="${1:?Aufruf: scripts/image-selftest.sh <image>}"
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "Image nicht gefunden: $IMAGE" >&2; exit 1; }
# Wie im Betrieb (compose.yaml): Benutzer des Images, schreibgeschütztes Dateisystem, /tmp im Speicher, keine
# Capabilities; zusätzlich ohne Netz und mit leerem, anonymem /data (entfernt --rm wieder). Keine Einbindungen vom Host.
docker run --rm --network none --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint sh "$IMAGE" -c '
    bad="$(find /app ! -type l \( ! -readable -o -type d ! -executable \) -print 2>&1 | head -n 20)"
    if [ -n "$bad" ]; then echo "Für $(id -un) (uid $(id -u)) nicht lesbar:"; echo "$bad"; exit 1; fi
    cd /app && node server/dist/cli.js self-check --release
  ' 2>&1
