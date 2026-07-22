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

// The on-disk/model-id layout the fetch script mirrors: <baseUrl>/Xenova/whisper-tiny.en/…
export const TRANSFORMERS_MODEL_ID = "Xenova/whisper-tiny.en";

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

      const pipe = await pipeline("automatic-speech-recognition", TRANSFORMERS_MODEL_ID, {
        dtype: "q8", // quantized weights — the artifacts fetch-voice-model.mjs stages
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
