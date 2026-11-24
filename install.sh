#!/usr/bin/env bash
# install.sh: one-time setup. Safe to run again; nothing that exists is overwritten.
#
#   ./install.sh                     toolchain, dependencies, builds and content/ template. On a
#                                    Linux server it then sets up the public website: it asks for
#                                    your domain and configures Envoy with HTTPS (Let's Encrypt).
#   ./install.sh --domain NAME --email ADDRESS
#                                    the same, without asking for domain and e-mail
#   ./install.sh --server            website only (Docker + Envoy); for a server that just serves a
#                                    gift sealed elsewhere
#   ./install.sh --no-web            skip the website setup
#   ./install.sh --yes               don't ask before installing Rust, Node.js or Docker
#
# Change the domain later with: ./install.sh --domain NEW --email ADDRESS (or ./start.sh domain …)
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[1;33m✦\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;35m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. $2"; }

WASM_PACK_VERSION=0.15.1 # same as the Dockerfile

MODE=full
ASSUME_YES=""
WEB=auto
DOMAIN_ARG=""
EMAIL_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) MODE=server ;;
    --yes | -y) ASSUME_YES=1 ;;
    --no-web) WEB=no ;;
    --domain) DOMAIN_ARG="${2:-}"; WEB=yes; shift ;;
    --domain=*) DOMAIN_ARG="${1#*=}"; WEB=yes ;;
    --email) EMAIL_ARG="${2:-}"; shift ;;
    --email=*) EMAIL_ARG="${1#*=}" ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "Unknown option $1 (try --help)" ;;
  esac
  shift
done

ask() { # ask "question": yes unless the answer starts with n (or --yes was given)
  [ -n "$ASSUME_YES" ] && return 0
  local a=""
  read -r -p "  $1 [Y/n] " a || true
  [[ ! "$a" =~ ^[Nn] ]]
}

prompt() { # prompt "question" default → answer on stdout
  local a=""
  read -r -p "  $1${2:+ [$2]}: " a || true
  printf '%s' "${a:-${2:-}}"
}

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# ---------- toolchain ----------

# Rust via the official rustup installer, if missing.
ensure_rust() {
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" # a fresh install isn't on PATH yet
  command -v rustup >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1 && return
  say "Rust is not installed."
  need curl "Install curl, or Rust by hand from https://rustup.rs."
  ask "Install it now with the official installer from https://rustup.rs?" || die "Install Rust from https://rustup.rs, then run ./install.sh again."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  . "$HOME/.cargo/env"
}

# Node.js 20+, via Homebrew on macOS if available; otherwise explain.
ensure_node() {
  local major=0
  command -v node >/dev/null 2>&1 && major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 20 ] && command -v npm >/dev/null 2>&1 && return
  [ "$major" -gt 0 ] && say "Node.js $major is too old (20 or newer is needed)." || say "Node.js is not installed."
  if [ "$(uname)" = Darwin ] && command -v brew >/dev/null 2>&1; then
    ask "Install it now with Homebrew (brew install node)?" || die "Install Node.js 20+ from https://nodejs.org, then run ./install.sh again."
    brew install node
  else
    die "Install Node.js 20 or newer (https://nodejs.org, or e.g. 'sudo apt install nodejs npm' / nvm), then run ./install.sh again."
  fi
}

# Docker Engine + Compose v2. On Linux, offer the official convenience script.
ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    say "Docker is not installed (the website runs in Docker: app, Envoy, certbot)."
    [ "$(uname)" = Linux ] || die "Install Docker Desktop (https://docs.docker.com/get-docker/), then run ./install.sh again."
    need curl "Install curl first (e.g. apt install curl)."
    ask "Install it now with Docker's official script (https://get.docker.com)?" || die "Install Docker (https://docs.docker.com/engine/install/), then run ./install.sh again."
    curl -fsSL https://get.docker.com | as_root sh
    as_root systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (install the 'docker-compose-plugin' package)."
  docker info >/dev/null 2>&1 || die "Docker is installed but not running, or this user may not use it (try: sudo systemctl start docker, or sudo usermod -aG docker \$USER and log in again)."
  ok "Docker $(docker version --format '{{.Server.Version}}') with Compose $(docker compose version --short)"
}

dev_setup() {
  ensure_rust
  ensure_node
  ok "Rust $(rustc --version | cut -d' ' -f2), Node $(node --version)"

  say "Adding the WebAssembly target"
  rustup target add wasm32-unknown-unknown >/dev/null 2>&1
  ok "wasm32-unknown-unknown"

  if command -v wasm-pack >/dev/null 2>&1; then
    ok "wasm-pack $(wasm-pack --version | cut -d' ' -f2)"
  else
    say "Installing wasm-pack $WASM_PACK_VERSION (a few minutes, once)"
    cargo install wasm-pack --locked --version "$WASM_PACK_VERSION"
  fi

  say "Installing web dependencies"
  npm --prefix web ci --no-audit --no-fund --loglevel=error
  ok "web/node_modules"

  say "Building the wasm core"
  npm --prefix web run --silent wasm >/dev/null 2>&1 || npm --prefix web run wasm
  ok "web/src/wasm"

  say "Building seal and the server (release)"
  cargo build --release --quiet -p seal -p server
  ok "target/release/{seal,server}"

  if [ -d content ]; then
    ok "content/ exists (left untouched)"
  else
    cp -R content.example content
    ok "Created content/ from the template"
  fi
}

# ---------- website: Envoy + HTTPS ----------

valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$ ]]; }
valid_email() { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }
env_value() { [ -f deploy/.env ] && sed -n "s/^$1=//p" deploy/.env | head -1 || true; }

