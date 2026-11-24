# Stjernehimlen ✦

A private, encrypted 3D gift. It opens as a brass planisphere (star wheel) with a closed lid. When she enters the right key (or opens your private link), the lid opens and the wheel turns to *your* date. The real night sky over *your* place at *your* moment then rises into a dome. Your memories hang in it as stars she can visit, each one a card with a photo and a few words. A letter comes last.

Everything personal is encrypted **before** it leaves your machine. The server, search engines and anyone who finds the URL only ever see ciphertext and a neutral lock screen.

```
content/  (plaintext, gitignored)   ── seal (native Rust, your machine) ──►  web/public/v/  (ciphertext only)
  gift.toml, photos/*.jpg              re-encode photos, strip EXIF/GPS,        header.bin   wrapped keys
                                       Argon2id + HKDF, AES-256-GCM             m.bin        manifest
                                                                                <random>.bin one per photo

Browser ── https://gave.example.dk/#<link-token> ──► Envoy :443 ──► app (Axum static server)
  main thread : Three.js + gift-wasm (sky math, springs, procedural brass geometry)
  Web Worker  : gift-wasm Vault (KDF + decryption). The key never leaves the worker.
```

## How the encryption works

* A random 256-bit **data key** encrypts every file with AES-256-GCM. Each file has its own nonce, and its name is bound in as associated data, so files can't be swapped. Every file is padded to a 16 KiB bucket, so sizes reveal little.
* The data key is stored in `header.bin`, wrapped in two **key slots** (LUKS-style):
  1. **Link slot.** A random 128-bit token, run through HKDF-SHA256. The token lives in the URL **fragment** (`#…`). Browsers never send the fragment to the server, and the app wipes it from the address bar and history the moment it has read it.
  2. **Passphrase slot.** Argon2id, 64 MiB, 3 passes. The input is normalised first (Unicode NFKC, case, extra spaces, iOS smart quotes), so typing it by hand is forgiving.
* The KDF parameters are authenticated too. The server can't weaken them, and absurd values are rejected before any work starts.
* Decryption happens in Rust → WebAssembly inside a Web Worker. Plaintext reaches the page only as decrypted bytes, and photos are shown from `blob:` URLs.
* The same `gift-crypto` crate is used by `seal` (native) and the browser (wasm), so the format can't drift. A wasm test opens a natively sealed fixture to prove it.

> ⚠️ **Choose the passphrase well.** The ciphertext is public: anyone with the URL can download it and guess passphrases offline, as fast as their hardware allows. Argon2id slows each guess down but can't save a weak secret. A date or a pet's name falls quickly. `seal` estimates the strength (zxcvbn, which also knows her name, your place and your dates) and warns below roughly 10¹⁰ guesses. Use a short sentence only the two of you would say, *or* run `seal --no-passphrase` and rely on the link alone (128 bits, not guessable).

## Project structure

```
crates/gift-crypto   payload format, key slots, Argon2id/HKDF/AES-GCM, passphrase normalisation (+ tests)
crates/gift-wasm     wasm-bindgen: Vault, sky.rs (alt/az, planisphere projection, Sun), springs.rs,
                     geometry.rs (lathe, horizon-window cover, radial instancing) (+ native & wasm tests)
crates/seal          CLI: gift.toml + photos → web/public/v/
crates/server        Axum static server: cache headers, security headers, ACME webroot, /healthz
web/                 Vite + TypeScript + three.js
  src/app.ts           state machine: lock → deriving → unfold → explore → letter
  src/crypto/          worker (holds the key) + promise client
  src/scene/           stage, planisphere, stars, sky dome + Milky Way, constellation, camera springs
  src/ui/              lock prompt, memory cards, letter, intro/caption, no-WebGL fallback
  src/strings.da.ts    every visible word (Danish)
  public/stars.bin     Yale Bright Star Catalogue, 9096 stars (public domain), built by tools/build-catalog.mjs
content.example/     template for content/
scripts/check-leak.mjs  fails if any text from content/gift.toml shows up in web/dist
deploy/              docker-compose.yml, envoy/envoy.yaml (+ SDS), certbot hook, local smoke test
Dockerfile           multi-stage: Rust/wasm → Vite → distroless, non-root
```

## Quick start

```sh
./install.sh            # once, on your machine: toolchain, deps, builds, content/ from the template
$EDITOR content/gift.toml && cp ~/Pictures/... content/photos/
./start.sh              # seals the gift if content/ changed, then serves it: dev server on :5173,
                        # or (when logged in over SSH) the production preview on :8080
                        # The "Passphrase:" prompt asks you to CHOOSE her code (hidden while typing,
                        # asked twice). Press Enter on an empty line for no code: the link opens it.
./start.sh preview      # production build + leak check, real security headers, on :8080
```

