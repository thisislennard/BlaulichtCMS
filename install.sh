#!/usr/bin/env bash
# ============================================================================================================
#  BlaulichtCMS – Installation und Update am Docker-Host (ein Skript für beides)
#
#    sudo bash install.sh            fragt die wenigen nötigen Werte ab
#    sudo bash install.sh --yes      ohne Rückfragen (Werte aus Umgebungsvariablen bzw. Standard)
#    sudo bash install.sh --rebuild  Image auch ohne neuen Code neu bauen (aktuelle Basis-Images mit
#                                    Sicherheitsupdates von Debian, Node.js und PostgreSQL) – monatlich empfohlen
#    sudo bash install.sh --remove-helper   Update-Helfer (Image-Updates aus der App) abschalten und entfernen
#
#  Update-Helfer (#226): systemd-Dienst blaulichtcms-update, mit dem sich Updates mit neuem Image in der App unter
#  Einstellungen → Updates anstoßen lassen – ohne dem Container Zugriff auf Docker zu geben. Beim ersten Lauf wird
#  gefragt (Standard: einrichten); --with-helper bzw. --no-helper entscheiden ohne Rückfrage (in .env gemerkt).
#  --unattended ist der nicht-interaktive Update-Modus, den der Helfer aufruft (nur Update einer bestehenden
#  Installation, keine Rückfragen, keine Nachinstallation von Programmen, keine neuen Einrichtungen).
#
#  Erstinstallation: fehlende Programme anbieten, Code nach /opt/apps/blaulichtcms holen, .env anlegen (fragt nur
#  Adresse und Art des Reverse Proxys), Docker-Netz proxy-net anlegen, Image bauen, starten, beim Einrichten des
#  Reverse Proxys helfen und die Adresse prüfen, Einrichtungsschlüssel anzeigen, tägliche Sicherung einrichten.
#  Erneut ausführen = Update: neuen Stand holen, Image bauen, mit Sicherung und automatischem Rückweg wechseln
#  (scripts/update.sh). Daten und .env bleiben erhalten.
#
#  Umgebungsvariablen (optional):
#    BLAULICHTCMS_DIR              Installationsordner (Standard /opt/apps/blaulichtcms)
#    BLAULICHTCMS_BACKUP_DIR       Ziel der täglichen Sicherung (Standard /opt/apps/blaulichtcms-sicherungen)
#    BLAULICHTCMS_BACKUP_KEY_FILE  Schlüssel für die verschlüsselten Volume-Sicherungen (Standard /etc/blaulichtcms/backup.key,
#                                  wird bei Bedarf erzeugt – Kopie getrennt verwahren)
#    BLAULICHTCMS_PUBLIC_URL       öffentliche HTTPS-Adresse (z. B. https://blaulichtcms.example.org)
#    BLAULICHTCMS_PROXY_MODE       Art des Reverse Proxys: 1 = Container auf diesem Server, 2 = direkt auf diesem Server,
#                                  3 = anderer Server (sonst Rückfrage, Standard 1)
#    BLAULICHTCMS_PROXY_IP         IP des Reverse Proxys bei Art 3 (nur von dort gelten Weiterleitungs-Kopfzeilen)
#    BLAULICHTCMS_BIND             Host-Schnittstelle für den Port (Standard 127.0.0.1)
#    BLAULICHTCMS_PORT             Host-Port (Standard 7310)
#    BLAULICHTCMS_PROXY_NETWORK    Docker-Netz des Reverse Proxys (Standard proxy-net)
#    BLAULICHTCMS_REPO             Quelle (Standard GitHub thisislennard/BlaulichtCMS)
#    BLAULICHTCMS_BRANCH           Branch (Standard main)
#    BLAULICHTCMS_UPDATE_CHANNEL   release = neuester Release-Tag v* auf dem Branch (Standard, sobald es Tags gibt)
#                                  main    = jeweils neuester Stand des Branches (ohne Freigabeschritt)
#    BLAULICHTCMS_ALLOWED_SIGNERS  SSH-allowed_signers-Datei; Tags müssen damit signiert sein
#                                  (Standard /etc/blaulichtcms/allowed_signers, wenn vorhanden)
#    BLAULICHTCMS_REQUIRE_SIGNED=1 Signatur verlangen (auch GPG-Tags mit Schlüsseln im Schlüsselbund von root)
#    BLAULICHTCMS_REQUIRE_CI=1     nur Stände übernehmen, deren CI-Lauf auf GitHub erfolgreich war
#    GITHUB_TOKEN                  Token mit Lesezugriff auf das (private) Repo – sonst wird bei Bedarf gefragt
#    HTTPS_PROXY / HTTP_PROXY / NO_PROXY werden an den Image-Build durchgereicht (Netz mit Proxy)
#    BLAULICHTCMS_BUILD_CA         PEM-Datei einer Proxy-CA für den Build (TLS-aufbrechender Proxy)
# ============================================================================================================
set -euo pipefail
# Feste umask für Programmcode, Build und Compose (#275): Aufrufer mit umask 077 (z. B. der Update-Helfer unter systemd)
# ließen git sonst Dateien mit 0600 auschecken, die der unprivilegierte Benutzer im Image nicht lesen kann. Geheimes
# (.env, Sicherungsschlüssel, Sicherungsziel, Helfer-Umgebung) wird weiterhin ausdrücklich mit 0600/0700 angelegt.
umask 022

APP_DIR="${BLAULICHTCMS_DIR:-/opt/apps/blaulichtcms}"
BACKUP_DIR="${BLAULICHTCMS_BACKUP_DIR:-/opt/apps/blaulichtcms-sicherungen}"
BACKUP_KEY="${BLAULICHTCMS_BACKUP_KEY_FILE:-/etc/blaulichtcms/backup.key}"
REPO="${BLAULICHTCMS_REPO:-https://github.com/thisislennard/BlaulichtCMS.git}"
BRANCH="${BLAULICHTCMS_BRANCH:-main}"
PROXY_NET="${BLAULICHTCMS_PROXY_NETWORK:-proxy-net}"
CONTAINER="blaulichtcms"
ASSUME_YES=0
WITH_CRON=1
REBUILD=0
UNATTENDED=0
HELPER_CHOICE=""
ORIG_ARGS=("$@")
for a in "$@"; do
  case "$a" in
    -y|--yes) ASSUME_YES=1 ;;
    --no-cron) WITH_CRON=0 ;;
    --rebuild) REBUILD=1 ;;
    --unattended) UNATTENDED=1; ASSUME_YES=1 ;;
    --with-helper) HELPER_CHOICE=1 ;;
    --no-helper) HELPER_CHOICE=0 ;;
    --remove-helper) HELPER_CHOICE=remove ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "Unbekannte Option: $a (siehe --help)" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------------------------------------------ Hilfen
if [ -t 1 ]; then B=$'\e[1m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'; else B=''; R=''; G=''; Y=''; N=''; fi
step() { echo; echo "${B}== $*${N}"; }
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
die()  { echo; echo "${R}✘ $*${N}" >&2; exit 1; }
die_rc() { local rc="$1"; shift; echo; echo "${R}✘ $*${N}" >&2; exit "$rc"; } # mit Exit-Code für den Update-Helfer
# Gibt es ein Terminal für Rückfragen? -r /dev/tty reicht nicht: ohne steuerndes Terminal (Cron, Automatisierung)
# ist die Datei lesbar, das Öffnen scheitert aber – Rückfragen kämen dann sofort leer zurück.
HAS_TTY=0
( exec </dev/tty ) 2>/dev/null && HAS_TTY=1
# Rückfrage – liest vom Terminal (funktioniert auch bei „curl … | bash“); mit --yes gilt der Vorschlag
ask() {
  local prompt="$1" def="${2:-}" ans=""
  if [ "$ASSUME_YES" = 1 ] || [ "$HAS_TTY" = 0 ]; then echo "$def"; return; fi
  read -r -p "  $prompt${def:+ [$def]}: " ans </dev/tty || true
  echo "${ans:-$def}"
}
yes_no() { # yes_no "Frage" J|N
  local a; a="$(ask "$1 (j/n)" "$2")"
  case "$a" in [jJyY]*) return 0 ;; *) return 1 ;; esac
}
envset() { # Schlüssel in .env setzen oder anhängen
  local f="$APP_DIR/.env"
  if grep -q "^$1=" "$f" 2>/dev/null; then sed -i "s|^$1=.*|$1=$2|" "$f"; else echo "$1=$2" >> "$f"; fi
}
envget() { [ -f "$APP_DIR/.env" ] || return 0; sed -n "s/^$1=//p" "$APP_DIR/.env" | tail -1; }

