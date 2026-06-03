import { defineConfig } from "vite";
import path from "node:path";

// SharedArrayBuffer (needed by Pyodide for threading + numpy performance)
// requires cross-origin isolation -> COOP + COEP on every response.
// `credentialless` (not `require-corp`) lets the Worker dynamically import
// scripts from a CDN without demanding that every cross-origin resource
// explicitly set the Cross-Origin-Resource-Policy header.
const crossOriginHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
} as const;

export default defineConfig({
  server: {
    port: 5173,
    headers: crossOriginHeaders,
    // Pyodide CDN fetches must not be pre-bundled.
    fs: { allow: [".."] },
  },
  preview: {
    port: 4173,
    headers: crossOriginHeaders,
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // Keep large runtime assets out of the JS bundle - Pyodide + wheels
    // are loaded lazily via fetch().
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
      },
      output: {
        manualChunks: {
          three: ["three"],
        },
      },
    },
  },
  optimizeDeps: {
    // Don't try to prebundle Pyodide - it ships as a runtime asset
    // loaded by the worker via dynamic import.
    exclude: ["pyodide"],
  },
});
