// Push-to-talk microphone capture (RFC #59 recognizer slice). One session per
// hold: getUserMedia → AudioContext → accumulate Float32 chunks → stop()
// resolves 16 kHz mono PCM for the recognizer (resampled by the same wav.ts
// math the corpus harness uses). Audio lives and dies in this module — it is
// never persisted, never leaves the browser (the client-only pledge, extended
// to audio; the privacy test proves the recognizer side).
//
// Lifecycle edges from the testing bar are mapped to typed reasons the canvas
// turns into loud messages: mic denied, no device, revoked mid-hold. Cleanup
// is unconditional — stop() and cancel() both close the AudioContext and stop
// every track (no orphaned audio contexts; verify via chrome://media-internals).
//
// ScriptProcessorNode is deprecated-but-universal; an AudioWorklet needs a
// separately-served module and buys nothing for 2–6 s utterances. Revisit only
// if a browser actually drops ScriptProcessor.
import { resampleTo, WHISPER_SAMPLE_RATE } from "./stt/wav.ts";

export type CaptureFailReason = "mic_denied" | "no_mic_device" | "mic_unavailable";

export class CaptureError extends Error {
  reason: CaptureFailReason;
  constructor(reason: CaptureFailReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export type CaptureSession = {
  /** Resolve the hold: returns 16 kHz mono PCM of everything heard. */
  stop(): Float32Array;
  /** Esc / tab-hide / revoke: tear down, discard audio. */
  cancel(): void;
  /** Fires when the OS/user revokes the mic mid-hold (track ended). */
  onEnded(cb: () => void): void;
};

export function captureSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

export async function startCapture(): Promise<CaptureSession> {
  if (!captureSupported()) throw new CaptureError("mic_unavailable", "microphone capture unsupported");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError")
      throw new CaptureError("mic_denied", "microphone permission denied");
    if (name === "NotFoundError" || name === "OverconstrainedError")
      throw new CaptureError("no_mic_device", "no microphone device");
    throw new CaptureError("mic_unavailable", err instanceof Error ? err.message : String(err));
  }

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let live = true;
  let endedCb: (() => void) | null = null;

  proc.onaudioprocess = (e) => {
    if (live) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(proc);
  proc.connect(ctx.destination); // required by some engines for the processor to tick; destination hears nothing (input-only graph)

  const track = stream.getAudioTracks()[0];
  track?.addEventListener("ended", () => { if (live) endedCb?.(); });

  const teardown = () => {
    live = false;
    proc.disconnect();
    source.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
  };

  return {
    stop() {
      const rate = ctx.sampleRate;
      teardown();
      let len = 0;
      for (const c of chunks) len += c.length;
      const all = new Float32Array(len);
      let off = 0;
      for (const c of chunks) { all.set(c, off); off += c.length; }
      return resampleTo(all, rate, WHISPER_SAMPLE_RATE);
    },
    cancel() {
      teardown();
      chunks.length = 0;
    },
    onEnded(cb) { endedCb = cb; },
  };
}