# ------------------------------------------------------------------------------------------------ Update-Helfer (#226)
# Der Helfer (scripts/host-update-helper.sh) reagiert auf eine Anfrage-Datei im Datenvolume und ruft dieses Skript
# mit --unattended auf. Der Container bekommt keine zusätzlichen Rechte; Austausch nur über host-update/ im Volume.
HELPER_UNIT=/etc/systemd/system/blaulichtcms-update
HELPER_ENV=/etc/blaulichtcms/update-helper.env
helper_installed() { [ -f "$HELPER_UNIT.path" ]; }
helper_prereq() { # Gründe, warum der Helfer hier nicht geht (leer = geht)
  local miss=() c
  { [ -d /run/systemd/system ] && command -v systemctl >/dev/null; } || miss+=("systemd")
  for c in setpriv flock timeout realpath; do command -v "$c" >/dev/null || miss+=("$c"); done
  echo "${miss[*]}"
}
helper_remove() {
  if systemctl is-active -q blaulichtcms-update.service 2>/dev/null; then
    die "Der Update-Helfer führt gerade ein Update aus – bitte das Ende abwarten (systemctl status blaulichtcms-update)."
  fi
  local ex=""
  [ -f "$HELPER_UNIT.path" ] && ex="$(sed -n 's/^PathExists=//p' "$HELPER_UNIT.path")" && ex="${ex%/request.json}"
  if [ -n "$ex" ] && [ -f "$APP_DIR/scripts/host-update-helper.sh" ]; then
    BLAULICHTCMS_DIR="$APP_DIR" BLAULICHTCMS_HELPER_EXCHANGE="$ex" bash "$APP_DIR/scripts/host-update-helper.sh" retract >/dev/null 2>&1 || true
  fi
  systemctl disable --now blaulichtcms-update.path >/dev/null 2>&1 || true
  rm -f "$HELPER_UNIT.path" "$HELPER_UNIT.service" "$HELPER_ENV"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf /var/lib/blaulichtcms-update
}
# Unit-Dateien und Umgebung schreiben; Rückgabe 0, wenn sich etwas geändert hat
helper_write_files() {
  local exchange="$1/host-update" tmp changed v val
  tmp="$(mktemp -d)"
  {
    echo "# BlaulichtCMS Update-Helfer – erzeugt von install.sh, nicht von Hand ändern (Werte des letzten Aufrufs)"
    printf 'BLAULICHTCMS_DIR="%s"\nBLAULICHTCMS_HELPER_EXCHANGE="%s"\nBLAULICHTCMS_BACKUP_DIR="%s"\nBLAULICHTCMS_BACKUP_KEY_FILE="%s"\nBLAULICHTCMS_BRANCH="%s"\n' \
      "$APP_DIR" "$exchange" "$BACKUP_DIR" "$BACKUP_KEY" "$BRANCH"
    # Einstellungen aus der Umgebung dieses Aufrufs übernehmen (Proxy für den Build, Signaturprüfung, Aufbewahrung …)
    for v in BLAULICHTCMS_ALLOWED_SIGNERS BLAULICHTCMS_REQUIRE_SIGNED BLAULICHTCMS_REQUIRE_CI BLAULICHTCMS_BACKUP_UNENCRYPTED \
             BLAULICHTCMS_KEEP_PRE_UPDATE BLAULICHTCMS_PRE_UPDATE_MAX_DAYS BLAULICHTCMS_BUILD_CA \
             HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
      val="${!v:-}"
      [ -n "$val" ] || continue
      case "$val" in *$'\n'*) continue ;; esac
      val="${val//\\/\\\\}"; val="${val//\"/\\\"}"
      printf '%s="%s"\n' "$v" "$val"
    done
  } > "$tmp/env"
  cat > "$tmp/service" <<UNIT
# BlaulichtCMS: Image-Update auf Anfrage aus der App (install.sh). Läuft als root nur für den festen Ablauf in
# scripts/host-update-helper.sh. Abschalten: sudo bash $APP_DIR/install.sh --remove-helper
[Unit]
Description=BlaulichtCMS: Image-Update auf Anfrage aus der App
Documentation=https://github.com/thisislennard/BlaulichtCMS/blob/main/docs/betrieb.md
After=docker.service network-online.target
Wants=network-online.target
StartLimitIntervalSec=10min
StartLimitBurst=5

[Service]
Type=oneshot
EnvironmentFile=$HELPER_ENV
Environment=HOME=/root
ExecStart=/bin/bash "$APP_DIR/scripts/host-update-helper.sh" run
TimeoutStartSec=4h
StateDirectory=blaulichtcms-update
StateDirectoryMode=0700
UMask=0077
Nice=5
# Härtung, ohne Docker-CLI, git und den Image-Build zu stören (Build und Container laufen im Docker-Dienst)
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=true
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
UNIT
  cat > "$tmp/path" <<UNIT
# BlaulichtCMS: wartet auf eine Update-Anfrage der App im Datenvolume (install.sh)
[Unit]
Description=BlaulichtCMS: auf Update-Anfragen aus der App achten

[Path]
PathExists=$exchange/request.json
Unit=blaulichtcms-update.service

[Install]
WantedBy=multi-user.target
UNIT
  if cmp -s "$tmp/env" "$HELPER_ENV" && cmp -s "$tmp/service" "$HELPER_UNIT.service" && cmp -s "$tmp/path" "$HELPER_UNIT.path"; then
    changed=1
  else
    ( umask 077; mkdir -p "$(dirname "$HELPER_ENV")" )
    install -m 600 "$tmp/env" "$HELPER_ENV"
    install -m 644 "$tmp/service" "$HELPER_UNIT.service"
    install -m 644 "$tmp/path" "$HELPER_UNIT.path"
    changed=0
  fi
  rm -rf "$tmp"
  return "$changed"
}

if [ "$HELPER_CHOICE" = remove ]; then
  step "Update-Helfer entfernen"
  [ "$(id -u)" = 0 ] || die "Bitte als root ausführen: sudo bash install.sh --remove-helper"
  helper_remove
  [ -f "$APP_DIR/.env" ] && envset BLAULICHTCMS_UPDATE_HELPER 0
  ok "Update-Helfer entfernt. Image-Updates wieder nur am Host: sudo bash $APP_DIR/install.sh (erneut einrichten: --with-helper)"
  exit 0
fi

