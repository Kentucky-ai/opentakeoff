// What Import from schedule does with a read (lib/scheduleRoute.ts). Every
// box the user drags is one pure decision here, with no sign-in or server input:
//   - rows open the approval dialog;
//   - a table refused as another schedule family is a plain-words message,
//     however many text runs the box held;
//   - a box with no table and at most STRAY_TEXT_MAX_RUNS text runs (none, or
//     a few stray labels over a picture) goes to the on-device reader, on any
//     page; more runs than that is a vector box that missed the schedule, and
//     gets the re-drag hint;
//   - only runs with a letter or digit count (countTextRuns), so leader dots
//     and rules don't push a raster box over the limit;
//   - an on-device read the site can't do is worded by why (turned off, or
//     not installed) and by the box: only a box with no text on a page with no
//     text layer is called a raster page;
//   - the on-device read's own result: rows, a refusal, or the no-rows hint;
//   - the hints name every key column the reader takes, not CODE alone;
//   - a title is named only when it is the reason (a "title" refusal).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  routeScheduleRead, routeOcrRead, refusalMessage, refusalWhy, countTextRuns, ocrUnavailableMessage, ocrFailedMessage,
  NO_SCHEDULE_HINT, EMPTY_BOX_MESSAGE, OCR_NO_ROWS_MESSAGE, OCR_DECLINED_MESSAGE, OCR_BUSY_MESSAGE, OCR_STARTING_MESSAGE,
  OCR_READING_MESSAGE, OCR_WAITING_MESSAGE, OCR_TOO_LARGE_MESSAGE, STRAY_TEXT_MAX_RUNS, heldKeyWouldPress, IMPORT_READ_STATUS_ATTR,
  ocrReadingMessage, OCR_NO_HEADER_MESSAGE,
} from "../src/lib/scheduleRoute.ts";
import { finishCodeOk, CODE_RE } from "../src/lib/sheetgraph.ts";
import { readScheduleSpans } from "../src/lib/scheduleRead.ts";
import { wordsToSpans, type OcrWord } from "../src/lib/ocr/types.ts";
import { readFileSync } from "node:fs";
import type { RefusalReason } from "../src/lib/scheduleRead.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";

const REFUSALS: RefusalReason[] = ["title", "equipment", "foreign-header", "no-color-style-pattern"];
const row: ScheduleRow = {
  finish_tag: "CPT-1", section: "FLOORING", category: "floor", category_source: "heading", description: "CARPET TILE",
  manufacturer: "VENDOR-A", style: "", spec_color: "", size: "", remarks: "", suggested: true,
};
const NO_TABLE = { rows: [] as [], refused: "no-table" as const };
const WHERE = "(its CODE / TAG / MARK / SYMBOL column and MATERIAL / MANUFACTURER / COLOR headers)";

test("finish table rows open the dialog", () => {
  for (const pageHasText of [true, false]) {
    assert.deepEqual(routeScheduleRead({ rows: [row] }, { textRuns: 12, pageHasText }), { kind: "rows", rows: [row] });
  }
});

test("a table of another schedule family is its refusal message, at any run count", () => {
  for (const refused of REFUSALS) {
    for (const title of [undefined, "DOOR SCHEDULE"]) {
      for (const textRuns of [0, 1, 8, 9, 30]) {
        for (const pageHasText of [true, false]) {
          const r = routeScheduleRead({ rows: [], refused, ...(title ? { title } : {}) }, { textRuns, pageHasText });
          assert.deepEqual(r, { kind: "message", text: refusalMessage(refused, title) }, `${refused} title=${title} runs=${textRuns}`);
        }
      }
    }
  }
});

test("no table and more than 8 text runs is the re-drag hint, on either page kind", () => {
  assert.equal(STRAY_TEXT_MAX_RUNS, 8);
  for (const textRuns of [9, 40]) {
    for (const pageHasText of [true, false]) {
      assert.deepEqual(routeScheduleRead(NO_TABLE, { textRuns, pageHasText }), { kind: "message", text: NO_SCHEDULE_HINT });
    }
  }
});

test("no table and at most 8 text runs goes to the on-device reader, on either page kind", () => {
  for (const textRuns of [0, 1, 8]) {
    for (const pageHasText of [true, false]) {
      assert.deepEqual(routeScheduleRead(NO_TABLE, { textRuns, pageHasText }), { kind: "ocr" }, `runs=${textRuns} pageHasText=${pageHasText}`);
    }
  }
});

