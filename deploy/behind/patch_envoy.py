#!/usr/bin/env python3
"""Add (or remove) the gift's section in another project's Envoy config.

Used by `./start.sh deploy` when the gift runs behind an Envoy that already owns ports 80/443
(MODE=behind in deploy/.env). Reads the config on stdin and writes the patched config to stdout.

Everything added sits between `# >>> stjernehimlen` and `# <<< stjernehimlen` marker comments, so
patching is idempotent (old blocks are removed first) and `--remove` restores the original text.

Added:
  * HTTP listener: a virtual host for the gift's domain that sends Let's Encrypt HTTP-01 challenges
    to the gift (so its own certbot can validate) and redirects everything else to HTTPS.
  * HTTPS listener (only with --tls, once the certificate exists): the TLS inspector listener
    filter, and a filter chain matched on SNI = the gift's domain, with the gift's own certificate
    (SDS from --cert-dir), security headers, brotli/gzip, routing to the gift app.
  * A cluster for the gift app (Docker network alias, port 8080).

Only the standard library is used; the YAML is edited as text, guided by indentation, so the
other project's comments and formatting stay exactly as they were.
"""
import argparse
import re
import sys

MARK_OPEN = "# >>> stjernehimlen (added by Mika-Gave ./start.sh deploy; ./start.sh detach removes it)"
MARK_CLOSE = "# <<< stjernehimlen"
CLUSTER = "stjernehimlen_gift"

CSP = (
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; "
    "img-src 'self' blob:; style-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests"
)


def http_vhost(domain):
    return f"""\
- name: stjernehimlen
  domains: ["{domain}", "{domain}:*"]
  routes:
    - match: {{ prefix: "/.well-known/acme-challenge/" }}
      route: {{ cluster: {CLUSTER}, timeout: 10s }}
    - match: {{ prefix: "/" }}
      redirect: {{ https_redirect: true, response_code: MOVED_PERMANENTLY }}
"""


LISTENER_FILTERS_KEY = """\
listener_filters:
  - name: envoy.filters.listener.tls_inspector
    typed_config: { "@type": type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector }
"""

LISTENER_FILTERS_ITEM = """\
- name: envoy.filters.listener.tls_inspector
  typed_config: { "@type": type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector }
"""


def header(key, value):
    return f"""\
            - header: {{ key: {key}, value: "{value}" }}
              append_action: OVERWRITE_IF_EXISTS_OR_ADD
"""


