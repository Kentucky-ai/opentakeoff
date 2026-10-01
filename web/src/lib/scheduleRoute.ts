// Import from schedule — what a marquee read turns into. Kept LIGHT (type-only
// imports from the reader), so the canvas and the agent registry can word a
// refusal without loading the sheet graph.
//
// A table the reader refused as another schedule family (a door schedule, a
// device schedule …) is a message and STOPS: the paid scan reader never runs
// on it, signed in or not — it would only read the wrong table. Only a box
// that held no table at all may fall through to the scan (a scanned page's
// stray text layer), and only when the scan is reachable.
import type { RefusalReason, ScheduleRead } from "./scheduleRead.ts";
import type { ScheduleRow } from "./scheduleRows.ts";

/** What the reader keys a row by and what says "finish" — the hint names them
 *  all, not CODE alone. */
const WHERE = "(its CODE / TAG / MARK / SYMBOL column and MATERIAL / MANUFACTURER / COLOR headers)";

/** The re-drag hint when the box held no table. */
export const NO_SCHEDULE_HINT = `No schedule found in that box — drag around the finish/material schedule ${WHERE}.`;

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

export type ImportRoute =
  | { kind: "rows"; rows: ScheduleRow[] }
  | { kind: "message"; text: string }
  | { kind: "scan" };

/** Rows → the dialog; a refused table → its message (never the scan); no
 *  table → the scan reader when `scanReachable`, else the re-drag hint. */
export function routeScheduleRead(read: ScheduleRead, scanReachable: boolean): ImportRoute {
  if (read.rows.length) return { kind: "rows", rows: read.rows };
  const refused = "refused" in read ? read.refused : "no-table";
  if (refused !== "no-table") return { kind: "message", text: refusalMessage(refused, "title" in read ? read.title : undefined) };
  return scanReachable ? { kind: "scan" } : { kind: "message", text: NO_SCHEDULE_HINT };
}

/** A box with no text, when the scan reader isn't configured, on a page with
 *  no text layer at all: the one case that may be called a scanned page. */
export const SCANNED_PAGE_NO_READER = "No schedule found — this looks like a scanned page (no text layer). Importing from scanned plans needs the AI backend.";

/** The message for a box that holds no text when the scan reader isn't
 *  configured. Only a page with no text anywhere is "scanned"; a page that has
 *  text elsewhere means the box missed the schedule — say so, and how to aim. */
export function emptyBoxMessage(pageHasText: boolean): string {
  return pageHasText ? `No text in that box — drag around the finish/material schedule ${WHERE}.` : SCANNED_PAGE_NO_READER;
}
