// STT engine seam (RFC #59 recognizer slice). PURE types + a tiny factory —
// the ONLY surface the worker, the corpus harness, and the benchmark runner
// see, so engines are interchangeable and the corpus numbers compare
// apples-to-apples. Adapters lazy-load their heavy deps (the ingest.js
// precedent) so nothing here weighs the initial bundle.
//
// Privacy contract every adapter MUST honor (the client-only pledge, extended
// to audio): after init() resolves, transcribe() performs ZERO network I/O —
// model weights come from the injected source (same-origin URL or cached
// bytes), never a third-party host. The privacy test monkeypatches
// fetch/XHR/WebSocket and asserts exactly this.

export type SttEngineId = "transformers-js" | "whisper-cpp";

/** Where the model comes from. Same-origin base URL in the browser (served
 *  from /models/ in dist), a filesystem path in Node (the corpus harness).
 *  The ORT wasm runtime needs no source entry: adapters resolve it through
 *  the bundler's asset pipeline (`?url`), same-origin in dev and build. */
export type ModelSource = { baseUrl: string };

export type SttProgress = { pct: number; note?: string };

export type SttEngine = {
  id: SttEngineId;
  /** Load + compile the model. Resolves when transcribe() is ready. The ONLY
   *  phase allowed to touch the network (same-origin / injected source). */
  init(source: ModelSource, onProgress?: (p: SttProgress) => void): Promise<void>;
  /** 16 kHz mono Float32 PCM → transcript text. Pure compute, no I/O. */
  transcribe(pcm: Float32Array): Promise<string>;
  /** Release model memory; the engine is unusable afterwards. */
  dispose(): Promise<void>;
};

/** Lazy adapter registry — dynamic import keeps engine deps out of the
 *  initial bundle (fflate/pdf-lib precedent in ingest.js). */
export async function createEngine(id: SttEngineId): Promise<SttEngine> {
  switch (id) {
    case "transformers-js": {
      const m = await import("./transformersJs.ts");
      return m.createTransformersJsEngine();
    }
    case "whisper-cpp": {
      const m = await import("./whisperCpp.ts");
      return m.createWhisperCppEngine();
    }
  }
}

/** The engine the app ships. The benchmark harness (docs/VOICE.md table)
 *  justifies the choice; the seam keeps the contender one line away. */
export const DEFAULT_ENGINE: SttEngineId = "transformers-js";