# Warn (don't fail) if the domain doesn't resolve to this machine yet.
dns_check() {
  local domain="$1" got mine ip
  command -v getent >/dev/null 2>&1 || return 0
  got=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
  if [ -z "$got" ]; then
    warn "$domain doesn't resolve yet. At your DNS provider, add an A record: $domain → this server's public IP."
    return 0
  fi
  mine=" $(hostname -I 2>/dev/null) "
  for ip in $got; do
    case "$mine" in *" $ip "*) ok "DNS: $domain → $ip (this server)"; return 0 ;; esac
  done
  warn "DNS: $domain → ${got% } isn't one of this server's addresses (${mine# }). Fine behind NAT; otherwise fix the A record."
}

# Ports 80/443 must be free for Envoy: other containers and host programs both count.
ports_check() { ./start.sh check-ports || true; }

# Open 80/443 in ufw if it is active.
firewall_check() {
  command -v ufw >/dev/null 2>&1 || return 0
  as_root ufw status 2>/dev/null | grep -q "^Status: active" || return 0
  local rules
  rules=$(as_root ufw status)
  if grep -qE "^80(/tcp)?[[:space:]].*ALLOW" <<<"$rules" && grep -qE "^443(/tcp)?[[:space:]].*ALLOW" <<<"$rules"; then
    ok "Firewall (ufw) allows 80 and 443"
  elif ask "The ufw firewall is active. Allow ports 80 and 443 (needed for the website)?"; then
    as_root ufw allow 80/tcp >/dev/null && as_root ufw allow 443/tcp >/dev/null
    ok "ufw: allowed 80/tcp and 443/tcp"
  else
    warn "Remember to open ports 80 and 443, or the website won't be reachable."
  fi
}

web_setup() {
  say "Website: Envoy with HTTPS on your own domain"
  local domain="$DOMAIN_ARG" email="$EMAIL_ARG" cur_domain cur_email
  cur_domain=$(env_value DOMAIN)
  cur_email=$(env_value LE_EMAIL)
  [ "$cur_domain" = gave.example.dk ] && cur_domain=""
  [ "$cur_email" = you@example.com ] && cur_email=""

  if [ -z "$domain" ]; then
    if [ -n "$ASSUME_YES" ] || [ ! -t 0 ]; then
      domain="$cur_domain"
    else
      echo "  The gift will live at https://<domain>/. Use a domain or subdomain you control,"
      echo "  e.g. gave.example.dk. Press Enter without typing to skip this for now."
      domain=$(prompt "Domain" "$cur_domain")
    fi
  fi
  domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##')
  if [ -z "$domain" ]; then
    ok "Website setup skipped. Later: ./install.sh --domain gave.example.dk --email you@example.com"
    return 0
  fi
  while ! valid_domain "$domain"; do
    [ -t 0 ] && [ -z "$ASSUME_YES" ] || die "'$domain' doesn't look like a domain name (e.g. gave.example.dk)."
    warn "'$domain' doesn't look like a domain name (e.g. gave.example.dk)."
    domain=$(prompt "Domain" "" | tr '[:upper:]' '[:lower:]')
    [ -n "$domain" ] || { ok "Website setup skipped."; return 0; }
  done

  [ -n "$email" ] || email="$cur_email"
  if [ -z "$email" ] || ! valid_email "$email"; then
    [ -t 0 ] && [ -z "$ASSUME_YES" ] || die "Give an e-mail for Let's Encrypt with --email you@example.com"
    echo "  Let's Encrypt sends certificate expiry notices to this address (it stays on this server)."
    email=$(prompt "E-mail" "")
    while ! valid_email "$email"; do
      warn "That doesn't look like an e-mail address."
      email=$(prompt "E-mail" "")
    done
  fi

  ensure_docker
  ./start.sh domain "$domain" "$email"
  dns_check "$domain"
  ports_check
  firewall_check
  chmod +x start.sh deploy/*.sh deploy/certbot/*.sh

  if [ ! -f web/public/v/header.bin ] && [ ! -f content/gift.toml ]; then
    warn "No gift to serve yet: seal one elsewhere and copy web/public/v/ here, or put content/ here."
    echo "  Then start the website with: ./start.sh deploy"
    return 0
  fi
  if [ -f content/gift.toml ] && grep -qE '^recipient *= *"Navn"' content/gift.toml; then
    echo "  (content/ is still the example. You can go online now and run ./start.sh deploy again after editing it.)"
  fi
  if ask "Get the HTTPS certificate and start https://$domain/ now?"; then
    ./start.sh deploy ${ASSUME_YES:+--yes}
  else
    echo "  Start it later with: ./start.sh deploy"
  fi
}

# ---------- main ----------

if [ "$MODE" = server ]; then
  chmod +x start.sh deploy/*.sh deploy/certbot/*.sh
  web_setup
  exit 0
fi

dev_setup
chmod +x start.sh deploy/*.sh deploy/certbot/*.sh
if command -v docker >/dev/null 2>&1; then ok "Docker found"; fi

# The website setup runs on Linux servers by default, or anywhere when --domain is given.
if [ "$WEB" = yes ] || { [ "$WEB" = auto ] && [ "$(uname)" = Linux ]; }; then
  echo
  web_setup
fi

cat <<'EOF'

Next:
  1. Fill in content/gift.toml and put your photos in content/photos/.
  2. ./start.sh           seals the gift (you choose her code) and shows a preview
  3. ./start.sh deploy    puts it online at your domain with HTTPS (after ./install.sh set the domain)
EOF
