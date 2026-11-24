#!/usr/bin/env bash
# start.sh: run the gift.
#
#   ./start.sh [dev]        local dev server (http://localhost:5173), re-seals first if content/ changed
#   ./start.sh preview      production build + leak check, served by the real server with its
#                           security headers (http://localhost:8080)
#   ./start.sh seal [args]  seal content/ now (args go to seal, e.g. --rotate-link or --no-passphrase)
#   ./start.sh deploy       on the server: domain config, first Let's Encrypt certificate, then
#                           build and start app + Envoy + certbot (add --yes to skip the prompt)
#   ./start.sh stop         stop the deployed stack
#   ./start.sh logs         follow the deployed stack's logs
#   ./start.sh status       show the deployed containers
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[1;33m✦\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;35m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. ${2:-Run ./install.sh first.}"; }

PAYLOAD=web/public/v/header.bin
COMPOSE=(docker compose --env-file deploy/.env -f deploy/docker-compose.yml)

# ---------- sealing ----------

# True when there is no payload yet, or something in content/ is newer than it.
seal_needed() {
  [ -f "$PAYLOAD" ] || return 0
  [ -d content ] && [ -n "$(find content -type f -newer "$PAYLOAD" ! -name .link-token ! -name .DS_Store -print -quit)" ]
}

seal() {
  [ -f content/gift.toml ] || die "content/gift.toml is missing. Run ./install.sh, then fill it in."
  if grep -qE '^recipient *= *"Navn"' content/gift.toml; then
    warn "content/gift.toml still holds the example text (recipient = \"Navn\")."
  fi
  need cargo
  say "Sealing content/ → web/public/v/"
  cargo run --quiet --release -p seal -- content web/public/v "$@"
}

seal_if_needed() {
  if seal_needed; then
    if [ -f content/gift.toml ]; then seal; else
      [ -f "$PAYLOAD" ] || die "Nothing to serve: no content/gift.toml and no sealed gift in web/public/v/."
    fi
  else
    ok "Sealed gift is up to date"
  fi
}

# ---------- local ----------

ensure_web_deps() {
  need node
  [ -d web/node_modules ] || { say "Installing web dependencies"; npm --prefix web ci --no-audit --no-fund --loglevel=error; }
  local wasm=web/src/wasm/gift_wasm_bg.wasm
  if [ ! -f "$wasm" ] || [ -n "$(find crates/gift-wasm/src crates/gift-crypto/src -newer "$wasm" -print -quit)" ]; then
    need wasm-pack
    say "Building the wasm core"
    npm --prefix web run --silent wasm >/dev/null 2>&1 || npm --prefix web run wasm
  fi
}

dev() {
  seal_if_needed
  ensure_web_deps
  say "Dev server on http://localhost:5173 (Ctrl+C to stop). To skip the prompt, open your private link with the domain swapped for localhost:5173."
  exec npm --prefix web run dev -- --port 5173
}

preview() {
  seal_if_needed
  ensure_web_deps
  say "Production build (typecheck, build, leak check)"
  npm --prefix web run --silent build
  need cargo
  cargo build --quiet --release -p server
  local port="${PORT:-8080}" acme
  acme=$(mktemp -d)
  say "Serving web/dist on http://localhost:$port with production headers (Ctrl+C to stop)"
  # cargo run finds the binary wherever CARGO_TARGET_DIR points.
  PORT="$port" STATIC_DIR=web/dist ACME_DIR="$acme" exec cargo run --quiet --release -p server
}

# ---------- server ----------

compose_ready() {
  need docker "Install Docker, then run ./install.sh --server."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' plugin)."
  if [ ! -f deploy/.env ]; then
    cp deploy/.env.example deploy/.env
    die "Created deploy/.env. Set DOMAIN and LE_EMAIL in it, then run again."
  fi
  set -a
  # shellcheck disable=SC1091
  . deploy/.env
  set +a
}

deploy() {
  local assume_yes="${1:-}"
  compose_ready
  [ -n "${DOMAIN:-}" ] && [ "$DOMAIN" != "gave.example.dk" ] || die "Set DOMAIN in deploy/.env."
  [ -n "${LE_EMAIL:-}" ] && [ "$LE_EMAIL" != "you@example.com" ] || die "Set LE_EMAIL in deploy/.env."
  case "$DOMAIN" in *[!a-zA-Z0-9.-]* | .* | *..*) die "DOMAIN '$DOMAIN' doesn't look like a host name." ;; esac

  # Envoy's virtual host must name the domain.
  local envoy=deploy/envoy/envoy.yaml current
  if ! grep -qF "domains: [\"$DOMAIN\"]" "$envoy"; then
    current=$(sed -nE 's/.*domains: \["([^"*]+)"\].*/\1/p' "$envoy" | head -1)
    [ -n "$current" ] || die "Couldn't find the gift's virtual host in $envoy."
    sed -i.bak "s/domains: \[\"$current\"\]/domains: [\"$DOMAIN\"]/" "$envoy" && rm -f "$envoy.bak"
    ok "Envoy virtual host set to $DOMAIN (was $current)"
  fi

  seal_if_needed

  # First certificate: Let's Encrypt standalone on port 80 (before Envoy takes the port).
  if ! "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh certbot -c 'test -s /certs/fullchain.pem' </dev/null >/dev/null 2>&1; then
    say "No certificate yet. Requesting one for $DOMAIN from Let's Encrypt."
    echo "  · DNS for $DOMAIN must point at this server, and port 80 must be reachable and free."
    echo "  · This accepts the Let's Encrypt Subscriber Agreement: https://letsencrypt.org/repository/"
    if [ "$assume_yes" != "--yes" ]; then
      local answer=""
      read -r -p "  Continue? [y/N] " answer || true
      [[ "$answer" =~ ^[YyJj] ]] || die "Stopped. Nothing was changed."
    fi
    "${COMPOSE[@]}" stop envoy >/dev/null 2>&1 || true
    "${COMPOSE[@]}" run --rm --no-deps -p 80:80 --entrypoint certbot certbot \
      certonly --standalone --non-interactive -d "$DOMAIN" -m "$LE_EMAIL" \
      --agree-tos --no-eff-email --deploy-hook /hooks/install-cert.sh
    ok "Certificate installed"
  else
    ok "Certificate present (renewed automatically)"
  fi

  say "Building and starting app, Envoy and certbot"
  "${COMPOSE[@]}" up -d --build --remove-orphans
  "${COMPOSE[@]}" ps
  ok "Live at https://$DOMAIN/"
}

case "${1:-dev}" in
  dev) dev ;;
  preview) preview ;;
  seal) shift; seal "$@" ;;
  deploy) deploy "${2:-}" ;;
  stop) compose_ready; "${COMPOSE[@]}" down ;;
  logs) compose_ready; "${COMPOSE[@]}" logs -f --tail 100 ;;
  status) compose_ready; "${COMPOSE[@]}" ps ;;
  -h | --help | help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" ;;
  *) die "Unknown command '$1' (try ./start.sh --help)" ;;
esac
