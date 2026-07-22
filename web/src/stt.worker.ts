// STT worker (RFC #59 recognizer slice) — hosts the whisper engine OFF the
// main thread, per the testing bar's performance budget: pan/zoom must stay
// smooth while decoding. First hand-rolled Worker in the repo (pdf.js spawns
// its own); `worker-src 'self'` in the CSP covers it. All heavy work (model
// fetch/compile via init, decode via transcribe) happens here; the main
// thread only posts messages and paints the chip.
//
// Protocol (one in-flight request at a time — the PTT flow is serial):
//   in : { type: "init", baseUrl, ortWasmBaseUrl }
//        { type: "transcribe", pcm: Float32Array }   (transferred, 16 kHz mono)
//        { type: "dispose" }
//   out: { type: "progress", pct, note? }
//        { type: "ready" }
//        { type: "result", text }
//        { type: "error", message }
import { createEngine, DEFAULT_ENGINE, type SttEngine } from "./lib/stt/recognizer.ts";

let engine: SttEngine | null = null;

type InMsg =
  | { type: "init"; baseUrl: string }
  | { type: "transcribe"; pcm: Float32Array }
  | { type: "dispose" };

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      if (!engine) {
        engine = await createEngine(DEFAULT_ENGINE);
        await engine.init(
          { baseUrl: msg.baseUrl },
          (p) => self.postMessage({ type: "progress", pct: p.pct, note: p.note }),
        );
      }
      self.postMessage({ type: "ready" });
    } else if (msg.type === "transcribe") {
      if (!engine) throw new Error("engine not initialized");
      const text = await engine.transcribe(msg.pcm);
      self.postMessage({ type: "result", text });
    } else if (msg.type === "dispose") {
      await engine?.dispose();
      engine = null;
      self.close();
    }
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
