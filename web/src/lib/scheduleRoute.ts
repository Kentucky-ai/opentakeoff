// Import from schedule — what a marquee read turns into. Kept LIGHT (type-only
// imports from the reader; the code test comes from its leaf, finishCode.ts),
// so the canvas and the agent registry can word a refusal without loading the
// sheet graph.
//
// Every box is one decision here, from the read plus two facts about the box:
// how many text runs it held and whether the page has a text layer at all.
// Nothing about sign-in or a server goes in — every build routes the same, and
// the box never leaves the device. A box whose text holds no table and has at
// most STRAY_TEXT_MAX_RUNS runs (none, or a few stray labels over a picture)
// goes to the on-device reader (OCR), on any page; more text than that is a
// vector box that missed the schedule, and gets the re-drag hint. The on-device
// read's own answers are worded here too, so every message lives in one place.
import type { RefusalReason, ScheduleRead } from "./scheduleRead.ts";
import type { ScheduleRow } from "./scheduleRows.ts";
import { MODAL_SELECTOR } from "./modalKeys.ts";
import { finishCodeOk } from "./finishCode.ts";

/** What the reader keys a row by and what says "finish" — the hint names them
 *  all, not CODE alone. */
const WHERE = "(its CODE / TAG / MARK / SYMBOL column and MATERIAL / MANUFACTURER / COLOR headers)";

/** The re-drag hint when the box held text but no table. */
export const NO_SCHEDULE_HINT = `No schedule found in that box — drag around the finish/material schedule ${WHERE}.`;

/** A box too small to read (the canvas's size gate): a mis-drag, never a
 *  claim about the page. */
export const EMPTY_BOX_MESSAGE = `No text in that box — drag around the finish/material schedule ${WHERE}.`;

/** The most text runs a box can hold and still go to the on-device reader:
 *  a raster schedule can carry a few real text labels (a stamp, a title
 *  typed over the scan), and a vector schedule has far more. */
export const STRAY_TEXT_MAX_RUNS = 8;

/** A run counts as text when it has a letter or digit; leader dots, rules
 *  and lone punctuation don't push a raster box over the limit. */
const HAS_TEXT = /[\p{L}\p{N}]/u;

/** The box's text runs, as the routing counts them. */
export function countTextRuns(spans: readonly { str: string }[]): number {
  let n = 0;
  for (const s of spans) if (HAS_TEXT.test(s.str || "")) n++;
  return n;
}

/** Why a table was refused, as a clause. The title is named only when it IS
 *  the reason: another refusal's title passed the finish reader's title check
 *  (it may even say FINISH), so quoting it would contradict the message. */
export function refusalWhy(refused: RefusalReason, title?: string): string {
  return refused === "title" && title
    ? `That's the "${title}", not a finish/material schedule`
    : "That table doesn't look like a finish/material schedule";
}

/** The canvas message for a refused table. */
export function refusalMessage(refused: RefusalReason, title?: string): string {
  return refused === "title" && title
    ? `${refusalWhy(refused, title)} — drag around the finish schedule instead.`
    : `${refusalWhy(refused, title)} — drag around the finish schedule ${WHERE}.`;
}

/** rows → the dialog (with any skipped codes — four- or five-letter codes
 *  with no number the reader saw but didn't read; absent when none);
 *  message → the footer; ocr → read the box on-device. */
export type ImportRoute =
  | { kind: "rows"; rows: ScheduleRow[]; skipped?: string[] }
  | { kind: "message"; text: string }
  | { kind: "ocr" };

/** What the box held: its text-run count (countTextRuns over the joined runs,
 *  after the crop) and whether the page has any text layer at all. */
export interface BoxText {
  textRuns: number;
  pageHasText: boolean;
}

/** A read with skipped codes → the dialog, rows or not: a box whose only
 *  codes were skipped opens it with zero rows and the skipped notice. */
function skippedRoute(read: ScheduleRead): Extract<ImportRoute, { kind: "rows" }> | null {
  return "skipped" in read && read.skipped?.length ? { kind: "rows", rows: read.rows, skipped: read.skipped } : null;
}

