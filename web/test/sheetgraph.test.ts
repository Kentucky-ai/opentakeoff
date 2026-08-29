// The sheet graph (lib/sheetgraph.ts, #87) — scored the way the RFC's finish
// line demands: given a multi-sheet set, the room → finish table with a
// source citation per cell, measured cell-level against a held-out key.
// The invariants:
//   - every edge carries evidence (sheet, text, bbox) — asserted per cell;
//   - a plan room with no schedule row is UNRESOLVED WITH A REASON;
//   - ambiguity (reused room numbers) refuses rather than guesses;
//   - a set with no text layer is unavailable, never half-populated;
//   - schedule sheets never mint phantom room tags.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSheetGraph, resolveTag, classifySheetRole, rowKeyAnswersFor, extractTable, roomTags, detailCallouts, revisionOf, type GraphSpan, type SheetSpans, type SheetGraph } from "../src/lib/sheetgraph.ts";

// span builder: 8pt-tall text, width ~5px/char — the shape the MCP server serves
const sp = (str: string, x: number, y: number): GraphSpan => ({ str, x, y, w: str.length * 5, h: 8 });

// ── the synthetic set: a plan sheet + a schedule sheet ──────────────────────
const planSheet: SheetSpans = {
  key: "set.pdf#1",
  sheet_number: "A-101",
  spans: [
    sp("FIRST FLOOR FINISH PLAN", 300, 900),
    // room bubbles: name stacked over number
    sp("OFFICE", 100, 100), sp("101", 104, 112),
    sp("WORKROOM", 300, 100), sp("102", 310, 112),
    sp("CORRIDOR", 500, 100), sp("103", 508, 112),
    sp("STORAGE", 700, 100), sp("104", 706, 112),   // ← on the plan, NOT in the schedule
    sp("3/A-601", 620, 400),                        // detail callout
  ],
};
const schedSheet: SheetSpans = {
  key: "set.pdf#2",
  sheet_number: "A-601",
  spans: [
    sp("ROOM FINISH SCHEDULE", 100, 40),
    sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("WALL", 500, 60), sp("REMARKS", 600, 60),
    sp("101", 100, 80), sp("OFFICE", 160, 80), sp("CPT-1", 300, 80), sp("RB-1", 400, 80), sp("P-1", 500, 80),
    sp("102", 100, 100), sp("WORKROOM", 160, 100), sp("LVT-1", 300, 100), sp("RB-1", 400, 100), sp("P-2", 500, 100),
    sp("103", 100, 120), sp("CORRIDOR", 160, 120), sp("CPT-2", 300, 120), sp("RB-1", 400, 120), sp("P-1", 500, 120),
    // a finish/material schedule lower on the same sheet
    sp("MATERIAL SCHEDULE", 100, 300),
    sp("CODE", 100, 320), sp("MATERIAL", 200, 320), sp("MANUFACTURER", 360, 320), sp("COLOR", 520, 320),
    sp("CPT-1", 100, 340), sp("CARPET TILE", 200, 340), sp("VENDOR-A", 360, 340), sp("NIGHTFALL", 520, 340),
    sp("LVT-1", 100, 360), sp("LUXURY VINYL TILE", 200, 360), sp("VENDOR-B", 360, 360), sp("OAK", 520, 360),
    sp("RB-1", 100, 380), sp("RESILIENT BASE", 200, 380), sp("VENDOR-C", 360, 380), sp("SLATE", 520, 380),
  ],
};

// the held-out key: every (room, surface) → code the set states
const KEY: Record<string, Record<string, string>> = {
  "101": { FLOOR: "CPT-1", BASE: "RB-1", WALL: "P-1" },
  "102": { FLOOR: "LVT-1", BASE: "RB-1", WALL: "P-2" },
  "103": { FLOOR: "CPT-2", BASE: "RB-1", WALL: "P-1" },
};

test("sheet roles classify from what the sheet SAYS, with evidence", () => {
  const plan = classifySheetRole(planSheet);
  assert.equal(plan.role, "plan");
  assert.ok(plan.confidence >= 0.8);
  assert.equal(plan.evidence?.text, "FIRST FLOOR FINISH PLAN");
  // titleless sheet falls back to the number convention — stated as weak
  const bare = classifySheetRole({ key: "x", sheet_number: "A-101", spans: [sp("nothing here", 0, 0)] });
  assert.deepEqual({ r: bare.role, weak: bare.confidence < 0.5 }, { r: "plan", weak: true });
  // every discipline draws plans — a mechanical sheet's ductwork plan title
  // must classify plan, not lose to an incidental LEGEND note
  const mech = classifySheetRole({
    key: "m", sheet_number: "M-121A",
    spans: [sp("SECOND FLOOR DUCTWORK PLAN AREA A", 100, 700), sp("WALL RATING LEGEND:", 620, 640)],
  });
  assert.equal(mech.role, "plan");
  assert.ok(mech.confidence >= 0.8);
  // and the number-convention fallback knows discipline prefixes
  const mBare = classifySheetRole({ key: "y", sheet_number: "M-101", spans: [sp("nothing here", 0, 0)] });
  assert.deepEqual({ r: mBare.role, weak: mBare.confidence < 0.5 }, { r: "plan", weak: true });
});

test("a compound schedule-row key answers for each of its marks", () => {
  assert.equal(rowKeyAnswersFor("R1/E1", "R1"), true);
  assert.equal(rowKeyAnswersFor("R1/E1", "E1"), true);
  assert.equal(rowKeyAnswersFor("R1/E1", "R1/E1"), true);
  assert.equal(rowKeyAnswersFor("R1 / E1", "E1"), true);
  assert.equal(rowKeyAnswersFor("R1/E1", "E2"), false);
  assert.equal(rowKeyAnswersFor("S1", "S1"), true);
  assert.equal(rowKeyAnswersFor("S1", "S"), false);
});

test("table extraction: header anchors, evidence per cell, titles found above", () => {
  const rf = extractTable(schedSheet, "room-finish")!;
  assert.equal(rf.rows.length, 3);
  assert.equal(rf.title?.text, "ROOM FINISH SCHEDULE");
  const r101 = rf.rows.find((r) => r.key === "101")!;
  assert.equal(r101.cells.FLOOR.text, "CPT-1");
  assert.ok(r101.cells.FLOOR.bbox[0] >= 300 && r101.cells.FLOOR.bbox[1] >= 80, "the cell knows where it came from");
  const fin = extractTable(schedSheet, "finish")!;
  assert.equal(fin.rows.length, 3);
  assert.equal(fin.rows.find((r) => r.key === "CPT-1")!.cells.MANUFACTURER.text, "VENDOR-A");
  // a sheet with no such structure yields null, never invented rows
  assert.equal(extractTable(planSheet, "room-finish"), null);
});

test("room tags pair the stacked name; schedule sheets never mint phantom rooms", () => {
  const tags = roomTags(planSheet);
  assert.deepEqual(tags.map((t) => [t.tag, t.name]).sort(), [["101", "OFFICE"], ["102", "WORKROOM"], ["103", "CORRIDOR"], ["104", "STORAGE"]]);
  const g = buildSheetGraph([planSheet, schedSheet]);
  // 104 is drawn on the plan and absent from the schedule. Where a
  // room-finish schedule EXISTS it is the authority on which numbers are
  // rooms (a keynote legend pairs a number with a description exactly the way
  // a bubble pairs one with a name), so 104 is not counted as an answered
  // room — it is surfaced under its own reason instead, never dropped.
  assert.deepEqual(g.rooms.map((r) => r.tag).sort(), ["101", "102", "103"], "the schedule sheet's NO column contributes rows, not room tags");
  assert.ok(g.rooms.every((r) => r.corroboration), "every room says WHY it is believed to be one");
  assert.deepEqual(g.unmatched_tags.map((u) => u.tag), ["104"]);
  assert.equal(g.unmatched_tags[0].name, "STORAGE");
  assert.match(g.unmatched_tags[0].reason, /no room-finish row answers for it/);
  assert.ok(g.notes.some((n) => /NOT counted as rooms/.test(n)), "the demotion is named in notes");
});

test("detail callouts parse and point at their sheet", () => {
  assert.deepEqual(detailCallouts(planSheet).map((c) => [c.detail, c.target_sheet]), [["3", "A-601"]]);
});

