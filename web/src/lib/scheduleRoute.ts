// Import from schedule — what a marquee read turns into. Kept LIGHT (type-only
// imports from the reader), so the canvas and the agent registry can word a
// refusal without loading the sheet graph.
//
// Every box is one decision here, from the read plus two facts about the box:
// how many text runs it held and whether the page has a text layer at all.
// Nothing about sign-in or a server goes in — every build routes the same, and
// the box never leaves the device. An empty box and a box with text but no
// table both read as "no-table"; the run count tells them apart.
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
  | { kind: "message"; text: string };

/** What the box held: its text-run count (joined runs, after the crop) and
 *  whether the page has any text layer at all. */
export interface BoxText {
  textRuns: number;
  pageHasText: boolean;
}

/** Rows → the dialog; a refused table → its message; no table → the re-drag
 *  hint when the box held text, else emptyBoxMessage. */
export function routeScheduleRead(read: ScheduleRead, box: BoxText): ImportRoute {
  if (read.rows.length) return { kind: "rows", rows: read.rows };
  const refused = "refused" in read ? read.refused : "no-table";
  if (refused !== "no-table") return { kind: "message", text: refusalMessage(refused, "title" in read ? read.title : undefined) };
  return { kind: "message", text: box.textRuns > 0 ? NO_SCHEDULE_HINT : emptyBoxMessage(box.pageHasText) };
}

/** A box with no text on a page with no text layer at all: the one case that
 *  may be called a raster page. Nothing in the app reads it. */
export const RASTER_PAGE_MESSAGE = "No schedule text here — this page looks like a raster image (no text layer), which Import from schedule can't read.";

/** The message for a box that holds no text. Only a page with no text anywhere
 *  is a raster page; a page that has text elsewhere means the box missed the
 *  schedule — say so, and how to aim. */
export function emptyBoxMessage(pageHasText: boolean): string {
  return pageHasText ? `No text in that box — drag around the finish/material schedule ${WHERE}.` : RASTER_PAGE_MESSAGE;
}
