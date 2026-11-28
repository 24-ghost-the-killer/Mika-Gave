# syntax=docker/dockerfile:1.7
#
# Builds the public site from the *sealed* payload in web/public/v/ (run `seal` first).
# content/ (plaintext) is excluded by .dockerignore and never enters any layer.

# ---- 1. Rust: wasm core + static server ----
FROM rust:1.94-slim-bookworm AS rust
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-pack --locked --version 0.15.1
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN wasm-pack build crates/gift-wasm --release --target web --out-dir /src/web/src/wasm --no-pack \
 && cargo build --release --locked -p server

# ---- 2. Web: Vite build ----
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY --from=rust /src/web/src/wasm ./src/wasm
# Advent day keys (outside the public folder; the server releases each on its date). May be absent.
RUN mkdir -p advent-keys \
 && test -f public/v/header.bin -a -f public/v/m.bin \
   || (echo "No sealed payload in web/public/v/. Run: cargo run -p seal --release -- content web/public/v" >&2; exit 1) \
 && npx tsc --noEmit \
 && npx vite build

# ---- 3. Runtime: distroless, non-root, read-only friendly ----
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=rust /src/target/release/server /app/server
COPY --from=web /src/web/dist /app/dist
COPY --from=web /src/web/advent-keys /app/advent-keys
ENV PORT=8080 STATIC_DIR=/app/dist ACME_DIR=/var/www/acme ADVENT_DIR=/app/advent-keys
EXPOSE 8080
USER nonroot
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD ["/app/server", "healthcheck"]
ENTRYPOINT ["/app/server"]
