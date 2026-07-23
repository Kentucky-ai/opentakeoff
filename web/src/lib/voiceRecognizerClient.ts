// Main-thread client for the STT worker (RFC #59 recognizer slice). Owns the
// worker lifecycle and exposes three promises; the canvas never touches the
// worker directly. Everything is lazy: nothing loads until the first
// push-to-talk hold (the ingest.js heavy-deps ethos).
//
// "Not installed" is a first-class state, not an error: the model directory
// is gitignored and staged per-deployment by scripts/fetch-voice-model.mjs —
// a cheap same-origin probe for config.json distinguishes "this deployment
// ships no voice model" (feature absent, UI says so) from a real failure
// (download interrupted → retryable).

export type VoiceModelStatus =
  | { phase: "unprobed" }
  | { phase: "uninstalled" }              // no model on this origin — feature absent
  | { phase: "loading"; pct: number }
  | { phase: "ready" }
  | { phase: "error"; message: string };  // retryable (ensureReady again)

const MODEL_BASE = "/models";
const PROBE_FILE = "/models/onnx-community/whisper-tiny.en/config.json";

export function createVoiceRecognizerClient(onStatus: (s: VoiceModelStatus) => void) {
  let worker: Worker | null = null;
  let ready = false;
  let initInFlight: Promise<boolean> | null = null;

  async function ensureReady(): Promise<boolean> {
    if (ready) return true;
    if (initInFlight) return initInFlight;
    initInFlight = (async () => {
      try {
        // same-origin probe: distinguishes uninstalled from broken. SPA-
        // fallback servers (vite dev, Netlify redirects) answer missing files
        // with 200 + index.html — so a JSON-ish content-type is part of the
        // check, not just res.ok.
        const probe = await fetch(PROBE_FILE, { method: "HEAD" });
        const ctype = probe.headers.get("content-type") ?? "";
        if (!probe.ok || ctype.includes("text/html")) {
          onStatus({ phase: "uninstalled" });
          return false;
        }
        onStatus({ phase: "loading", pct: 0 });
        worker ??= new Worker(new URL("../stt.worker.ts", import.meta.url), { type: "module" });
        const ok = await new Promise<boolean>((resolve) => {
          worker!.onmessage = (e: MessageEvent<{ type: string; pct?: number; note?: string; message?: string }>) => {
            const m = e.data;
            if (m.type === "progress") onStatus({ phase: "loading", pct: m.pct ?? 0 });
            else if (m.type === "ready") { onStatus({ phase: "ready" }); resolve(true); }
            else if (m.type === "error") { onStatus({ phase: "error", message: m.message ?? "init failed" }); resolve(false); }
          };
          worker!.postMessage({ type: "init", baseUrl: MODEL_BASE });
        });
        ready = ok;
        return ok;
      } catch (err) {
        onStatus({ phase: "error", message: err instanceof Error ? err.message : String(err) });
        return false;
      } finally {
        initInFlight = null;
      }
    })();
    return initInFlight;
  }

  /** 16 kHz mono Float32 → transcript. Rejects on worker error. The buffer is
   *  TRANSFERRED (zero-copy) — the caller must not reuse it. */
  function transcribe(pcm: Float32Array): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!worker || !ready) return reject(new Error("recognizer not ready"));
      worker.onmessage = (e: MessageEvent<{ type: string; text?: string; message?: string }>) => {
        const m = e.data;
        if (m.type === "result") resolve(m.text ?? "");
        else if (m.type === "error") reject(new Error(m.message ?? "decode failed"));
      };
      worker.postMessage({ type: "transcribe", pcm }, [pcm.buffer]);
    });
  }

  /** Unmount cleanup — no orphaned workers (the bar's chrome://media-internals check). */
  function dispose() {
    worker?.postMessage({ type: "dispose" });
    worker?.terminate();
    worker = null;
    ready = false;
  }

  return { ensureReady, transcribe, dispose };
}
