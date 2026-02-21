#!/usr/bin/env sh
set -eu

CONFIG_FILE="${1:-config.env}"

random_hex() {
  bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes" | tr -d '\n'
    return
  fi

  if [ -r /dev/urandom ]; then
    # shellcheck disable=SC2002
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
    return
  fi

  echo "Fehler: Kein Zufallsquellen-Generator gefunden (openssl oder /dev/urandom)." >&2
  exit 1
}

ensure_key() {
  key="$1"
  value="$2"

  if grep -Eq "^${key}=" "$CONFIG_FILE"; then
    return 1
  fi

  printf '%s=%s\n' "$key" "$value" >> "$CONFIG_FILE"
  return 0
}

created_file=0

if [ ! -f "$CONFIG_FILE" ]; then
  printf '# FlatWiki Erstkonfiguration\n' > "$CONFIG_FILE"
  created_file=1
fi

if [ -s "$CONFIG_FILE" ] && [ "$(tail -c 1 "$CONFIG_FILE" || true)" != "" ]; then
  printf '\n' >> "$CONFIG_FILE"
fi

ensure_key "PORT" "3000" || true
ensure_key "HOST" "0.0.0.0" || true
ensure_key "COOKIE_SECRET" "$(random_hex 32)" || true
ensure_key "PASSWORD_PEPPER" "$(random_hex 24)" || true
ensure_key "CONTENT_ENCRYPTION_KEY" "$(random_hex 32)" || true
ensure_key "CONTENT_INTEGRITY_KEY" "$(random_hex 32)" || true
ensure_key "BACKUP_ENCRYPTION_KEY" "$(random_hex 32)" || true
ensure_key "BACKUP_AUTO_ENABLED" "false" || true
ensure_key "BACKUP_AUTO_INTERVAL_HOURS" "24" || true
ensure_key "BACKUP_RETENTION_MAX_FILES" "30" || true
ensure_key "BACKUP_RETENTION_MAX_AGE_DAYS" "0" || true
ensure_key "SESSION_TTL_HOURS" "12" || true
ensure_key "WIKI_TITLE" "FlatWiki" || true
ensure_key "INDEX_BACKEND" "flat" || true
ensure_key "BOOTSTRAP_ADMIN_USERNAME" "admin" || true

echo "Installer abgeschlossen: $CONFIG_FILE"

if [ "$created_file" -eq 1 ]; then
  echo "- Datei wurde neu erstellt."
else
  echo "- Datei war vorhanden; fehlende Werte wurden ergänzt."
fi

echo "- Admin wird über den visuellen Setup-Assistenten beim ersten Start angelegt."
echo "- Optional für Headless-Bootstrap: BOOTSTRAP_ADMIN_PASSWORD manuell in config.env setzen."
echo "- Bitte config.env vor Produktion prüfen und sensible Werte sicher aufbewahren."

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo ""
  echo "Starte FlatWiki mit Docker..."
  docker compose up -d --build
  echo ""
  echo "FlatWiki läuft unter:              http://127.0.0.1:3000"
  echo "Setup-Assistent (erster Start):    http://127.0.0.1:3000/setup"
else
  echo ""
  echo "Docker nicht gefunden. FlatWiki manuell starten:"
  echo "  docker compose up -d --build   (Docker)"
  echo "  npm install && npm run dev     (Node.js Entwicklung)"
fi
