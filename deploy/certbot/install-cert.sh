#!/bin/sh
# certbot --deploy-hook: copy the fresh certificate where Envoy (distroless nonroot, uid/gid 65532)
# can read it. Files are moved into place atomically, and Envoy's watched_directory then
# hot-reloads them.
set -eu
src="/etc/letsencrypt/live/${DOMAIN:?DOMAIN not set}"
dst=/certs
umask 077
cp -L "$src/fullchain.pem" "$dst/.fullchain.pem.tmp"
cp -L "$src/privkey.pem" "$dst/.privkey.pem.tmp"
chown 65532:65532 "$dst/.fullchain.pem.tmp" "$dst/.privkey.pem.tmp"
chmod 0444 "$dst/.fullchain.pem.tmp"
chmod 0400 "$dst/.privkey.pem.tmp"
mv -f "$dst/.fullchain.pem.tmp" "$dst/fullchain.pem"
mv -f "$dst/.privkey.pem.tmp" "$dst/privkey.pem"
echo "install-cert: installed certificate for $DOMAIN"
