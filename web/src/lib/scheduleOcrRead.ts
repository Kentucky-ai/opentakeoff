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
//   2. whenIdle(), when given (the OCR client's): the engine reads one thing
//      at a time, so a page read or a copy read (#471) under way goes first.
//      onWaiting() says so on the status line while it waits; Cancel ends
//      the wait at once (the client's wait takes no signal, so it is raced
//      against the session's). Then onReading() — the status line says
//      "Reading" from here on;
//   3. rasterize() renders the box; recognize() reads its words. Both get
//      the session's signal, so Cancel stops a render under way;
//   4. read() is the sheet graph's finish reader (readScheduleSpans with
//      { ocr: true } on the canvas), fed the words as spans (wordsToSpans),
//      and routeOcrRead words the result.
// Before each step and once more after the session answers, a read that is no
// longer wanted (the signal aborted, or isCurrent() false: the canvas moved on
// to another sheet) stops. Inside the task that is a throw of the private
// STALE sentinel, which the session reports as `failed` (or `aborted` once the
// signal has fired); both come back here as "cancelled", never as a failure.
// The check after the render is what keeps a render that finished for a
// sheet the canvas has left (isCurrent() false, the signal not aborted) from
// being read.
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
  /** render the box for the engine; the signal cancels the render */
  rasterize: (signal?: AbortSignal) => Promise<R>;
  /** read the render's words, in the sheet's image px */
  recognize: (raster: R, signal?: AbortSignal) => Promise<OcrWord[]>;
  /** the finish reader */
  read: (spans: GraphSpan[]) => ScheduleRead;
  /** false once the canvas has moved on (another sheet rendered) */
  isCurrent: () => boolean;
  /** the engine is up and the box is about to be rendered */
  onReading: () => void;
  /** resolves once no other on-device read is running or queued (the OCR
   *  client's whenIdle); absent, the box is rendered at once */
  whenIdle?: () => Promise<void>;
  /** the engine is up and the box waits for whenIdle */
  onWaiting?: () => void;
  signal: AbortSignal;
  /** the box's text, for the unavailable message */
  box: BoxText;
}

/** Thrown inside the task when the read is no longer wanted. */
const STALE = new Error("The box read is no longer wanted.");

const CANCELLED: OcrReadResult = { kind: "cancelled" };

/** `p`, or a rejection the moment `signal` aborts. */
function untilAbort(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(STALE);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(STALE);
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(() => { signal?.removeEventListener("abort", onAbort); resolve(); },
      (e) => { signal?.removeEventListener("abort", onAbort); reject(e); });
  });
}

export async function readBoxOnDevice<R>(steps: BoxReadSteps<R>): Promise<OcrReadResult> {
  const { session, rasterize, recognize, read, isCurrent, onReading, whenIdle, onWaiting, signal, box } = steps;
  const stale = () => signal.aborted || !isCurrent();
  const check = () => { if (stale()) throw STALE; };
  const r = await session.run(async (sig) => {
    check();
    if (whenIdle) {
      onWaiting?.();
      await untilAbort(whenIdle(), sig);
      check();
    }
    onReading();
    const raster = await rasterize(sig);
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