test("SCORED: room → finish → citation, cell-level precision/recall against the held-out key", () => {
  const g = buildSheetGraph([planSheet, schedSheet]);
  assert.equal(g.available, true);
  let tp = 0, fp = 0;
  const expected = Object.values(KEY).reduce((n, v) => n + Object.keys(v).length, 0);
  for (const tag of Object.keys(KEY)) {
    const res = resolveTag(g, tag);
    assert.equal(res.status, "resolved", tag);
    if (res.status !== "resolved") continue;
    for (const f of res.finishes) {
      assert.ok(f.source.sheet && f.source.bbox, `every cell carries a citation: ${tag}/${f.surface}`);
      if (KEY[tag][f.surface] === f.code) tp++; else fp++;
    }
    // resolution chains to the finish definition where one exists
    const floor = res.finishes.find((f) => f.surface === "FLOOR")!;
    if (tag === "101") assert.equal(floor.definition?.cells.MANUFACTURER, "VENDOR-A");
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / expected;
  console.log(`  sheetgraph cell-level: precision ${precision.toFixed(3)} recall ${recall.toFixed(3)} (${tp}/${expected})`);
  assert.ok(precision >= 0.99, `precision ${precision}`);
  assert.ok(recall >= 0.99, `recall ${recall}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2 (#87): continuation sheets, rotated headers, multi-building keys.
// Same doctrine, three new ways a real set breaks the naive reading:
//   - a schedule that CONTINUES across sheets is ONE table — rows resolve
//     regardless of which sheet carries them, and each row cites its own sheet;
//   - column headers written at 90° still anchor the table;
//   - a room number reused across buildings is ambiguous UNTIL the tag is
//     qualified — the refusal lists the candidates, never the first match.
// ═════════════════════════════════════════════════════════════════════════════

// a vertical (quarter-turn) span: narrow box, text runs downward in y
const vsp = (str: string, x: number, y: number): GraphSpan => ({ str, x, y, w: 8, h: str.length * 5, rot: 90 });

// ── continuation set: plan + schedule + "— CONT'D" schedule (header repeated) ─
const contPlan: SheetSpans = {
  key: "cont.pdf#1",
  sheet_number: "A-102",
  spans: [
    sp("SECOND FLOOR FINISH PLAN", 300, 900),
    sp("OFFICE", 100, 100), sp("201", 104, 112),
    sp("CONFERENCE", 300, 100), sp("202", 310, 112),
    sp("BREAK RM", 500, 100), sp("203", 508, 112),
    sp("COPY RM", 700, 100), sp("204", 706, 112),
    sp("STORAGE", 100, 300), sp("205", 104, 312),
  ],
};
const contSchedBase: SheetSpans = {
  key: "cont.pdf#2",
  sheet_number: "A-601",
  spans: [
    sp("ROOM FINISH SCHEDULE", 100, 40),
    sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("WALL", 500, 60),
    sp("201", 100, 80), sp("OFFICE", 160, 80), sp("CPT-5", 300, 80), sp("RB-5", 400, 80), sp("P-5", 500, 80),
    sp("202", 100, 100), sp("CONFERENCE", 160, 100), sp("CPT-5", 300, 100), sp("RB-5", 400, 100), sp("P-5", 500, 100),
    sp("203", 100, 120), sp("BREAK RM", 160, 120), sp("LVT-5", 300, 120), sp("RB-5", 400, 120), sp("P-6", 500, 120),
  ],
};
const contSchedContd: SheetSpans = {
  key: "cont.pdf#3",
  sheet_number: "A-602",
  spans: [
    sp("ROOM FINISH SCHEDULE - CONT'D", 100, 40),
    sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("WALL", 500, 60),
    sp("204", 100, 80), sp("COPY RM", 160, 80), sp("LVT-5", 300, 80), sp("RB-5", 400, 80), sp("P-5", 500, 80),
    sp("205", 100, 100), sp("STORAGE", 160, 100), sp("VCT-5", 300, 100), sp("RB-5", 400, 100), sp("P-6", 500, 100),
  ],
};
// header NOT repeated: the title alone, rows aligned to the base's columns
const contSchedHeaderless: SheetSpans = {
  key: "cont.pdf#3",
  sheet_number: "A-602",
  spans: [
    sp("ROOM FINISH SCHEDULE (CONT'D)", 100, 40),
    sp("204", 100, 80), sp("COPY RM", 160, 80), sp("LVT-5", 300, 80), sp("RB-5", 400, 80), sp("P-5", 500, 80),
    sp("205", 100, 100), sp("STORAGE", 160, 100), sp("VCT-5", 300, 100), sp("RB-5", 400, 100), sp("P-6", 500, 100),
  ],
};
// header NOT repeated AND columns shifted — adoption must refuse, not guess
const contSchedMisaligned: SheetSpans = {
  key: "cont.pdf#3",
  sheet_number: "A-602",
  spans: [
    sp("ROOM FINISH SCHEDULE (CONT'D)", 100, 40),
    sp("204", 560, 80), sp("COPY RM", 620, 80), sp("LVT-5", 760, 80),
  ],
};

const CONT_KEY: Record<string, Record<string, string>> = {
  "201": { FLOOR: "CPT-5", BASE: "RB-5", WALL: "P-5" },
  "202": { FLOOR: "CPT-5", BASE: "RB-5", WALL: "P-5" },
  "203": { FLOOR: "LVT-5", BASE: "RB-5", WALL: "P-6" },
  "204": { FLOOR: "LVT-5", BASE: "RB-5", WALL: "P-5" },
  "205": { FLOOR: "VCT-5", BASE: "RB-5", WALL: "P-6" },
};

test("continuation sheets: '— CONT'D' fragments merge into ONE logical table, rows citing their own sheet", () => {
  const g = buildSheetGraph([contPlan, contSchedBase, contSchedContd]);
  const roomFinish = g.tables.filter((t) => t.kind === "room-finish");
  assert.equal(roomFinish.length, 1, "one LOGICAL table, not two schedules");
  const tab = roomFinish[0];
  assert.equal(tab.rows.length, 5);
  assert.deepEqual(tab.parts?.map((p) => [p.sheet, p.rows]), [["cont.pdf#2", 3], ["cont.pdf#3", 2]]);
  // per-sheet view: the continuation sheet's fragment names its base
  const contSheet = g.sheets.find((s) => s.key === "cont.pdf#3")!;
  assert.equal(contSheet.schedules[0].continues, "cont.pdf#2");
  assert.equal(g.sheets.find((s) => s.key === "cont.pdf#2")!.schedules[0].continues, undefined);
  // a row carried by the continuation resolves — and cites the CONTINUATION sheet
  const res = resolveTag(g, "205");
  assert.equal(res.status, "resolved");
  if (res.status !== "resolved") return;
  assert.equal(res.finishes.find((f) => f.surface === "FLOOR")!.code, "VCT-5");
  assert.ok(res.finishes.every((f) => f.source.sheet === "cont.pdf#3"), "evidence points at the ink, not the base sheet");
  assert.ok(res.sources.some((s) => s.sheet === "cont.pdf#3"));
  // a base-sheet row still resolves against the base
  const base = resolveTag(g, "202");
  assert.equal(base.status, "resolved");
  if (base.status === "resolved") assert.ok(base.finishes.every((f) => f.source.sheet === "cont.pdf#2"));
});

test("continuation sheets: a title-only continuation adopts the base's columns — gated on alignment", () => {
  // aligned columns: rows adopt, the table reads as one
  const g = buildSheetGraph([contPlan, contSchedBase, contSchedHeaderless]);
  const tab = g.tables.find((t) => t.kind === "room-finish")!;
  assert.equal(tab.rows.length, 5, "title-only continuation rows are indexed");
  const res = resolveTag(g, "204");
  assert.equal(res.status, "resolved");
  if (res.status === "resolved") {
    assert.equal(res.finishes.find((f) => f.surface === "FLOOR")!.code, "LVT-5");
    assert.equal(res.finishes[0].source.sheet, "cont.pdf#3");
  }
  // misaligned columns: refusal, and the gap is NAMED — never silently dropped
  const g2 = buildSheetGraph([contPlan, contSchedBase, contSchedMisaligned]);
  assert.equal(g2.tables.find((t) => t.kind === "room-finish")!.rows.length, 3);
  assert.ok(g2.notes.some((n) => /cont\.pdf#3/.test(n) && /NOT indexed/.test(n)), `the gap is named: ${g2.notes.join(" | ")}`);
  const miss = resolveTag(g2, "204");
  assert.equal(miss.status, "unresolved");
  assert.match((miss as { reason: string }).reason, /no schedule row for 204/);
});

// ── rotated headers: column labels at a quarter-turn ────────────────────────
const rotPlan: SheetSpans = {
  key: "rot.pdf#1",
  sheet_number: "A-103",
  spans: [
    sp("THIRD FLOOR FINISH PLAN", 300, 900),
    sp("CONF RM", 100, 100), sp("301", 104, 112),
    sp("TRAINING", 300, 100), sp("302", 308, 112),
  ],
};
const rotSched: SheetSpans = {
  key: "rot.pdf#2",
  sheet_number: "A-603",
  spans: [
    sp("ROOM FINISH SCHEDULE", 100, 20),
    // the header band: vertical spans — "FLOOR" deliberately carries NO rot
    // (h ≫ w decides), the rest are explicit quarter-turns
    vsp("NO", 100, 40), vsp("NAME", 160, 40),
    { str: "FLOOR", x: 300, y: 40, w: 8, h: 25 },
    vsp("BASE", 400, 40), vsp("WALL", 500, 40),
    sp("301", 100, 80), sp("CONF RM", 160, 80), sp("CPT-9", 300, 80), sp("RB-9", 400, 80), sp("P-9", 500, 80),
    sp("302", 100, 100), sp("TRAINING", 160, 100), sp("LVT-9", 300, 100), sp("RB-9", 400, 100), sp("P-9", 500, 100),
    // a material schedule below, horizontal headers — same sheet, both found
    sp("MATERIAL SCHEDULE", 100, 300),
    sp("CODE", 100, 320), sp("MATERIAL", 200, 320), sp("MANUFACTURER", 360, 320),
    sp("CPT-9", 100, 340), sp("CARPET TILE", 200, 340), sp("EXAMPLECO", 360, 340),
  ],
};

const ROT_KEY: Record<string, Record<string, string>> = {
  "301": { FLOOR: "CPT-9", BASE: "RB-9", WALL: "P-9" },
  "302": { FLOOR: "LVT-9", BASE: "RB-9", WALL: "P-9" },
};

test("rotated headers: a quarter-turn header band still anchors the table", () => {
  const tab = extractTable(rotSched, "room-finish")!;
  assert.ok(tab, "the rotated header band is found");
  assert.equal(tab.rotated_headers, true);
  assert.equal(tab.title?.text, "ROOM FINISH SCHEDULE");
  assert.deepEqual(tab.headers, ["NO", "NAME", "FLOOR", "BASE", "WALL"]);
  assert.equal(tab.rows.length, 2);
  assert.equal(tab.rows[0].cells.FLOOR.text, "CPT-9");
  // full graph: resolution chains through the rotated table to the definition
  const g = buildSheetGraph([rotPlan, rotSched]);
  const sched = g.sheets.find((s) => s.key === "rot.pdf#2")!;
  assert.equal(sched.schedules.find((x) => x.kind === "room-finish")!.rotated_headers, true);
  assert.equal(sched.schedules.find((x) => x.kind === "finish")!.rotated_headers, undefined, "the horizontal table is not mislabeled rotated");
  const res = resolveTag(g, "301");
  assert.equal(res.status, "resolved");
  if (res.status === "resolved") {
    assert.equal(res.finishes.find((f) => f.surface === "FLOOR")!.definition?.cells.MANUFACTURER, "EXAMPLECO");
  }
});

// ── multi-building keys: room 134 in Building A ≠ 134 in Building B ─────────
const bldgPlanA: SheetSpans = {
  key: "mb.pdf#1",
  sheet_number: "A-101",
  spans: [
    sp("BUILDING A - FIRST FLOOR FINISH PLAN", 300, 900),
    sp("OFFICE", 100, 100), sp("134", 104, 112),
    sp("LAB", 300, 100), sp("135", 302, 112),
  ],
};
const bldgPlanB: SheetSpans = {
  key: "mb.pdf#2",
  sheet_number: "A-201",
  spans: [
    sp("BUILDING B - FIRST FLOOR FINISH PLAN", 300, 900),
    sp("STORAGE", 100, 100), sp("134", 104, 112),
    sp("OFFICE", 300, 100), sp("201", 304, 112),
  ],
};
const bldgSchedA: SheetSpans = {
  key: "mb.pdf#3",
  sheet_number: "A-601",
  spans: [
    sp("ROOM FINISH SCHEDULE - BUILDING A", 100, 40),
    sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("WALL", 500, 60),
    sp("134", 100, 80), sp("OFFICE", 160, 80), sp("CPT-1", 300, 80), sp("RB-1", 400, 80), sp("P-1", 500, 80),
    sp("135", 100, 100), sp("LAB", 160, 100), sp("LVT-1", 300, 100), sp("RB-1", 400, 100), sp("P-1", 500, 100),
  ],
};
const bldgSchedB: SheetSpans = {
  key: "mb.pdf#4",
  sheet_number: "A-602",
  spans: [
    sp("ROOM FINISH SCHEDULE - BUILDING B", 100, 40),
    sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("WALL", 500, 60),
    sp("134", 100, 80), sp("STORAGE", 160, 80), sp("VCT-2", 300, 80), sp("RB-2", 400, 80), sp("P-2", 500, 80),
    sp("201", 100, 100), sp("OFFICE", 160, 100), sp("CPT-2", 300, 100), sp("RB-2", 400, 100), sp("P-2", 500, 100),
  ],
};

const MB_KEY: Record<string, Record<string, string>> = {
  "A-134": { FLOOR: "CPT-1", BASE: "RB-1", WALL: "P-1" },
  "A-135": { FLOOR: "LVT-1", BASE: "RB-1", WALL: "P-1" },
  "B-134": { FLOOR: "VCT-2", BASE: "RB-2", WALL: "P-2" },
  "B-201": { FLOOR: "CPT-2", BASE: "RB-2", WALL: "P-2" },
};

test("multi-building: an unqualified reused number REFUSES and lists the candidates — never first-match", () => {
  const g = buildSheetGraph([bldgPlanA, bldgPlanB, bldgSchedA, bldgSchedB]);
  assert.deepEqual(g.buildings, ["A", "B"]);
  assert.equal(g.sheets.find((s) => s.key === "mb.pdf#1")!.building, "A");
  assert.equal(g.rooms.find((r) => r.tag === "134" && r.sheet === "mb.pdf#2")!.building, "B");

  const dup = resolveTag(g, "134");
  assert.equal(dup.status, "unresolved");
  if (dup.status !== "unresolved") return;
  assert.match(dup.reason, /ambiguous: room 134 appears in 2 buildings/);
  assert.match(dup.reason, /qualify the tag/);
  assert.equal(dup.room, null, "citing one building's plan tag would be quietly wrong");
  assert.deepEqual(dup.candidates?.map((c) => [c.building, c.sheet]).sort(), [["A", "mb.pdf#3"], ["B", "mb.pdf#4"]]);
});

test("multi-building: qualified tags resolve honestly; unknown buildings refuse by name", () => {
  const g = buildSheetGraph([bldgPlanA, bldgPlanB, bldgSchedA, bldgSchedB]);
  const a = resolveTag(g, "A-134");
  assert.equal(a.status, "resolved");
  if (a.status === "resolved") {
    assert.equal(a.building, "A");
    assert.equal(a.finishes.find((f) => f.surface === "FLOOR")!.code, "CPT-1");
    assert.equal(a.room?.name, "OFFICE", "the room cited is BUILDING A's 134, not B's");
    assert.equal(a.room?.sheet, "mb.pdf#1");
  }
  const b = resolveTag(g, "B-134");
  assert.equal(b.status, "resolved");
  if (b.status === "resolved") assert.equal(b.finishes.find((f) => f.surface === "FLOOR")!.code, "VCT-2");
  // unqualified but unique across the set: resolves, and names its building
  const unique = resolveTag(g, "201");
  assert.equal(unique.status, "resolved");
  if (unique.status === "resolved") assert.equal(unique.building, "B");
  // a building the set never names refuses by name — with the candidates
  const c = resolveTag(g, "C-134");
  assert.equal(c.status, "unresolved");
  if (c.status === "unresolved") {
    assert.match(c.reason, /names no building "C"/);
    assert.equal(c.candidates?.length, 2);
  }
});

test("multi-building: qualified ROW keys ('A-134') carry their building; sheet numbers never mint rooms", () => {
  const qPlanA: SheetSpans = {
    key: "q.pdf#1",
    sheet_number: "A-101",
    spans: [
      sp("BUILDING A - FIRST FLOOR FINISH PLAN", 300, 900),
      sp("OFFICE", 100, 100), sp("A-134", 100, 112),
      sp("A-601", 600, 50), // a sheet-number reference — NOT a room
    ],
  };
  const qPlanB: SheetSpans = {
    key: "q.pdf#2",
    sheet_number: "A-201",
    spans: [
      sp("BUILDING B - FIRST FLOOR FINISH PLAN", 300, 900),
      sp("STORAGE", 100, 100), sp("B-134", 100, 112),
    ],
  };
  const qSched: SheetSpans = {
    key: "q.pdf#3",
    sheet_number: "A-601",
    spans: [
      sp("ROOM FINISH SCHEDULE", 100, 40),
      sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("WALL", 500, 60),
      sp("A-134", 100, 80), sp("OFFICE", 160, 80), sp("CPT-1", 300, 80), sp("RB-1", 400, 80), sp("P-1", 500, 80),
      sp("B-134", 100, 100), sp("STORAGE", 160, 100), sp("VCT-2", 300, 100), sp("RB-2", 400, 100), sp("P-2", 500, 100),
    ],
  };
  const g = buildSheetGraph([qPlanA, qPlanB, qSched]);
  assert.deepEqual(g.rooms.map((r) => [r.tag, r.building]).sort(), [["A-134", "A"], ["B-134", "B"]]);
  assert.ok(!g.rooms.some((r) => r.tag === "A-601"), "the title-block sheet number never mints a room");
  const a = resolveTag(g, "A-134");
  assert.equal(a.status, "resolved");
  if (a.status === "resolved") {
    assert.equal(a.finishes.find((f) => f.surface === "FLOOR")!.code, "CPT-1");
    assert.equal(a.room?.name, "OFFICE");
  }
  const dup = resolveTag(g, "134");
  assert.equal(dup.status, "unresolved");
  if (dup.status === "unresolved") assert.match(dup.reason, /ambiguous: room 134 appears in 2 buildings/);
});

// ── phase-2 SCORED: the three lanes together, cell-level P/R pinned ─────────
test("SCORED phase 2: continuation + rotated + multi-building, precision/recall against the held-out keys", () => {
  const graphs: Array<[SheetGraph, Record<string, Record<string, string>>]> = [
    [buildSheetGraph([contPlan, contSchedBase, contSchedContd]), CONT_KEY],
    [buildSheetGraph([rotPlan, rotSched]), ROT_KEY],
    [buildSheetGraph([bldgPlanA, bldgPlanB, bldgSchedA, bldgSchedB]), MB_KEY],
  ];
  let tp = 0, fp = 0, expected = 0;
  for (const [g, key] of graphs) {
    expected += Object.values(key).reduce((n, v) => n + Object.keys(v).length, 0);
    for (const tag of Object.keys(key)) {
      const res = resolveTag(g, tag);
      assert.equal(res.status, "resolved", tag);
      if (res.status !== "resolved") continue;
      for (const f of res.finishes) {
        assert.ok(f.source.sheet && f.source.bbox, `every cell carries a citation: ${tag}/${f.surface}`);
        if (key[tag][f.surface] === f.code) tp++; else fp++;
      }
    }
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / expected;
  console.log(`  sheetgraph phase-2 cell-level: precision ${precision.toFixed(3)} recall ${recall.toFixed(3)} (${tp}/${expected})`);
  assert.ok(precision >= 0.99, `precision ${precision}`);
  assert.ok(recall >= 0.99, `recall ${recall}`);
});

test("the failure modes REFUSE with reasons — never silent omission", () => {
  const g = buildSheetGraph([planSheet, schedSheet]);
  // on the plan, not in the schedule — THE lost-bid case
  const missing = resolveTag(g, "104");
  assert.equal(missing.status, "unresolved");
  assert.match((missing as { reason: string }).reason, /no schedule row for 104/);
  assert.equal(missing.room?.name, "STORAGE", "the plan bubble is STILL cited even though 104 is uncorroborated — that ink is the evidence the schedule may have missed a room");
  assert.equal(missing.room?.sheet, "set.pdf#1");
  // reused room numbers across buildings — ambiguity refuses
  const dupSheet: SheetSpans = { ...schedSheet, key: "set.pdf#3", spans: schedSheet.spans.map((s) => ({ ...s })) };
  const g2 = buildSheetGraph([planSheet, schedSheet, dupSheet]);
  const dup = resolveTag(g2, "101");
  assert.equal(dup.status, "unresolved");
  assert.match((dup as { reason: string }).reason, /ambiguous: 2 schedule rows/);
  // no room-finish table at all
  const g3 = buildSheetGraph([planSheet]);
  assert.match((resolveTag(g3, "101") as { reason: string }).reason, /no room-finish schedule found/);
  // a scanned set (no text layer) is unavailable, cleanly
  const scanned = buildSheetGraph([{ key: "scan.pdf#1", spans: [] }]);
  assert.equal(scanned.available, false);
  assert.deepEqual(scanned.rooms, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// Phase 3 (#87): revision markers, and banding precision on very wide REMARKS
// gaps. Same doctrine, two more ways a real set produces a confident wrong
// number:
//   - a delta triangle beside a schedule row is drafting's flag that the ink
//     CHANGED — reading the row without surfacing the delta prices a revision
//     silently, and a delta left of the key column used to strip to its digit
//     and MINT a room;
//   - a wide REMARKS column wraps and baseline-shifts its text — the fragment
//     rows used to drop silently, and a left-aligned remark could band into
//     the WALL column on a left-x tie.
// ═════════════════════════════════════════════════════════════════════════════

// a small-font span (a remark cell's 6pt text): the baseline-offset shape
const rsp = (str: string, x: number, y: number): GraphSpan => ({ str, x, y, w: str.length * 5, h: 6 });

test("revisionOf: whole-span markers only — a bare number or running text never matches", () => {
  assert.equal(revisionOf("Δ2"), "2");
  assert.equal(revisionOf("∆ 3"), "3");
  assert.equal(revisionOf("2▲"), "2");
  assert.equal(revisionOf("REV 2"), "2");
  assert.equal(revisionOf("REVISION 12"), "12");
  assert.equal(revisionOf("rev. #4"), "4");
  assert.equal(revisionOf("2"), null, "a bare number is never a marker");
  assert.equal(revisionOf("102"), null);
  assert.equal(revisionOf("SEE REV 2 NOTES"), null, "running text never matches");
  assert.equal(revisionOf("REVISED PER ADDENDUM"), null);
});

// ── revision fixture: a delta on a schedule row, a delta on a plan bubble ───
const revPlan: SheetSpans = {
  key: "rev.pdf#1",
  sheet_number: "A-104",
  spans: [
    sp("FOURTH FLOOR FINISH PLAN", 300, 900),
    sp("OFFICE", 100, 100), sp("401", 104, 112),
    sp("LAB", 300, 100), sp("402", 310, 112), sp("Δ2", 330, 108), // delta ON the bubble
    sp("STOR", 500, 100), sp("403", 508, 112),
  ],
};
const revSched: SheetSpans = {
  key: "rev.pdf#2",
  sheet_number: "A-604",
  spans: [
    sp("ROOM FINISH SCHEDULE", 100, 40),
    sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("WALL", 500, 60),
    sp("401", 100, 80), sp("OFFICE", 160, 80), sp("CPT-4", 300, 80), sp("RB-4", 400, 80), sp("P-4", 500, 80),
    // the delta sits LEFT of the key column, in the margin — the classic spot
    sp("Δ2", 70, 100),
    sp("402", 100, 100), sp("LAB", 160, 100), sp("EPX-1", 300, 100), sp("RB-4", 400, 100), sp("P-4", 500, 100),
    sp("REV 3", 62, 120),
    sp("403", 100, 120), sp("STOR", 160, 120), sp("VCT-4", 300, 120), sp("RB-4", 400, 120), sp("P-4", 500, 120),
  ],
};
const REV_KEY: Record<string, Record<string, string>> = {
  "401": { FLOOR: "CPT-4", BASE: "RB-4", WALL: "P-4" },
  "402": { FLOOR: "EPX-1", BASE: "RB-4", WALL: "P-4" },
  "403": { FLOOR: "VCT-4", BASE: "RB-4", WALL: "P-4" },
};

test("revision markers: a delta never mints a room key, and never corrupts a cell", () => {
  const tab = extractTable(revSched, "room-finish")!;
  assert.ok(!tab.rows.some((r) => r.key === "2"), "'Δ2' left of the key column must not strip to row key '2'");
  assert.ok(!tab.rows.some((r) => r.key === "3"), "'REV 3' must not mint a row either");
  assert.deepEqual(tab.rows.map((r) => r.key), ["401", "402", "403"]);
  const r402 = tab.rows.find((r) => r.key === "402")!;
  assert.equal(r402.cells.NO.text, "402", "the marker stayed out of the key cell");
  assert.equal(r402.cells.FLOOR.text, "EPX-1");
  // the marker attached as the row's revision, with evidence at the ink
  assert.equal(r402.revision?.rev, "2");
  assert.equal(r402.revision?.source.text, "Δ2");
  assert.ok(r402.revision!.source.bbox[0] < 100, "the evidence bbox points at the margin delta");
  assert.equal(tab.rows.find((r) => r.key === "403")!.revision?.rev, "3", "REV-style tags attach too");
  assert.equal(tab.rows.find((r) => r.key === "401")!.revision, undefined, "unrevised rows carry nothing");
});

test("revision markers: they ride the graph, the plan bubble, and every resolution", () => {
  const g = buildSheetGraph([revPlan, revSched]);
  assert.equal(g.revisions.length, 3, "every marker the set carries is listed");
  assert.deepEqual([...new Set(g.revisions.map((r) => r.rev))].sort(), ["2", "3"]);
  // the plan bubble's delta attaches to room 402, not its neighbours
  assert.equal(g.rooms.find((r) => r.tag === "402")!.revision?.rev, "2");
  assert.equal(g.rooms.find((r) => r.tag === "401")!.revision, undefined);
  assert.equal(g.rooms.find((r) => r.tag === "403")!.revision, undefined);
  // resolution surfaces the delta — the codes are the POST-revision answer,
  // and the consumer is told the ink changed (row + bubble dedupe to one)
  const res = resolveTag(g, "402");
  assert.equal(res.status, "resolved");
  if (res.status === "resolved") {
    assert.equal(res.finishes.find((f) => f.surface === "FLOOR")!.code, "EPX-1");
    assert.equal(res.revisions?.length, 1);
    assert.equal(res.revisions![0].rev, "2");
    assert.ok(res.revisions![0].source.sheet, "the revision carries evidence like every other edge");
  }
  const clean = resolveTag(g, "401");
  assert.equal(clean.status, "resolved");
  if (clean.status === "resolved") assert.equal(clean.revisions, undefined, "no marker, no revisions field");
});

// ── wide-REMARKS fixture: wrapped + baseline-offset remark, wide column gap ─
const widePlan: SheetSpans = {
  key: "wide.pdf#1",
  sheet_number: "A-105",
  spans: [
    sp("FIFTH FLOOR FINISH PLAN", 300, 900),
    sp("OFFICE", 100, 100), sp("501", 104, 112),
    sp("LAB", 300, 100), sp("502", 310, 112),
    sp("STOR", 500, 100), sp("503", 508, 112),
  ],
};
const wideSched: SheetSpans = {
  key: "wide.pdf#2",
  sheet_number: "A-605",
  spans: [
    sp("ROOM FINISH SCHEDULE", 100, 40),
    // REMARKS sits far right — a very wide column, header centered over it
    sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("WALL", 500, 60), sp("REMARKS", 900, 60),
    sp("501", 100, 80), sp("OFFICE", 160, 80), sp("CPT-8", 300, 80), sp("RB-8", 400, 80), sp("P-8", 500, 80),
    // the remark: smaller font, baseline-offset, left-aligned at the wide
    // column's far-left edge — and WRAPPED onto a second line
    rsp("SEE FINISH PLAN FOR", 700, 84),
    rsp("EXTENT OF CPT-8", 700, 94),
    sp("502", 100, 110), sp("LAB", 160, 110), sp("EPX-2", 300, 110), sp("RB-8", 400, 110), sp("P-8", 500, 110),
    sp("503", 100, 140), sp("STOR", 160, 140), sp("VCT-8", 300, 140), sp("RB-8", 400, 140), sp("P-8", 500, 140), sp("ATTIC STOCK", 905, 140),
    // a notes block BELOW the table — near-ish, but beyond the repair radius
    sp("GENERAL NOTES:", 100, 200),
    sp("ALL FINISHES PER SPEC SECTION 09", 100, 212),
  ],
};
const WIDE_KEY: Record<string, Record<string, string>> = {
  "501": { FLOOR: "CPT-8", BASE: "RB-8", WALL: "P-8" },
  "502": { FLOOR: "EPX-2", BASE: "RB-8", WALL: "P-8" },
  "503": { FLOOR: "VCT-8", BASE: "RB-8", WALL: "P-8" },
};

test("wide REMARKS: wrapped and baseline-offset remark lines merge into their row — in order, cited", () => {
  const tab = extractTable(wideSched, "room-finish")!;
  assert.deepEqual(tab.rows.map((r) => r.key), ["501", "502", "503"], "notes below the table mint nothing");
  const r501 = tab.rows.find((r) => r.key === "501")!;
  // the left-aligned wide-column remark bands to REMARKS, not WALL — and the
  // wrapped second line rides along in reading order
  assert.equal(r501.cells.REMARKS?.text, "SEE FINISH PLAN FOR EXTENT OF CPT-8");
  assert.equal(r501.cells.WALL.text, "P-8", "the wall finish is not polluted by the remark");
  assert.ok(r501.cells.REMARKS!.bbox[3] >= 94, "the cell's evidence bbox spans both lines");
  assert.equal(tab.rows.find((r) => r.key === "503")!.cells.REMARKS?.text, "ATTIC STOCK");
  assert.equal(tab.rows.find((r) => r.key === "502")!.cells.REMARKS, undefined, "no remark, no invented cell");
  // the notes block stayed OUT — beyond the repair radius
  for (const r of tab.rows) for (const c of Object.values(r.cells)) assert.ok(!/GENERAL NOTES|PER SPEC/.test(c.text), `notes leaked into ${r.key}`);
});

// ── phase-3 SCORED: both lanes, cell-level P/R pinned like every phase ──────
test("SCORED phase 3: revisions + wide REMARKS, precision/recall against the held-out keys", () => {
  const graphs: Array<[SheetGraph, Record<string, Record<string, string>>]> = [
    [buildSheetGraph([revPlan, revSched]), REV_KEY],
    [buildSheetGraph([widePlan, wideSched]), WIDE_KEY],
  ];
  let tp = 0, fp = 0, expected = 0;
  for (const [g, key] of graphs) {
    expected += Object.values(key).reduce((n, v) => n + Object.keys(v).length, 0);
    for (const tag of Object.keys(key)) {
      const res = resolveTag(g, tag);
      assert.equal(res.status, "resolved", tag);
      if (res.status !== "resolved") continue;
      for (const f of res.finishes) {
        assert.ok(f.source.sheet && f.source.bbox, `every cell carries a citation: ${tag}/${f.surface}`);
        if (key[tag][f.surface] === f.code) tp++; else fp++;
      }
    }
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / expected;
  console.log(`  sheetgraph phase-3 cell-level: precision ${precision.toFixed(3)} recall ${recall.toFixed(3)} (${tp}/${expected})`);
  assert.ok(precision >= 0.99, `precision ${precision}`);
  assert.ok(recall >= 0.99, `recall ${recall}`);
});

// ── drawn deltas: geometry proves what the text layer can't say ─────────────
// Real CAD sets rarely emit "Δ2" as text — the convention is a DRAWN triangle
// with a bare digit inside, and the text layer carries just "2" (which the
// text pass rightly refuses: a bare number can't be a marker). The geometric
// lane accepts exactly that shape, and nothing else.
import { drawnDeltaMarkers } from "../src/lib/sheetgraph.ts";

const tri = (a: [number, number], b: [number, number], c: [number, number]): number[] =>
  [a[0], a[1], b[0], b[1], b[0], b[1], c[0], c[1], c[0], c[1], a[0], a[1]];

test("drawn deltas: a bare digit inside a digit-scale triangle — circles, roofs, and open shapes are not", () => {
  const digit = sp("2", 100, 100); // bbox [100,100,105,108], center (102.5, 104)
  // a closed digit-scale triangle around the digit → marker
  const hit = drawnDeltaMarkers([digit], tri([90, 96], [115, 96], [102, 122]));
  assert.equal(hit.length, 1);
  assert.equal(hit[0].span, digit);
  assert.ok(hit[0].tri[0] <= 90 && hit[0].tri[3] >= 122, "the triangle bbox is reported");
  // an OPEN shape (third side missing) is not a marker
  assert.equal(drawnDeltaMarkers([digit], tri([90, 96], [115, 96], [102, 122]).slice(0, 8)).length, 0);
  // a roof-scale triangle around the digit is not a marker (side ≫ digit scale)
  assert.equal(drawnDeltaMarkers([digit], tri([0, 0], [300, 0], [150, 260])).length, 0);
  // a circle (many short chords) is not a marker — grid bubbles stay out
  const circle: number[] = [];
  for (let i = 0; i < 12; i++) {
    const a0 = (i / 12) * 2 * Math.PI, a1 = ((i + 1) / 12) * 2 * Math.PI;
    circle.push(102.5 + 12 * Math.cos(a0), 104 + 12 * Math.sin(a0), 102.5 + 12 * Math.cos(a1), 104 + 12 * Math.sin(a1));
  }
  assert.equal(drawnDeltaMarkers([digit], circle).length, 0);
  // a triangle beside (not around) the digit is not this digit's marker
  assert.equal(drawnDeltaMarkers([digit], tri([140, 96], [165, 96], [152, 122])).length, 0);
  // three or more digits are never delta digits
  assert.equal(drawnDeltaMarkers([sp("102", 100, 100)], tri([90, 96], [125, 96], [107, 126])).length, 0);
});

test("drawn deltas ride the graph: attach to the row and the bubble, mint nothing, and say drawn", () => {
  const dPlan: SheetSpans = {
    key: "dd.pdf#1",
    sheet_number: "A-106",
    spans: [
      sp("SIXTH FLOOR FINISH PLAN", 300, 900),
      sp("OFFICE", 100, 100), sp("601", 104, 112),
      sp("LAB", 300, 100), sp("602", 310, 112), sp("1", 332, 110),
    ],
    segs: tri([326, 104], [346, 104], [336, 124]),
  };
  const dSched: SheetSpans = {
    key: "dd.pdf#2",
    sheet_number: "A-606",
    spans: [
      sp("ROOM FINISH SCHEDULE", 100, 40),
      sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("WALL", 500, 60),
      sp("601", 100, 80), sp("OFFICE", 160, 80), sp("CPT-6", 300, 80), sp("RB-6", 400, 80), sp("P-6", 500, 80),
      sp("1", 66, 100),
      sp("602", 100, 100), sp("LAB", 160, 100), sp("EPX-6", 300, 100), sp("RB-6", 400, 100), sp("P-6", 500, 100),
    ],
    segs: tri([60, 94], [80, 94], [70, 114]),
  };
  const g = buildSheetGraph([dPlan, dSched]);
  // the graph lists both drawn markers, flagged, bbox spanning the triangle
  assert.equal(g.revisions.length, 2);
  assert.ok(g.revisions.every((r) => r.drawn === true && r.rev === "1"));
  // the bare digit minted neither a room nor a schedule row
  assert.ok(!g.rooms.some((r) => r.tag === "1"), "the delta digit is not a room");
  const tab = g.tables.find((t) => t.kind === "room-finish")!;
  assert.deepEqual(tab.rows.map((r) => r.key), ["601", "602"]);
  // attachment: the schedule row and the plan bubble, both flagged drawn
  assert.equal(tab.rows.find((r) => r.key === "602")!.revision?.drawn, true);
  assert.equal(g.rooms.find((r) => r.tag === "602")!.revision?.drawn, true);
  assert.equal(g.rooms.find((r) => r.tag === "601")!.revision, undefined);
  // resolution surfaces it once (row + bubble dedupe by rev), evidence literal
  const res = resolveTag(g, "602");
  assert.equal(res.status, "resolved");
  if (res.status === "resolved") {
    assert.equal(res.finishes.find((f) => f.surface === "FLOOR")!.code, "EPX-6");
    assert.equal(res.revisions?.length, 1);
    assert.equal(res.revisions![0].drawn, true);
    assert.equal(res.revisions![0].source.text, "1", "evidence text is the literal ink");
    assert.ok(res.revisions![0].source.bbox[2] - res.revisions![0].source.bbox[0] >= 20, "evidence bbox spans the triangle");
  }
});

// ── side-by-side tables: field-found on a real gym set ──────────────────────
// A ROOM SCHEDULE whose LAST column is a code column (CEILING), with the
// finish legend sitting a few hundred px to its right, sharing the y band.
// The generous right band edge — correct for a wide REMARKS column — swallowed
// the legend: every CEILING cell grew legend ink ("SC-1 TL-3 CERAMIC TILE").
// The edge is wide ONLY when the last column is prose-shaped.
const sideSched: SheetSpans = {
  key: "side.pdf#1",
  sheet_number: "A-607",
  spans: [
    sp("ROOM SCHEDULE", 100, 40),
    sp("NO", 100, 60), sp("NAME", 160, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("CEILING", 500, 60),
    sp("701", 100, 80), sp("GYM", 160, 80), sp("RF-1", 300, 80), sp("VWB-1", 400, 80), sp("EXP-1", 500, 80),
    sp("702", 100, 100), sp("OFFICE", 160, 100), sp("TL-1", 300, 100), sp("VWB-1", 400, 100), sp("SC-1", 500, 100),
    // the legend to the RIGHT, rows sharing the y band with the schedule's
    sp("FINISH LEGEND", 700, 40),
    sp("RF-1", 700, 80), sp("RUBBER FLOORING", 760, 80),
    sp("TL-1", 700, 100), sp("CERAMIC TILE", 760, 100),
  ],
};

test("side-by-side tables: a code-column right edge hugs the table — the legend next door stays out", () => {
  const tab = extractTable(sideSched, "room-finish")!;
  assert.equal(tab.rows.length, 2);
  const r701 = tab.rows.find((r) => r.key === "701")!;
  assert.equal(r701.cells.CEILING.text, "EXP-1", "the legend did not bleed into CEILING");
  assert.equal(tab.rows.find((r) => r.key === "702")!.cells.CEILING.text, "SC-1");
  for (const r of tab.rows) for (const c of Object.values(r.cells)) {
    assert.ok(!/RUBBER FLOORING|CERAMIC TILE|LEGEND/.test(c.text), `legend ink leaked into row ${r.key}: "${c.text}"`);
  }
});

test("finish tables headed SYMBOL extract and chain — the INTERIOR FINISH SCHEDULE shape", () => {
  // field-found: a real set's finish table is headed SYMBOL | MATERIAL
  // DESCRIPTION | MANUFACTURER | PRODUCT — no CODE/MARK anywhere, so the
  // definitions never chained and every resolution lost its manufacturer
  const symSched: SheetSpans = {
    key: "sym.pdf#1",
    sheet_number: "A-608",
    spans: [
      sp("INTERIOR FINISH SCHEDULE", 100, 40),
      sp("SYMBOL", 100, 60), sp("MATERIAL DESCRIPTION", 200, 60), sp("MANUFACTURER", 420, 60), sp("PRODUCT", 600, 60),
      sp("TL-9", 100, 80), sp("CERAMIC TILE", 200, 80), sp("VENDOR-D", 420, 80), sp("CW9763651PR", 600, 80),
      sp("RF-9", 100, 100), sp("RUBBER", 200, 100), sp("VENDOR-E", 420, 100), sp("PERFORMANCE RUBBER", 600, 100),
    ],
  };
  const fin = extractTable(symSched, "finish")!;
  assert.ok(fin, "SYMBOL anchors the finish table");
  assert.equal(fin.rows.length, 2);
  assert.equal(fin.rows.find((r) => r.key === "TL-9")!.cells.MANUFACTURER.text, "VENDOR-D");
});

// ── two-tier headers: a merged parent over N/E/S/W sub-columns ──────────────
// The real shape, field-found: a WALLS parent spanning four direction columns
// whose labels are single letters — not vocabulary words. Before the sub-tier
// hunt, N and E banded into BASE and S and W into CEILING, so BASE read
// "VWB-1 FRP-1 PT" instead of "VWB-1". A polluted base column is a wrong
// number in the bid.
const twoTierSched: SheetSpans = {
  key: "tier.pdf#1",
  sheet_number: "A-609",
  spans: [
    sp("ROOM SCHEDULE", 100, 20),
    // tier 1: the merged parent, centered over the wall block
    sp('WALLS (PLAN DIRECTION: N = "PLAN NORTH")', 480, 45),
    // tier 2: the real header row
    sp("NUMBER", 100, 65), sp("ROOM NAME", 200, 65), sp("FLOOR", 330, 65), sp("BASE", 400, 65),
    sp("N", 480, 65), sp("E", 560, 65), sp("S", 640, 65), sp("W", 720, 65), sp("CEILING", 790, 65),
    sp("801", 100, 90), sp("GYM", 200, 90), sp("RF-1", 330, 90), sp("VWB-1", 400, 90),
    sp("FRP-1", 480, 90), sp("FRP-2", 560, 90), sp("PT-1", 640, 90), sp("PT-2", 720, 90), sp("EXP-1", 790, 90),
    sp("802", 100, 115), sp("LOBBY", 200, 115), sp("TL-1", 330, 115), sp("VWB-1", 400, 115),
    sp("PT-1", 480, 115), sp("PT-1", 560, 115), sp("PT-1", 640, 115), sp("PT-1", 720, 115), sp("SC-1", 790, 115),
  ],
};

test("two-tier headers: N/E/S/W sub-columns anchor under their parent — BASE and CEILING stay clean", () => {
  const tab = extractTable(twoTierSched, "room-finish")!;
  assert.ok(tab.headers.includes("WALLS N"), `sub-columns are named by parent+sub: ${tab.headers.join(" | ")}`);
  assert.deepEqual(tab.headers.filter((h) => h.startsWith("WALLS ")), ["WALLS N", "WALLS E", "WALLS S", "WALLS W"]);
  const r801 = tab.rows.find((r) => r.key === "801")!;
  assert.equal(r801.cells.BASE.text, "VWB-1", "the north wall no longer smears into BASE");
  assert.equal(r801.cells.CEILING.text, "EXP-1", "the south and west walls no longer smear into CEILING");
  assert.equal(r801.cells["WALLS N"].text, "FRP-1");
  assert.equal(r801.cells["WALLS E"].text, "FRP-2");
  assert.equal(r801.cells["WALLS S"].text, "PT-1");
  assert.equal(r801.cells["WALLS W"].text, "PT-2");
  // the schedule alone still answers — it just cites no plan tag
  const solo = resolveTag(buildSheetGraph([twoTierSched]), "801");
  assert.equal(solo.status, "resolved");
  assert.equal(solo.room, null, "no plan sheet in the set, so no bubble to cite");
  // resolution surfaces every wall face separately, FLOOR still first
  const tierPlan: SheetSpans = {
    key: "tier.pdf#0", sheet_number: "A-107",
    spans: [sp("SEVENTH FLOOR FINISH PLAN", 300, 900), sp("GYM", 100, 300), sp("801", 104, 312)],
  };
  const g2 = buildSheetGraph([tierPlan, twoTierSched]);
  const r = resolveTag(g2, "801");
  assert.equal(r.status, "resolved");
  if (r.status !== "resolved") return;
  assert.equal(r.finishes[0].surface, "FLOOR", "FLOOR still leads the list");
  assert.equal(r.finishes.find((f) => f.surface === "BASE")!.code, "VWB-1");
  assert.deepEqual(
    r.finishes.filter((f) => f.surface.startsWith("WALLS ")).map((f) => [f.surface, f.code]),
    [["WALLS E", "FRP-2"], ["WALLS N", "FRP-1"], ["WALLS S", "PT-1"], ["WALLS W", "PT-2"]],
  );
  assert.equal(r.finishes.find((f) => f.surface === "CEILING")!.code, "EXP-1");
});

test("a lone unexplained token never mints a column — the sub-tier needs a parent above it", () => {
  const noParent: SheetSpans = {
    key: "np.pdf#1", sheet_number: "A-610",
    spans: [
      sp("ROOM SCHEDULE", 100, 20),
      sp("NO", 100, 65), sp("NAME", 200, 65), sp("FLOOR", 330, 65), sp("BASE", 400, 65),
      sp("X", 480, 65), sp("Y", 560, 65), sp("CEILING", 790, 65),   // no parent span above
      sp("901", 100, 90), sp("GYM", 200, 90), sp("RF-1", 330, 90), sp("VWB-1", 400, 90), sp("EXP-1", 790, 90),
    ],
  };
  const tab = extractTable(noParent, "room-finish")!;
  assert.ok(!tab.headers.some((h) => / [XY]$/.test(h)), `no phantom sub-columns: ${tab.headers.join(" | ")}`);
});

// ── other schedule families: a DOOR schedule is not a finish schedule ───────
// Field-found on a real grocery set: DOOR SCHEDULE (MARK | DESCRIPTION |
// MATERIAL | COMMENTS) extracted as 54 "finish" rows, so a finish code
// colliding with a door mark would chain to a DOOR — a confidently wrong
// product in the bid. Refused by title, and the drop is named.
import { isNonFinishSchedule } from "../src/lib/sheetgraph.ts";

test("isNonFinishSchedule: other families refuse, anything naming FINISH or MATERIAL is kept", () => {
  for (const t of ["DOOR SCHEDULE", "DOOR AND WINDOW SCHEDULE", "PARTITION SCHEDULE", "EQUIPMENT SCHEDULE", "LIGHTING SCHEDULE"]) {
    assert.equal(isNonFinishSchedule(t), true, t);
  }
  for (const t of ["INTERIOR FINISH SCHEDULE", "MATERIAL SCHEDULE", "ROOM FINISH SCHEDULE", "DOOR FINISH SCHEDULE", "FINISH LEGEND"]) {
    assert.equal(isNonFinishSchedule(t), false, `${t} must be kept — when in doubt, keep and let the caller look`);
  }
});

test("a DOOR SCHEDULE never becomes a finish table — and the drop is NAMED", () => {
  const doorSheet: SheetSpans = {
    key: "door.pdf#1",
    sheet_number: "A-611",
    spans: [
      sp("DOOR SCHEDULE", 100, 20),
      sp("MARK", 100, 60), sp("DESCRIPTION", 200, 60), sp("MATERIAL", 400, 60), sp("COMMENTS", 560, 60),
      // a door mark that genuinely COLLIDES with room 101's floor code
      sp("CPT-1", 100, 80), sp("HOLLOW METAL DOOR", 200, 80), sp("HM", 400, 80), sp("PAIR", 560, 80),
      sp("D-2", 100, 100), sp("WOOD DOOR", 200, 100), sp("WD", 400, 100), sp("SINGLE", 560, 100),
    ],
  };
  // extractTable is the raw reader — it still sees any MARK table's shape
  assert.equal(extractTable(doorSheet, "finish")!.rows.length, 2);
  // the door sheet is loaded FIRST, so an ungated graph would chain to it
  const g = buildSheetGraph([doorSheet, planSheet, schedSheet]);
  assert.ok(!g.tables.some((t) => t.title?.text === "DOOR SCHEDULE"), "no door schedule among the indexed tables");
  assert.ok(g.notes.some((n) => /DOOR SCHEDULE/.test(n) && /NOT indexed/.test(n)), `the drop is named: ${g.notes.join(" | ")}`);
  // room 101's FLOOR chains to the MATERIAL schedule's CPT-1, never the door's
  const res = resolveTag(g, "101");
  assert.equal(res.status, "resolved");
  if (res.status !== "resolved") return;
  const floor = res.finishes.find((f) => f.surface === "FLOOR")!;
  assert.equal(floor.code, "CPT-1");
  assert.equal(floor.definition?.cells.MATERIAL, "CARPET TILE", "chained to the material schedule, never to the door schedule");
  assert.equal(floor.definition?.cells.MANUFACTURER, "VENDOR-A");
});

// ═════════════════════════════════════════════════════════════════════════════
// Phase 4 (#87): what a SCORED run against real bid sets forced. Each of these
// reproduces a failure measured on an actual planset, not an imagined one.
// ═════════════════════════════════════════════════════════════════════════════

test("columns come from where the DATA starts, not where the header sits", () => {
  // Field-found: headers centred, cells left-aligned. "PT-1" and
  // "SEE INT. ELEVATIONS" share a left edge but their centres differ by 120px,
  // so centre-banding put the short one in BASE and the long one in WALL.
  const sched: SheetSpans = {
    key: "align.pdf#1", sheet_number: "A-620",
    spans: [
      sp("ROOM SCHEDULE", 100, 20),
      // header cells are WIDE and centred over their columns
      { str: "NO.", x: 100, y: 60, w: 30, h: 8 },
      { str: "NAME", x: 200, y: 60, w: 90, h: 8 },
      { str: "FLOOR FINISH", x: 360, y: 60, w: 150, h: 8 },
      { str: "BASE FINISH", x: 560, y: 60, w: 140, h: 8 },
      { str: "WALL FINISH", x: 800, y: 60, w: 140, h: 8 },
      // data is LEFT-ALIGNED at each column's own start
      sp("601", 100, 85), sp("LOBBY", 200, 85), sp("CT-1", 355, 85), sp("VB-1", 545, 85), sp("SEE INT. ELEVATIONS", 745, 85),
      sp("602", 100, 105), sp("STORAGE", 200, 105), sp("SC-1", 355, 105), sp("VB-1", 545, 105), sp("PT-1", 745, 105),
      sp("603", 100, 125), sp("OFFICE", 200, 125), sp("SC-1", 355, 125), sp("VB-1", 545, 125), sp("PT-1", 745, 125),
    ],
  };
  const tab = extractTable(sched, "room-finish")!;
  for (const key of ["601", "602", "603"]) {
    const r = tab.rows.find((x) => x.key === key)!;
    assert.equal(r.cells.BASE.text, "VB-1", `${key}: BASE keeps its own cell`);
  }
  assert.equal(tab.rows.find((r) => r.key === "602")!.cells.WALL.text, "PT-1", "a SHORT wall cell lands in WALL, not BASE");
  assert.equal(tab.rows.find((r) => r.key === "601")!.cells.WALL.text, "SEE INT. ELEVATIONS");
});

test("three-tier headers: the LOWEST tier defines the columns, the tiers above NAME them", () => {
  // Field-found: ROOM | FLOOR | WALLS | CEILING over
  // MARK | LOCATION | FINISH | BASE | NORTH | … | FINISH | HEIGHT.
  // The parent row carries enough vocabulary to look like the header; taking
  // it read every sub-header as data. Two columns are both headed FINISH, so
  // each takes its parent's name.
  const sched: SheetSpans = {
    key: "tier3.pdf#1", sheet_number: "A-621",
    spans: [
      sp("ROOM FINISH SCHEDULE", 100, 20),
      // tier 1 — parents, centred over their groups
      { str: "ROOM", x: 130, y: 45, w: 60, h: 8 },
      { str: "FLOOR", x: 330, y: 45, w: 70, h: 8 },
      { str: "CEILING", x: 660, y: 45, w: 90, h: 8 },
      // a column that spans BOTH tiers, on its own row between them
      { str: "REMARKS", x: 860, y: 58, w: 90, h: 8 },
      // tier 2 — the real columns
      sp("MARK", 100, 70), sp("LOCATION", 180, 70), sp("FINISH", 300, 70), sp("BASE", 400, 70),
      sp("FINISH", 640, 70), sp("HEIGHT", 740, 70),
      sp("701", 100, 95), sp("LOBBY", 180, 95), sp("PT-1", 300, 95), sp("WB-1", 400, 95), sp("ACT-1", 640, 95), sp("9'-0\"", 740, 95),
      sp("702", 100, 115), sp("OFFICE", 180, 115), sp("RT-1", 300, 115), sp("WB-2", 400, 115), sp("ACT-2", 640, 115), sp("13'-0\"", 740, 115),
    ],
  };
  const tab = extractTable(sched, "room-finish")!;
  assert.ok(tab.headers.includes("FLOOR FINISH"), `floor column takes its parent's name: ${tab.headers.join(" | ")}`);
  assert.ok(tab.headers.includes("CEILING FINISH"), "the second FINISH is named by ITS parent, not dropped as a duplicate");
  assert.ok(tab.headers.includes("BASE"), "BASE is its own surface and is never renamed 'FLOOR BASE'");
  const r = tab.rows.find((x) => x.key === "701")!;
  assert.equal(r.cells["FLOOR FINISH"].text, "PT-1");
  assert.equal(r.cells.BASE.text, "WB-1");
  assert.equal(r.cells["CEILING FINISH"].text, "ACT-1");
  // resolution ranks by the LEADING word, so the parent-named columns still
  // read as their surfaces, FLOOR first
  const plan: SheetSpans = {
    key: "tier3.pdf#0", sheet_number: "A-108",
    spans: [sp("EIGHTH FLOOR FINISH PLAN", 300, 900), sp("LOBBY", 100, 300), sp("701", 104, 312)],
  };
  const res = resolveTag(buildSheetGraph([plan, sched]), "701");
  assert.equal(res.status, "resolved");
  if (res.status !== "resolved") return;
  assert.equal(res.finishes[0].surface, "FLOOR FINISH");
  assert.equal(res.finishes[0].code, "PT-1");
  assert.equal(res.finishes.find((f) => f.surface === "BASE")!.code, "WB-1");
});

test("a table ends where its rows stop — a legend far below is not extra rows", () => {
  const sched: SheetSpans = {
    key: "end.pdf#1", sheet_number: "A-622",
    spans: [
      sp("ROOM SCHEDULE", 100, 20),
      sp("NO", 100, 60), sp("NAME", 200, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("CEILING", 500, 60),
      sp("801", 100, 80), sp("LOBBY", 200, 80), sp("CT-1", 300, 80), sp("VB-1", 400, 80), sp("ACT-1", 500, 80),
      sp("802", 100, 100), sp("OFFICE", 200, 100), sp("CT-1", 300, 100), sp("VB-1", 400, 100), sp("ACT-1", 500, 100),
      sp("803", 100, 120), sp("STORAGE", 200, 120), sp("SC-1", 300, 120), sp("VB-1", 400, 120), sp("ACT-2", 500, 120),
      // far below: a keyed-looking row from something else entirely
      sp("801", 100, 900), sp("DUPLICATE", 200, 900), sp("XX-9", 300, 900), sp("XX-9", 400, 900), sp("XX-9", 500, 900),
    ],
  };
  const tab = extractTable(sched, "room-finish")!;
  assert.deepEqual(tab.rows.map((r) => r.key), ["801", "802", "803"], "the far-below row is not part of this table");
  assert.equal(tab.rows.find((r) => r.key === "801")!.cells.FLOOR.text, "CT-1");
});

test("corroboration: a keynote legend row never becomes a room, and the reason says so", () => {
  const plan: SheetSpans = {
    key: "kn.pdf#1", sheet_number: "A-109",
    spans: [
      sp("NINTH FLOOR FINISH PLAN", 300, 900),
      sp("LOBBY", 100, 100), sp("901", 104, 112),
      // a keynote legend: a number paired with a description, exactly the way
      // a bubble pairs one with a name
      sp("LOCKER ROOM ACCESSORY", 600, 300), sp("10", 604, 312),
      sp("MIRROR", 600, 340), sp("13", 604, 352),
    ],
  };
  const sched: SheetSpans = {
    key: "kn.pdf#2", sheet_number: "A-623",
    spans: [
      sp("ROOM SCHEDULE", 100, 20),
      sp("NO", 100, 60), sp("NAME", 200, 60), sp("FLOOR", 300, 60), sp("BASE", 400, 60), sp("CEILING", 500, 60),
      sp("901", 100, 80), sp("LOBBY", 200, 80), sp("CT-1", 300, 80), sp("VB-1", 400, 80), sp("ACT-1", 500, 80),
      sp("902", 100, 100), sp("OFFICE", 200, 100), sp("CT-1", 300, 100), sp("VB-1", 400, 100), sp("ACT-1", 500, 100),
    ],
  };
  const g = buildSheetGraph([plan, sched]);
  assert.deepEqual(g.rooms.map((r) => r.tag), ["901"], "the legend numbers are not rooms");
  assert.equal(g.rooms[0].corroboration, "name+schedule");
  assert.deepEqual(g.unmatched_tags.map((u) => u.tag).sort(), ["10", "13"]);
  for (const u of g.unmatched_tags) assert.match(u.reason, /keynote\/legend row|keynote, detail marker/);
  // and the disclosure still cites the ink, so a genuinely omitted room is findable
  assert.ok(g.unmatched_tags.every((u) => u.sheet && u.bbox));
});

test("cell alignment is READ, not assumed: a schedule that CENTRES its cells bands correctly", () => {
  // Field-found on a municipal set drawn in a hand-lettered CAD font: cells
  // are centred, not left-aligned, so a long value ("PNT-1, FRP-1") starts
  // far left of a short one ("PNT-1") in the same column and left-edge
  // banding pushed it into the column before it.
  const centred: SheetSpans = {
    key: "ctr.pdf#1", sheet_number: "A-624",
    spans: [
      sp("ROOM FINISH SCHEDULE", 100, 20),
      { str: "ROOM #", x: 96, y: 60, w: 60, h: 8 },
      { str: "ROOM NAME", x: 200, y: 60, w: 90, h: 8 },
      { str: "FLOOR", x: 380, y: 60, w: 60, h: 8 },
      { str: "BASE", x: 540, y: 60, w: 50, h: 8 },
      { str: "WALL", x: 700, y: 60, w: 50, h: 8 },
      // every cell CENTRED on its column: 126 / 245 / 410 / 565 / 725
      { str: "100", x: 111, y: 85, w: 30, h: 8 }, { str: "CHEM FEED", x: 200, y: 85, w: 90, h: 8 },
      { str: "SC-1", x: 390, y: 85, w: 40, h: 8 }, { str: "RB-1", x: 545, y: 85, w: 40, h: 8 },
      { str: "PNT-1", x: 700, y: 85, w: 50, h: 8 },
      { str: "102", x: 111, y: 105, w: 30, h: 8 }, { str: "MECH./JAN.", x: 197, y: 105, w: 96, h: 8 },
      { str: "SC-1", x: 390, y: 105, w: 40, h: 8 }, { str: "RB-1", x: 545, y: 105, w: 40, h: 8 },
      // the long one: centred, so it STARTS left of the short values above
      { str: "PNT-1, FRP-1", x: 665, y: 105, w: 120, h: 8 },
      { str: "104", x: 111, y: 125, w: 30, h: 8 }, { str: "TLT/SHWR", x: 202, y: 125, w: 86, h: 8 },
      { str: "HTF-1", x: 387, y: 125, w: 46, h: 8 }, { str: "HTB-1", x: 542, y: 125, w: 46, h: 8 },
      { str: "PNT-1", x: 700, y: 125, w: 50, h: 8 },
    ],
  };
  const tab = extractTable(centred, "room-finish")!;
  assert.deepEqual(tab.rows.map((r) => r.key), ["100", "102", "104"]);
  const r102 = tab.rows.find((r) => r.key === "102")!;
  assert.equal(r102.cells.BASE.text, "RB-1", "the long wall value did not spill into BASE");
  assert.equal(r102.cells.WALL.text, "PNT-1, FRP-1");
  assert.equal(tab.rows.find((r) => r.key === "104")!.cells.FLOOR.text, "HTF-1");
});

test("a header cell naming two vocabulary words gives up the second: ROOM # | ROOM NAME", () => {
  // Both cells lead with ROOM. Deduping on the leading word alone left the
  // NAME column with no anchor, and the room name merged into FLOOR.
  const sched: SheetSpans = {
    key: "rn.pdf#1", sheet_number: "A-625",
    spans: [
      sp("ROOM FINISH SCHEDULE", 100, 20),
      sp("ROOM #", 100, 60), sp("ROOM NAME", 200, 60), sp("FLOOR", 400, 60), sp("BASE", 520, 60), sp("WALL", 640, 60),
      sp("100", 100, 85), sp("CHEM FEED", 200, 85), sp("SC-1", 400, 85), sp("RB-1", 520, 85), sp("PNT-1", 640, 85),
      sp("101", 100, 105), sp("LAB", 200, 105), sp("SC-1", 400, 105), sp("RB-1", 520, 105), sp("PNT-1", 640, 105),
      sp("102", 100, 125), sp("CONTROL RM", 200, 125), sp("HTF-1", 400, 125), sp("HTB-1", 520, 125), sp("PNT-1", 640, 125),
    ],
  };
  const tab = extractTable(sched, "room-finish")!;
  assert.ok(tab.headers.includes("NAME"), `the name column keeps an anchor: ${tab.headers.join(" | ")}`);
  for (const r of tab.rows) {
    assert.ok(!/CHEM FEED|LAB|CONTROL RM/.test(r.cells.FLOOR.text), `room name leaked into FLOOR on ${r.key}: "${r.cells.FLOOR.text}"`);
  }
  assert.equal(tab.rows.find((r) => r.key === "100")!.cells.FLOOR.text, "SC-1");
  assert.equal(tab.rows.find((r) => r.key === "102")!.cells.BASE.text, "HTB-1");
});

test("#355: ROOM NO. | ROOM NAME self-cannibalizing the distinct-hit count no longer starves a real schedule below minHits", () => {
  // Only 4 header cells — ROOM NO., ROOM NAME, FLOOR, BASE. Under first-
  // match-per-cell, ROOM NO. and ROOM NAME both contribute only "ROOM" to
  // the distinct-hit set: {ROOM, FLOOR, BASE} = 3, one short of minHits=4,
  // so the header row never qualifies and the whole table goes invisible —
  // even though every one of these four columns is real vocabulary and the
  // room-name anchor already resolves correctly once a header IS found (see
  // the ROOM # | ROOM NAME test above). This is the minimal repro: no FLOOR
  // WALL/CEILING/REMARKS padding to carry the count past the gate.
  const sched: SheetSpans = {
    key: "min.pdf#1", sheet_number: "A-611",
    spans: [
      sp("ROOM FINISH SCHEDULE", 100, 20),
      sp("ROOM NO.", 100, 60), sp("ROOM NAME", 220, 60), sp("FLOOR", 400, 60), sp("BASE", 520, 60),
      sp("201", 100, 85), sp("LOBBY", 220, 85), sp("CT-1", 400, 85), sp("RB-2", 520, 85),
      sp("202", 100, 105), sp("OFFICE", 220, 105), sp("CT-1", 400, 105), sp("RB-2", 520, 105),
      sp("203", 100, 125), sp("BREAK RM", 220, 125), sp("SC-2", 400, 125), sp("RB-2", 520, 125),
    ],
  };
  const tab = extractTable(sched, "room-finish");
  assert.ok(tab, "a real 4-column room-finish schedule must be detected, not starved below minHits");
  assert.equal(tab!.rows.length, 3);
  assert.ok(tab!.headers.includes("NAME"), `NAME keeps its own anchor: ${tab!.headers.join(" | ")}`);
  assert.equal(tab!.rows.find((r) => r.key === "201")!.cells.FLOOR.text, "CT-1");
  assert.equal(tab!.rows.find((r) => r.key === "203")!.cells.BASE.text, "RB-2");
  // and the existing fixtures still find exactly what they found before —
  // this fix must not change extraction on any table that already qualified
  const rf = extractTable(schedSheet, "room-finish")!;
  assert.equal(rf.rows.length, 3);
  assert.equal(rf.title?.text, "ROOM FINISH SCHEDULE");
  const fin = extractTable(schedSheet, "finish")!;
  assert.equal(fin.rows.length, 3);
});