On a Linux server, `./install.sh` also sets up the website. It asks for your **domain** and an
e-mail for Let's Encrypt, writes `deploy/.env`, points Envoy at the domain, checks DNS and ports
80/443 (and opens them in ufw), offers to install Docker, and finally offers to fetch the HTTPS
certificate and start everything:

```sh
./install.sh                                              # asks for the domain
./install.sh --domain gave.example.dk --email you@example.com   # or say it up front
./install.sh --server                                     # website only (gift sealed elsewhere)
./start.sh domain ny.example.dk you@example.com           # change the domain later
./start.sh deploy                                         # (re)start it; gets a new certificate if needed
./start.sh logs | status | stop
```

`./start.sh seal --rotate-link` (or any other `seal` flag) re-seals by hand. The steps below are what the scripts do, in detail.

## Step by step

### 1. Tools (once)

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
# Node 20+ and Docker (for deployment)
npm --prefix web ci
```

### 2. Write the gift

```sh
cp -r content.example content        # content/ is gitignored and dockerignored
$EDITOR content/gift.toml            # name, moment + place of the sky, memories, letter
cp ~/Pictures/... content/photos/    # JPEG/PNG/WebP (export HEIC as JPEG)
```

* `sky.when` is RFC 3339 with offset: summer time in Denmark is `+02:00`, winter time `+01:00`.
* Latitude and longitude are decimal degrees (right-click a spot in a maps app to copy them).
* Memories are joined in order into your constellation. `alt`/`az` are optional.

### 3. Seal it

```sh
cargo run -p seal --release -- content web/public/v
```

It asks for the passphrase twice (hidden), prints a strength estimate, then prints **the private link**:

```
https://gave.example.dk/#Xc0…   ← give her this (or just the passphrase)
```

The token is kept in `content/.link-token`, so re-sealing after an edit keeps the same link. `--rotate-link` issues a new one, and the old link stops working. `--no-passphrase` makes the link the only way in.

### 4. Preview locally

```sh
npm --prefix web run wasm    # build the wasm core into web/src/wasm
npm --prefix web run dev     # http://localhost:5173 (+ #token from step 3 to skip the prompt)
```

Add `?fps` to the URL to log frame rates to the console.

### 5. Check nothing leaks

```sh
npm --prefix web run build   # typecheck + build + scripts/check-leak.mjs against content/gift.toml
```

### 6. Point a domain at your server

* DNS: an `A` (and `AAAA`) record for e.g. `gave.example.dk` → your server's IP.
* Replace `gave.example.dk` with your domain in `deploy/envoy/envoy.yaml` (the virtual host `gift`).
* `cp deploy/.env.example deploy/.env` and set `DOMAIN` and `LE_EMAIL`.
* Open ports 80 and 443.

### 7. First certificate (Let's Encrypt)

On the server, with ports 80/443 still free:

```sh
set -a; . deploy/.env; set +a       # DOMAIN, LE_EMAIL
docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm -p 80:80 \
  --entrypoint certbot certbot certonly --standalone \
  -d "$DOMAIN" -m "$LE_EMAIL" --agree-tos --no-eff-email \
  --deploy-hook "sh /hooks/install-cert.sh"
```

The hook copies the certificate into the `certs` volume, where Envoy (non-root) can read it.

### 8. Run it

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

* `app` is the static server, on an internal network only.
* `envoy` handles :80 → 301 to HTTPS (except ACME challenges) and :443 TLS 1.2/1.3 with HSTS, CSP, `X-Robots-Tag`, `application/wasm` and brotli/gzip. Any other Host header gets a 404.
* `certbot` renews over HTTP-01 (webroot) every 12 h. Envoy hot-reloads the new certificate through filesystem SDS, with no restart.

To change the content later: edit `content/`, re-seal (step 3), then `docker compose … up -d --build`.

### Local smoke test of the whole stack (self-signed)

```sh
./deploy/local-cert.sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml \
  --env-file deploy/.env.example up -d --build app envoy
curl -kI --resolve gave.example.dk:8443:127.0.0.1 https://gave.example.dk:8443/
```

## Tests

```sh
cargo test --workspace                              # crypto round-trips, tampering, padding, sky math, springs, geometry
wasm-pack test --node crates/gift-wasm              # wasm Vault opens a natively sealed fixture
npm --prefix web run typecheck
```

## Privacy notes

* `<meta name="robots">`, `X-Robots-Tag` and `robots.txt` all say no indexing. Nothing public names her: the page title is `✦`.
* There are no third-party requests. Fonts (Fraunces, Instrument Sans), three.js and the star catalog are self-hosted. The CSP is `default-src 'none'` plus only what the app needs.
* Photos are re-encoded from pixels, so GPS, camera and time metadata never reach the payload.
* Access logs record method, path, status and size only: no query, referrer or user agent. The `#token` is never sent to a server.

Star data: Yale Bright Star Catalogue, 5th ed. (public domain) via [brettonw/YaleBrightStarCatalog](https://github.com/brettonw/YaleBrightStarCatalog).
