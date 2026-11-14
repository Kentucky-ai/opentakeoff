// Door-detector worker: runs the RF-DETR door model (ONNX) on WebGPU, off the
// main thread. A thin shell: the download, integrity check, tile
// preprocessing and decoding live in lib/doorDetect/workerCore.ts, tested
// under Node. `worker-src 'self'` in the CSP covers this file; the model
// download from huggingface.co is covered by the open connect-src.
//
// The runtime is the same onnxruntime-web build voice and OCR use. Its wasm
// and .mjs glue are served from this site (Vite `?url` imports), so nothing
// but the model itself is fetched from another host.
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { createDetectCore, type DetectInMsg, type SessionLike } from "./lib/doorDetect/workerCore.ts";
import { DOOR_DETECT_SETTINGS as S } from "./lib/doorDetect/pipeline.ts";

interface OrtModule {
  env: { wasm: Record<string, unknown>; logLevel?: string };
  InferenceSession: { create(model: ArrayBuffer, opts: Record<string, unknown>): Promise<SessionLike> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}
let ortP: Promise<OrtModule> | null = null;
const loadOrt = () => (ortP ??= import("onnxruntime-web/webgpu") as unknown as Promise<OrtModule>);
let TensorCtor: OrtModule["Tensor"] | null = null;

const core = createDetectCore({
  fetchImpl: (url, init) => fetch(url, init),
  cacheStorage: typeof caches === "undefined" ? undefined : caches,
  hasWebGpu: async () => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    try { return !!(await gpu.requestAdapter()); } catch { return false; }
  },
  createSession: async (model) => {
    const ort = await loadOrt();
    ort.env.wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = "error";
    TensorCtor = ort.Tensor;
    return ort.InferenceSession.create(model, { executionProviders: ["webgpu"], graphOptimizationLevel: "all" });
  },
  makeTensor: (data, dims) => new TensorCtor!("float32", data, dims),
  post: (msg) => self.postMessage(msg),
  close: () => self.close(),
}, {
  url: `https://huggingface.co/${S.model.repo}/resolve/${S.model.revision}/${S.model.file}`,
  bytes: S.model.bytes, sha256: S.model.sha256, nClasses: S.model.classes.length,
}, S.detect);

self.onmessage = (e: MessageEvent<DetectInMsg>) => { void core.handle(e.data); };
