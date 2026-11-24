import { defineConfig } from "vite";

export default defineConfig({
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
