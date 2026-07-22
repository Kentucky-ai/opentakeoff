// transformers.js adapter (RFC #59 recognizer slice): whisper-tiny.en ONNX on
// onnxruntime — single-threaded WASM in the browser (this deployment has no
// COOP/COEP, so no SharedArrayBuffer), native CPU under Node (the corpus
// harness). Lazy-imported via recognizer.ts so ~1 MB of JS + the runtime stay
// out of the initial bundle.
//
// Privacy: allowRemoteModels is forced OFF and localModelPath is pinned to the
// injected source — the library can never reach the HuggingFace hub. Model
// files are served same-origin (browser) or read from disk (Node); the
// privacy test asserts zero network I/O after init.
import type { ModelSource, SttEngine, SttProgress } from "./recognizer.ts";

// The on-disk/model-id layout the fetch script mirrors: <baseUrl>/onnx-community/whisper-tiny.en/…
export const TRANSFORMERS_MODEL_ID = "onnx-community/whisper-tiny.en";

type AsrPipeline = (pcm: Float32Array) => Promise<{ text: string }>;

export function createTransformersJsEngine(): SttEngine {
  let asr: AsrPipeline | null = null;
  let disposeFn: (() => Promise<void>) | null = null;

  return {
    id: "transformers-js",

    async init(source: ModelSource, onProgress?: (p: SttProgress) => void): Promise<void> {
      const { pipeline, env } = await import("@huggingface/transformers");
      // pin the library to the injected source — never the hub
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = source.baseUrl;

      // Browser (worker) path: pin the ORT wasm runtime to SAME-ORIGIN assets
      // resolved through the bundler (`?url` — served in dev, hashed into
      // dist/assets in build). Without this ORT defaults to a CDN, which the
      // client-only pledge forbids. Single-threaded: this deployment has no
      // COOP/COEP, so no SharedArrayBuffer — threads can't engage anyway.
      // Node never enters this branch (onnxruntime-node native CPU).
      const isNode = typeof process !== "undefined" && !!process.versions?.node;
      if (!isNode) {
        const [mjs, wasm] = await Promise.all([
          import("onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url"),
          import("onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url"),
        ]);
        const ortEnv = (env.backends as { onnx?: { wasm?: { wasmPaths?: unknown; numThreads?: number } } }).onnx;
        if (ortEnv?.wasm) {
          ortEnv.wasm.wasmPaths = { mjs: mjs.default, wasm: wasm.default };
          ortEnv.wasm.numThreads = 1;
        }
      }

      const pipe = await pipeline("automatic-speech-recognition", TRANSFORMERS_MODEL_ID, {
        // q8 encoder + uint8 decoder — the artifacts fetch-voice-model.mjs stages.
        // The int8 "_quantized" decoder trips ort-web's QDQ fusion (missing
        // per-column scales for MatMulNBits transpose); the uint8 export avoids
        // that fusion and loads on BOTH backends — Node native and browser
        // wasm run the identical files (the CI/browser parity claim).
        dtype: { encoder_model: "q8", decoder_model_merged: "uint8" },
        ...(isNode
          ? {}
          : {
              device: "wasm" as const,
              // ort-web's EXTENDED graph pass (TransposeDQWeightsForMatMulNBits)
              // rejects these QDQ whisper decoders outright ("missing required
              // scale"); basic optimization skips that fusion and the same
              // files load — Node native needs no such cap.
              session_options: { graphOptimizationLevel: "basic" as const },
            }),
        progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
          if (onProgress && typeof p?.progress === "number")
            onProgress({ pct: Math.round(p.progress), note: p.file });
        },
      });
      asr = pipe as unknown as AsrPipeline;
      disposeFn = async () => { await (pipe as unknown as { dispose?: () => Promise<void> }).dispose?.(); };
    },

    async transcribe(pcm: Float32Array): Promise<string> {
      if (!asr) throw new Error("engine not initialized");
      const out = await asr(pcm);
      return (out?.text ?? "").trim();
    },

    async dispose(): Promise<void> {
      await disposeFn?.();
      asr = null;
      disposeFn = null;
    },
  };
}