/** Rows (or skipped codes) → the dialog; a refused table → its message,
 *  however much text the box held; no table → the on-device reader for at
 *  most STRAY_TEXT_MAX_RUNS runs, else the re-drag hint. */
export function routeScheduleRead(read: ScheduleRead, box: BoxText): ImportRoute {
  const skipped = skippedRoute(read);
  if (skipped) return skipped;
  if (read.rows.length) return { kind: "rows", rows: read.rows };
  const refused = "refused" in read ? read.refused : "no-table";
  if (refused !== "no-table") return { kind: "message", text: refusalMessage(refused, "title" in read ? read.title : undefined) };
  return box.textRuns <= STRAY_TEXT_MAX_RUNS ? { kind: "ocr" } : { kind: "message", text: NO_SCHEDULE_HINT };
}

// ── the on-device read ───────────────────────────────────────────────────────

/** The footer's status line while the engine starts, then while the box is
 *  rendered and read. Both carry Cancel. */
export const OCR_STARTING_MESSAGE = "Starting the on-device reader…";
export const OCR_READING_MESSAGE = "Reading the schedule on this device…";

/** The reading line once the read reports progress. A box read in one
 *  raster keeps the plain line; a box read in several (tiles, then patches
 *  across their seams) adds how many are read, never "n of N": the plan
 *  grows when patches join it, and a count that goes back reads as a fault.
 *  Takes seams.ts's SeamProgress (only these two counts). */
export function ocrReadingMessage(p: { rastersDone: number; rastersPlanned: number } | null | undefined): string {
  if (!p || p.rastersPlanned <= 1 || p.rastersDone < 1) return OCR_READING_MESSAGE;
  return `${OCR_READING_MESSAGE} (${p.rastersDone} ${p.rastersDone === 1 ? "raster" : "rasters"} read)`;
}

/** A box past the on-device reader's tile cap (OCR_MAX_TILES), refused
 *  before the engine starts: no download notice for a read that can't run. */
export const OCR_TOO_LARGE_MESSAGE = "That box is too large to read — draw it around the schedule only.";
/** …and while it waits for a page read or copy read (#471) ahead of it: the
 *  same words as Copy text's own waiting line (an inline string there). */
export const OCR_WAITING_MESSAGE = "Waiting for another read…";

/** The status line's attribute: keys inside it (its Cancel) are its own. */
export const IMPORT_READ_STATUS_ATTR = "data-import-read-status";

/** Where Space and Enter type rather than press: a text field, a select or
 *  an editable region. An <input> counts only as a text field (no type, an
 *  empty one, or a text-like type); a checkbox, radio or button input would
 *  be pressed. */
const TEXT_ENTRY = "textarea, select, [contenteditable=true]";
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

type KeyTarget = { closest?: (sel: string) => unknown } | null | undefined;
type InputLike = { getAttribute?: (name: string) => string | null } | null | undefined;

function typesInto(target: KeyTarget): boolean {
  if (target?.closest?.(TEXT_ENTRY)) return true;
  const input = target?.closest?.("input") as InputLike;
  if (!input) return false;
  return TEXT_INPUT_TYPES.has((input.getAttribute?.("type") ?? "").trim().toLowerCase());
}

/** While a box is read on-device the canvas's keys are held, but Space and
 *  Enter would still press whatever button has focus (after the download
 *  notice closes, focus can land on the Read control): true when this key
 *  must be kept from doing that. Space and Enter only; never inside the
 *  status line (Enter or Space on its Cancel still cancels), inside a modal
 *  (the download notice's Download and Cancel, open while the read waits on
 *  it) or in a text field. */
export function heldKeyWouldPress(key: string, target: KeyTarget): boolean {
  if (key !== " " && key !== "Enter") return false;
  if (target?.closest?.(`[${IMPORT_READ_STATUS_ATTR}], ${MODAL_SELECTOR}`)) return false;
  return !typesInto(target);
}

/** A box drawn while another is still being read. */
export const OCR_BUSY_MESSAGE = "Still reading the last box.";

/** The download notice's Cancel. */
export const OCR_DECLINED_MESSAGE = "Not read — reading a raster schedule needs the on-device reader, which wasn't downloaded.";

