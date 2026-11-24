//! Static server for the built site. It runs behind Envoy, which terminates TLS and compresses.
//!
//! * `/assets/*` (content-hashed by Vite): `Cache-Control: public, max-age=31536000, immutable`
//! * everything else (index.html, /v/*.bin ciphertext): `no-cache`, revalidated with ETag/Last-Modified
//! * `/.well-known/acme-challenge/*`: served from the certbot webroot (`ACME_DIR`) for HTTP-01 renewals
//! * `/healthz`: liveness probe (`server healthcheck` calls it, for Docker)
//!
//! The security headers are also set here, so the app is safe even without Envoy in front (local
//! testing). Envoy overwrites them with the same values.
//!
//! Environment: `PORT` (8080), `STATIC_DIR` (/app/dist), `ACME_DIR` (/var/www/acme).

use std::net::SocketAddr;

use axum::extract::Request;
use axum::http::{header, HeaderName, HeaderValue};
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

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest_service("/.well-known/acme-challenge", ServeDir::new(acme_dir))
        .fallback_service(ServeDir::new(&static_dir))
        .layer(middleware::from_fn(headers));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    println!("serving {static_dir} on {addr}");
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await.expect("server");
}

async fn headers(req: Request, next: Next) -> Response {
    let immutable = req.uri().path().starts_with("/assets/");
    let mut res = next.run(req).await;
    let ok = res.status().is_success();
    let h = res.headers_mut();
    let set = |h: &mut axum::http::HeaderMap, k: &'static str, v: &'static str| {
        h.insert(HeaderName::from_static(k), HeaderValue::from_static(v));
    };
    let cache = if immutable && ok { "public, max-age=31536000, immutable" } else { "no-cache" };
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
