// What Import from schedule does with a read (lib/scheduleRoute.ts). Every
// box the user drags is one pure decision here, with no sign-in or server input:
//   - rows open the approval dialog;
//   - a table refused as another schedule family is a plain-words message;
//   - a box with text but no table gets the re-drag hint;
//   - a box with no text gets emptyBoxMessage: a mis-drag on a page that has
//     text, the raster-page message on a page with no text layer;
//   - the hints name every key column the reader takes, not CODE alone;
//   - a title is named only when it is the reason (a "title" refusal).
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeScheduleRead, refusalMessage, refusalWhy, NO_SCHEDULE_HINT, RASTER_PAGE_MESSAGE, emptyBoxMessage } from "../src/lib/scheduleRoute.ts";
import type { RefusalReason } from "../src/lib/scheduleRead.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";

const REFUSALS: RefusalReason[] = ["title", "equipment", "foreign-header", "no-color-style-pattern"];
const row: ScheduleRow = {
  finish_tag: "CPT-1", section: "FLOORING", category: "floor", category_source: "heading", description: "CARPET TILE",
  manufacturer: "VENDOR-A", style: "", spec_color: "", size: "", remarks: "", suggested: true,
};
const NO_TABLE = { rows: [] as [], refused: "no-table" as const };

test("finish table rows open the dialog", () => {
  for (const pageHasText of [true, false]) {
    assert.deepEqual(routeScheduleRead({ rows: [row] }, { textRuns: 12, pageHasText }), { kind: "rows", rows: [row] });
  }
});

test("a table of another schedule family is its refusal message", () => {
  for (const refused of REFUSALS) {
    for (const title of [undefined, "DOOR SCHEDULE"]) {
      const r = routeScheduleRead({ rows: [], refused, ...(title ? { title } : {}) }, { textRuns: 30, pageHasText: true });
      assert.deepEqual(r, { kind: "message", text: refusalMessage(refused, title) }, `${refused} title=${title}`);
    }
  }
});

test("text but no table is the re-drag hint", () => {
  for (const textRuns of [1, 8, 40]) {
    assert.deepEqual(routeScheduleRead(NO_TABLE, { textRuns, pageHasText: true }), { kind: "message", text: NO_SCHEDULE_HINT });
  }
});

test("no text, on a page that has text, is the empty-box hint", () => {
  assert.deepEqual(routeScheduleRead(NO_TABLE, { textRuns: 0, pageHasText: true }), { kind: "message", text: emptyBoxMessage(true) });
});

test("no text, on a page with no text layer, is the raster-page message", () => {
  assert.deepEqual(routeScheduleRead(NO_TABLE, { textRuns: 0, pageHasText: false }), { kind: "message", text: RASTER_PAGE_MESSAGE });
});

test("the routing takes no sign-in or server input and never routes to a scan", () => {
  for (const read of [{ rows: [row] }, NO_TABLE, { rows: [] as [], refused: "title" as const }]) {
    for (const textRuns of [0, 5]) {
      for (const pageHasText of [true, false]) {
        const kind = routeScheduleRead(read, { textRuns, pageHasText }).kind;
        assert.ok(kind === "rows" || kind === "message", kind);
      }
    }
  }
});

test("a title refusal names the title", () => {
  assert.equal(
    refusalMessage("title", "DOOR SCHEDULE"),
    `That's the "DOOR SCHEDULE", not a finish/material schedule — drag around the finish schedule instead.`,
  );
});

test("a title refusal without a title, and every other refusal, use the generic wording", () => {
  const generic = "That table doesn't look like a finish/material schedule — drag around the finish schedule "
    + "(its CODE / TAG / MARK / SYMBOL column and MATERIAL / MANUFACTURER / COLOR headers).";
  assert.equal(refusalMessage("title"), generic);
  for (const refused of ["equipment", "foreign-header", "no-color-style-pattern"] as RefusalReason[]) {
    // a title that passed the finish reader's title check (it may even say
    // FINISH) is not why these were refused — never quote it as the reason
    assert.equal(refusalMessage(refused, "FINISH SCHEDULE"), generic, refused);
    assert.equal(refusalMessage(refused), generic, refused);
  }
});

test("refusalWhy is the reason clause the agent's note shares", () => {
  assert.equal(refusalWhy("title", "DOOR SCHEDULE"), `That's the "DOOR SCHEDULE", not a finish/material schedule`);
  assert.equal(refusalWhy("foreign-header", "X"), "That table doesn't look like a finish/material schedule");
});

test("the hints name every key column, not CODE alone", () => {
  for (const s of [NO_SCHEDULE_HINT, refusalMessage("equipment")]) {
    for (const k of ["CODE", "TAG", "MARK", "SYMBOL"]) assert.match(s, new RegExp(`\\b${k}\\b`), s);
  }
});

// A box with no text. Only a page with NO text layer at all is called a
// raster image; a vector page's empty box is a mis-drag and gets the re-drag
// hint instead.
test("an empty box on a page with no text layer says raster image", () => {
  assert.equal(emptyBoxMessage(false), RASTER_PAGE_MESSAGE);
  assert.equal(
    RASTER_PAGE_MESSAGE,
    "No schedule text here — this page looks like a raster image (no text layer), which Import from schedule can't read.",
  );
});

test("an empty box on a page that has text never claims a raster page", () => {
  const m = emptyBoxMessage(true);
  assert.doesNotMatch(m, /scann|raster/i);
  assert.match(m, /^No text in that box — drag around the finish\/material schedule/);
  for (const k of ["CODE", "TAG", "MARK", "SYMBOL"]) assert.match(m, new RegExp(`\\b${k}\\b`));
});
