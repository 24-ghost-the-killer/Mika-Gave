#!/usr/bin/env bash
# install.sh: one-time setup.
#
#   ./install.sh            your own machine: toolchain, dependencies, builds, content/ template
#   ./install.sh --server   the server: only checks Docker (the image builds everything else)
#
# Safe to run again; nothing that exists is overwritten.
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[1;33m✦\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;35m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. $2"; }

WASM_PACK_VERSION=0.15.1 # same as the Dockerfile

server_setup() {
  need docker "Install Docker Engine: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 missing (the 'docker compose' plugin)."
  docker info >/dev/null 2>&1 || die "Docker is installed but not running, or this user may not use it (try: sudo usermod -aG docker \$USER, then log in again)."
  ok "Docker $(docker version --format '{{.Server.Version}}') with $(docker compose version --short)"

  if [ ! -f deploy/.env ]; then
    cp deploy/.env.example deploy/.env
    ok "Created deploy/.env. Set DOMAIN and LE_EMAIL in it."
  else
    ok "deploy/.env exists"
  fi
  chmod +x start.sh deploy/*.sh
  [ -f web/public/v/header.bin ] || warn "No sealed gift in web/public/v/ yet. Seal it on your own machine (./start.sh seal) and copy web/public/v/ here, or put content/ here and let start.sh seal it."

  cat <<EOF

Next:
  1. Point DNS for your domain at this server, and open ports 80 and 443.
  2. Edit deploy/.env (DOMAIN, LE_EMAIL).
  3. ./start.sh deploy
EOF
}

dev_setup() {
  need rustup "Install Rust from https://rustup.rs (then open a new terminal)."
  need cargo "Install Rust from https://rustup.rs (then open a new terminal)."
  need node "Install Node.js 20 or newer (https://nodejs.org or your package manager)."
  need npm "npm comes with Node.js."
  local node_major
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$node_major" -ge 20 ] || die "Node.js $node_major is too old; 20 or newer is needed."
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
  chmod +x start.sh deploy/*.sh

  if command -v docker >/dev/null 2>&1; then ok "Docker found (needed only to deploy)"; else warn "Docker not found. Only needed for deploying."; fi

  cat <<EOF

Next:
  1. Fill in content/gift.toml and put your photos in content/photos/.
  2. ./start.sh          seals the gift (asks for the passphrase) and opens a local preview
EOF
}

case "${1:-}" in
  --server) server_setup ;;
  "") dev_setup ;;
  -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" ;;
  *) die "Unknown option $1 (try --help)" ;;
esac
