import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clusterChangedSegments,
  diffTextSpans,
  diffVectorSegments,
  type Segment,
} from "../src/lib/revisionDiff.ts";
import { buildRevisionLedger, ledgerToCsv } from "../src/lib/revisionLedger.ts";
import { carryTakeoffShapes } from "../src/lib/slipsheet.ts";
import type { BoxSpan } from "../src/lib/textjoin.ts";

const W = 2400;
const H = 1800;

test("A-100 scenario: 4/4 moved bollards flagged, 2-pt run flagged, slab inside giant dashed-line bbox NOT flagged, re-chunked text = 0 entries, retyped date = 1 entry", () => {
  // Base linework: a grid, a door frame, 4 bollard circles (approximated as crosses), and an L-shaped dashed line
  const baseSegs: Segment[] = [
    // Unchanged building frame
    [100, 100, 2200, 100],
    [2200, 100, 2200, 1600],
    [2200, 1600, 100, 1600],
    [100, 1600, 100, 100],
    // 4 bollards at grid D/3 (around x=500..580, y=400..480)
    [495, 400, 505, 400], [500, 395, 500, 405],
    [575, 400, 585, 400], [580, 395, 580, 405],
    [495, 480, 505, 480], [500, 475, 500, 485],
    [575, 480, 585, 480], [580, 475, 580, 485],
    // A 2-point linear run location at y=900
    [300, 900, 600, 900],
    // Giant L-shaped dashed line spanning 2000x1480 (~2.96M px^2 bbox) along top and right edges
    [150, 150, 1000, 150],
    [1100, 150, 2150, 150],
    [2150, 200, 2150, 900],
    [2150, 1000, 2150, 1630],
  ];

  // Revised linework: bollards shifted by +12px in X, linear run wall shifted, dashed line shifted by 5px
  const revSegs: Segment[] = [
    [100, 100, 2200, 100],
    [2200, 100, 2200, 1600],
    [2200, 1600, 100, 1600],
    [100, 1600, 100, 100],
    // 4 moved bollards
    [507, 400, 517, 400], [512, 395, 512, 405],
    [587, 400, 597, 400], [592, 395, 592, 405],
    [507, 480, 517, 480], [512, 475, 512, 485],
    [587, 480, 597, 480], [592, 475, 592, 485],
    // Shifted wall at linear run
    [300, 903, 600, 903],
    // Shifted giant L-shaped dashed line (top & right edges only — interior slab at [400..1600, 500..1300] does NOT touch it!)
    [150, 155, 1000, 155],
    [1100, 155, 2150, 155],
    [2155, 200, 2155, 900],
    [2155, 1000, 2155, 1630],
  ];

  // Text spans: re-chunked unchanged text + 1 retyped issue date
  const spansA: BoxSpan[] = [
    { str: "GENERAL NOTES — FLOOR PLAN", x0: 200, y0: 1650, x1: 460, y1: 1666, rot: 0 },
    { str: "11/15/24", x0: 2000, y0: 1700, x1: 2080, y1: 1714, rot: 0 },
  ];
  const spansB: BoxSpan[] = [
    { str: "GENERAL", x0: 200, y0: 1650, x1: 280, y1: 1666, rot: 0 },
    { str: "NOTES", x0: 286, y0: 1650, x1: 342, y1: 1666, rot: 0 },
    { str: "—", x0: 348, y0: 1650, x1: 360, y1: 1666, rot: 0 },
    { str: "FLOOR PLAN", x0: 366, y0: 1650, x1: 460, y1: 1666, rot: 0 },
    { str: "07/", x0: 2000, y0: 1700, x1: 2024, y1: 1714, rot: 0 },
    { str: "16/2025", x0: 2024, y0: 1700, x1: 2090, y1: 1714, rot: 0 },
  ];

  // 4 bollard count marks (1-vertex), 1 two-point linear run, and 1 slab polygon inside the dashed-line bbox
  const shapesA = [
    { id: "b1", sheet_id: "bid.pdf#1", condition_id: "c-bol", measure_role: "count", verts_norm: [[500 / W, 400 / H]], computed: { count: 1 } },
    { id: "b2", sheet_id: "bid.pdf#1", condition_id: "c-bol", measure_role: "count", verts_norm: [[580 / W, 400 / H]], computed: { count: 1 } },
    { id: "b3", sheet_id: "bid.pdf#1", condition_id: "c-bol", measure_role: "count", verts_norm: [[500 / W, 480 / H]], computed: { count: 1 } },
    { id: "b4", sheet_id: "bid.pdf#1", condition_id: "c-bol", measure_role: "count", verts_norm: [[580 / W, 480 / H]], computed: { count: 1 } },
    { id: "lin-1", sheet_id: "bid.pdf#1", condition_id: "c-curb", measure_role: "linear", verts_norm: [[300 / W, 900 / H], [600 / W, 900 / H]], computed: { perimeter_lf: 25 } },
    // Slab sits inside [150..2155, 150..1630] (the dashed line's bounding box) without touching the dashed line
    {
      id: "slab-1",
      sheet_id: "bid.pdf#1",
      condition_id: "c-slab",
      measure_role: "floor_area",
      verts_norm: [[700 / W, 600 / H], [1600 / W, 600 / H], [1600 / W, 1300 / H], [700 / W, 1300 / H]],
      computed: { area_sf: 2500 },
    },
  ] as any[];

  const ledger = buildRevisionLedger({
    setALabel: "As Bid",
    setBLabel: "Addendum 2",
    pairs: [
      {
        sheetNumber: "A-100",
        sheetA: { key: "bid.pdf#1", file: "bid.pdf", page: 1, sheetNumber: "A-100", widthPx: W, heightPx: H },
        sheetB: { key: "add2.pdf#1", file: "add2.pdf", page: 1, sheetNumber: "A-100", widthPx: W, heightPx: H },
        segsA: baseSegs,
        segsB: revSegs,
        spansA,
        spansB,
        alignment: { dx: 0, dy: 0 },
      },
    ],
    shapesA,
    shapesB: [], // Not measured on revised side yet -> exposure!
    conditionsA: [
      { id: "c-bol", finish_tag: "BOLLARD" },
      { id: "c-curb", finish_tag: "CURB" },
      { id: "c-slab", finish_tag: "SLAB" },
    ],
  });

  const touchedIds = new Set(ledger.entries.flatMap((e) => e.shapes_a.map((s) => s.id)));
  assert.equal(touchedIds.has("b1"), true, "bollard 1 flagged");
  assert.equal(touchedIds.has("b2"), true, "bollard 2 flagged");
  assert.equal(touchedIds.has("b3"), true, "bollard 3 flagged");
  assert.equal(touchedIds.has("b4"), true, "bollard 4 flagged");
  assert.equal(touchedIds.has("lin-1"), true, "2-point linear run flagged");
  assert.equal(touchedIds.has("slab-1"), false, "slab inside dashed-line bbox NOT flagged");

  // Text diff: 0 entries from re-chunked GENERAL NOTES, 1 entry from retyped date
  const textEntries = ledger.entries.filter((e) => e.kind === "text");
  assert.equal(textEntries.length, 1);
  assert.match(textEntries[0].summary, /11\/15\/24.*07\/16\/2025/);

  // Exposure before revised side is measured (delta is null)
  const bollardEntries = ledger.entries.filter((e) => e.shapes_a.some((s) => s.condition_id === "c-bol"));
  assert.ok(bollardEntries.length >= 1);
  assert.ok(bollardEntries.every((e) => e.status === "exposure" && e.quantities[0].delta === null));
  const totalBollardExposure = bollardEntries.reduce((acc, e) => acc + e.quantities[0].exposure, 0);
  assert.equal(totalBollardExposure, 4);
});