def filter_chain(domain, cert_dir):
    headers = "".join(
        header(k, v)
        for k, v in [
            ("strict-transport-security", "max-age=63072000; includeSubDomains"),
            ("x-robots-tag", "noindex, nofollow, noarchive, nosnippet, noimageindex"),
            ("content-security-policy", CSP),
            ("referrer-policy", "no-referrer"),
            ("x-content-type-options", "nosniff"),
            ("x-frame-options", "DENY"),
            ("permissions-policy", "camera=(), microphone=(), geolocation=()"),
            ("cross-origin-opener-policy", "same-origin"),
            ("cross-origin-resource-policy", "same-origin"),
        ]
    )
    compressible = (
        "[text/html, text/css, text/plain, text/javascript, application/javascript, "
        "application/json, application/wasm, image/svg+xml]"
    )
    return f"""\
- filter_chain_match: {{ server_names: ["{domain}"] }}
  transport_socket:
    name: envoy.transport_sockets.tls
    typed_config:
      "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
      common_tls_context:
        alpn_protocols: ["h2", "http/1.1"]
        tls_params:
          tls_minimum_protocol_version: TLSv1_2
          tls_maximum_protocol_version: TLSv1_3
          cipher_suites: [ECDHE-ECDSA-AES128-GCM-SHA256, ECDHE-RSA-AES128-GCM-SHA256, ECDHE-ECDSA-AES256-GCM-SHA384, ECDHE-RSA-AES256-GCM-SHA384, ECDHE-ECDSA-CHACHA20-POLY1305, ECDHE-RSA-CHACHA20-POLY1305]
          ecdh_curves: [X25519, P-256]
        tls_certificate_sds_secret_configs:
          - name: stjernehimlen_cert
            sds_config:
              resource_api_version: V3
              path_config_source:
                path: {cert_dir}/sds.yaml
                watched_directory: {{ path: {cert_dir} }}
  filters:
    - name: envoy.filters.network.http_connection_manager
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
        stat_prefix: stjernehimlen
        codec_type: AUTO
        use_remote_address: true
        strip_any_host_port: true
        server_header_transformation: PASS_THROUGH
        normalize_path: true
        merge_slashes: true
        path_with_escaped_slashes_action: REJECT_REQUEST
        stream_idle_timeout: 60s
        request_timeout: 30s
        common_http_protocol_options: {{ idle_timeout: 300s, headers_with_underscores_action: REJECT_REQUEST }}
        route_config:
          name: stjernehimlen
          response_headers_to_remove: ["x-envoy-upstream-service-time"]
          virtual_hosts:
            - name: stjernehimlen
              domains: ["{domain}"]
              routes:
                - match: {{ safe_regex: {{ regex: "^/assets/[^/]+\\\\.wasm$" }} }}
                  route: {{ cluster: {CLUSTER}, timeout: 15s }}
                  response_headers_to_add:
                    - header: {{ key: content-type, value: application/wasm }}
                      append_action: OVERWRITE_IF_EXISTS_OR_ADD
                - match: {{ prefix: "/" }}
                  route: {{ cluster: {CLUSTER}, timeout: 15s }}
              response_headers_to_add:
{indent(headers, 4)}            - name: stjernehimlen_other_host
              domains: ["*"]
              routes:
                - match: {{ prefix: "/" }}
                  direct_response: {{ status: 404 }}
        http_filters:
          - name: envoy.filters.http.compressor.brotli
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.compressor.v3.Compressor
              response_direction_config: {{ common_config: {{ min_content_length: 256, content_type: {compressible} }} }}
              compressor_library:
                name: brotli
                typed_config: {{ "@type": type.googleapis.com/envoy.extensions.compression.brotli.compressor.v3.Brotli, quality: 5, window_bits: 22 }}
          - name: envoy.filters.http.compressor.gzip
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.compressor.v3.Compressor
              response_direction_config: {{ common_config: {{ min_content_length: 256, content_type: {compressible} }} }}
              compressor_library:
                name: gzip
                typed_config: {{ "@type": type.googleapis.com/envoy.extensions.compression.gzip.compressor.v3.Gzip, compression_level: BEST_SPEED, window_bits: 15 }}
          - name: envoy.filters.http.router
            typed_config: {{ "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router }}
"""


def cluster(address):
    return f"""\
- name: {CLUSTER}
  type: STRICT_DNS
  connect_timeout: 3s
  load_assignment:
    cluster_name: {CLUSTER}
    endpoints: [{{ lb_endpoints: [{{ endpoint: {{ address: {{ socket_address: {{ address: {address}, port_value: 8080 }} }} }} }}] }}]
"""


def indent(text, n):
    pad = " " * n
    return "".join(pad + line if line.strip() else line for line in text.splitlines(keepends=True))


def block(text, n):
    """Indent a block by n spaces and wrap it in marker comments."""
    pad = " " * n
    return f"{pad}{MARK_OPEN}\n{indent(text, n)}{pad}{MARK_CLOSE}\n"


def lead(line):
    return len(line) - len(line.lstrip(" "))


def remove_blocks(lines):
    out, skipping = [], False
    for line in lines:
        s = line.strip()
        if s.startswith("# >>> stjernehimlen"):
            skipping = True
            continue
        if skipping and s.startswith("# <<< stjernehimlen"):
            skipping = False
            continue
        if not skipping:
            out.append(line)
    if skipping:
        sys.exit("patch_envoy: unbalanced stjernehimlen markers in the config; fix them by hand")
    return out


def find(lines, pattern, start=0, end=None):
    rx = re.compile(pattern)
    for i in range(start, len(lines) if end is None else end):
        if rx.match(lines[i]):
            return i
    return -1


def block_end(lines, i):
    """Index after the YAML block that starts at line i (first later line indented <= line i)."""
    n = lead(lines[i])
    j = i + 1
    while j < len(lines):
        s = lines[j].strip()
        if s and not s.startswith("#") and lead(lines[j]) <= n:
            break
        j += 1
    return j


