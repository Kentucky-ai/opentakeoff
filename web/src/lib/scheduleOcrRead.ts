// Import from schedule — reading a box on-device (#470). When scheduleRoute
// sends a box to the on-device reader (no table in its text layer, and at most
// a few stray runs), the canvas hands this the box's steps and gets back what
// the box becomes: rows, a message, or "cancelled" (the person left: Cancel,
// another sheet, the canvas closed), which shows nothing.
//
// Pure: every step is injected, so this touches no DOM, worker or pdf.js.
//   0. tooLarge(): a box past the reader's tile cap is refused before
//      anything starts (no download notice for a read that can't run);
//   1. session.run starts the engine the way the person agreed (lib/ocr/
//      session.ts: cached files start at once, else the download notice, and
//      only its Download downloads);
//   2. whenIdle(), when given (the OCR client's): the engine reads one thing
//      at a time, so a page read or a copy read (#471) under way goes first.
//      onWaiting() says so on the status line while it waits; Cancel ends
//      the wait at once (the client's wait takes no signal, so it is raced
//      against the session's). Then onReading() — the status line says
//      "Reading" from here on;
//   3. readWords() reads the box (lib/ocr/boxRead.ts: tiled at 216 DPI, as a
//      page read is) and returns its words; it gets the session's signal, so
//      Cancel stops a render or read under way, and reports progress, passed
//      on to onProgress while the read is wanted;
//   4. read() is the sheet graph's finish reader (readScheduleSpans with
//      { ocr: true } on the canvas), fed the words as spans (wordsToSpans),
//      and routeOcrRead words the result (given the spans too, so no table
//      over a column of codes says the header row is what's missing).
// Before each step and once more after the session answers, a read that is no
// longer wanted (the signal aborted, or isCurrent() false: the canvas moved on
// to another sheet) stops. Inside the task that is a throw of the private
// STALE sentinel, which the session reports as `failed` (or `aborted` once the
// signal has fired); both come back here as "cancelled", never as a failure.
// So does any failure while the read is no longer wanted: boxRead.ts aborts
// its read when a render lands for a sheet the canvas has left, and that
// AbortError is reported `failed` (session.ts reports only the caller's own
// abort as `aborted`). An AbortError nobody asked for (the page closed
// during the read) is cancelled too.
import type { OcrSession } from "./ocr/session.ts";
import type { SeamProgress } from "./ocr/seams.ts";
import { wordsToSpans, type OcrWord } from "./ocr/types.ts";
import type { GraphSpan } from "./sheetgraph.ts";
import type { ScheduleRead } from "./scheduleRead.ts";
import {
  routeOcrRead, ocrUnavailableMessage, ocrFailedMessage, OCR_DECLINED_MESSAGE, OCR_TOO_LARGE_MESSAGE, type BoxText, type ImportRoute,
} from "./scheduleRoute.ts";

/** What a box read on-device becomes. */
export type OcrReadResult = Exclude<ImportRoute, { kind: "ocr" }> | { kind: "cancelled" };

export interface BoxReadSteps {
  session: Pick<OcrSession, "run">;
  /** read the box's words, in the sheet's image px; the signal cancels a
   *  render or read under way (lib/ocr/boxRead.ts boxReadWords) */
  readWords: (signal?: AbortSignal, onProgress?: (p: SeamProgress) => void) => Promise<OcrWord[]>;
  /** the box is past the reader's tile cap (boxRead.ts boxTooLarge) */
  tooLarge: () => boolean;
  /** the read's progress, while it is wanted */
  onProgress?: (p: SeamProgress) => void;
  /** the finish reader */
  read: (spans: GraphSpan[]) => ScheduleRead;
  /** false once the canvas has moved on (another sheet rendered) */
  isCurrent: () => boolean;
  /** the engine is up and the box is about to be read */
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

/** A thrown value that is the read's PageTooLargeError (regionRead.ts). */
const tooLargeError = (e: unknown) => (e as { name?: string } | null)?.name === "PageTooLargeError";
const abortError = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

export async function readBoxOnDevice(steps: BoxReadSteps): Promise<OcrReadResult> {
  const { session, readWords, tooLarge, onProgress, read, isCurrent, onReading, whenIdle, onWaiting, signal, box } = steps;
  if (tooLarge()) return { kind: "message", text: OCR_TOO_LARGE_MESSAGE };
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
    const words = await readWords(sig, (p) => { if (!stale()) onProgress?.(p); });
    check();
    return words;
  }, { signal });
  if (r.ok) {
    if (stale()) return CANCELLED;
    const spans = wordsToSpans(r.value);
    return routeOcrRead(read(spans), spans);
  }
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
      if (r.error === STALE || stale() || abortError(r.error)) return CANCELLED;
      if (tooLargeError(r.error)) return { kind: "message", text: OCR_TOO_LARGE_MESSAGE };
      return { kind: "message", text: ocrFailedMessage(r.error instanceof Error ? r.error.message : String(r.error)) };
  }
}
