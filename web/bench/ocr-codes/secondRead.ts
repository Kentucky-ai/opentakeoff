// A second reader for the #519 measurement: what a provider would be asked
// about a code the on-device check flagged. Bench only; the app does not
// call it. The reader never receives the primary read or the alternate, so
// it cannot pick one of them (#519 point 2): it transcribes blind.
import { buildVisionRequest, parseVisionResponse } from "../../src/lib/ai.js";

export type CropUnit = "crop" | "row";
/** Where the flagged cell sits across the image, in percent. The prompt
 * names leftPct for a whole-row crop; the on-device stand-in uses both. */
export type CropHint = { leftPct: number; rightPct?: number };
/** PNG bytes of one crop → the code it shows, or null when nothing usable.
 * Throws when the reader itself fails (a transport error is not a read). */
export type SecondReader = (png: Uint8Array, unit: CropUnit, hint: CropHint) => Promise<string | null>;

const RULES = "Copy the characters exactly as printed: keep hyphens, periods and parentheses, and tell letters from digits (O from 0, I from 1, S from 5, B from 8). Reply with the code only, no other words. If it can't be read, reply UNREADABLE.";

/** The blind-transcription prompt. It names no candidate reading. */
export function blindReadPrompt(unit: CropUnit, hint: CropHint): string {
  return unit === "row"
    ? `This image is one row of a finish schedule on a construction drawing. Transcribe the code in the cell that starts about ${Math.round(hint.leftPct)}% of the way across the image. ${RULES}`
    : `This image is one cell cut from a finish schedule on a construction drawing. Transcribe the code printed in it. ${RULES}`;
}

/** A reply → one code-shaped string, or null. A sentence is not a code. */
export function parseBlindReply(reply: string | null | undefined): string | null {
  const text = (reply ?? "").trim().replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "").trim();
  if (!text || /^UNREADABLE\.?$/i.test(text)) return null;
  if (!/^[A-Z0-9][A-Z0-9()./ -]{0,23}$/i.test(text) || text.split(/\s+/).length > 3) return null;
  return text;
}

type ProviderConfig = { endpoint: string; model: string; provider: string; apiKey?: string };
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** The app's own request plumbing (ai.js buildVisionRequest /
 * parseVisionResponse, the same shapes visionQuery sends), with the config
 * and fetch passed in so a measurement names its endpoint explicitly. */
export function providerSecondReader(cfg: ProviderConfig, fetchFn: FetchLike): SecondReader {
  return async (png, unit, hint) => {
    const { url, headers, body } = buildVisionRequest(cfg, {
      imageDataUrl: `data:image/png;base64,${base64(png)}`, prompt: blindReadPrompt(unit, hint), maxTokens: 20,
    });
    const res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`second read failed (HTTP ${res.status})`);
    return parseBlindReply(parseVisionResponse(cfg.provider, await res.json().catch(() => null)));
  };
}
