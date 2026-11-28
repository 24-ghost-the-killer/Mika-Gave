//! Static server for the built site. It runs behind Envoy, which terminates TLS and compresses.
//!
//! * `/assets/*` (content-hashed by Vite): `Cache-Control: public, max-age=31536000, immutable`
//! * everything else (index.html, /v/*.bin ciphertext): `no-cache`, revalidated with ETag/Last-Modified
//! * `/.well-known/acme-challenge/*`: served from the certbot webroot (`ACME_DIR`, as passed to
//!   `certbot --webroot -w`) for HTTP-01 challenges
//! * `/healthz`: liveness probe (`server healthcheck` calls it, for Docker)
//! * `/advent/{day}`: the day secret for an advent door, only from midnight on its date (403 with
//!   the opening time before that). The secret alone opens nothing: the door is also sealed under
//!   the gift's key, which never reaches this server. `ADVENT_PREVIEW=1` ignores the dates (local
//!   preview only).
//!
//! The security headers are also set here, so the app is safe even without Envoy in front (local
//! testing). Envoy overwrites them with the same values.
//!
//! Environment: `PORT` (8080), `STATIC_DIR` (/app/dist), `ACME_DIR` (/var/www/acme),
//! `ADVENT_DIR` (/app/advent-keys), `ADVENT_PREVIEW` (unset).

use std::net::SocketAddr;

use axum::extract::{Path, Request};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use tower_http::services::ServeDir;

const CSP: &str = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; \
img-src 'self' blob:; style-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// `server healthcheck`: for Docker's HEALTHCHECK, since the distroless image has no curl.
fn healthcheck(port: u16) -> ! {
    use std::io::{Read, Write};
    let ok = (|| -> std::io::Result<bool> {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port))?;
        s.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
        s.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut buf = [0u8; 12];
        s.read_exact(&mut buf)?;
        Ok(buf.ends_with(b"200"))
    })()
    .unwrap_or(false);
    std::process::exit(if ok { 0 } else { 1 })
}

#[tokio::main]
async fn main() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_owned());
    let port: u16 = env("PORT", "8080").parse().expect("PORT must be a number");
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        healthcheck(port);
    }
    let static_dir = env("STATIC_DIR", "/app/dist");
    let acme_dir = env("ACME_DIR", "/var/www/acme");
    let advent_dir = env("ADVENT_DIR", "/app/advent-keys");
    let preview = std::env::var("ADVENT_PREVIEW").is_ok_and(|v| v == "1");
    if preview {
        println!("ADVENT_PREVIEW=1: every advent door opens now (local preview only)");
    }

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/advent/{day}", get(move |Path(day): Path<u8>| door_secret(advent_dir.clone(), day, preview)))
        // certbot --webroot writes tokens to <webroot>/.well-known/acme-challenge/<token>.
        .nest_service("/.well-known/acme-challenge", ServeDir::new(format!("{acme_dir}/.well-known/acme-challenge")))
        .fallback_service(ServeDir::new(&static_dir))
        .layer(middleware::from_fn(headers));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    println!("serving {static_dir} on {addr}");
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await.expect("server");
}

/// The day secret, once its door has opened. Files are written by `seal`:
/// `{"opens_ms":1764543600000,"secret":"<64 hex>"}`.
async fn door_secret(dir: String, day: u8, preview: bool) -> Response {
    let json = |code: StatusCode, body: String| (code, [(header::CONTENT_TYPE, "application/json")], body).into_response();
    let Ok(text) = tokio::fs::read_to_string(format!("{dir}/{day}.json")).await else {
        return json(StatusCode::NOT_FOUND, "{}".into());
    };
    let field = |name: &str| -> Option<String> {
        let rest = &text[text.find(&format!("\"{name}\":"))? + name.len() + 3..];
        let rest = rest.trim_start().trim_start_matches('"');
        Some(rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect())
    };
    let (Some(opens), Some(secret)) = (field("opens_ms").and_then(|v| v.parse::<i64>().ok()), field("secret")) else {
        return json(StatusCode::INTERNAL_SERVER_ERROR, "{}".into());
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    if now < opens && !preview {
        return json(StatusCode::FORBIDDEN, format!("{{\"opens_ms\":{opens}}}"));
    }
    json(StatusCode::OK, format!("{{\"secret\":\"{secret}\"}}"))
}

async fn headers(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let immutable = path.starts_with("/assets/");
    let private = path.starts_with("/advent/");
    let mut res = next.run(req).await;
    let ok = res.status().is_success();
    let h = res.headers_mut();
    let set = |h: &mut axum::http::HeaderMap, k: &'static str, v: &'static str| {
        h.insert(HeaderName::from_static(k), HeaderValue::from_static(v));
    };
    let cache = match (immutable && ok, private) {
        (_, true) => "no-store",
        (true, _) => "public, max-age=31536000, immutable",
        _ => "no-cache",
    };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    set(h, "x-robots-tag", "noindex, nofollow, noarchive, nosnippet, noimageindex");
    set(h, "content-security-policy", CSP);
    set(h, "referrer-policy", "no-referrer");
    set(h, "x-content-type-options", "nosniff");
    set(h, "permissions-policy", "camera=(), microphone=(), geolocation=()");
    set(h, "cross-origin-opener-policy", "same-origin");
    set(h, "cross-origin-resource-policy", "same-origin");
    res
}

async fn shutdown() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.ok() };
    #[cfg(unix)]
    let term = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal").recv().await;
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}