/** The on-device reader read the box and found no finish table in it. */
export const OCR_NO_ROWS_MESSAGE = `No schedule found in that box — the on-device reader found no finish/material rows. Drag around the schedule ${WHERE}.`;

/** Why the on-device reader can't run on this site, as a clause: turned off
 *  (VITE_OCR=off) or not installed (no models staged). Copy text says it too. */
export const ocrOffReason = (reason: "disabled" | "uninstalled"): string =>
  reason === "disabled" ? "on-device reading is turned off on this site" : "this site doesn't have the on-device reader installed";

/** The on-device reader can't run on this site (ocrOffReason). Only a box
 *  with no text on a page with no text layer is called a raster page; any
 *  other box sent to the reader (stray labels, or an empty box on a page with
 *  text) only says what applies if it is a raster image. */
export function ocrUnavailableMessage(reason: "disabled" | "uninstalled", box: BoxText): string {
  const why = ocrOffReason(reason);
  return box.textRuns === 0 && !box.pageHasText
    ? `No schedule text here — this page looks like a raster image (no text layer), and ${why}.`
    : `No schedule found in that box. If it's a raster image, ${why}.`;
}

/** A read the reader never answered (lib/ocr/client.ts OcrTimeoutError):
 *  the reader restarts on its own, so trying again is the next move. Its
 *  own line rather than ocrFailedMessage, which would wrap the error's
 *  sentence in parentheses. */
export const OCR_TIMEOUT_MESSAGE = "The on-device reader stopped responding — try again.";

/** A start or a read step that failed, with the reason it gave. */
export function ocrFailedMessage(reason: string): string {
  return `Couldn't read that box on this device (${reason}) — try again.`;
}

/** No table, but finish codes stacked in a column (#484): the engine found
 *  the codes and no header row, as on a schedule whose header row is rotated
 *  90° (OCR reads left to right only, and gave no detections in a rotated
 *  header band at all) or that the box cut off above. */
export const OCR_NO_HEADER_MESSAGE = "Found finish codes in a column but no header row the reader could read. The headers may be rotated (which can't be read yet) or outside the box — box the schedule with a header row that reads left to right.";

/** A span's text as a code: upper case, only letters, digits and hyphens
 *  kept. Close to the reader's rowKeyOf, not the same: rowKeyOf keeps "/"
 *  and splits a compound cell ("R1 / E1") into codes first; this drops the
 *  "/" and tests the whole span, so a compound span may not count. */
const asCode = (str: string) => str.toUpperCase().replace(/[^A-Z0-9-]/g, "");

/** At least three finish codes stacked in one column: spans that pass the
 *  reader's own code test (finishCodeOk) and hold a digit or hyphen (the
 *  test alone passes "SEE", "AND", "TO"), three of them overlapping one
 *  code's x extent. */
function codesInAColumn(spans: readonly { str: string; x: number; w: number }[]): boolean {
  const codes = spans.filter((s) => { const c = asCode(s.str); return /[\d-]/.test(c) && finishCodeOk(c); });
  return codes.some((a) => codes.filter((b) => b.x < a.x + a.w && a.x < b.x + b.w).length >= 3);
}

/** The on-device read's result: rows (or skipped codes) → the dialog; a
 *  refused table → its message; no table → the no-header hint when `spans`
 *  (the words read) hold codes in a column, else the no-rows hint. OCR reads
 *  carry no skipped codes today (the reader's OCR gate), but are routed the
 *  same. */
export function routeOcrRead(read: ScheduleRead, spans?: readonly { str: string; x: number; w: number }[]): Exclude<ImportRoute, { kind: "ocr" }> {
  const skipped = skippedRoute(read);
  if (skipped) return skipped;
  if (read.rows.length) return { kind: "rows", rows: read.rows };
  const refused = "refused" in read ? read.refused : "no-table";
  if (refused !== "no-table") return { kind: "message", text: refusalMessage(refused, "title" in read ? read.title : undefined) };
  return { kind: "message", text: spans && codesInAColumn(spans) ? OCR_NO_HEADER_MESSAGE : OCR_NO_ROWS_MESSAGE };
}