test("the routing takes no sign-in or server input: rows, a message or the on-device reader", () => {
  for (const read of [{ rows: [row] }, NO_TABLE, { rows: [] as [], refused: "title" as const }]) {
    for (const textRuns of [0, 5, 20]) {
      for (const pageHasText of [true, false]) {
        const kind = routeScheduleRead(read, { textRuns, pageHasText }).kind;
        assert.ok(kind === "rows" || kind === "message" || kind === "ocr", kind);
      }
    }
  }
});

test("countTextRuns counts only runs with a letter or digit", () => {
  const s = (str: string) => ({ str, x: 0, y: 0, w: 1, h: 1 });
  assert.equal(countTextRuns([]), 0);
  assert.equal(countTextRuns([s("CPT-1"), s("A"), s("7"), s("É")]), 4);
  assert.equal(countTextRuns([s("....."), s("—"), s("|"), s("-- / --"), s(" "), s("")]), 0);
  // nine leader/rule runs beside eight labels still route to the reader
  const box = [...Array(9)].map(() => s("....")).concat([...Array(8)].map((_, i) => s(`L${i}`)));
  assert.equal(countTextRuns(box), 8);
  assert.deepEqual(routeScheduleRead(NO_TABLE, { textRuns: countTextRuns(box), pageHasText: true }), { kind: "ocr" });
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
  for (const s of [NO_SCHEDULE_HINT, refusalMessage("equipment"), EMPTY_BOX_MESSAGE, OCR_NO_ROWS_MESSAGE]) {
    for (const k of ["CODE", "TAG", "MARK", "SYMBOL"]) assert.match(s, new RegExp(`\\b${k}\\b`), s);
  }
});

// The box too small to read (the canvas's size gate) is a mis-drag, never a
// claim about the page.
test("the empty-box message aims the next drag and never claims a raster page", () => {
  assert.equal(EMPTY_BOX_MESSAGE, `No text in that box — drag around the finish/material schedule ${WHERE}.`);
  assert.doesNotMatch(EMPTY_BOX_MESSAGE, /scann|raster/i);
});

// The on-device reader is turned off (VITE_OCR=off) or not installed (no
// models staged). Only a box with no text on a page with no text layer is
// called a raster page; any other box routed to the reader (stray labels, or
// an empty box on a page with text) only says what to do if it is one.
test("the reader unavailable: two reasons by two box kinds", () => {
  const raster = { textRuns: 0, pageHasText: false };
  assert.equal(
    ocrUnavailableMessage("disabled", raster),
    "No schedule text here — this page looks like a raster image (no text layer), and on-device reading is turned off on this site.",
  );
  assert.equal(
    ocrUnavailableMessage("uninstalled", raster),
    "No schedule text here — this page looks like a raster image (no text layer), and this site doesn't have the on-device reader installed.",
  );
  for (const box of [{ textRuns: 0, pageHasText: true }, { textRuns: 3, pageHasText: true }, { textRuns: 3, pageHasText: false }]) {
    assert.equal(
      ocrUnavailableMessage("disabled", box),
      "No schedule found in that box. If it's a raster image, on-device reading is turned off on this site.",
      JSON.stringify(box),
    );
    assert.equal(
      ocrUnavailableMessage("uninstalled", box),
      "No schedule found in that box. If it's a raster image, this site doesn't have the on-device reader installed.",
      JSON.stringify(box),
    );
  }
});

test("the reader's own result: rows, a refusal, or the no-rows hint naming WHERE", () => {
  assert.deepEqual(routeOcrRead({ rows: [row] }), { kind: "rows", rows: [row] });
  for (const refused of REFUSALS) {
    for (const title of [undefined, "DOOR SCHEDULE"]) {
      assert.deepEqual(
        routeOcrRead({ rows: [], refused, ...(title ? { title } : {}) }),
        { kind: "message", text: refusalMessage(refused, title) },
      );
    }
  }
  assert.deepEqual(routeOcrRead(NO_TABLE), { kind: "message", text: OCR_NO_ROWS_MESSAGE });
  assert.equal(
    OCR_NO_ROWS_MESSAGE,
    `No schedule found in that box — the on-device reader found no finish/material rows. Drag around the schedule ${WHERE}.`,
  );
});

// ── codes but no header row (#484) ──────────────────────────────────────────

/** The real per-box words of a synthetic schedule whose header row is
 * rotated 90°: the engine found no header at all (fixture's `about`). */
const ROTATED: { rs: number; words: OcrWord[] } = JSON.parse(readFileSync(new URL("./fixtures/schedule-ocr/rotated-header-perbox.json", import.meta.url), "utf8"));
const span = (str: string, x: number, y: number) => ({ str, x, y, w: 40, h: 12 });

