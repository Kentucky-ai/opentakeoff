// WAV → PCM for the voice recognizer (RFC #59 recognizer slice). PURE —
// imports nothing, runs identically under node:test (the corpus harness) and
// in the browser. Whisper-class models want 16 kHz mono Float32; the corpus
// fixtures are committed as 16-bit PCM WAV, and mic capture arrives at the
// AudioContext's native rate — both funnel through here so the SAME
// decode/resample math feeds CI and the live app (the parity claim).

export type WavData = { sampleRate: number; samples: Float32Array };

export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Decode a RIFF/WAVE file: PCM 16-bit int or 32-bit float, mono or stereo
 * (stereo is averaged to mono). Throws on anything else — corpus fixtures are
 * committed in a known format, so an unreadable file is a corrupted fixture,
 * never something to guess around.
 */
export function decodeWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) =>
    String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE")
    throw new Error("not a RIFF/WAVE file");

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: { off: number; len: number } | null = null;

  // walk chunks (chunks are word-aligned; sizes can be odd)
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      data = { off: body, len: Math.min(size, bytes.length - body) };
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV missing fmt or data chunk");
  if (fmt.channels < 1 || fmt.channels > 2) throw new Error(`unsupported channel count ${fmt.channels}`);

  const { channels } = fmt;
  let samples: Float32Array;
  if (fmt.format === 1 && fmt.bits === 16) {
    const frames = Math.floor(data.len / 2 / channels);
    samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let acc = 0;
      for (let ch = 0; ch < channels; ch++) acc += view.getInt16(data.off + (i * channels + ch) * 2, true);
      samples[i] = acc / channels / 32768;
    }
  } else if (fmt.format === 3 && fmt.bits === 32) {
    const frames = Math.floor(data.len / 4 / channels);
    samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let acc = 0;
      for (let ch = 0; ch < channels; ch++) acc += view.getFloat32(data.off + (i * channels + ch) * 4, true);
      samples[i] = acc / channels;
    }
  } else {
    throw new Error(`unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit)`);
  }
  return { sampleRate: fmt.sampleRate, samples };
}

/**
 * Linear-interpolation resample. Adequate for speech into a 16 kHz model
 * (whisper's own mel front-end low-passes far below any aliasing this
 * introduces at typical 44.1/48 kHz sources); exact pass-through when the
 * rate already matches.
 */
export function resampleTo(samples: Float32Array, fromRate: number, toRate: number = WHISPER_SAMPLE_RATE): Float32Array {
  if (fromRate === toRate) return samples;
  if (fromRate <= 0 || toRate <= 0) throw new Error("bad sample rate");
  const outLen = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = (samples.length - 1) / Math.max(1, outLen - 1);
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const hi = Math.min(samples.length - 1, lo + 1);
    const frac = pos - lo;
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
  }
  return out;
}

/** decodeWav + resample to whisper's 16 kHz in one step. */
export function wavToModelPcm(bytes: Uint8Array): Float32Array {
  const { sampleRate, samples } = decodeWav(bytes);
  return resampleTo(samples, sampleRate, WHISPER_SAMPLE_RATE);
}

/**
 * Encode Float32 PCM as a 16-bit mono WAV (the corpus fixture format). Used
 * by tooling/tests only — lets the harness round-trip and lets dev scripts
 * write scratch fixtures in exactly the committed format.
 */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const w = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return bytes;
}
