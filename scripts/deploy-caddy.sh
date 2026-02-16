#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
FlatWiki Domain+HTTPS Setup (Caddy + Let's Encrypt/ACME)

Verwendung:
  ./scripts/deploy-caddy.sh --domain wiki.example.com [--email admin@example.com] [--force] [--no-up]

Optionen:
  --domain   Öffentliche Domain für FlatWiki (Pflicht)
  --email    E-Mail für Let's Encrypt/ACME (optional, empfohlen)
  --force    Vorhandene deploy-Dateien überschreiben
  --no-up    Nur Dateien erzeugen, Container nicht starten
  -h, --help Hilfe anzeigen

Erzeugte Dateien (lokal, nicht für Git):
  deploy/Caddyfile
  docker-compose.caddy.yml
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Fehler: Benötigtes Kommando fehlt: $1" >&2
    exit 1
  fi
}

DOMAIN=""
EMAIL=""
FORCE=0
NO_UP=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain)
      [ "$#" -ge 2 ] || { echo "Fehler: --domain benötigt einen Wert." >&2; exit 1; }
      DOMAIN="$2"
      shift 2
      ;;
    --email)
      [ "$#" -ge 2 ] || { echo "Fehler: --email benötigt einen Wert." >&2; exit 1; }
      EMAIL="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift 1
      ;;
    --no-up)
      NO_UP=1
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

if [ -z "$DOMAIN" ]; then
  echo "Fehler: --domain ist erforderlich." >&2
  usage >&2
  exit 1
fi

if ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$'; then
  echo "Fehler: Domain enthält ungültige Zeichen: $DOMAIN" >&2
  exit 1
fi

if [ -n "$EMAIL" ] && ! printf '%s' "$EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
  echo "Fehler: Ungültige E-Mail-Adresse: $EMAIL" >&2
  exit 1
fi

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEPLOY_DIR="$ROOT_DIR/deploy"
CADDYFILE_PATH="$DEPLOY_DIR/Caddyfile"
COMPOSE_OVERRIDE_PATH="$ROOT_DIR/docker-compose.caddy.yml"

if [ ! -f "$ROOT_DIR/docker-compose.yml" ]; then
  echo "Fehler: docker-compose.yml nicht gefunden in $ROOT_DIR" >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/config.env" ]; then
  echo "Fehler: config.env fehlt. Bitte zuerst ./install.sh ausführen." >&2
  exit 1
fi

mkdir -p "$DEPLOY_DIR"

if [ -f "$CADDYFILE_PATH" ] && [ "$FORCE" -ne 1 ]; then
  echo "Fehler: $CADDYFILE_PATH existiert bereits. Nutze --force zum Überschreiben." >&2
  exit 1
fi

if [ -f "$COMPOSE_OVERRIDE_PATH" ] && [ "$FORCE" -ne 1 ]; then
  echo "Fehler: $COMPOSE_OVERRIDE_PATH existiert bereits. Nutze --force zum Überschreiben." >&2
  exit 1
fi

if [ -n "$EMAIL" ]; then
  cat >"$CADDYFILE_PATH" <<EOF
{
  email $EMAIL
}

$DOMAIN {
  encode zstd gzip
  reverse_proxy flatwiki:3000
}
EOF
else
  cat >"$CADDYFILE_PATH" <<EOF
$DOMAIN {
  encode zstd gzip
  reverse_proxy flatwiki:3000
}
EOF
fi

cat >"$COMPOSE_OVERRIDE_PATH" <<'EOF'
services:
  flatwiki:
    ports: []
    expose:
      - "3000"

  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on:
      - flatwiki
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
EOF

echo "OK: $CADDYFILE_PATH erstellt"
echo "OK: $COMPOSE_OVERRIDE_PATH erstellt"
echo ""
echo "Wichtig:"
echo "- DNS A/AAAA von $DOMAIN muss auf deinen Server zeigen."
echo "- Ports 80 und 443 müssen offen sein."
echo ""

if [ "$NO_UP" -eq 1 ]; then
  echo "Container-Start übersprungen (--no-up)."
  echo "Starte manuell mit:"
  echo "  cd \"$ROOT_DIR\""
  echo "  docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build"
  exit 0
fi

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "Fehler: 'docker compose' ist nicht verfügbar." >&2
  exit 1
fi

(
  cd "$ROOT_DIR"
  docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
)

echo ""
echo "FlatWiki läuft jetzt hinter Caddy."
echo "Prüfen:"
echo "  https://$DOMAIN"
echo "  docker compose -f docker-compose.yml -f docker-compose.caddy.yml logs -f caddy"
echo "  /admin/ssl im FlatWiki-Adminbereich"
