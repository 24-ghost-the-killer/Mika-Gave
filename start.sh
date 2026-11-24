#!/usr/bin/env bash
# start.sh: run the gift.
#
#   ./start.sh              dev on your own machine; preview when you're logged in over SSH
#   ./start.sh dev          local dev server (http://localhost:5173), re-seals first if content/ changed
#   ./start.sh preview      production build + leak check, served by the real server with its
#                           security headers (http://localhost:8080)
#   ./start.sh seal [args]  seal content/ now (args go to seal, e.g. --rotate-link or --no-passphrase)
#   ./start.sh link         print the private link again (it opens the gift without the code)
#   ./start.sh new-code     choose a new code (the old one stops working) and update the live site;
#                           add --rotate-link to also replace the link
#   ./start.sh deploy       on the server: domain config, first Let's Encrypt certificate, then
#                           build and start app + Envoy + certbot (add --yes to skip the prompt).
#                           If another project's Envoy already owns ports 80/443, it offers to run
#                           the gift behind that Envoy instead (adds a marked section to its config).
#   ./start.sh detach       undo that: remove the gift's section from the other Envoy, stop the gift
#   ./start.sh domain NAME EMAIL   set (or change) the public domain and Let's Encrypt e-mail
#   ./start.sh check-ports  show what (if anything) is using ports 80/443
#   ./start.sh proxy-info   describe the other web server on 80/443 (to run the gift behind it)
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
ASSUME_YES=""

# ---------- sealing ----------

# True when there is no payload yet, or something in content/ is newer than it.
seal_needed() {
  [ -f "$PAYLOAD" ] || return 0
  [ -d content ] && [ -n "$(find content -type f -newer "$PAYLOAD" ! -name .link-token ! -name .DS_Store -print -quit)" ]
}

# True while content/ is still the untouched template: example name and no photos added.
is_example() {
  grep -qE '^recipient *= *"Navn"' content/gift.toml &&
    [ -z "$(find content/photos -type f ! -name README.md ! -name .DS_Store -print -quit 2>/dev/null)" ]
}

seal() {
  [ -f content/gift.toml ] || die "content/gift.toml is missing. Run ./install.sh, then fill it in."
  if is_example; then
    # An untouched template from an older version may reference photos that don't exist; refresh it.
    if ! cmp -s content/gift.toml content.example/gift.toml; then
      cp content/gift.toml content/gift.toml.bak
      cp content.example/gift.toml content/gift.toml
      ok "Refreshed the example content/gift.toml (old copy: content/gift.toml.bak)"
    fi
    warn "content/gift.toml still holds the example text. Fine for a first look; edit it for the real gift."
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

# ---------- keys ----------

# The private link: the stored token after the domain.
show_link() {
  [ -s content/.link-token ] || die "There is no link yet. Run ./start.sh seal first."
  local domain=""
  [ -f deploy/.env ] && domain=$(sed -n 's/^DOMAIN=//p' deploy/.env | head -1)
  if [ -n "$domain" ] && [ "$domain" != gave.example.dk ]; then
    echo "https://$domain/#$(cat content/.link-token)"
  else
    echo "https://YOUR-DOMAIN/#$(cat content/.link-token)"
  fi
}

# Re-seal with a new code (seal always asks), then rebuild the running site so it serves the new files.
new_code() {
  seal "$@"
  if [ -f deploy/.env ] && command -v docker >/dev/null 2>&1 &&
    [ -n "$(docker ps -q --filter label=com.docker.compose.project=stjernehimlen --filter label=com.docker.compose.service=app)" ]; then
    compose_ready
    say "Updating the live site"
    "${COMPOSE[@]}" up -d --build app
    ok "The live site now uses the new code. The old one no longer works."
  else
    ok "Sealed with the new code. Run ./start.sh deploy to put it online."
  fi
  echo "  Private link: $(show_link)"
}

# ---------- local ----------

# This machine's address as seen by the SSH client (else localhost).
host_addr() {
  local ip
  ip=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $3}')
  case "$ip" in "") echo localhost ;; *:*) echo "[$ip]" ;; *) echo "$ip" ;; esac
}

