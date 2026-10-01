// Import from schedule — reading a box on-device (#470). When scheduleRoute
// sends a box to the on-device reader (no table in its text layer, and at most
// a few stray runs), the canvas hands this the box's steps and gets back what
// the box becomes: rows, a message, or "cancelled" (the person left: Cancel,
// another sheet, the canvas closed), which shows nothing.
//
// Pure: every step is injected, so this touches no DOM, worker or pdf.js.
//   1. session.run starts the engine the way the person agreed (lib/ocr/
//      session.ts: cached files start at once, else the download notice, and
//      only its Download downloads);
//   2. onReading() — the status line says "Reading" from here on;
//   3. rasterize() renders the box; recognize() reads its words;
//   4. read() is the sheet graph's finish reader (readScheduleSpans), fed the
//      words as spans (wordsToSpans), and routeOcrRead words the result.
// Before each step and once more after the session answers, a read that is no
// longer wanted (the signal aborted, or isCurrent() false: the canvas moved on
// to another sheet) stops. Inside the task that is a throw of the private
// STALE sentinel, which the session reports as `failed` (or `aborted` once the
// signal has fired); both come back here as "cancelled", never as a failure.
// The render can't be stopped once started (rasterize takes no signal), so
// the check after it is what keeps a stale render from being read.
import type { OcrSession } from "./ocr/session.ts";
import { wordsToSpans, type OcrWord } from "./ocr/types.ts";
import type { GraphSpan } from "./sheetgraph.ts";
import type { ScheduleRead } from "./scheduleRead.ts";
import {
  routeOcrRead, ocrUnavailableMessage, ocrFailedMessage, OCR_DECLINED_MESSAGE, type BoxText, type ImportRoute,
} from "./scheduleRoute.ts";

/** What a box read on-device becomes. */
export type OcrReadResult = Exclude<ImportRoute, { kind: "ocr" }> | { kind: "cancelled" };

export interface BoxReadSteps<R> {
  session: Pick<OcrSession, "run">;
  /** render the box for the engine */
  rasterize: () => Promise<R>;
  /** read the render's words, in the sheet's image px */
  recognize: (raster: R, signal?: AbortSignal) => Promise<OcrWord[]>;
  /** the finish reader */
  read: (spans: GraphSpan[]) => ScheduleRead;
  /** false once the canvas has moved on (another sheet rendered) */
  isCurrent: () => boolean;
  /** the engine is up and the box is about to be rendered */
  onReading: () => void;
  signal: AbortSignal;
  /** the box's text, for the unavailable message */
  box: BoxText;
}

/** Thrown inside the task when the read is no longer wanted. */
const STALE = new Error("The box read is no longer wanted.");

const CANCELLED: OcrReadResult = { kind: "cancelled" };

export async function readBoxOnDevice<R>(steps: BoxReadSteps<R>): Promise<OcrReadResult> {
  const { session, rasterize, recognize, read, isCurrent, onReading, signal, box } = steps;
  const stale = () => signal.aborted || !isCurrent();
  const check = () => { if (stale()) throw STALE; };
  const r = await session.run(async (sig) => {
    check();
    onReading();
    const raster = await rasterize();
    check();
    const words = await recognize(raster, sig);
    check();
    return words;
  }, { signal });
  if (r.ok) return stale() ? CANCELLED : routeOcrRead(read(wordsToSpans(r.value)));
  switch (r.reason) {
    case "disabled":
    case "uninstalled":
      return { kind: "message", text: ocrUnavailableMessage(r.reason, box) };
    case "declined":
      return { kind: "message", text: OCR_DECLINED_MESSAGE };
    case "aborted":
      return CANCELLED;
    case "error":
      return { kind: "message", text: ocrFailedMessage(r.message) };
    case "failed":
      if (r.error === STALE) return CANCELLED;
      return { kind: "message", text: ocrFailedMessage(r.error instanceof Error ? r.error.message : String(r.error)) };
  }
}
