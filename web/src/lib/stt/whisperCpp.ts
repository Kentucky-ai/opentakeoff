// whisper.cpp WASM adapter (RFC #59 recognizer slice) — the benchmark
// contender. Finding so far (recorded for the RFC's "pick one with
// benchmarks"): the maintained whisper.cpp browser wrappers require
// SharedArrayBuffer (threads), and this deployment deliberately has no
// COOP/COEP (adding them would break the cross-origin fonts/GIS loads under
// the current CSP) — so whisper.cpp is only browser-viable here in a
// single-thread build. The benchmark harness (M5) wires a single-thread
// artifact through this adapter to get corpus numbers; until then init()
// refuses loudly rather than pretending.
import type { ModelSource, SttEngine, SttProgress } from "./recognizer.ts";

export function createWhisperCppEngine(): SttEngine {
  return {
    id: "whisper-cpp",
    async init(_source: ModelSource, _onProgress?: (p: SttProgress) => void): Promise<void> {
      throw new Error(
        "whisper-cpp adapter is benchmark-only and not wired yet (see docs/VOICE.md engine notes)",
      );
    },
    async transcribe(_pcm: Float32Array): Promise<string> {
      throw new Error("engine not initialized");
    },
    async dispose(): Promise<void> {},
  };
}