open_hint() { # open_hint URL
  say "Open $1/ in your browser"
  [ -s content/.link-token ] && echo "  · or skip the code with your private link: $1/#$(cat content/.link-token)"
  [ -n "${SSH_CONNECTION:-}" ] && echo "  · on a server, the port must be open in its firewall (e.g. ufw allow ${1##*:}/tcp)"
  return 0
}

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
  open_hint "http://localhost:5173"
  say "Dev server running (Ctrl+C to stop)"
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
  open_hint "http://$(host_addr):$port"
  say "Serving web/dist with production headers (Ctrl+C to stop)"
  # cargo run finds the binary wherever CARGO_TARGET_DIR points.
  PORT="$port" STATIC_DIR=web/dist ACME_DIR="$acme" exec cargo run --quiet --release -p server
}

# ---------- server ----------

# Everything else holding host port $1: other Docker containers, or programs on the host.
# Our own containers (project "stjernehimlen") don't count.
port_holders() {
  local port="$1"
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null |
      grep -E ":$port->" | grep -v '^stjernehimlen-' |
      awk -F'|' '{ print "Docker container \"" $1 "\" (" $2 ")" }' || true
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$port" 2>/dev/null | grep -v docker-proxy |
      sed -E 's/.*users:\(\("([^"]+)".*/program "\1"/; t; s/.*/a program (run as root to see which)/' | sort -u || true
  fi
}

# ./start.sh proxy-info: describe the other container that owns port 443 (its project folder,
# mounts, networks and Envoy/nginx config, with secrets blanked), so the gift can be set up behind it.
proxy_info() {
  need docker "Docker is needed for this."
  local c
  c=$(docker ps --format '{{.Names}}|{{.Ports}}' | grep -E ':443->' | grep -v '^stjernehimlen-' | cut -d'|' -f1 | head -1)
  [ -n "$c" ] || c=$(docker ps --format '{{.Names}}|{{.Ports}}' | grep -E ':80->' | grep -v '^stjernehimlen-' | cut -d'|' -f1 | head -1)
  [ -n "$c" ] || die "No other container is using port 80 or 443."

  echo "===== container"
  docker inspect "$c" --format 'name:      {{.Name}}
image:     {{.Config.Image}}
project:   {{index .Config.Labels "com.docker.compose.project"}}
folder:    {{index .Config.Labels "com.docker.compose.project.working_dir"}}
compose:   {{index .Config.Labels "com.docker.compose.project.config_files"}}
command:   {{json .Config.Entrypoint}} {{json .Config.Cmd}}
ports:     {{range $p, $b := .NetworkSettings.Ports}}{{$p}}{{if $b}}->{{(index $b 0).HostPort}}{{end}} {{end}}'
  echo "===== networks"
  docker inspect "$c" --format '{{range $n, $v := .NetworkSettings.Networks}}{{$n}}{{"\n"}}{{end}}'
  echo "===== mounts"
  docker inspect "$c" --format '{{range .Mounts}}{{.Type}}  {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

  # Config files from the mounts (yaml/conf/json, small ones only), secrets blanked.
  local src f
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    for f in $( { [ -f "$src" ] && echo "$src"; [ -d "$src" ] && find "$src" -maxdepth 2 -type f \( -name '*.yaml' -o -name '*.yml' -o -name '*.conf' -o -name '*.json' -o -name 'Caddyfile' \) 2>/dev/null; } | head -20); do
      case "$f" in *.pem | *.key | *.crt) continue ;; esac
      [ "$(wc -c < "$f")" -le 200000 ] || continue
      echo "===== file: $f"
      perl -0777 -pe '
        s/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/REDACTED PRIVATE KEY/gs;
        s/((?:password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|client_secret)[^:=\n]*[:=][ \t]*)[^\s][^\n]*/${1}REDACTED/gi;
      ' "$f"
    done
  done < <(docker inspect "$c" --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}')
  echo "===== end (check the text above for anything private before you share it)"
}