test("the no-header hint is worded as decided", () => {
  assert.equal(
    OCR_NO_HEADER_MESSAGE,
    "Found finish codes in a column but no header row the reader could read. The headers may be rotated (which can't be read yet) or outside the box — box the schedule with a header row that reads left to right.",
  );
});

test("the rotated-header table: the reader finds no table, and the hint says why", () => {
  const spans = wordsToSpans(ROTATED.words);
  const read = readScheduleSpans(spans, { ocr: true });
  assert.deepEqual(read, { rows: [], refused: "no-table" }, "the expected refusal is no-table");
  assert.deepEqual(routeOcrRead(read, spans), { kind: "message", text: OCR_NO_HEADER_MESSAGE });
  // without the spans (the one-argument call): the no-rows hint, as before
  assert.deepEqual(routeOcrRead(read), { kind: "message", text: OCR_NO_ROWS_MESSAGE });
});

test("the hint needs three codes stacked in one column", () => {
  const column = [span("CPT-1", 100, 50), span("LVT-1", 102, 80), span("RB-1", 98, 110)];
  assert.deepEqual(routeOcrRead(NO_TABLE, column), { kind: "message", text: OCR_NO_HEADER_MESSAGE });
  // two codes: no hint
  assert.deepEqual(routeOcrRead(NO_TABLE, column.slice(0, 2)), { kind: "message", text: OCR_NO_ROWS_MESSAGE });
  // three codes scattered across columns: no hint
  const scattered = [span("CPT-1", 100, 50), span("LVT-1", 400, 80), span("RB-1", 700, 110)];
  assert.deepEqual(routeOcrRead(NO_TABLE, scattered), { kind: "message", text: OCR_NO_ROWS_MESSAGE });
  // two in one column and one elsewhere: no hint
  assert.deepEqual(routeOcrRead(NO_TABLE, [...column.slice(0, 2), span("RB-1", 700, 110)]), { kind: "message", text: OCR_NO_ROWS_MESSAGE });
});

test("the hint counts only codes with a digit or hyphen: a column of words the code test passes is no hint", () => {
  // CODE_RE alone passes these; the reader's test passes all but none is a code
  for (const w of ["SEE", "AND", "TO"]) assert.ok(finishCodeOk(w) && CODE_RE.test(w), w);
  const words = [span("SEE", 100, 50), span("AND", 101, 80), span("TO", 99, 110), span("SEE", 100, 140)];
  assert.deepEqual(routeOcrRead(NO_TABLE, words), { kind: "message", text: OCR_NO_ROWS_MESSAGE });
  // and text with a digit or hyphen that the reader's code test refuses never counts
  for (const w of ["CPT-12345", "ABCDE-1", "CPT--1"]) assert.ok(!finishCodeOk(w), w);
  const long = [span("CPT-12345", 100, 50), span("ABCDE-1", 100, 80), span("CPT--1", 100, 110)];
  assert.deepEqual(routeOcrRead(NO_TABLE, long), { kind: "message", text: OCR_NO_ROWS_MESSAGE });
});

test("the hint is only for no table: rows and other refusals are unchanged", () => {
  const column = [span("CPT-1", 100, 50), span("LVT-1", 102, 80), span("RB-1", 98, 110)];
  assert.deepEqual(routeOcrRead({ rows: [row] }, column), { kind: "rows", rows: [row] });
  for (const refused of REFUSALS) {
    assert.deepEqual(routeOcrRead({ rows: [], refused }, column), { kind: "message", text: refusalMessage(refused) });
  }
});

test("declined, failed, and the status lines are worded as decided", () => {
  assert.equal(OCR_DECLINED_MESSAGE, "Not read — reading a raster schedule needs the on-device reader, which wasn't downloaded.");
  assert.equal(ocrFailedMessage("OCR engine not ready"), "Couldn't read that box on this device (OCR engine not ready) — try again.");
  assert.equal(OCR_BUSY_MESSAGE, "Still reading the last box.");
  assert.equal(OCR_STARTING_MESSAGE, "Starting the on-device reader…");
  assert.equal(OCR_READING_MESSAGE, "Reading the schedule on this device…");
  assert.equal(OCR_WAITING_MESSAGE, "Waiting for another read…", "Copy text's waiting line, word for word");
  assert.equal(OCR_TOO_LARGE_MESSAGE, "That box is too large to read — draw it around the schedule only.");
});

