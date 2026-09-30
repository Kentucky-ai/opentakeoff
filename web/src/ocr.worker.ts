// On-device OCR worker (#469): runs PaddleOCR (PP-OCRv5 mobile, English) off
// the main thread so the canvas stays smooth during a read. A thin shell: the
// download, integrity checks, runtime setup and word mapping live in
// lib/ocr/workerCore.ts, tested under Node. This file wires in the browser
// pieces. `worker-src 'self'` in the CSP covers it.
//
// The runtime is the same ORT asyncify build voice uses (vite.config.js
// aliases ppu's bare `onnxruntime-web` import to the webgpu entry). Its wasm
// arrives as bytes through the core, from this site or Cache Storage; only
// the small .mjs glue loads by URL. Reads run on single-thread wasm: the
// execution provider is pinned to "cpu" explicitly in OCR_ENGINE_OPTIONS,
// which says why (forcing WebGPU hung engine start in Chrome, no speed gain).
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { createOcrCore, type OcrInMsg, type OcrServiceLike, type OrtLike } from "./lib/ocr/workerCore.ts";

const core = createOcrCore({
  fetchImpl: (url, init) => fetch(url, init),
  cacheStorage: typeof caches === "undefined" ? undefined : caches,
  ortWasmUrl,
  ortMjsUrl,
  loadRuntime: async () => (await import("onnxruntime-web/webgpu")) as unknown as OrtLike,
  loadService: async (buffers, options) => {
    // Imported only after the runtime is configured: on load, ppu points
    // wasmPaths at a CDN unless it is already set.
    const { PaddleOcrService } = await import("ppu-paddle-ocr/web");
    // ppu's types require recognition.charactersDictionary; the model's
    // dictionary buffer supplies it, and ppu deep-merges these options
    // over its defaults.
    const svc = new PaddleOcrService({ model: buffers, ...options } as ConstructorParameters<typeof PaddleOcrService>[0]);
    await svc.initialize();
    // ppu 6.6.0 keeps the model buffers after initialize() (it writes them
    // back to its options.model in web/paddle-ocr.service.web.js), about
    // 12.7 MB for the engine's life. Left alone: clearing them means
    // editing ppu's private state.
    return svc as unknown as OcrServiceLike;
  },
  makeCanvas: (rgba, width, height) => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context in the OCR worker");
    const img = ctx.createImageData(width, height);
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
    return canvas;
  },
  origin: self.location.origin,
  post: (msg) => self.postMessage(msg),
  close: () => self.close(),
});

self.onmessage = (e: MessageEvent<OcrInMsg>) => { void core.handle(e.data); };