# check_ports strict|warn: Envoy needs host ports 80 and 443 for itself.
check_ports() {
  local mode="$1" port holders busy=""
  for port in 80 443; do
    holders=$(port_holders "$port")
    [ -n "$holders" ] || continue
    busy=1
    warn "Port $port is already in use by:"
    printf '%s\n' "$holders" | sed 's/^/      /' >&2
  done
  if [ -z "$busy" ]; then
    ok "Ports 80 and 443 are free for Envoy"
    return 0
  fi
  cat >&2 <<'MSG'
  The gift's Envoy needs ports 80 and 443 for itself. What to do:
  · Old or unused container?  docker stop NAME && docker update --restart=no NAME   then run this again.
  · A system web server?      sudo systemctl disable --now nginx   (or apache2 / caddy), then run this again.
  · Serving your other sites? Keep it. The gift then has to run behind that server instead of using
                              Envoy on 80/443; that needs a different setup.
MSG
  [ "$mode" = strict ] && die "Stopped before changing anything: ports 80/443 are taken."
  return 0
}

valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$ ]]; }
valid_email() { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }

# Point Envoy's virtual host for the gift at $1.
set_envoy_domain() {
  local domain="$1" envoy=deploy/envoy/envoy.yaml current
  grep -qF "domains: [\"$domain\"]" "$envoy" && return 0
  current=$(sed -nE 's/.*domains: \["([^"*]+)"\].*/\1/p' "$envoy" | head -1)
  [ -n "$current" ] || die "Couldn't find the gift's virtual host in $envoy."
  sed -i.bak "s/domains: \[\"$current\"\]/domains: [\"$domain\"]/" "$envoy" && rm -f "$envoy.bak"
  ok "Envoy now answers for $domain (was $current)"
}

# env_set KEY VALUE: set one setting in deploy/.env, keeping the others.
env_set() {
  local key="$1" value="$2" f=deploy/.env
  [ -f "$f" ] || printf '%s\n' "# Settings for ./start.sh deploy. Change the domain with: ./start.sh domain NAME EMAIL" > "$f"
  if grep -q "^$key=" "$f"; then
    awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  else
    printf '%s=%s\n' "$key" "$value" >> "$f"
  fi
}

# ./start.sh domain NAME EMAIL: write deploy/.env and Envoy's virtual host.
set_domain() {
  local domain email
  domain=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
  email="${2:-}"
  [ -n "$domain" ] && [ -n "$email" ] || die "Usage: ./start.sh domain gave.example.dk you@example.com"
  valid_domain "$domain" || die "'$domain' doesn't look like a domain name (e.g. gave.example.dk)."
  valid_email "$email" || die "'$email' doesn't look like an e-mail address."
  env_set DOMAIN "$domain"
  env_set LE_EMAIL "$email"
  ok "deploy/.env: DOMAIN=$domain, LE_EMAIL=$email"
  set_envoy_domain "$domain"
}

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
  if [ "${MODE:-}" = behind ]; then
    COMPOSE=(docker compose --env-file deploy/.env -f deploy/docker-compose.behind.yml)
  fi
}

# ---------- behind another Envoy ----------

# The other container (not ours) publishing host port $1, if any.
other_container_on() {
  docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null | grep -E ":$1->" | grep -v '^stjernehimlen-' | cut -d'|' -f1 | head -1
}