test("the reading line counts rasters read only when the box takes several, never as n/N", () => {
  const p = (rastersDone: number, rastersPlanned: number) => ({ rastersDone, rastersPlanned });
  // no progress yet, or a box read in one raster: the plain line
  assert.equal(ocrReadingMessage(null), OCR_READING_MESSAGE);
  assert.equal(ocrReadingMessage(undefined), OCR_READING_MESSAGE);
  assert.equal(ocrReadingMessage(p(0, 1)), OCR_READING_MESSAGE);
  assert.equal(ocrReadingMessage(p(1, 1)), OCR_READING_MESSAGE);
  // several planned, none read yet: still the plain line, not "0 rasters"
  assert.equal(ocrReadingMessage(p(0, 4)), OCR_READING_MESSAGE);
  // several: how many are read (the total grows when patches join the plan)
  assert.equal(ocrReadingMessage(p(1, 4)), "Reading the schedule on this device… (1 raster read)");
  assert.equal(ocrReadingMessage(p(3, 4)), "Reading the schedule on this device… (3 rasters read)");
  assert.equal(ocrReadingMessage(p(5, 6)), "Reading the schedule on this device… (5 rasters read)");
});

/** A fake element: a tag, its attributes and a parent. closest() matches a
 * selector list the way the DOM does for the simple forms used here — a tag,
 * any number of [attr] / [attr=value] / [attr="value"] parts, or both — on
 * this element first, then up the parent chain. */
type FakeEl = { tagName: string; attrs: Record<string, string>; parent: FakeEl | null; getAttribute(n: string): string | null; closest(sel: string): FakeEl | null };
const matchesSimple = (el: FakeEl, sel: string) => {
  const m = /^([a-z]*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
  if (!m) throw new Error(`fake closest can't read ${sel}`);
  if (m[1] && m[1].toLowerCase() !== el.tagName.toLowerCase()) return false;
  for (const a of m[2].matchAll(/\[([^=\]]+)(?:=("?)([^"\]]*)\2)?\]/g)) {
    const [, name, , value] = a;
    if (!(name in el.attrs)) return false;
    if (value !== undefined && el.attrs[name] !== value) return false;
  }
  return true;
};
const el = (tagName: string, attrs: Record<string, string> = {}, parent: FakeEl | null = null): FakeEl => {
  const self: FakeEl = {
    tagName: tagName.toUpperCase(), attrs, parent,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    closest: (sel) => {
      const parts = sel.split(",");
      for (let e: FakeEl | null = self; e; e = e.parent) if (parts.some((p) => matchesSimple(e!, p))) return e;
      return null;
    },
  };
  return self;
};
const body = el("body");

test("held keys: the fake element's closest() reads selectors, not their spelling", () => {
  const box = el("div", { "aria-modal": "true" }, body);
  assert.equal(el("button", {}, box).closest('[aria-modal="true"]'), box);
  assert.equal(el("button", {}, body).closest('[aria-modal="true"]'), null);
  const cb = el("input", { type: "checkbox" }, box);
  assert.equal(cb.closest("input"), cb);
  assert.equal(cb.closest("textarea, [aria-modal=\"true\"]"), box, "a list matches its first hit up the chain");
  assert.equal(el("dialog", { open: "" }).closest("dialog[open]")?.tagName, "DIALOG");
  assert.equal(el("dialog").closest("dialog[open]"), null);
});

test("held keys: Space and Enter on a button are kept from pressing it during a read", () => {
  for (const key of [" ", "Enter"]) {
    assert.equal(heldKeyWouldPress(key, el("button", {}, body)), true, `${JSON.stringify(key)} on a button`);
    assert.equal(heldKeyWouldPress(key, body), true, `${JSON.stringify(key)} on the body`);
    assert.equal(heldKeyWouldPress(key, null), true, `${JSON.stringify(key)} with no target`);
  }
});

test("held keys: the status line's own Cancel and text entry keep their keys", () => {
  const status = el("div", { [IMPORT_READ_STATUS_ATTR]: "" }, body);
  for (const key of [" ", "Enter"]) {
    assert.equal(heldKeyWouldPress(key, el("button", {}, status)), false, "inside the status line: Cancel still presses");
    for (const ed of [el("textarea"), el("select"), el("div", { contenteditable: "true" })]) {
      assert.equal(heldKeyWouldPress(key, ed), false, `typing into ${ed.tagName}`);
    }
    assert.equal(heldKeyWouldPress(key, el("span", {}, el("div", { contenteditable: "true" }, body))), false, "inside an editable region");
  }
});