# ------------------------------------------------------------------------------------------------ 1. Voraussetzungen
step "1/8 Voraussetzungen"
[ "$(id -u)" = 0 ] || die "Bitte als root ausführen: sudo bash install.sh"
# Nie zwei Läufe gleichzeitig (auch nicht mit dem Update-Helfer); nach dem Neustart des Skripts mit der neuen Fassung
# (siehe Schritt 2) gilt die geerbte Sperre weiter
LOCK_FILE=/run/lock/blaulichtcms-install.lock
[ -d /run/lock ] || LOCK_FILE=/var/lock/blaulichtcms-install.lock
if [ -z "${BLAULICHTCMS_REEXEC:-}" ] && command -v flock >/dev/null; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "install.sh läuft bereits (z. B. ein Update über den Update-Helfer) – bitte das Ende abwarten."
fi
# Fehlende Werkzeuge auf Debian/Ubuntu auf Wunsch gleich installieren
missing=()
command -v git >/dev/null || missing+=(git)
command -v curl >/dev/null || missing+=(curl)
if [ ${#missing[@]} -gt 0 ]; then
  [ "$UNATTENDED" = 1 ] && die "Es fehlt: ${missing[*]} – im nicht-interaktiven Modus wird nichts nachinstalliert."
  if command -v apt-get >/dev/null && yes_no "Es fehlt: ${missing[*]}. Jetzt installieren (apt-get)?" "j"; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null || die "Installation von ${missing[*]} fehlgeschlagen."
    ok "installiert: ${missing[*]}"
  else
    die "Es fehlt: ${missing[*]} – bitte installieren (z. B. apt install ${missing[*]}) und das Skript erneut starten."
  fi
fi
if ! command -v docker >/dev/null; then
  [ "$UNATTENDED" = 1 ] && die "Docker ist nicht installiert."
  echo "  Docker ist nicht installiert. Das offizielle Installationsskript von Docker (get.docker.com) richtet"
  echo "  Docker Engine und Compose ein."
  if yes_no "Docker jetzt installieren?" "j"; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh >/tmp/get-docker.log 2>&1 || { tail -15 /tmp/get-docker.log | sed 's/^/  │ /'; die "Docker-Installation fehlgeschlagen (Protokoll /tmp/get-docker.log)."; }
    rm -f /tmp/get-docker.sh
    ok "Docker installiert"
  else
    die "Docker fehlt. Anleitung: https://docs.docker.com/engine/install/ – danach das Skript erneut starten."
  fi
fi
docker info >/dev/null 2>&1 || die "Docker läuft nicht (systemctl start docker) oder ist nicht erreichbar."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 fehlt (Paket docker-compose-plugin, z. B. apt install docker-compose-plugin)."
ok "Docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short 2>/dev/null | sed 's/^/Compose /')"

# ------------------------------------------------------------------------------------------------ 2. Code holen
step "2/8 Programmcode nach $APP_DIR"
# Zugriff auf ein privates Repo ohne das Token irgendwo zu speichern: nur als Kopfzeile für diese Aufrufe.
# Übergabe über die Umgebung (GIT_CONFIG_*), nicht als Argument – Argumente stehen für jeden lesbar in der
# Prozessliste (/proc/<pid>/cmdline), die Umgebung nur für root und den eigenen Benutzer (#160).
GIT_AUTH_HEADER=""
git_auth() {
  local token="${GITHUB_TOKEN:-}"
  if [ -z "$token" ]; then
    { [ "$ASSUME_YES" = 1 ] || [ "$HAS_TTY" = 0 ]; } && die "Das Repo verlangt eine Anmeldung: GITHUB_TOKEN setzen (Token mit Lesezugriff auf $REPO)."
    echo "  Das Repository ist privat – für den Abruf wird ein GitHub-Token mit Leserecht gebraucht."
    echo "  Anlegen: github.com → Settings → Developer settings → Fine-grained tokens → Generate new token,"
    echo "  „Only select repositories“ → dieses Repository, Berechtigung „Contents: Read-only“."
    read -r -s -p "  GitHub-Token (wird nicht gespeichert): " token </dev/tty; echo
  fi
  [ -n "$token" ] || die "Kein Token angegeben."
  GIT_AUTH_HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
}
git_try() {
  if [ -n "$GIT_AUTH_HEADER" ]; then
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$GIT_AUTH_HEADER" git "$@"
  else
    GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

# Freigegebene Stände (#106): Kanal „release“ folgt dem neuesten Tag v<version> auf dem Branch (optional mit
# Signaturprüfung), Kanal „main“ dem jeweils neuesten Commit. Die Wahl wird in .env gemerkt.
CHANNEL_SET="${BLAULICHTCMS_UPDATE_CHANNEL:-}"
[ -z "$CHANNEL_SET" ] && CHANNEL_SET="$(envget BLAULICHTCMS_UPDATE_CHANNEL)"
case "${CHANNEL_SET:-auto}" in release|main|auto) ;; *) die "BLAULICHTCMS_UPDATE_CHANNEL muss release oder main sein." ;; esac
SIGNERS="${BLAULICHTCMS_ALLOWED_SIGNERS:-/etc/blaulichtcms/allowed_signers}"
[ -n "${BLAULICHTCMS_ALLOWED_SIGNERS:-}" ] && [ ! -f "$SIGNERS" ] && die "BLAULICHTCMS_ALLOWED_SIGNERS zeigt auf keine Datei: $SIGNERS"
REQUIRE_SIGNED="${BLAULICHTCMS_REQUIRE_SIGNED:-0}"
[ -f "$SIGNERS" ] && REQUIRE_SIGNED=1
git_verify() { # git_verify tag|commit <ref>
  if [ -f "$SIGNERS" ]; then git -c gpg.ssh.allowedSignersFile="$SIGNERS" "verify-$1" "$2"; else git "verify-$1" "$2"; fi
}
# CI-Ergebnis eines Commits auf GitHub (optional): alle Check-Läufe abgeschlossen und erfolgreich bzw. übersprungen
ci_green() {
  local sha="$1" slug hdr json total good
  slug="$(printf '%s' "$REPO" | sed -E -n 's#^https://github\.com/([^/]+/[^/]+)$#\1#p' | sed 's/\.git$//')"
  [ -n "$slug" ] || { warn "CI-Prüfung nur für Repos auf github.com möglich."; return 1; }
  hdr="$(mktemp)"; chmod 600 "$hdr"
  echo "Accept: application/vnd.github+json" > "$hdr"
  # Token nicht als Argument (Prozessliste), sondern als Kopfzeilen-Datei
  if [ -n "${GITHUB_TOKEN:-}" ]; then echo "Authorization: Bearer $GITHUB_TOKEN" >> "$hdr"; fi
  json="$(curl -fsS -H @"$hdr" "https://api.github.com/repos/$slug/commits/$sha/check-runs?per_page=100" 2>/dev/null || true)"
  rm -f "$hdr"
  total="$(printf '%s' "$json" | grep -oE '"conclusion": *("[a-z_]*"|null)' | wc -l)"
  good="$(printf '%s' "$json" | grep -oE '"conclusion": *"(success|skipped|neutral)"' | wc -l)"
  [ "$total" -gt 0 ] && [ "$total" = "$good" ]
}
select_release() { # setzt TARGET_REF auf den zu installierenden Stand
  TARGET_REF=""; TARGET_LABEL=""
  local channel="${CHANNEL_SET:-auto}" tag
  if [ "$channel" != main ]; then
    tag="$(git tag -l 'v[0-9]*' --merged "origin/$BRANCH" --sort=-v:refname | head -1)"
    if [ -n "$tag" ]; then
      TARGET_REF="refs/tags/$tag"; TARGET_LABEL="Release $tag"
      if [ "$REQUIRE_SIGNED" = 1 ]; then
        git_verify tag "$tag" >/dev/null 2>&1 || die "Die Signatur von $tag ist ungültig oder unbekannt – Update abgelehnt (Schlüssel: $SIGNERS)."
        ok "Signatur von $tag geprüft"
      else
        warn "Tag $tag wird ohne Signaturprüfung übernommen (Schlüssel hinterlegen: docs/betrieb.md, Freigabe von Updates)."
      fi
    elif [ "$channel" = release ]; then
      die "Kanal „release“, aber im Repo gibt es noch keinen Release-Tag v… auf $BRANCH."
    else
      warn "Noch kein Release-Tag im Repo – es gilt vorerst der neueste Stand von $BRANCH (ohne Freigabeschritt)."
      warn "Mit dem ersten Tag v<version> folgt das Update automatisch den Releases (docs/betrieb.md, Freigabe von Updates)."
    fi
  fi
  if [ -z "$TARGET_REF" ]; then
    TARGET_REF="origin/$BRANCH"; TARGET_LABEL="$BRANCH"
    if [ "$REQUIRE_SIGNED" = 1 ]; then
      git_verify commit "origin/$BRANCH" >/dev/null 2>&1 || die "Der neueste Commit auf $BRANCH ist nicht gültig signiert – Update abgelehnt."
      ok "Signatur des Commits geprüft"
    fi
  fi
  # Update-Helfer: genau der Tag, den er geprüft hat – erscheint inzwischen ein anderer, lieber abbrechen
  if [ -n "${BLAULICHTCMS_EXPECT_TAG:-}" ] && [ "$TARGET_REF" != "refs/tags/$BLAULICHTCMS_EXPECT_TAG" ]; then
    die "Erwartet war Release $BLAULICHTCMS_EXPECT_TAG, gefunden $TARGET_LABEL – Update abgebrochen (in der App erneut prüfen)."
  fi
  if [ "${BLAULICHTCMS_REQUIRE_CI:-0}" = 1 ]; then
    ci_green "$(git rev-parse "$TARGET_REF^{commit}")" || die "Für $TARGET_LABEL liegt kein vollständig erfolgreicher CI-Lauf auf GitHub vor – Update abgelehnt."
    ok "CI auf GitHub für $TARGET_LABEL erfolgreich"
  fi
}
checkout_target() {
  local target cur
  target="$(git rev-parse "$TARGET_REF^{commit}")"; cur="$(git rev-parse HEAD)"
  if [ "$target" = "$cur" ]; then return 0; fi
  # Nie auf einen älteren Stand zurück (z. B. Wechsel vom Kanal main auf release): der Datenstand passt sonst nicht
  if git merge-base --is-ancestor "$target" "$cur"; then
    [ -n "${BLAULICHTCMS_EXPECT_TAG:-}" ] && die "Der installierte Stand ist neuer als $TARGET_LABEL – kein Rückschritt."
    warn "Der installierte Stand ist neuer als $TARGET_LABEL – er bleibt, bis ein neuerer Release-Tag erscheint."
    TARGET_REF=HEAD; TARGET_LABEL="bisheriger Stand"
    return 0
  fi
  case "$TARGET_REF" in
    refs/tags/*) git checkout -q --detach "$target" ;;
    *) git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
       git merge -q --ff-only "origin/$BRANCH" || die "Der Stand in $APP_DIR lässt sich nicht vorspulen (abweichende Commits)." ;;
  esac
}

mkdir -p "$(dirname "$APP_DIR")"
if [ -d "$APP_DIR/.git" ]; then
  MODE=update
  [ -z "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ] || die "In $APP_DIR gibt es lokale Änderungen am Code. Bitte prüfen (git -C $APP_DIR status) – das Skript überschreibt nichts."
  OLD_HEAD="$(git -C "$APP_DIR" rev-parse HEAD)"
  # Tags ohne --force: ein nachträglich verschobener Tag lässt den Abruf scheitern, statt still übernommen zu werden
  fetch_tags() { git_try -C "$APP_DIR" fetch --tags origin "$BRANCH" 2>&1; }
  moved_tag() { printf '%s' "$1" | grep -qiE 'clobber|would overwrite|\(already exists\)'; }
  # Nach dem Neustart des Skripts (unten) ist bereits abgerufen
  if [ -z "${BLAULICHTCMS_REEXEC:-}" ] && ! ferr="$(fetch_tags)"; then
    moved_tag "$ferr" && die "Ein bereits geholter Release-Tag wurde auf dem Server verschoben – Update abgelehnt. Vor dem Update klären (git -C $APP_DIR fetch --tags origin)."
    git_auth
    if ! ferr="$(fetch_tags)"; then
      moved_tag "$ferr" && die "Ein bereits geholter Release-Tag wurde auf dem Server verschoben – Update abgelehnt."
      die "Abruf von $REPO fehlgeschlagen: $ferr"
    fi
  fi
  cd "$APP_DIR"
  select_release
  checkout_target
  ok "Stand: $(git log -1 --format='%h %s' | cut -c1-70) ($TARGET_LABEL)"
  # Bringt der neue Stand ein geändertes install.sh mit, gleich mit diesem weitermachen (#226) – sonst liefe der Rest
  # dieses Laufs noch mit dem alten Skript (die Shell liest die bereits geöffnete alte Datei weiter)
  if [ -z "${BLAULICHTCMS_REEXEC:-}" ] && [ "$(realpath -e -- "$0" 2>/dev/null || true)" = "$(realpath -e -- "$APP_DIR/install.sh")" ] \
     && ! git diff --quiet "$OLD_HEAD" HEAD -- install.sh; then
    ok "install.sh wurde aktualisiert – weiter mit der neuen Fassung"
    export BLAULICHTCMS_REEXEC=1
    exec bash "$APP_DIR/install.sh" "${ORIG_ARGS[@]}"
  fi
elif [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
  die "$APP_DIR existiert und ist nicht leer (kein Git-Stand von BlaulichtCMS). Anderen Ordner wählen: BLAULICHTCMS_DIR=…"
else
  [ "$UNATTENDED" = 1 ] && die "Kein bestehender Stand in $APP_DIR – der nicht-interaktive Modus aktualisiert nur bestehende Installationen."
  MODE=install
  git_try ls-remote -q "$REPO" "$BRANCH" >/dev/null 2>&1 || git_auth
  git_try clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
  cd "$APP_DIR"
  select_release
  checkout_target
  ok "geholt: $(git log -1 --format='%h %s' | cut -c1-70) ($TARGET_LABEL)"
fi
cd "$APP_DIR"
# Rechte der versionierten Dateien vereinheitlichen (#275): Ein Lauf mit umask 077 (Update-Helfer bis 0.7.0) hat
# geänderte Dateien mit 0600 und neue Ordner mit 0700 ausgecheckt. Nur reguläre Dateien und Ordner aus Git (keine
# symbolischen Links, nichts Unversioniertes wie .env); ausführbare Dateien behalten ihr x-Bit.
normalize_modes() {
  local entry p
  git ls-files -s -z | while IFS= read -r -d '' entry; do
    p="${entry#*$'\t'}"
    case "$entry" in
      100644\ *|100755\ *) if [ -f "$p" ] && [ ! -L "$p" ]; then printf '%s\0' "$p"; fi ;;
    esac
  done | xargs -0 -r chmod u+rw,go+r,go-w,a+X -- || return 1
  git ls-tree -r -d -z --name-only HEAD | while IFS= read -r -d '' p; do
    if [ -d "$p" ] && [ ! -L "$p" ]; then printf '%s\0' "$p"; fi
  done | xargs -0 -r chmod u+rwx,go+rx,go-w -- || return 1
  chmod u+rwx,go+rx,go-w . || return 1
}
normalize_modes || die "Die Rechte der Programmdateien in $APP_DIR ließen sich nicht vereinheitlichen."
VERSION="$(cat VERSION 2>/dev/null || echo 0.0.0)"
ok "BlaulichtCMS $VERSION"
case "$TARGET_REF" in refs/tags/v*) [ "${TARGET_REF#refs/tags/v}" = "$VERSION" ] || warn "Tag ${TARGET_REF#refs/tags/} und VERSION ($VERSION) stimmen nicht überein." ;; esac

# ------------------------------------------------------------------------------------------------ 3. Umgebung prüfen
step "3/8 Umgebung prüfen"
RUNNING="$(docker ps -q -f "name=^${CONTAINER}$")"
if docker volume inspect blaulichtcms_data >/dev/null 2>&1; then
  ok "vorhandenes Datenvolume blaulichtcms_data wird weiterverwendet"
fi

# ------------------------------------------------------------------------------------------------ 4. Konfiguration
step "4/8 Konfiguration (.env)"
port_busy() { # belegt durch etwas anderes als BlaulichtCMS?
  local p="$1"
  if docker ps --format '{{.Names}} {{.Ports}}' | grep -v "^${CONTAINER} " | grep -q ":${p}->"; then return 0; fi
  if [ -z "$RUNNING" ] && command -v ss >/dev/null && ss -ltn "( sport = :$p )" 2>/dev/null | grep -q LISTEN; then return 0; fi
  return 1
}
NEW_ENV=0
if [ ! -f .env ]; then
  [ "$UNATTENDED" = 1 ] && die "Keine .env in $APP_DIR – der nicht-interaktive Modus richtet nichts neu ein."
  install -m 600 .env.example .env
  NEW_ENV=1
  # Abbruch während der Fragen: halbe .env wieder entfernen, sonst überspränge der nächste Lauf die Konfiguration
  trap '[ -f "$APP_DIR/.env.unfertig" ] && rm -f "$APP_DIR/.env" "$APP_DIR/.env.unfertig"' EXIT
  touch .env.unfertig
  echo "  Die öffentliche Adresse ist die HTTPS-Adresse, die im Reverse Proxy für BlaulichtCMS eingerichtet wird"
  echo "  (steht später in Einladungen, Upload-Links und QR-Codes)."
  PUBLIC_URL="${BLAULICHTCMS_PUBLIC_URL:-}"
  DOMAIN="$(hostname -d 2>/dev/null || true)"
  if [ -z "$PUBLIC_URL" ]; then
    [ "$ASSUME_YES" = 1 ] && die "Ohne Rückfragen bitte die Adresse vorgeben: BLAULICHTCMS_PUBLIC_URL=https://… bash install.sh --yes"
    PUBLIC_URL="$(ask "Öffentliche Adresse" "https://blaulichtcms.${DOMAIN:-example.org}")"
  fi
  PUBLIC_URL="${PUBLIC_URL%/}"
  case "$PUBLIC_URL" in
    https://*) envset COOKIE_SECURE true ;;
    http://*)  warn "http:// nur für einen ersten Test – Anmeldung und Upload-Links gehören hinter HTTPS."
               envset COOKIE_SECURE false ;;
    *) die "Die Adresse muss mit https:// beginnen (z. B. https://blaulichtcms.example.org)." ;;
  esac
  sed -i "s|^# PUBLIC_URL=.*|PUBLIC_URL=$PUBLIC_URL|" .env
  # Art des Reverse Proxys bestimmt Port-Bindung und vertrauenswürdige Proxy-Adressen (TRUSTED_PROXIES, #92)
  echo
  echo "  Wo läuft der Reverse Proxy, der HTTPS für BlaulichtCMS bereitstellt?"
  echo "    1) als Docker-Container auf diesem Server, z. B. Nginx Proxy Manager   (empfohlen)"
  echo "    2) direkt auf diesem Server, z. B. nginx, Caddy oder Apache"
  echo "    3) auf einem anderen Server, z. B. IIS oder eine Firewall"
  PROXY_MODE="${BLAULICHTCMS_PROXY_MODE:-}"
  [ -n "$PROXY_MODE" ] || PROXY_MODE="$(ask "Auswahl" "1")"
  case "$PROXY_MODE" in
    1) BIND="${BLAULICHTCMS_BIND:-127.0.0.1}" ;;
    2) BIND="${BLAULICHTCMS_BIND:-127.0.0.1}" ;;
    3) LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
       BIND="${BLAULICHTCMS_BIND:-$(ask "Adresse dieses Servers im LAN (dort ist BlaulichtCMS für den Proxy erreichbar)" "${LAN_IP:-0.0.0.0}")}"
       PROXY_IP="${BLAULICHTCMS_PROXY_IP:-}"
       while ! printf '%s' "$PROXY_IP" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$'; do
         { [ "$ASSUME_YES" = 1 ] || [ "$HAS_TTY" = 0 ]; } && die "Ohne Rückfragen und mit Proxy auf anderem Server bitte BLAULICHTCMS_PROXY_IP=<IP des Proxys> setzen."
         PROXY_IP="$(ask "IP-Adresse des Reverse Proxys (nur von dort werden Weiterleitungs-Kopfzeilen akzeptiert)" "")"
       done
       envset TRUSTED_PROXIES "$PROXY_IP"
       warn "Port $BIND:${BLAULICHTCMS_PORT:-7310} per Firewall nur für $PROXY_IP freigeben." ;;
    *) die "Bitte 1, 2 oder 3 wählen." ;;
  esac
  envset BLAULICHTCMS_PROXY_MODE "$PROXY_MODE"
  PORT="${BLAULICHTCMS_PORT:-7310}"
  if port_busy "$PORT"; then
    warn "Port $PORT ist bereits von einem anderen Dienst belegt."
    PORT="$(ask "Anderen Port für BlaulichtCMS verwenden" "7311")"
    port_busy "$PORT" && die "Port $PORT ist ebenfalls belegt. BLAULICHTCMS_PORT=… setzen."
  fi
  envset BLAULICHTCMS_BIND "$BIND"
  envset BLAULICHTCMS_PORT "$PORT"
  envset BLAULICHTCMS_PROXY_NETWORK "$PROXY_NET"
  rm -f .env.unfertig
  ok ".env angelegt (Adresse $PUBLIC_URL, Port $BIND:$PORT)"
else
  ok "vorhandene .env bleibt unverändert"
  PROXY_MODE="$(envget BLAULICHTCMS_PROXY_MODE)"
  PUBLIC_URL="$(envget PUBLIC_URL)"; BIND="$(envget BLAULICHTCMS_BIND)"; PORT="$(envget BLAULICHTCMS_PORT)"
  PROXY_NET="$(envget BLAULICHTCMS_PROXY_NETWORK)"; PROXY_NET="${PROXY_NET:-proxy-net}"
  # Altes TRUST_PROXY=true (vertraute jedem X-Forwarded-For) auf die Proxy-Liste umstellen (#92)
  if grep -q "^TRUST_PROXY=true" .env && ! grep -q "^TRUSTED_PROXIES=" .env; then envset TRUSTED_PROXIES private; ok "TRUSTED_PROXIES=private ergänzt (enger fassen: docs/reverse-proxy.md)"; fi
fi
BIND="${BIND:-127.0.0.1}"; PORT="${PORT:-7310}"
# CPU-Grenze in compose.yaml (#135, Standard 2): auf Hosts mit weniger Kernen startet Docker den Container sonst nicht
if [ -z "$(envget BLAULICHTCMS_CPUS)" ]; then
  NCPU="$(nproc 2>/dev/null || echo 2)"
  if [ "$NCPU" -lt 2 ]; then envset BLAULICHTCMS_CPUS "$NCPU"; ok "BLAULICHTCMS_CPUS=$NCPU (Host hat $NCPU CPU-Kern)"; fi
fi

# Sicherungsschlüssel (#93): Volume-Sicherungen werden damit verschlüsselt. Er liegt außerhalb des Volumes und des
# Sicherungsziels (sonst läge er wieder neben den Daten); eine Kopie gehört getrennt verwahrt.
NEW_BACKUP_KEY=0
if [ "${BLAULICHTCMS_BACKUP_UNENCRYPTED:-0}" = 1 ]; then
  warn "BLAULICHTCMS_BACKUP_UNENCRYPTED=1 – Volume-Sicherungen bleiben unverschlüsselt (nicht empfohlen)."
elif [ -f "$BACKUP_KEY" ]; then
  chmod 600 "$BACKUP_KEY" 2>/dev/null || true
  ok "Sicherungsschlüssel vorhanden ($BACKUP_KEY)"
else
  ( umask 077; mkdir -p "$(dirname "$BACKUP_KEY")" ) 2>/dev/null || die "Ordner für den Sicherungsschlüssel lässt sich nicht anlegen: $(dirname "$BACKUP_KEY") (als root ausführen oder BLAULICHTCMS_BACKUP_KEY_FILE setzen)."
  ( umask 077; head -c 32 /dev/urandom | base64 > "$BACKUP_KEY" )
  chmod 600 "$BACKUP_KEY"
  NEW_BACKUP_KEY=1
  ok "Sicherungsschlüssel erzeugt: $BACKUP_KEY"
fi
# Sicherungsziel nur für root (#93); auch bestehende Ordner aus älteren Versionen einschränken
( umask 077; mkdir -p "$BACKUP_DIR/vor-update" )
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/vor-update" 2>/dev/null || warn "Rechte von $BACKUP_DIR ließen sich nicht auf 700 setzen (Netzlaufwerk?) – Freigabe prüfen."
find "$BACKUP_DIR" -maxdepth 3 -type f -name 'blaulichtcms-*' -perm /077 -exec chmod 600 {} + 2>/dev/null || true
if [ -n "$(find "$BACKUP_DIR" -maxdepth 3 -type f -name 'blaulichtcms-*.tar.gz' 2>/dev/null | head -1)" ]; then
  warn "Im Sicherungsziel liegen ältere, unverschlüsselte Archive (*.tar.gz). Sie enthalten den Master-Schlüssel im Klartext:"
  warn "nach der ersten verschlüsselten Sicherung löschen bzw. Kopien außer Haus ersetzen (docs/betrieb.md, Sicherung)."
fi
if [ -n "${BLAULICHTCMS_UPDATE_CHANNEL:-}" ]; then envset BLAULICHTCMS_UPDATE_CHANNEL "$BLAULICHTCMS_UPDATE_CHANNEL"; ok "Update-Kanal: $BLAULICHTCMS_UPDATE_CHANNEL (in .env gemerkt)"; fi

# ------------------------------------------------------------------------------------------------ 5. Docker-Netz
step "5/8 Docker-Netz $PROXY_NET"
if docker network inspect "$PROXY_NET" >/dev/null 2>&1; then
  ok "vorhanden$(docker network inspect -f '{{range .Containers}} {{.Name}}{{end}}' "$PROXY_NET" | sed 's/^ / – verbunden: /')"
else
  docker network create "$PROXY_NET" >/dev/null
  ok "angelegt"
fi
if [ "${PROXY_MODE:-}" = 1 ]; then
  # Proxy-Container suchen (Nginx Proxy Manager, Traefik, Caddy, nginx) und auf Wunsch mit dem Netz verbinden
  connected=" $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$PROXY_NET") "
  proxies="$(docker ps --format '{{.Names}} {{.Image}}' | grep -iE 'nginx-proxy-manager|jc21/|traefik|caddy|nginx|haproxy' | grep -v "^${CONTAINER} " | awk '{print $1}' || true)"
  for p in $proxies; do
    case "$connected" in
      *" $p "*) ok "Reverse Proxy „$p“ ist mit $PROXY_NET verbunden" ;;
      *) if [ "$UNATTENDED" = 1 ]; then
           warn "Container „$p“ ist nicht mit $PROXY_NET verbunden (nicht-interaktiv: unverändert)."
         elif yes_no "Container „$p“ sieht wie ein Reverse Proxy aus. Mit dem Netz $PROXY_NET verbinden?" "j"; then
           docker network connect "$PROXY_NET" "$p" && ok "„$p“ mit $PROXY_NET verbunden"
         fi ;;
    esac
  done
  [ -n "$proxies" ] || warn "Kein Reverse-Proxy-Container gefunden. Den Proxy später mit dem Netz verbinden: docker network connect $PROXY_NET <container>"
  # Nur aus diesem Netz kommende Weiterleitungs-Kopfzeilen gelten (#92)
  if [ "$NEW_ENV" = 1 ]; then
    subnet="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$PROXY_NET" | awk '{print $1}')"
    if [ -n "$subnet" ]; then envset TRUSTED_PROXIES "$subnet"; ok "vertrauenswürdige Proxy-Adressen: $subnet (Netz $PROXY_NET)"
    else envset TRUSTED_PROXIES private; warn "Netzbereich von $PROXY_NET unbekannt – TRUSTED_PROXIES=private"; fi
  fi
fi

# ------------------------------------------------------------------------------------------------ 6. Image bauen
step "6/8 Image bauen (dauert beim ersten Mal einige Minuten)"
IMAGE="blaulichtcms:${VERSION}-$(git rev-parse --short HEAD)"
# Neubau ohne Codeänderung (#103): eigener Tag mit Builddatum, damit Update-Weg mit Sicherung und Rückweg greift
[ "$REBUILD" = 1 ] && IMAGE="${IMAGE}-r$(date +%Y%m%d%H%M)"
BUILD_ARGS=()
for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
  [ -n "${!v:-}" ] && BUILD_ARGS+=(--build-arg "$v=${!v}")
done
# Unter set -u jede Variable mit Standard expandieren – sonst Abbruch, wenn z. B. nur NO_PROXY gesetzt ist (#159)
BUILD_PROXY="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"
if [ -n "$BUILD_PROXY" ]; then ok "Proxy für den Build: $BUILD_PROXY"
elif [ ${#BUILD_ARGS[@]} -gt 0 ]; then ok "Proxy-Ausnahmen für den Build: ${NO_PROXY:-${no_proxy:-}}"; fi
if [ -n "${BLAULICHTCMS_BUILD_CA:-}" ]; then
  [ -f "$BLAULICHTCMS_BUILD_CA" ] || die "BLAULICHTCMS_BUILD_CA zeigt auf keine Datei: $BLAULICHTCMS_BUILD_CA"
  BUILD_ARGS+=(--secret "id=build_ca,src=$BLAULICHTCMS_BUILD_CA")
  ok "Proxy-CA für den Build: $BLAULICHTCMS_BUILD_CA"
fi
LOG="$APP_DIR/build.log"
SELFTEST_LOG="$APP_DIR/selftest.log"
build_image() { # build_image [weitere Optionen für docker build]
  echo "  Protokoll: $LOG"
  # --pull: Basis-Images immer neu laden – sonst bleiben Sicherheitsupdates aus dem Cache des ersten Builds hängen (#103)
  if ! DOCKER_BUILDKIT=1 docker build --pull --progress=plain "$@" "${BUILD_ARGS[@]}" -t "$IMAGE" . >"$LOG" 2>&1; then
    tail -25 "$LOG" | sed 's/^/  │ /'
    die "Der Build ist fehlgeschlagen (Auszug oben, vollständig in $LOG). Hinter einem Proxy: HTTPS_PROXY und ggf. BLAULICHTCMS_BUILD_CA setzen."
  fi
  ok "$IMAGE gebaut"
}
# Selbsttest vor Wartungsmodus, Sicherung und Wechsel (#275): ohne Netz, als Benutzer des Images – alle Dateien
# lesbar, Programm samt Paketkonfiguration und nativen Modulen ladbar (scripts/image-selftest.sh)
selftest() { bash scripts/image-selftest.sh "$IMAGE" >"$SELFTEST_LOG" 2>&1; }
BUILT=0
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if selftest; then
    ok "$IMAGE ist bereits gebaut (Selbsttest bestanden)"
    # Hinweis, wenn die Basis-Images des laufenden Stands veraltet sind (#103)
    created="$(docker image inspect -f '{{.Created}}' "$IMAGE" 2>/dev/null | cut -c1-10)"
    if [ -n "$created" ] && [ "$(( ($(date +%s) - $(date -d "$created" +%s 2>/dev/null || date +%s)) / 86400 ))" -gt 30 ]; then
      warn "Das Image ist vom $created (älter als 30 Tage). Sicherheitsupdates der Basis-Images einspielen: sudo bash $APP_DIR/install.sh --rebuild"
    fi
  else
    # z. B. ein Image, das ein älteres install.sh aus einem Stand mit falschen Dateirechten gebaut hat
    warn "Das vorhandene Image $IMAGE besteht den Selbsttest nicht – es wird entfernt und ohne Cache neu gebaut:"
    tail -8 "$SELFTEST_LOG" | sed 's/^/  │ /'
    docker image rm "$IMAGE" >/dev/null 2>&1 || warn "$IMAGE ließ sich nicht entfernen (noch von einem Container verwendet?) – der Neubau übernimmt den Namen."
    build_image --no-cache
    BUILT=1
  fi
else
  build_image
  BUILT=1
fi
if [ "$BUILT" = 1 ]; then
  if ! selftest; then
    tail -20 "$SELFTEST_LOG" | sed 's/^/  │ /'
    die_rc 3 "Das neu gebaute Image $IMAGE besteht den Selbsttest nicht (Auszug oben, vollständig in $SELFTEST_LOG) – abgebrochen, bevor am Betrieb etwas geändert wurde; ein laufendes BlaulichtCMS läuft unverändert weiter. Der nächste Lauf baut das Image ohne Cache neu."
  fi
  ok "Selbsttest bestanden (ohne Netz, als Benutzer des Images: Dateien lesbar, Programm lädt)"
  # Optional: Schwachstellenprüfung vor dem Wechsel, wenn Trivy auf dem Host installiert ist (blockiert nicht)
  if command -v trivy >/dev/null; then
    if trivy image --quiet --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 "$IMAGE" >"$APP_DIR/trivy.log" 2>&1; then
      ok "Trivy: keine behebbaren hohen/kritischen Schwachstellen"
    else
      warn "Trivy meldet behebbare hohe/kritische Schwachstellen oder lief nicht durch – siehe $APP_DIR/trivy.log"
    fi
  fi
fi

# ------------------------------------------------------------------------------------------------ 7. Starten bzw. Update
health() { docker compose exec -T blaulichtcms node -e "fetch('http://127.0.0.1:7310/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; }
# Update-Pfad (Sicherung, Wechsel, Rückweg), sobald Daten vorhanden sind und ein anderes Image eingetragen ist – auch
# bei gestopptem Container (#155). Sonst liefe die Schema-Migration ohne Sicherung gegen das bestehende Volume.
HAS_DATA=0
docker volume inspect blaulichtcms_data >/dev/null 2>&1 && HAS_DATA=1
if [ "$HAS_DATA" = 1 ] && [ "$(envget BLAULICHTCMS_IMAGE)" != "$IMAGE" ]; then
  step "7/8 Update: Sicherung → Wechsel → Prüfung (bei Fehler automatischer Rückweg)"
  [ -n "$RUNNING" ] || warn "Container läuft nicht – Update mit Sicherung des bestehenden Volumes, ohne Wartungsmodus."
  # Meldung je nach Abbruchpunkt (Exit-Codes siehe scripts/update.sh, #120)
  rc=0; scripts/update.sh "$IMAGE" "$BACKUP_DIR/vor-update" --rollback || rc=$?
  case "$rc" in
    0) ;;
    3) die_rc 3 "Update vor dem Imagewechsel abgebrochen – BlaulichtCMS läuft weiter mit dem vorherigen Stand, Wartungsmodus beendet (Ausgabe oben)." ;;
    4) die_rc 4 "Das neue Image startete nicht sauber – automatischer Rückweg erfolgreich: vorheriges Image mit dem Datenstand von vor dem Update (Ausgabe oben)." ;;
    *) die_rc 5 "Update fehlgeschlagen und nicht automatisch zurückgenommen – BlaulichtCMS läuft womöglich NICHT oder steht im Wartungsmodus. Anleitung in der Ausgabe oben, Rückweg auch in docs/betrieb.md." ;;
  esac
  ok "Update auf $IMAGE abgeschlossen"
elif [ -n "$RUNNING" ]; then
  step "7/8 Start"
  ok "läuft bereits mit $IMAGE – nichts zu tun"
else
  step "7/8 Start"
  envset BLAULICHTCMS_IMAGE "$IMAGE"
  wait_healthy() {
    docker compose up -d --no-build 2>&1 | grep -v "^ *$" | sed 's/^/  /' || true
    printf "  warte auf BlaulichtCMS "
    okh=0
    for i in $(seq 1 90); do
      if health; then okh=1; break; fi
      printf "."; sleep 2
    done
    echo
  }
  wait_healthy
  # Proxy direkt auf dem Host: Anfragen kommen über das Gateway der Docker-Netze an (#92) – erst jetzt bekannt
  if [ "$okh" = 1 ] && [ "${PROXY_MODE:-}" = 2 ] && [ "$NEW_ENV" = 1 ]; then
    gws="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' "$CONTAINER" | xargs | tr ' ' ',')"
    if [ -n "$gws" ]; then
      envset TRUSTED_PROXIES "$gws"
      ok "vertrauenswürdige Proxy-Adressen: $gws (Docker-Gateway für den Proxy auf diesem Host) – Neustart"
      wait_healthy
    fi
  fi
  if [ "$okh" != 1 ]; then
    docker compose logs --tail 30 blaulichtcms | sed 's/^/  /'
    reason="$(curl -fsS "http://${BIND/0.0.0.0/127.0.0.1}:$PORT/healthz" 2>/dev/null || curl -sS "http://${BIND/0.0.0.0/127.0.0.1}:$PORT/healthz" 2>/dev/null || true)"
    [ -n "$reason" ] && echo "  Antwort: $reason"
    die "BlaulichtCMS ist nicht gesund gestartet (Protokoll oben). Nach der Ursache: erneut ./install.sh ausführen."
  fi
  ok "BlaulichtCMS läuft (Container $CONTAINER, $(docker compose exec -T blaulichtcms node -e "fetch('http://127.0.0.1:7310/healthz').then(r=>r.json()).then(j=>console.log(Object.entries(j.checks).map(([k,v])=>k+': '+v.detail).join(', ')))" 2>/dev/null))"
fi

# blaulichtcms:local erst nach erfolgreichem Start/Update auf den neuen Stand setzen (#121) – vorher zeigte es beim
# Rückweg sonst schon auf das neue Image. Handinstallationen und Skripte ohne BLAULICHTCMS_IMAGE nutzen diesen Namen.
docker tag "$IMAGE" blaulichtcms:local

# ------------------------------------------------------------------------------------------------ 8. Sicherung
step "8/8 Tägliche Sicherung"
CRON=/etc/cron.d/blaulichtcms
if [ "$WITH_CRON" = 0 ]; then
  ok "übersprungen (--no-cron)"
elif [ -f "$CRON" ]; then
  ok "eingerichtet ($CRON)"
elif [ "$UNATTENDED" = 1 ]; then
  warn "nicht eingerichtet (nicht-interaktiv) – einrichten mit: sudo bash $APP_DIR/install.sh"
elif [ ! -w /etc/cron.d ]; then
  warn "keine Schreibrechte für /etc/cron.d – Sicherung bitte selbst einplanen: $APP_DIR/scripts/backup-cron.sh $BACKUP_DIR"
elif yes_no "Täglich um 02:30 nach $BACKUP_DIR sichern (14 tägliche + 8 wöchentliche Stände, Container hält dafür kurz an)?" "j"; then
  cat > "$CRON" <<CRONTAB
# BlaulichtCMS: tägliche, verschlüsselte Volume-Sicherung (install.sh). Ziel am besten auf NAS/zweitem Datenträger.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BLAULICHTCMS_BACKUP_KEY_FILE=$BACKUP_KEY
30 2 * * * root cd $APP_DIR && scripts/backup-cron.sh $BACKUP_DIR >> /var/log/blaulichtcms-backup.log 2>&1
CRONTAB
  chmod 644 "$CRON"
  ok "eingerichtet: $CRON (Protokoll /var/log/blaulichtcms-backup.log)"
else
  warn "nicht eingerichtet – später: $APP_DIR/scripts/backup-cron.sh $BACKUP_DIR"
fi

# ------------------------------------------------------------------------------------------------ Update-Helfer
step "Update-Helfer (Image-Updates aus der App)"
HELPER_WANT="$HELPER_CHOICE"
[ -n "$HELPER_WANT" ] || HELPER_WANT="$(envget BLAULICHTCMS_UPDATE_HELPER)"
helper_why="$(helper_prereq)"
if [ "$UNATTENDED" = 1 ]; then
  # Aufruf durch den Helfer selbst: nur die Unit-Dateien auf den neuen Stand bringen, nichts ein- oder ausschalten
  if helper_installed && [ -z "$helper_why" ]; then
    mp="$(sed -n 's/^PathExists=//p' "$HELPER_UNIT.path")"; mp="${mp%/host-update/request.json}"
    if helper_write_files "$mp"; then systemctl daemon-reload && ok "Update-Helfer aktualisiert"; else ok "Update-Helfer unverändert"; fi
  fi
elif [ "$HELPER_WANT" = 0 ]; then
  if helper_installed; then helper_remove; ok "Update-Helfer entfernt (--no-helper)"; else ok "nicht eingerichtet (abgewählt; einrichten mit --with-helper)"; fi
  envset BLAULICHTCMS_UPDATE_HELPER 0
elif [ -n "$helper_why" ]; then
  warn "auf diesem Host nicht möglich (es fehlt: $helper_why) – Image-Updates weiter mit: sudo bash $APP_DIR/install.sh"
else
  if [ "$HELPER_WANT" != 1 ] && ! helper_installed; then
    echo "  Mit dem Update-Helfer lassen sich auch Updates, die ein neues Docker-Image brauchen, in der App unter"
    echo "  Einstellungen → Updates anstoßen. Ein kleiner systemd-Dienst führt dann genau diesen Ablauf aus (signiertes"
    echo "  Release prüfen, bauen, sichern, wechseln, bei Fehler zurück). Der Container erhält keinen Zugriff auf Docker."
    if yes_no "Update-Helfer einrichten?" "j"; then HELPER_WANT=1; else HELPER_WANT=0; fi
  fi
  if [ "$HELPER_WANT" = 0 ]; then
    envset BLAULICHTCMS_UPDATE_HELPER 0
    ok "nicht eingerichtet (später: sudo bash $APP_DIR/install.sh --with-helper)"
  else
    mp="$(docker volume inspect -f '{{.Mountpoint}}' blaulichtcms_data 2>/dev/null || true)"
    if [ -z "$mp" ] || [ ! -d "$mp" ] || [ "$(stat -c %u "$mp")" = 0 ]; then
      warn "Datenvolume blaulichtcms_data nicht gefunden oder noch nicht eingerichtet – Helfer beim nächsten Lauf einrichten."
    else
      helper_write_files "$mp" || true
      systemctl daemon-reload
      { systemctl enable blaulichtcms-update.path && systemctl restart blaulichtcms-update.path; } >/dev/null 2>&1 || die "blaulichtcms-update.path ließ sich nicht starten (systemctl status blaulichtcms-update.path)."
      BLAULICHTCMS_DIR="$APP_DIR" BLAULICHTCMS_HELPER_EXCHANGE="$mp/host-update" bash "$APP_DIR/scripts/host-update-helper.sh" announce >/dev/null 2>&1 || warn "Der Helfer konnte sich in der App nicht bekannt machen."
      envset BLAULICHTCMS_UPDATE_HELPER 1
      ok "eingerichtet: blaulichtcms-update.path (Anfragen aus $mp/host-update), Protokoll /var/log/blaulichtcms-update.log"
      ok "abschalten: sudo bash $APP_DIR/install.sh --remove-helper"
    fi
  fi
fi

# ------------------------------------------------------------------------------------------------ Reverse Proxy
INTERACTIVE=0
[ "$ASSUME_YES" = 0 ] && [ "$HAS_TTY" = 1 ] && INTERACTIVE=1
DOMAIN_NAME="${PUBLIC_URL#https://}"; DOMAIN_NAME="${DOMAIN_NAME#http://}"; DOMAIN_NAME="${DOMAIN_NAME%%/*}"
proxy_help() {
  case "${PROXY_MODE:-1}" in
    1) echo "  Im Nginx Proxy Manager: Hosts → Proxy Hosts → Add Proxy Host"
       echo "    Domain Names ............ $DOMAIN_NAME"
       echo "    Scheme / Hostname / Port  http / $CONTAINER / 7310"
       echo "    Block Common Exploits ... an"
       echo "    Reiter SSL .............. Zertifikat anfordern (Let's Encrypt), Force SSL und HTTP/2 an"
       echo "    Reiter Advanced ......... diesen Block einfügen:"
       echo "      client_max_body_size 2g;"
       echo "      proxy_request_buffering off;"
       echo "      proxy_read_timeout 1800s;"
       echo "      proxy_send_timeout 1800s;"
       echo "      proxy_set_header X-Forwarded-Proto \$scheme;"
       echo "      proxy_set_header X-Forwarded-For \$remote_addr;"
       echo "      access_log off;   # Upload-Links enthalten Zugangsschlüssel – nicht protokollieren"
       echo "  Anderer Proxy-Container: Ziel http://$CONTAINER:7310 im Netz $PROXY_NET, Beispiele in $APP_DIR/docs/reverse-proxy.md" ;;
    2) echo "  Im Reverse Proxy auf diesem Server einen HTTPS-Host für $DOMAIN_NAME anlegen,"
       echo "  Ziel http://127.0.0.1:$PORT. Fertige Beispiele für nginx, Caddy und Apache:"
       echo "    $APP_DIR/docs/reverse-proxy.md" ;;
    3) echo "  Im Reverse Proxy auf dem anderen Server einen HTTPS-Host für $DOMAIN_NAME anlegen,"
       echo "  Ziel http://$BIND:$PORT. Beispiele (IIS, HAProxy, Traefik …): $APP_DIR/docs/reverse-proxy.md" ;;
  esac
  echo "  Wichtig für Uploads großer Videos: bis 2 GB pro Anfrage zulassen, Zeitlimit 30 Minuten."
}
# Öffentliche Adresse vom Server aus prüfen und die Ursache benennen, wenn es nicht klappt
check_public() {
  local out rc code
  # unter set -e: Fehlercode von curl auffangen statt das Skript zu beenden
  rc=0; out="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_URL/healthz" 2>&1)" || rc=$?
  code="${out: -3}"
  case "$rc:$code" in
    0:200) ok "$PUBLIC_URL ist erreichbar und BlaulichtCMS antwortet"; return 0 ;;
    6:*)   warn "Der Name $DOMAIN_NAME ist nicht auflösbar – DNS-Eintrag (A/AAAA) auf den Proxy anlegen." ;;
    7:*)   warn "Keine Verbindung zu $DOMAIN_NAME auf Port 443 – läuft der Proxy, ist die Firewall offen?" ;;
    28:*)  warn "Zeitüberschreitung bei $DOMAIN_NAME – Firewall oder Weiterleitung prüfen." ;;
    35:*|60:*) warn "HTTPS-Fehler (Zertifikat fehlt oder ungültig) – im Proxy ein Zertifikat für $DOMAIN_NAME anfordern." ;;
    0:502|0:504) warn "Der Proxy erreicht BlaulichtCMS nicht (HTTP $code) – Ziel und Netz prüfen (siehe oben)." ;;
    0:404|0:421) warn "Der Proxy kennt $DOMAIN_NAME noch nicht (HTTP $code) – Proxy Host für genau diesen Namen anlegen." ;;
    0:503) warn "BlaulichtCMS meldet „nicht bereit“ (HTTP 503) – Protokoll: cd $APP_DIR && docker compose logs blaulichtcms" ;;
    *)     warn "Prüfung von $PUBLIC_URL fehlgeschlagen (curl $rc, HTTP $code)." ;;
  esac
  return 1
}
PUBLIC_OK=0
if [ "$MODE" = install ] || ! check_public >/dev/null 2>&1; then
  step "Reverse Proxy einrichten und Adresse prüfen"
  if check_public; then
    PUBLIC_OK=1
  else
    proxy_help
    echo "  Die Prüfung läuft vom Server aus. Klappt $PUBLIC_URL im Browser, der Server erreicht sich über den Router"
    echo "  aber nicht selbst (Hairpin-NAT), einfach mit „s“ weitermachen."
    while [ "$INTERACTIVE" = 1 ]; do
      a="$(ask "Enter = erneut prüfen, s = später" "")"
      case "$a" in s|S) break ;; esac
      if check_public; then PUBLIC_OK=1; break; fi
    done
    [ "$PUBLIC_OK" = 1 ] || warn "Adresse noch nicht erreichbar – später erneut prüfen: sudo bash $APP_DIR/install.sh"
  fi
else
  PUBLIC_OK=1
fi

# ------------------------------------------------------------------------------------------------ Sicherungsschlüssel
if [ "$NEW_BACKUP_KEY" = 1 ] && [ "$INTERACTIVE" = 1 ]; then
  step "Sicherungsschlüssel ablegen"
  echo "  Alle Sicherungen sind mit diesem Schlüssel verschlüsselt. Ohne ihn lässt sich keine Sicherung"
  echo "  wiederherstellen. Jetzt in einen Passwortmanager oder Tresor kopieren (nicht ins Sicherungsziel):"
  echo
  echo "    ${B}$(cat "$BACKUP_KEY")${N}"
  echo
  until yes_no "Schlüssel sicher abgelegt?" "n"; do
    warn "Bitte jetzt ablegen – später jederzeit anzeigen mit: sudo cat $BACKUP_KEY"
    yes_no "Trotzdem fortfahren?" "n" && break
  done
fi

# ------------------------------------------------------------------------------------------------ Abschluss
TOKEN=""
[ "$UNATTENDED" = 1 ] || TOKEN="$(docker compose exec -T blaulichtcms sh -c 'cat /data/setup-token.txt 2>/dev/null' 2>/dev/null || true)"
echo
echo "${B}════════════════════════════════════════════════════════════════════════════${N}"
echo "${G}${B}  BlaulichtCMS $VERSION läuft.${N}"
echo
n=1
if [ "$PUBLIC_OK" != 1 ]; then
  echo "  $n. Reverse Proxy fertig einrichten (Hinweise oben), dann erneut: sudo bash $APP_DIR/install.sh"; n=$((n+1))
fi
if [ -n "$TOKEN" ]; then
  echo "  $n. Ersteinrichtung im Browser öffnen:  ${B}$PUBLIC_URL/einrichtung${N}"
  echo "     Einrichtungsschlüssel:  ${B}$TOKEN${N}"
  echo "     (Organisation, Zeitzone, erstes Konto mit Zwei-Faktor-Anmeldung – die App führt durch die Schritte)"; n=$((n+1))
  echo "  $n. In BlaulichtCMS unter Einstellungen → Datenschutz Verantwortlichen und Datenschutzerklärung eintragen,"
  echo "     dann unter Verwaltung → Benutzer und Rollen die Redaktion einladen. Hilfe in der App unter /hilfe."; n=$((n+1))
fi
[ "$NEW_BACKUP_KEY" = 1 ] && [ "$INTERACTIVE" = 0 ] && { echo "  $n. Sicherungsschlüssel getrennt ablegen: sudo cat $BACKUP_KEY"; n=$((n+1)); }
echo
echo "  Updates:     Einstellungen → Updates in der App, oder: sudo bash $APP_DIR/install.sh"
echo "  Protokoll:   cd $APP_DIR && docker compose logs -f blaulichtcms"
echo "  Sicherungen: $BACKUP_DIR (verschlüsselt, Schlüssel $BACKUP_KEY)"
echo "${B}════════════════════════════════════════════════════════════════════════════${N}"
