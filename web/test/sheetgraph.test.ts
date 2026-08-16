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
import { buildSheetGraph, resolveTag, classifySheetRole, extractTable, roomTags, detailCallouts, revisionOf, type GraphSpan, type SheetSpans, type SheetGraph } from "../src/lib/sheetgraph.ts";

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
    sp("CPT-1", 100, 340), sp("CARPET TILE", 200, 340), sp("SHAW", 360, 340), sp("NIGHTFALL", 520, 340),
    sp("LVT-1", 100, 360), sp("LUXURY VINYL TILE", 200, 360), sp("MANNINGTON", 360, 360), sp("OAK", 520, 360),
    sp("RB-1", 100, 380), sp("RESILIENT BASE", 200, 380), sp("TARKETT", 360, 380), sp("SLATE", 520, 380),
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
  assert.equal(fin.rows.find((r) => r.key === "CPT-1")!.cells.MANUFACTURER.text, "SHAW");
  // a sheet with no such structure yields null, never invented rows
  assert.equal(extractTable(planSheet, "room-finish"), null);
});

test("room tags pair the stacked name; schedule sheets never mint phantom rooms", () => {
  const tags = roomTags(planSheet);
  assert.deepEqual(tags.map((t) => [t.tag, t.name]).sort(), [["101", "OFFICE"], ["102", "WORKROOM"], ["103", "CORRIDOR"], ["104", "STORAGE"]]);
  const g = buildSheetGraph([planSheet, schedSheet]);
  assert.equal(g.rooms.length, 4, "the schedule sheet's NO column contributes rows, not room tags");
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
    if (tag === "101") assert.equal(floor.definition?.cells.MANUFACTURER, "SHAW");
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
  assert.equal(missing.room?.name, "STORAGE", "the room is still cited — the gap is named, not hidden");
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
