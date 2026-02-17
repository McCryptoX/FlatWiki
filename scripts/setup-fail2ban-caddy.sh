#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
FlatWiki Fail2ban Setup (Docker-Caddy)

Verwendung:
  sudo ./scripts/setup-fail2ban-caddy.sh [--instance-dir /opt/flatwiki] [--jail-name flatwiki-caddy]
                                           [--maxretry 8] [--findtime 10m] [--bantime 1h]
                                           [--no-install]

Optionen:
  --instance-dir  FlatWiki-Instanzpfad (Standard: Projektordner dieses Scripts)
  --jail-name     Name der Fail2ban-Jail (Standard: flatwiki-caddy)
  --maxretry      Fehlversuche bis Bann (Standard: 8)
  --findtime      Zeitfenster (Standard: 10m)
  --bantime       Bann-Dauer (Standard: 1h)
  --no-install    fail2ban nicht automatisch installieren
  -h, --help      Hilfe anzeigen

Was eingerichtet wird:
  - /etc/fail2ban/filter.d/flatwiki-caddy.conf
  - /etc/fail2ban/jail.d/<jail-name>.local
  - Logdatei: <instance-dir>/deploy/logs/access.log
EOF
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Fehler: Bitte als root (oder via sudo) ausführen." >&2
    exit 1
  fi
}

INSTANCE_DIR=""
JAIL_NAME="flatwiki-caddy"
MAXRETRY="8"
FINDTIME="10m"
BANTIME="1h"
NO_INSTALL="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --instance-dir)
      [ "$#" -ge 2 ] || { echo "Fehler: --instance-dir benötigt einen Wert." >&2; exit 1; }
      INSTANCE_DIR="$2"
      shift 2
      ;;
    --jail-name)
      [ "$#" -ge 2 ] || { echo "Fehler: --jail-name benötigt einen Wert." >&2; exit 1; }
      JAIL_NAME="$2"
      shift 2
      ;;
    --maxretry)
      [ "$#" -ge 2 ] || { echo "Fehler: --maxretry benötigt einen Wert." >&2; exit 1; }
      MAXRETRY="$2"
      shift 2
      ;;
    --findtime)
      [ "$#" -ge 2 ] || { echo "Fehler: --findtime benötigt einen Wert." >&2; exit 1; }
      FINDTIME="$2"
      shift 2
      ;;
    --bantime)
      [ "$#" -ge 2 ] || { echo "Fehler: --bantime benötigt einen Wert." >&2; exit 1; }
      BANTIME="$2"
      shift 2
      ;;
    --no-install)
      NO_INSTALL="1"
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Fehler: Unbekannte Option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_root

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -z "$INSTANCE_DIR" ]; then
  INSTANCE_DIR="$ROOT_DIR"
fi
INSTANCE_DIR=$(CDPATH= cd -- "$INSTANCE_DIR" && pwd)

if [ ! -f "$INSTANCE_DIR/docker-compose.yml" ]; then
  echo "Fehler: Kein FlatWiki-Instanzordner: $INSTANCE_DIR (docker-compose.yml fehlt)." >&2
  exit 1
fi

LOG_PATH="$INSTANCE_DIR/deploy/logs/access.log"
FILTER_PATH="/etc/fail2ban/filter.d/flatwiki-caddy.conf"
JAIL_PATH="/etc/fail2ban/jail.d/${JAIL_NAME}.local"

mkdir -p "$(dirname "$LOG_PATH")"
touch "$LOG_PATH"

if ! command -v fail2ban-client >/dev/null 2>&1; then
  if [ "$NO_INSTALL" = "1" ]; then
    echo "Fehler: fail2ban ist nicht installiert (--no-install gesetzt)." >&2
    exit 1
  fi
  echo "Installiere fail2ban ..."
  apt-get update
  apt-get install -y fail2ban
fi

cat >"$FILTER_PATH" <<'EOF'
[Definition]
# Quelle: Caddy JSON Access Log (Docker)
failregex = ^.*"request":\{.*"remote_ip":"<HOST>".*"method":"POST".*"uri":"/login".*"status":429.*$
            ^.*"request":\{.*"remote_ip":"<HOST>".*"uri":"/(wp-login\.php|xmlrpc\.php|phpmyadmin|\.env|\.git|boaform/admin/formLogin).*"status":(401|403|404).*$

ignoreregex =
EOF

cat >"$JAIL_PATH" <<EOF
[$JAIL_NAME]
enabled = true
filter = flatwiki-caddy
port = http,https
logpath = $LOG_PATH
backend = auto
maxretry = $MAXRETRY
findtime = $FINDTIME
bantime = $BANTIME
EOF

systemctl enable --now fail2ban
if ! fail2ban-client reload >/dev/null 2>&1; then
  systemctl restart fail2ban
fi

echo "OK: Filter erstellt: $FILTER_PATH"
echo "OK: Jail erstellt:   $JAIL_PATH"
echo "OK: Logdatei:        $LOG_PATH"
echo ""
echo "Status prüfen:"
echo "  fail2ban-client status"
echo "  fail2ban-client status $JAIL_NAME"
echo ""
echo "Hinweis für mehrere Instanzen:"
echo "  Script pro Instanz mit eigener Jail aufrufen, z.B."
echo "  sudo ./scripts/setup-fail2ban-caddy.sh --instance-dir /opt/flatwiki-public --jail-name flatwiki-public"
echo "  sudo ./scripts/setup-fail2ban-caddy.sh --instance-dir /opt/flatwiki-private --jail-name flatwiki-private"
