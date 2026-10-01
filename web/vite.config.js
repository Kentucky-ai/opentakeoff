import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The one source of truth for the app version — package.json — inlined as
// __APP_VERSION__ so contributions can carry generator_version without a
// runtime fetch. Guarded with `typeof` at the use site so the Node test
// runner (no Vite, no define) sees plain undefined instead of a crash.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// OpenTakeoff is a client-only static app: the takeoff canvas runs entirely in
// the browser (pdf.js + canvas + the geometry libs), persists to IndexedDB /
// localStorage, and builds to a static `dist/` you can host anywhere (GitHub
// Pages, Vercel, Netlify, an S3 bucket).
//
// The `/ai` proxy is OPTIONAL — it only matters if you run the bring-your-own-
// model AI sandbox in `../server` (see server/README.md). Without it, the app
// works fully; the AI hooks just stay dormant.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // On-device OCR (#469): ppu-paddle-ocr imports the bare `onnxruntime-web`,
  // which would bundle ORT's default (jsep) build and ship a second ~24 MB
  // wasm. Point it at the webgpu entry voice already uses, so both share the
  // one asyncify runtime. A regex, not a string key: a string also matches
  // `onnxruntime-web/…` prefixes and would break voice's own subpath imports.
  resolve: {
    alias: [{ find: /^onnxruntime-web$/, replacement: "onnxruntime-web/webgpu" }],
  },
  // The STT worker (stt.worker.ts, RFC #59) lazy-imports its engine adapter,
  // which needs code-splitting inside the worker bundle — only the ES format
  // supports that (Vite's default iife errors on split worker builds).
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: {
      // The sandbox's /ai routes are key-locked (server/README.md). Export the
      // same OT_SANDBOX_API_KEY in the shell running `npm run dev` and the
      // proxy stamps the header on — the browser never handles the secret.
      "/ai": {
        target: "http://localhost:8000",
        headers: process.env.OT_SANDBOX_API_KEY
          ? { "X-API-Key": process.env.OT_SANDBOX_API_KEY }
          : {},
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