file_owner() { stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"; }
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# Learn how the other Envoy is set up (config file, cert folder, network, file owner) and store it.
detect_proxy() {
  local c="$1" cmd cfg_in cfg="" tls_src="" tls_dest="" type src dest owner mode
  cmd=$(docker inspect -f '{{range .Config.Cmd}}{{.}} {{end}}' "$c")
  cfg_in=$(printf '%s' "$cmd" | awk '{ for (i = 1; i < NF; i++) if ($i == "-c" || $i == "--config-path") { print $(i + 1); exit } }')
  cfg_in=${cfg_in:-/etc/envoy/envoy.yaml}
  while IFS='|' read -r type src dest; do
    [ "$type" = bind ] || continue
    if [ "$dest" = "$cfg_in" ]; then cfg="$src"
    elif [ -z "$tls_src" ] && [ -d "$src" ]; then tls_src="$src"; tls_dest="$dest"; fi
  done < <(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$c")
  [ -n "$cfg" ] && [ -f "$cfg" ] || die "Couldn't find the config file of $c on this machine (expected a bind mount of $cfg_in)."
  [ -n "$tls_src" ] || die "$c has no folder mount to put the gift's certificate in."

  # Match the ownership of that Envoy's own key, so it can read ours too.
  if [ -f "$tls_src/privkey.pem" ]; then
    owner=$(file_owner "$tls_src/privkey.pem"); mode=$(file_mode "$tls_src/privkey.pem")
  else
    owner="$(docker exec "$c" id -u 2>/dev/null || echo 101):$(docker exec "$c" id -g 2>/dev/null || echo 101)"; mode=0400
  fi

  env_set MODE behind
  env_set PROXY_CONTAINER "$c"
  env_set PROXY_IMAGE "$(docker inspect -f '{{.Config.Image}}' "$c")"
  env_set PROXY_NETWORK "$(docker inspect -f '{{range $n, $v := .NetworkSettings.Networks}}{{$n}} {{end}}' "$c" | awk '{ print $1 }')"
  env_set PROXY_CONFIG "$cfg"
  env_set PROXY_CONFIG_IN "$cfg_in"
  env_set PROXY_CERT_DIR "$tls_src/stjernehimlen"
  env_set PROXY_CERT_DIR_IN "$tls_dest/stjernehimlen"
  env_set CERT_OWNER "$owner"
  env_set CERT_KEY_MODE "$mode"
  compose_ready
  ok "Will run behind $c (config $cfg, network $PROXY_NETWORK)"
}

# Run the patcher with python3, or in a throwaway Python container if this machine has none.
run_patcher() {
  if command -v python3 >/dev/null 2>&1; then
    python3 deploy/behind/patch_envoy.py "$@"
  else
    docker run --rm -i -v "$PWD/deploy/behind:/p:ro" python:3.12-alpine python3 /p/patch_envoy.py "$@"
  fi
}

# Is the other Envoy answering on 80 and 443 (any HTTP status counts)?
proxy_alive() {
  local a b
  a=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1/ || true)
  b=$(curl -sk -o /dev/null -m 3 -w '%{http_code}' https://127.0.0.1/ || true)
  [ "${a:-000}" != 000 ] && [ "${b:-000}" != 000 ]
}

# apply_proxy_patch [--tls|--remove]: validate, back up, write in place, restart, roll back on failure.
apply_proxy_patch() {
  local how="${1:-}" patched args=() type src dest
  need curl "curl is needed to check the other Envoy after its restart."
  patched=$(mktemp)
  if [ "$how" = --remove ]; then
    run_patcher --remove < "$PROXY_CONFIG" > "$patched"
  else
    run_patcher --domain "$DOMAIN" --cert-dir "$PROXY_CERT_DIR_IN" ${how:+"$how"} < "$PROXY_CONFIG" > "$patched"
  fi
  if cmp -s "$patched" "$PROXY_CONFIG"; then
    rm -f "$patched"
    ok "$PROXY_CONTAINER's config is already up to date"
    return 0
  fi

  # Validate with the same image and the same mounts, our version of the config swapped in.
  while IFS='|' read -r type src dest; do
    [ "$type" = bind ] || continue
    if [ "$dest" = "$PROXY_CONFIG_IN" ]; then args+=(-v "$patched:$dest:ro"); else args+=(-v "$src:$dest:ro"); fi
  done < <(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$PROXY_CONTAINER")
  say "Checking the new config with $PROXY_IMAGE"
  if ! docker run --rm --entrypoint envoy "${args[@]}" "$PROXY_IMAGE" --mode validate -c "$PROXY_CONFIG_IN" >/dev/null 2>"$patched.err"; then
    tail -5 "$patched.err" >&2
    rm -f "$patched" "$patched.err"
    die "The patched config didn't validate, so nothing was changed."
  fi
  rm -f "$patched.err"
  ok "Config is valid"

  echo "  This updates $PROXY_CONFIG (a backup is kept) and restarts $PROXY_CONTAINER."
  echo "  Its sites pause for a few seconds during the restart."
  if [ "$ASSUME_YES" != "--yes" ]; then
    local answer=""
    read -r -p "  Continue? [y/N] " answer || true
    [[ "$answer" =~ ^[YyJj] ]] || { rm -f "$patched"; die "Stopped. Nothing was changed."; }
  fi

  local backup
  backup="$PROXY_CONFIG.bak-stjernehimlen-$(date +%Y%m%d-%H%M%S)"
  cp -p "$PROXY_CONFIG" "$backup"
  cat "$patched" > "$PROXY_CONFIG" # in place: a bind-mounted file keeps its inode
  rm -f "$patched"
  docker restart "$PROXY_CONTAINER" >/dev/null

  local i
  for i in $(seq 1 30); do
    sleep 1
    if [ "$(docker inspect -f '{{.State.Running}}' "$PROXY_CONTAINER")" = true ] && proxy_alive; then
      ok "$PROXY_CONTAINER restarted and answers on 80/443 (backup: $backup)"
      return 0
    fi
  done
  warn "$PROXY_CONTAINER didn't come back healthy. Restoring the backup…"
  docker logs --tail 20 "$PROXY_CONTAINER" >&2 || true
  cat "$backup" > "$PROXY_CONFIG"
  docker restart "$PROXY_CONTAINER" >/dev/null
  die "Restored $PROXY_CONFIG from $backup. Nothing of the gift was added."
}

behind_cert_ok() { [ -s "$PROXY_CERT_DIR/fullchain.pem" ] && [ "$(cat "$PROXY_CERT_DIR/domain" 2>/dev/null)" = "$DOMAIN" ]; }

deploy_behind() {
  [ -n "${PROXY_CONTAINER:-}" ] && docker inspect "$PROXY_CONTAINER" >/dev/null 2>&1 ||
    die "The Envoy container '${PROXY_CONTAINER:-}' isn't running. Start it, or remove MODE=behind from deploy/.env."
  seal_if_needed

  # The certificate folder inside the other Envoy's TLS mount, with an SDS file pointing at our files.
  mkdir -p "$PROXY_CERT_DIR"
  printf '%s\n' 'resources:' \
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret' \
    '    name: stjernehimlen_cert' \
    '    tls_certificate:' \
    "      certificate_chain: { filename: $PROXY_CERT_DIR_IN/fullchain.pem }" \
    "      private_key: { filename: $PROXY_CERT_DIR_IN/privkey.pem }" > "$PROXY_CERT_DIR/sds.yaml"
  chmod 0755 "$PROXY_CERT_DIR"
  chmod 0644 "$PROXY_CERT_DIR/sds.yaml"

  say "Building and starting the gift app on $PROXY_NETWORK"
  "${COMPOSE[@]}" up -d --build --remove-orphans app

  if behind_cert_ok; then
    apply_proxy_patch --tls
  else
    # 1) Route Let's Encrypt's check for our domain to the app, 2) get the certificate, 3) add HTTPS.
    apply_proxy_patch
    say "Requesting a certificate for $DOMAIN from Let's Encrypt (through $PROXY_CONTAINER)."
    echo "  · DNS for $DOMAIN must point at this server."
    echo "  · This accepts the Let's Encrypt Subscriber Agreement: https://letsencrypt.org/repository/"
    if [ "$ASSUME_YES" != "--yes" ]; then
      local answer=""
      read -r -p "  Continue? [y/N] " answer || true
      [[ "$answer" =~ ^[YyJj] ]] || die "Stopped before the certificate. Run ./start.sh deploy again to continue."
    fi
    # Leftovers from an interrupted earlier attempt would otherwise keep running.
    docker ps -aq --filter "name=stjernehimlen-certbot-run" | xargs -r docker rm -f >/dev/null 2>&1 || true
    # --entrypoint certbot: the service's own entrypoint is the 12-hour renewal loop.
    "${COMPOSE[@]}" run --rm --no-deps --entrypoint certbot certbot certonly --webroot -w /var/www/acme \
      --non-interactive -d "$DOMAIN" -m "$LE_EMAIL" --agree-tos --no-eff-email \
      --deploy-hook "sh /hooks/install-cert.sh" </dev/null
    behind_cert_ok || die "The certificate didn't arrive in $PROXY_CERT_DIR."
    ok "Certificate installed"
    apply_proxy_patch --tls
  fi

  "${COMPOSE[@]}" up -d --build --remove-orphans
  "${COMPOSE[@]}" ps
  local code
  code=$(curl -sk -o /dev/null -m 5 -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)
  [ "$code" = 200 ] && ok "Live at https://$DOMAIN/ (behind $PROXY_CONTAINER)" ||
    warn "https://$DOMAIN/ answered $code from this server. Check: ./start.sh logs"
  echo "  If $PROXY_CONTAINER's project ever rewrites its envoy.yaml, run ./start.sh deploy again."
}

detach() {
  compose_ready
  [ "${MODE:-}" = behind ] || die "The gift isn't set up behind another Envoy."
  apply_proxy_patch --remove
  "${COMPOSE[@]}" down
  env_set MODE standalone
  ok "Removed the gift from $PROXY_CONTAINER and stopped it. (Its certificate stays in $PROXY_CERT_DIR.)"
}

deploy() {
  local assume_yes="${1:-}"
  compose_ready
  [ -n "${DOMAIN:-}" ] && [ "$DOMAIN" != "gave.example.dk" ] || die "No domain set. Run: ./start.sh domain gave.example.dk you@example.com"
  [ -n "${LE_EMAIL:-}" ] && [ "$LE_EMAIL" != "you@example.com" ] || die "No e-mail set. Run: ./start.sh domain $DOMAIN you@example.com"
  valid_domain "$DOMAIN" || die "DOMAIN '$DOMAIN' in deploy/.env doesn't look like a domain name."
  ASSUME_YES="$assume_yes"

  if [ "${MODE:-}" = behind ]; then
    deploy_behind
    return
  fi
  # Another project's Envoy on 443? Offer to run behind it instead of fighting over the ports.
  local other
  other=$(other_container_on 443)
  if [ -n "$other" ] && docker inspect -f '{{.Config.Image}}' "$other" | grep -q 'envoyproxy/envoy'; then
    say "Ports 80/443 belong to $other, an Envoy from another project."
    echo "  The gift can run behind it: its config gets a separate, marked section for $DOMAIN"
    echo "  (with its own certificate), and that project's own sites stay exactly as they are."
    local answer="y"
    [ "$assume_yes" = "--yes" ] || read -r -p "  Run the gift behind $other? [Y/n] " answer || true
    if [[ ! "$answer" =~ ^[Nn] ]]; then
      detect_proxy "$other"
      deploy_behind
      return
    fi
  fi
  set_envoy_domain "$DOMAIN"
  check_ports strict

  seal_if_needed

  # First certificate (or a new one after a domain change): Let's Encrypt standalone on port 80,
  # before Envoy takes the port.
  if ! "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh certbot \
    -c 'test -s /certs/fullchain.pem && [ "$(cat /certs/domain 2>/dev/null)" = "$DOMAIN" ]' </dev/null >/dev/null 2>&1; then
    say "No certificate for $DOMAIN yet. Requesting one from Let's Encrypt."
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
      --agree-tos --no-eff-email --deploy-hook "sh /hooks/install-cert.sh"
    ok "Certificate installed"
  else
    ok "Certificate present (renewed automatically)"
  fi

  say "Building and starting app, Envoy and certbot"
  "${COMPOSE[@]}" up -d --build --remove-orphans
  "${COMPOSE[@]}" ps
  ok "Live at https://$DOMAIN/"
}

if [ -n "${SSH_CONNECTION:-}" ]; then DEFAULT=preview; else DEFAULT=dev; fi
case "${1:-$DEFAULT}" in
  dev) dev ;;
  preview) preview ;;
  seal) shift; seal "$@" ;;
  link) show_link ;;
  new-code) shift; new_code "$@" ;;
  deploy) deploy "${2:-}" ;;
  domain) set_domain "${2:-}" "${3:-}" ;;
  check-ports) check_ports warn ;;
  proxy-info) proxy_info ;;
  detach) ASSUME_YES="${2:-}"; detach ;;
  stop) compose_ready; "${COMPOSE[@]}" down ;;
  logs) compose_ready; "${COMPOSE[@]}" logs -f --tail 100 ;;
  status) compose_ready; "${COMPOSE[@]}" ps ;;
  -h | --help | help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" ;;
  *) die "Unknown command '$1' (try ./start.sh --help)" ;;
esac