def next_item_indent(lines, i):
    """Indentation of the first list item after the key on line i."""
    for j in range(i + 1, len(lines)):
        s = lines[j].strip()
        if s and not s.startswith("#"):
            if s.startswith("- "):
                return lead(lines[j])
            break
    return lead(lines[i]) + 2


def listeners(lines):
    """[(start, end, text)] for each listener item under static_resources.listeners."""
    k = find(lines, r"^\s*listeners:\s*$")
    if k < 0:
        sys.exit("patch_envoy: no 'listeners:' section found")
    end = block_end(lines, k)
    item = next_item_indent(lines, k)
    starts = [i for i in range(k + 1, end) if lead(lines[i]) == item and lines[i].strip().startswith("- ")]
    out = []
    for n, s in enumerate(starts):
        e = starts[n + 1] if n + 1 < len(starts) else end
        out.append((s, e, "".join(lines[s:e])))
    return out


def patch(text, domain, cert_dir, address, tls):
    lines = remove_blocks(text.splitlines(keepends=True))
    inserts = []  # (line index, text); applied bottom-up

    ls = listeners(lines)
    https = [l for l in ls if "DownstreamTlsContext" in l[2]]
    http = [l for l in ls if "DownstreamTlsContext" not in l[2] and "virtual_hosts:" in l[2]]
    if not http:
        sys.exit("patch_envoy: no plain-HTTP listener with virtual_hosts found")
    if tls and not https:
        sys.exit("patch_envoy: no TLS listener found")

    # HTTP: our vhost first in virtual_hosts (before any "*" catch-all).
    s, e, _ = http[0]
    v = find(lines, r"^\s*virtual_hosts:\s*$", s, e)
    if v < 0:
        sys.exit("patch_envoy: HTTP listener has no virtual_hosts")
    inserts.append((v + 1, block(http_vhost(domain), next_item_indent(lines, v))))

    if tls:
        s, e, body = https[0]
        fc = find(lines, r"^\s*filter_chains:\s*$", s, e)
        if fc < 0:
            sys.exit("patch_envoy: TLS listener has no filter_chains")
        # Our chain goes first; the existing chain(s) stay as they are.
        inserts.append((fc + 1, block(filter_chain(domain, cert_dir), next_item_indent(lines, fc))))
        if "tls_inspector" not in body:
            lf = find(lines, r"^\s*listener_filters:\s*$", s, e)
            if lf >= 0:
                inserts.append((lf + 1, block(LISTENER_FILTERS_ITEM, next_item_indent(lines, lf))))
            else:
                inserts.append((fc, block(LISTENER_FILTERS_KEY, lead(lines[fc]))))

    c = find(lines, r"^\s*clusters:\s*$")
    if c < 0:
        sys.exit("patch_envoy: no 'clusters:' section found")
    inserts.append((c + 1, block(cluster(address), next_item_indent(lines, c))))

    for i, t in sorted(inserts, key=lambda x: x[0], reverse=True):
        lines.insert(i, t)
    return "".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--domain")
    ap.add_argument("--cert-dir", help="certificate directory as seen inside the Envoy container")
    ap.add_argument("--address", default="stjernehimlen-gift", help="gift app address on the shared network")
    ap.add_argument("--tls", action="store_true", help="also add the HTTPS filter chain (certificate must exist)")
    ap.add_argument("--remove", action="store_true", help="only remove the gift's section")
    a = ap.parse_args()
    text = sys.stdin.read()
    if a.remove:
        sys.stdout.write("".join(remove_blocks(text.splitlines(keepends=True))))
        return
    if not a.domain or not a.cert_dir:
        ap.error("--domain and --cert-dir are required")
    if not re.fullmatch(r"[a-z0-9.-]+", a.domain) or not re.fullmatch(r"[A-Za-z0-9._/-]+", a.cert_dir):
        ap.error("unexpected characters in --domain or --cert-dir")
    sys.stdout.write(patch(text, a.domain, a.cert_dir, a.address, a.tls))


if __name__ == "__main__":
    main()