test("held keys: a modal dialog's buttons keep their keys (the download notice's Download and Cancel)", () => {
  const notice = el("div", { role: "dialog", "aria-modal": "true" }, body);
  const dlg = el("dialog", { open: "" }, body);
  for (const key of [" ", "Enter"]) {
    assert.equal(heldKeyWouldPress(key, el("button", {}, notice)), false, `${JSON.stringify(key)} on a button in an aria-modal dialog`);
    assert.equal(heldKeyWouldPress(key, el("button", {}, el("div", {}, notice))), false, `${JSON.stringify(key)} nested deeper in the dialog`);
    assert.equal(heldKeyWouldPress(key, el("button", {}, dlg)), false, `${JSON.stringify(key)} in an open <dialog>`);
    assert.equal(heldKeyWouldPress(key, el("button", {}, el("div", { "aria-modal": "false" }, body))), true, `${JSON.stringify(key)} under aria-modal="false"`);
  }
});

test("held keys: only text-like inputs count as text entry", () => {
  for (const key of [" ", "Enter"]) {
    for (const type of ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]) {
      assert.equal(heldKeyWouldPress(key, el("input", { type }, body)), true, `${JSON.stringify(key)} on input type=${type} would press it`);
    }
    for (const type of ["text", "search", "email", "url", "tel", "password", "number", "TEXT", ""]) {
      assert.equal(heldKeyWouldPress(key, el("input", { type }, body)), false, `${JSON.stringify(key)} typing into input type=${JSON.stringify(type)}`);
    }
    assert.equal(heldKeyWouldPress(key, el("input", {}, body)), false, `${JSON.stringify(key)} typing into input with no type`);
  }
});

test("held keys: other keys are not this guard's", () => {
  for (const key of ["a", "Escape", "Tab", "Delete", "1"]) assert.equal(heldKeyWouldPress(key, el("button", {}, body)), false, key);
});

// ── #483: skipped codes ──────────────────────────────────────────────────────
// A read can carry skipped codes (four- or five-letter codes with no number the
// reader saw but didn't read). Rows plus skipped open the dialog with both; a
// box whose only codes were skipped ({ rows: [], skipped }) still opens the
// dialog (zero rows, the skipped notice) — never the on-device reader or a
// hint, however few text runs it held. No skipped → no skipped key.
test("rows with no skipped codes: no skipped key", () => {
  assert.deepEqual(routeScheduleRead({ rows: [row] }, { textRuns: 12, pageHasText: true }), { kind: "rows", rows: [row] });
  assert.deepEqual(routeScheduleRead({ rows: [row], skipped: [] }, { textRuns: 12, pageHasText: true }), { kind: "rows", rows: [row] });
  assert.deepEqual(routeOcrRead({ rows: [row] }), { kind: "rows", rows: [row] });
});

test("rows plus skipped codes → rows and skipped", () => {
  assert.deepEqual(routeScheduleRead({ rows: [row], skipped: ["EPOX"] }, { textRuns: 12, pageHasText: true }), { kind: "rows", rows: [row], skipped: ["EPOX"] });
  assert.deepEqual(routeOcrRead({ rows: [row], skipped: ["EPOX"] }), { kind: "rows", rows: [row], skipped: ["EPOX"] });
});

test("{ rows: [], skipped } → the dialog with zero rows, at any run count (never OCR, never a hint)", () => {
  for (const textRuns of [0, 1, 8, 9, 40]) {
    for (const pageHasText of [true, false]) {
      assert.deepEqual(routeScheduleRead({ rows: [], skipped: ["EPOX", "SEAL"] }, { textRuns, pageHasText }),
        { kind: "rows", rows: [], skipped: ["EPOX", "SEAL"] }, `runs=${textRuns}`);
    }
  }
  assert.deepEqual(routeOcrRead({ rows: [], skipped: ["EPOX"] }), { kind: "rows", rows: [], skipped: ["EPOX"] });
});

test("refusals and no-table route as before alongside the skipped check", () => {
  assert.deepEqual(routeScheduleRead({ rows: [], refused: "title", title: "DOOR SCHEDULE" }, { textRuns: 3, pageHasText: true }),
    { kind: "message", text: refusalMessage("title", "DOOR SCHEDULE") });
  assert.deepEqual(routeScheduleRead(NO_TABLE, { textRuns: 3, pageHasText: true }), { kind: "ocr" });
  assert.deepEqual(routeScheduleRead(NO_TABLE, { textRuns: 30, pageHasText: true }), { kind: "message", text: NO_SCHEDULE_HINT });
  assert.deepEqual(routeOcrRead({ rows: [], refused: "title", title: "DOOR SCHEDULE" }), { kind: "message", text: refusalMessage("title", "DOOR SCHEDULE") });
  assert.deepEqual(routeOcrRead(NO_TABLE), { kind: "message", text: OCR_NO_ROWS_MESSAGE });
});
