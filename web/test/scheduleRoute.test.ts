// What Import from schedule does with a read (lib/scheduleRoute.ts). Invariants:
//   - rows open the approval dialog;
//   - a table refused as another schedule family is a plain-words message and
//     NEVER the paid scan reader — signed in or not;
//   - only "no-table" (nothing read as a table) may fall through to the scan,
//     and only when the scan is reachable; otherwise the re-drag hint;
//   - the hints name every key column the reader takes, not CODE alone;
//   - a title is named only when it is the reason (a "title" refusal).
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeScheduleRead, refusalMessage, refusalWhy, NO_SCHEDULE_HINT, SCANNED_PAGE_NO_READER, emptyBoxMessage } from "../src/lib/scheduleRoute.ts";
import type { RefusalReason } from "../src/lib/scheduleRead.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";

const REFUSALS: RefusalReason[] = ["title", "equipment", "foreign-header", "no-color-style-pattern"];
const row: ScheduleRow = {
  finish_tag: "CPT-1", section: "FLOORING", category: "floor", category_source: "heading", description: "CARPET TILE",
  manufacturer: "VENDOR-A", style: "", spec_color: "", size: "", remarks: "", suggested: true,
};

test("rows open the dialog whether or not the scan is reachable", () => {
  for (const reachable of [true, false]) {
    assert.deepEqual(routeScheduleRead({ rows: [row] }, reachable), { kind: "rows", rows: [row] });
  }
});

test("a refused table is a message and never routes to the scan", () => {
  for (const refused of REFUSALS) {
    for (const reachable of [true, false]) {
      for (const title of [undefined, "DOOR SCHEDULE"]) {
        const r = routeScheduleRead({ rows: [], refused, ...(title ? { title } : {}) }, reachable);
        assert.equal(r.kind, "message", `${refused} reachable=${reachable} title=${title}`);
        assert.equal((r as { text: string }).text, refusalMessage(refused, title));
      }
    }
  }
});

test("no table: the scan reader when reachable, else the re-drag hint", () => {
  assert.deepEqual(routeScheduleRead({ rows: [], refused: "no-table" }, true), { kind: "scan" });
  assert.deepEqual(routeScheduleRead({ rows: [], refused: "no-table" }, false), { kind: "message", text: NO_SCHEDULE_HINT });
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

// A box with no text when the scan reader isn't configured. Only a page with
// NO text layer at all may be called scanned; a vector page's empty box is a
// mis-drag and gets the re-drag hint instead.
test("an empty box on a page with no text layer says scanned page", () => {
  assert.equal(emptyBoxMessage(false), SCANNED_PAGE_NO_READER);
  assert.match(SCANNED_PAGE_NO_READER, /scanned page \(no text layer\)/);
});

test("an empty box on a page that has text never claims a scanned page", () => {
  const m = emptyBoxMessage(true);
  assert.doesNotMatch(m, /scann/i);
  assert.match(m, /^No text in that box — drag around the finish\/material schedule/);
  for (const k of ["CODE", "TAG", "MARK", "SYMBOL"]) assert.match(m, new RegExp(`\\b${k}\\b`));
});