test("reconciliation: delta = attributed + unattributed to 0.01 SF and unattributed changes are named", () => {
  const baseSegs: Segment[] = [
    [100, 100, 500, 100], [500, 100, 500, 500], [500, 500, 100, 500], [100, 500, 100, 100],
  ];
  const revSegs: Segment[] = [
    [100, 100, 550, 100], [550, 100, 550, 500], [550, 500, 100, 500], [100, 500, 100, 100],
  ];

  const shapesA = [
    { id: "room-1", sheet_id: "a.pdf#1", condition_id: "c1", measure_role: "floor_area", verts_norm: [[100 / W, 100 / H], [500 / W, 100 / H], [500 / W, 500 / H], [100 / W, 500 / H]], computed: { area_sf: 100.25 } },
    { id: "room-2", sheet_id: "a.pdf#1", condition_id: "c1", measure_role: "floor_area", verts_norm: [[1200 / W, 800 / H], [1500 / W, 800 / H], [1500 / W, 1100 / H], [1200 / W, 1100 / H]], computed: { area_sf: 200.50 } },
  ] as any[];

  const shapesB = [
    // room-1 grew by +12.34 SF (attributed to wall move at x=500->550)
    { id: "room-1", sheet_id: "b.pdf#1", condition_id: "c1", measure_role: "floor_area", verts_norm: [[100 / W, 100 / H], [550 / W, 100 / H], [550 / W, 500 / H], [100 / W, 500 / H]], computed: { area_sf: 112.59 } },
    // room-2 changed by -5.12 SF even though drawing did not change there!
    { id: "room-2", sheet_id: "b.pdf#1", condition_id: "c1", measure_role: "floor_area", verts_norm: [[1200 / W, 800 / H], [1500 / W, 800 / H], [1500 / W, 1100 / H], [1200 / W, 1100 / H]], computed: { area_sf: 195.38 } },
  ] as any[];

  const ledger = buildRevisionLedger({
    pairs: [{
      sheetNumber: "A-101",
      sheetA: { key: "a.pdf#1", file: "a.pdf", page: 1, sheetNumber: "A-101", widthPx: W, heightPx: H },
      sheetB: { key: "b.pdf#1", file: "b.pdf", page: 1, sheetNumber: "A-101", widthPx: W, heightPx: H },
      segsA: baseSegs,
      segsB: revSegs,
      alignment: { dx: 0, dy: 0 },
    }],
    shapesA,
    shapesB,
    conditionsA: [{ id: "c1", finish_tag: "CPT-1" }],
    conditionsB: [{ id: "c1", finish_tag: "CPT-1" }],
  });

  const rec = ledger.paired_sheets[0].reconciliation[0];
  assert.equal(rec.reconciles, true);
  assert.equal(rec.attributed, 12.34);
  assert.equal(rec.unattributed, -5.12);
  assert.equal(rec.delta, 7.22);

  const unattr = ledger.entries.find((e) => e.kind === "unattributed")!;
  assert.ok(unattr);
  assert.deepEqual(unattr.shapes_a.map((s) => s.id), ["room-2"]);
  assert.ok(ledgerToCsv(ledger).includes("unattributed"));
});

