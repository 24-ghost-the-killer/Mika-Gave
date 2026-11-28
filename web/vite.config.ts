import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev-server twin of the real server's `/advent/{day}`: hands out a door's day secret only from
 * midnight on its date. `ADVENT_PREVIEW=1 npm run dev` opens every door (for checking your texts).
 */
function adventKeys(): Plugin {
  const preview = process.env.ADVENT_PREVIEW === "1";
  return {
    name: "advent-keys",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const m = /^\/advent\/(\d{1,2})$/.exec(req.url ?? "");
        if (!m) return next();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        try {
          const { opens_ms, secret } = JSON.parse(await readFile(new URL(`./advent-keys/${+m[1]}.json`, import.meta.url), "utf8"));
          if (Date.now() < opens_ms && !preview) {
            res.statusCode = 403;
            res.end(JSON.stringify({ opens_ms }));
          } else {
            res.end(JSON.stringify({ secret }));
          }
        } catch {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [adventKeys()],
  build: {
    target: "es2022",
    // No data: URIs. The CSP only allows same-origin fonts, images and scripts.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 800, // three.js; gzip/brotli bring it to ~150 kB
  },
  worker: { format: "es" },
  server: {
    headers: { "X-Robots-Tag": "noindex, nofollow" },
  },
});
