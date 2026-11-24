#!/bin/sh
# Self-signed certificate for the local smoke test (deploy/docker-compose.local.yml). Never use it in production.
set -eu
dir="$(dirname "$0")/local-certs"
domain="${1:-gave.example.dk}"
mkdir -p "$dir"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 7 \
  -keyout "$dir/privkey.pem" -out "$dir/fullchain.pem" \
  -subj "/CN=$domain" -addext "subjectAltName=DNS:$domain" 2>/dev/null
chmod 0644 "$dir/privkey.pem" # readable by Envoy's nonroot user; test key only
echo "wrote $dir/{fullchain,privkey}.pem for $domain"