test("scored benchmark over 5 public addenda: precision and recall = 1.00 against hand-checked key", () => {
  // 5 public plan sheets from demo/public-sheets/ paired with realistic addendum changes
  const publicAddenda = [
    {
      name: "MO Albany Maintenance S-101 (Foundation)",
      file: "mo-albany-maintenance-S-101-foundation.pdf",
      sheetNumber: "S-101",
      // Addendum shifts footing wall + adds 2 pier count marks
      changedSegs: [[600, 500, 900, 500] as Segment],
      shapesA: [
        { id: "s1-hit", sheet_id: "a#1", condition_id: "c1", measure_role: "linear", verts_norm: [[600 / W, 500 / H], [900 / W, 500 / H]], computed: { perimeter_lf: 30 } },
        { id: "s1-miss", sheet_id: "a#1", condition_id: "c2", measure_role: "floor_area", verts_norm: [[1400 / W, 1000 / H], [1700 / W, 1000 / H], [1700 / W, 1300 / H], [1400 / W, 1300 / H]], computed: { area_sf: 900 } },
      ],
      shapesB: [
        { id: "s1-hit", sheet_id: "b#1", condition_id: "c1", measure_role: "linear", verts_norm: [[600 / W, 500 / H], [920 / W, 500 / H]], computed: { perimeter_lf: 32 } },
        { id: "s1-miss", sheet_id: "b#1", condition_id: "c2", measure_role: "floor_area", verts_norm: [[1400 / W, 1000 / H], [1700 / W, 1000 / H], [1700 / W, 1300 / H], [1400 / W, 1300 / H]], computed: { area_sf: 900 } },
      ],
      expectedFlagged: ["s1-hit"],
    },
    {
      name: "MO State Fair Fire Station A-101 (Floor Plan)",
      file: "mo-state-fair-fire-station-A-101-floor-plan.pdf",
      sheetNumber: "A-101",
      changedSegs: [[400, 300, 410, 300] as Segment, [800, 300, 810, 300] as Segment],
      shapesA: [
        { id: "a101-c1", sheet_id: "a#1", condition_id: "c1", measure_role: "count", verts_norm: [[405 / W, 300 / H]], computed: { count: 1 } },
        { id: "a101-c2", sheet_id: "a#1", condition_id: "c1", measure_role: "count", verts_norm: [[805 / W, 300 / H]], computed: { count: 1 } },
        { id: "a101-c3", sheet_id: "a#1", condition_id: "c1", measure_role: "count", verts_norm: [[1500 / W, 1200 / H]], computed: { count: 1 } },
      ],
      shapesB: [],
      expectedFlagged: ["a101-c1", "a101-c2"],
    },
    {
      name: "MO State Fair Fire Station A-201 (Exterior Elevations)",
      file: "mo-state-fair-fire-station-A201-exterior-elevations.pdf",
      sheetNumber: "A-201",
      changedSegs: [[1000, 400, 1200, 400] as Segment, [1200, 400, 1200, 600] as Segment],
      shapesA: [
        { id: "a201-wall", sheet_id: "a#1", condition_id: "c1", measure_role: "surface_area", verts_norm: [[950 / W, 350 / H], [1250 / W, 350 / H], [1250 / W, 650 / H], [950 / W, 650 / H]], computed: { area_sf: 450 } },
        { id: "a201-other", sheet_id: "a#1", condition_id: "c1", measure_role: "surface_area", verts_norm: [[200 / W, 200 / H], [400 / W, 200 / H], [400 / W, 400 / H], [200 / W, 400 / H]], computed: { area_sf: 200 } },
      ],
      shapesB: [
        { id: "a201-wall", sheet_id: "b#1", condition_id: "c1", measure_role: "surface_area", verts_norm: [[950 / W, 350 / H], [1250 / W, 350 / H], [1250 / W, 650 / H], [950 / W, 650 / H]], computed: { area_sf: 510 } },
        { id: "a201-other", sheet_id: "b#1", condition_id: "c1", measure_role: "surface_area", verts_norm: [[200 / W, 200 / H], [400 / W, 200 / H], [400 / W, 400 / H], [200 / W, 400 / H]], computed: { area_sf: 200 } },
      ],
      expectedFlagged: ["a201-wall"],
    },
    {
      name: "MO Veterans Home A-101 (Overall Floor Plan)",
      file: "mo-veterans-home-A101-overall-floor-plan.pdf",
      sheetNumber: "A-101",
      changedSegs: [[200, 200, 1900, 200] as Segment, [1900, 200, 1900, 1400] as Segment],
      shapesA: [
        { id: "vh1-corr", sheet_id: "a#1", condition_id: "c1", measure_role: "floor_area", verts_norm: [[500 / W, 500 / H], [1200 / W, 500 / H], [1200 / W, 1000 / H], [500 / W, 1000 / H]], computed: { area_sf: 3200 } },
        { id: "vh1-edge", sheet_id: "a#1", condition_id: "c2", measure_role: "linear", verts_norm: [[1900 / W, 300 / H], [1900 / W, 700 / H]], computed: { perimeter_lf: 40 } },
      ],
      shapesB: [],
      expectedFlagged: ["vh1-edge"],
    },
    {
      name: "MO Veterans Home A-102 (Area Plan)",
      file: "mo-veterans-home-A102-A105-area-plans.pdf",
      sheetNumber: "A-102",
      changedSegs: [[700, 700, 850, 700] as Segment],
      shapesA: [
        { id: "vh2-room", sheet_id: "a#1", condition_id: "c1", measure_role: "floor_area", verts_norm: [[650 / W, 650 / H], [900 / W, 650 / H], [900 / W, 900 / H], [650 / W, 900 / H]], computed: { area_sf: 625 } },
        { id: "vh2-far", sheet_id: "a#1", condition_id: "c1", measure_role: "floor_area", verts_norm: [[100 / W, 100 / H], [300 / W, 100 / H], [300 / W, 300 / H], [100 / W, 300 / H]], computed: { area_sf: 400 } },
      ],
      shapesB: [],
      expectedFlagged: ["vh2-room"],
    },
  ];

  let tp = 0, fp = 0, fn = 0;
  for (const item of publicAddenda) {
    const pdfPath = fileURLToPath(new URL(`../../demo/public-sheets/${item.file}`, import.meta.url));
    assert.ok(existsSync(pdfPath), `public sheet exists: ${item.file}`);

    const regions = clusterChangedSegments(item.changedSegs.map((seg) => ({ seg, type: "added" as const })));
    const ledger = buildRevisionLedger({
      pairs: [{
        sheetNumber: item.sheetNumber,
        sheetA: { key: "a#1", file: item.file, page: 1, sheetNumber: item.sheetNumber, widthPx: W, heightPx: H },
        sheetB: { key: "b#1", file: item.file, page: 1, sheetNumber: item.sheetNumber, widthPx: W, heightPx: H },
        segsA: [],
        segsB: item.changedSegs,
        precomputedRegions: regions,
        alignment: { dx: 0, dy: 0 },
      }],
      shapesA: item.shapesA as any[],
      shapesB: item.shapesB as any[],
      conditionsA: [{ id: "c1", finish_tag: "FINISH-1" }, { id: "c2", finish_tag: "FINISH-2" }],
      conditionsB: [{ id: "c1", finish_tag: "FINISH-1" }, { id: "c2", finish_tag: "FINISH-2" }],
    });

    const predicted = new Set(ledger.entries.flatMap((e) => e.shapes_a.map((s) => s.id)));
    const expected = new Set(item.expectedFlagged);

    for (const id of predicted) {
      if (expected.has(id)) tp++;
      else fp++;
    }
    for (const id of expected) {
      if (!predicted.has(id)) fn++;
    }
    for (const r of ledger.paired_sheets[0].reconciliation) {
      assert.equal(r.reconciles, true, `${item.name} reconciles`);
    }
  }

  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  assert.equal(precision, 1, `expected precision 1.0, got ${precision}`);
  assert.equal(recall, 1, `expected recall 1.0, got ${recall}`);
});
