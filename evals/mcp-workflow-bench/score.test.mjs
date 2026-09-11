import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCandidate, polygonIntersectionArea } from "./score.mjs";

const reference = JSON.parse(readFileSync(new URL("./reference.json", import.meta.url), "utf8"));
const width = reference.source.pdf_points.width * reference.source.render_scale;
const height = reference.source.pdf_points.height * reference.source.render_scale;
const expectedArea = 431.3858024691358;

function baseCandidate() {
  return {
    schema: "opentakeoff.takeoff_canvas.v1",
    sheets: [{ sheet_id: "sample-plan.pdf", units_per_px: reference.scale.feet_per_image_px, scale_source: "upp", scale_confirmed: false }],
    shapes: reference.rooms.map((room, i) => ({
      id: `shape-${i}`,
      sheet_id: "sample-plan.pdf",
      label: room.label,
      measure_role: "floor_area",
      verts_norm: room.verts_px.map(([x, y]) => [x / width, y / height]),
      computed: { area_sf: expectedArea },
      origin: { actor: "agent", reviewed: false },
    })),
  };
}

test("exact positive export passes", () => assert.equal(scoreCandidate(baseCandidate(), reference).pass, true));

test("detected scale source remains valid when units match", () => {
  const candidate = baseCandidate();
  candidate.sheets[0].scale_source = "detected";
  assert.equal(scoreCandidate(candidate, reference).pass, true);
});

test("equal-area shifted polygon fails intersection and boundary gates", () => {
  const candidate = baseCandidate();
  candidate.shapes[0].verts_norm = candidate.shapes[0].verts_norm.map(([x, y]) => [x + 10 / width, y]);
  const row = scoreCandidate(candidate, reference).rooms[0];
  assert.equal(row.pass, false);
  assert.ok(row.overlap_iou < reference.tolerances.overlap_iou);
});

test("same-bounding-box nonrectangle fails spatial gates", () => {
  const candidate = baseCandidate();
  const room = reference.rooms[0];
  candidate.shapes[0].verts_norm = [
    [room.verts_px[0][0] / width, room.verts_px[0][1] / height],
    [room.verts_px[1][0] / width, room.verts_px[1][1] / height],
    [(room.verts_px[2][0] - 487) / width, (room.verts_px[2][1] + 287) / height],
    [room.verts_px[2][0] / width, room.verts_px[2][1] / height],
    [room.verts_px[3][0] / width, room.verts_px[3][1] / height],
  ];
  candidate.shapes[0].computed.area_sf = expectedArea * 0.75;
  const result = scoreCandidate(candidate, reference);
  assert.equal(result.pass, false);
  assert.ok(Math.abs(result.rooms[0].overlap_iou - 0.75) < 1e-9);
  assert.ok(result.rooms[0].boundary_vertex_edge_px > reference.tolerances.boundary_max_px);
});

test("missing computed quantity fails only that room", () => {
  const candidate = baseCandidate();
  delete candidate.shapes[0].computed;
  const result = scoreCandidate(candidate, reference);
  assert.equal(result.rooms[0].reason, "missing or invalid computed.area_sf");
  assert.equal(result.rooms[1].pass, true);
});

test("wrong scale and wrong sheet metadata fail", () => {
  const scale = baseCandidate();
  scale.sheets[0].units_per_px *= 2;
  assert.match(scoreCandidate(scale, reference).metadata_error, /units_per_px/);
  const sheet = baseCandidate();
  sheet.sheets[0].sheet_id = "other.pdf";
  assert.match(scoreCandidate(sheet, reference).metadata_error, /sheet/);
});

test("self-intersection, repeated vertex, holes, and extra shapes fail independently", () => {
  const self = baseCandidate();
  self.shapes[0].verts_norm = [[0.1, 0.5], [0.5, 0.85], [0.5, 0.5], [0.1, 0.85]];
  assert.match(scoreCandidate(self, reference).rooms[0].reason, /self-intersecting/);
  const repeated = baseCandidate();
  repeated.shapes[0].verts_norm[1] = repeated.shapes[0].verts_norm[0];
  assert.match(scoreCandidate(repeated, reference).rooms[0].reason, /repeated/);
  const holes = baseCandidate();
  holes.shapes[0].verts_norm_holes = [[[0.2, 0.2], [0.3, 0.2], [0.3, 0.3]]];
  assert.match(scoreCandidate(holes, reference).rooms[0].reason, /verts_norm_holes/);
  const extra = baseCandidate();
  extra.shapes.push({ ...extra.shapes[0], id: "extra", label: "EXTRA" });
  assert.equal(scoreCandidate(extra, reference).pass, false);
});

test("CLI positive prints JSON and negative exits nonzero", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ot-score-cli-"));
  try {
    const candidatePath = resolve(dir, "candidate.json");
    const candidate = baseCandidate();
    writeFileSync(candidatePath, JSON.stringify(candidate));
    const script = fileURLToPath(new URL("./score.mjs", import.meta.url));
    const positive = spawnSync(process.execPath, [script, candidatePath], { encoding: "utf8" });
    assert.equal(positive.status, 0);
    assert.equal(JSON.parse(positive.stdout).pass, true);
    candidate.shapes[0].label = "WRONG";
    writeFileSync(candidatePath, JSON.stringify(candidate));
    const negative = spawnSync(process.execPath, [script, candidatePath], { encoding: "utf8" });
    assert.notEqual(negative.status, 0);
    assert.equal(JSON.parse(negative.stdout).pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("missing and duplicate room labels fail independently", () => {
  const missing = baseCandidate();
  missing.shapes.pop();
  assert.match(scoreCandidate(missing, reference).rooms[3].reason, /missing candidate label/);
  const duplicate = baseCandidate();
  duplicate.shapes.push({ ...duplicate.shapes[0], id: "duplicate" });
  assert.match(scoreCandidate(duplicate, reference).rooms[0].reason, /duplicate candidate labels/);
});

test("frozen agent pilot retains first-pass failure and assisted success", () => {
  const first = JSON.parse(readFileSync(new URL("./evidence/first-pass.takeoff.json", import.meta.url), "utf8"));
  const assisted = JSON.parse(readFileSync(new URL("./evidence/assisted.takeoff.json", import.meta.url), "utf8"));
  assert.equal(scoreCandidate(first, reference).pass, false);
  const corrected = scoreCandidate(assisted, reference);
  assert.equal(corrected.pass, true);
  for (const room of corrected.rooms) {
    assert.equal(room.overlap_iou, 1);
    assert.equal(room.boundary_vertex_edge_px, 0);
  }
});

test("legacy profile output is byte-for-byte unchanged against frozen evidence", () => {
  const assisted = JSON.parse(readFileSync(new URL("./evidence/assisted.takeoff.json", import.meta.url), "utf8"));
  const expectedWrapped = JSON.parse(readFileSync(new URL("./evidence/assisted.score.json", import.meta.url), "utf8"));
  const result = scoreCandidate(assisted, reference);
  // evidence/assisted.score.json is the CLI's wrapper ({ candidate: <path>, ...scoreCandidate(...) });
  // scoreCandidate() itself never emits the "candidate" key, so re-add it before comparing.
  assert.deepEqual({ candidate: "assisted.takeoff.json", ...result }, expectedWrapped);
  assert.equal(Object.hasOwn(result, "profile"), false);
  for (const room of result.rooms) assert.equal(Object.hasOwn(room, "finish"), false);
});

// ---- estimator-trace profile ----

// Shoelace formula, independently re-derived here only to build exact test
// fixtures (expected areas); it is not used to validate score.mjs's own math.
function shoelaceArea(ring) {
  return Math.abs(ring.reduce((sum, [x, y], i) => {
    const [nx, ny] = ring[(i + 1) % ring.length];
    return sum + x * ny - nx * y;
  }, 0) / 2);
}

test("polygonIntersectionArea: concave reference ring b is triangulated and clipped correctly", () => {
  // Convex vs. convex control: two 10x10 squares offset by (5,5) overlap in
  // the 5x5 square [5,10]x[5,10] -> area 25. This exercises the untouched
  // convex fast path and must match the analytic overlap exactly.
  const squareA = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const squareB = [[5, 5], [15, 5], [15, 15], [5, 15]];
  const analyticOverlap = [[5, 5], [10, 5], [10, 10], [5, 10]];
  assert.equal(polygonIntersectionArea(squareA, squareB), shoelaceArea(analyticOverlap));
  assert.ok(Math.abs(polygonIntersectionArea(squareA, squareB) - 25) < 1e-9);

  // Concave L-shaped b: full 10x10 square minus its top-right 5x5 quadrant.
  // b = bottom strip [0,10]x[0,5]  (area 50)
  //   + left-upper block [0,5]x[5,10] (area 25)   -> area(b) = 75
  const bConcave = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]];
  assert.ok(Math.abs(shoelaceArea(bConcave) - 75) < 1e-9);

  // a = square [3,8]x[3,8] (area 25).
  const a = [[3, 3], [8, 3], [8, 8], [3, 8]];
  // a is convex, b is concave -> exercises the new triangulate(b) branch.
  // a ∩ bottom strip [0,10]x[0,5]:   x[3,8]∩[0,10]=[3,8] (5), y[3,8]∩[0,5]=[3,5] (2) -> 5*2=10
  // a ∩ upper-left block [0,5]x[5,10]: x[3,8]∩[0,5]=[3,5] (2), y[3,8]∩[5,10]=[5,8] (3) -> 2*3=6
  // total = 10 + 6 = 16
  assert.ok(Math.abs(polygonIntersectionArea(a, bConcave) - 16) < 1e-9);
});

function buildTraceFixture() {
  const width = 1000;
  const height = 1000;
  const plainRoom = {
    label: "PATIENT ROOM 137",
    finish: "CPT-1",
    verts_px: [[100, 100], [500, 100], [500, 400], [100, 400]],
  };
  // Rectangle [100,500]x[500,800] (400x300=120000) with a jamb notch bitten
  // out of the top edge: 30px wide (x:250-280), 8px deep (y:500-508).
  const notchedRoom = {
    label: "EXAM ROOM 210",
    finish: "VCT-1",
    verts_px: [
      [100, 500], [250, 500], [250, 508], [280, 508], [280, 500],
      [500, 500], [500, 800], [100, 800],
    ],
  };
  const plainArea = shoelaceArea(plainRoom.verts_px);
  const notchedArea = shoelaceArea(notchedRoom.verts_px);
  assert.ok(Math.abs(plainArea - 120000) < 1e-9);
  assert.ok(Math.abs(notchedArea - 119760) < 1e-9); // 120000 - 30*8

  const reference = {
    reference_id: "test-estimator-trace-fixture",
    profile: "estimator-trace",
    source: {
      path: "demo/sample-finish-plan.pdf",
      sha256: "0".repeat(64),
      page: 1,
      pdf_points: { width, height },
      render_scale: 1,
      kind: "synthetic test fixture",
    },
    scale: { feet_per_image_px: 1, description: "1 image px = 1 foot (test fixture)" },
    wall_semantics: "interior-face",
    rooms: [plainRoom, notchedRoom],
    tolerances: { area_percent: 0.75, overlap_iou: 0.985, boundary_max_px: 2.5 },
    review: { human_reviewed: false },
  };
  const expectedSheet = "sample-finish-plan.pdf";
  return { reference, width, height, plainRoom, notchedRoom, plainArea, notchedArea, expectedSheet };
}

function traceCandidate({ expectedSheet, scale, shapes }) {
  return {
    schema: "opentakeoff.takeoff_canvas.v1",
    sheets: [{ sheet_id: expectedSheet, units_per_px: scale, scale_source: "upp", scale_confirmed: false }],
    conditions: [
      { id: "c-cpt", finish_tag: "CPT-1" },
      { id: "c-vct", finish_tag: "VCT-1" },
    ],
    shapes,
  };
}

function toVertsNorm(verts_px, width, height) {
  return verts_px.map(([x, y]) => [x / width, y / height]);
}

test("estimator-trace: exact trace of a concave and a plain room passes with IoU 1 and boundary 0", () => {
  const { reference, width, height, plainRoom, notchedRoom, plainArea, notchedArea, expectedSheet } = buildTraceFixture();
  const candidate = traceCandidate({
    expectedSheet,
    scale: reference.scale.feet_per_image_px,
    shapes: [
      {
        id: "shape-1", sheet_id: expectedSheet, label: plainRoom.label, measure_role: "floor_area",
        condition_id: "c-cpt", verts_norm: toVertsNorm(plainRoom.verts_px, width, height),
        computed: { area_sf: plainArea },
      },
      {
        id: "shape-2", sheet_id: expectedSheet, label: notchedRoom.label, measure_role: "floor_area",
        condition_id: "c-vct", verts_norm: toVertsNorm(notchedRoom.verts_px, width, height),
        computed: { area_sf: notchedArea },
      },
    ],
  });
  const result = scoreCandidate(candidate, reference);
  assert.equal(result.profile, "estimator-trace");
  assert.equal(result.pass, true);
  for (const room of result.rooms) {
    // The notched room's overlap is computed via triangulation (concave
    // ring), so it is exact only up to floating-point summation error,
    // unlike the convex clip path's bit-exact results.
    assert.ok(Math.abs(room.overlap_iou - 1) < 1e-9);
    assert.ok(room.boundary_vertex_edge_px < 1e-9);
    assert.ok("finish" in room);
  }
});

test("estimator-trace: skipping the notch passes area/IoU but fails the boundary gate", () => {
  const { reference, width, height, plainRoom, notchedRoom, plainArea, expectedSheet } = buildTraceFixture();
  const outerRectOnly = [[100, 500], [500, 500], [500, 800], [100, 800]];
  const candidate = traceCandidate({
    expectedSheet,
    scale: reference.scale.feet_per_image_px,
    shapes: [
      {
        id: "shape-1", sheet_id: expectedSheet, label: plainRoom.label, measure_role: "floor_area",
        condition_id: "c-cpt", verts_norm: toVertsNorm(plainRoom.verts_px, width, height),
        computed: { area_sf: plainArea },
      },
      {
        // Drawn as the plain outer rectangle -- the jamb notch was skipped.
        id: "shape-2", sheet_id: expectedSheet, label: notchedRoom.label, measure_role: "floor_area",
        condition_id: "c-vct", verts_norm: toVertsNorm(outerRectOnly, width, height),
        computed: { area_sf: shoelaceArea(outerRectOnly) },
      },
    ],
  });
  const result = scoreCandidate(candidate, reference);
  assert.equal(result.pass, false);
  const plainRow = result.rooms.find((row) => row.label === plainRoom.label);
  const notchedRow = result.rooms.find((row) => row.label === notchedRoom.label);
  assert.equal(plainRow.pass, true);
  assert.equal(notchedRow.overlap_iou >= reference.tolerances.overlap_iou, true);
  assert.ok(notchedRow.boundary_vertex_edge_px > reference.tolerances.boundary_max_px);
  assert.equal(notchedRow.pass, false);
});

function buildDualFinishReference() {
  const width = 1000;
  const height = 1000;
  const roomCarpet = {
    label: "CONFERENCE/BREAK ROOM 134",
    finish: "CPT-1",
    verts_px: [[0, 0], [200, 0], [200, 100], [0, 100]],
  };
  const roomTile = {
    label: "CONFERENCE/BREAK ROOM 134",
    finish: "VCT-1",
    verts_px: [[0, 100], [200, 100], [200, 200], [0, 200]],
  };
  const reference = {
    reference_id: "test-estimator-trace-dual-finish",
    profile: "estimator-trace",
    source: {
      path: "demo/sample-finish-plan.pdf",
      sha256: "0".repeat(64),
      pdf_points: { width, height },
      render_scale: 1,
      kind: "synthetic test fixture",
    },
    scale: { feet_per_image_px: 1, description: "test" },
    rooms: [roomCarpet, roomTile],
    tolerances: { area_percent: 0.75, overlap_iou: 0.985, boundary_max_px: 2.5 },
  };
  return { reference, width, height, roomCarpet, roomTile, expectedSheet: "sample-finish-plan.pdf" };
}

test("estimator-trace: same label with two finishes matches each separately", () => {
  const { reference, width, height, roomCarpet, roomTile, expectedSheet } = buildDualFinishReference();
  const candidate = traceCandidate({
    expectedSheet,
    scale: reference.scale.feet_per_image_px,
    shapes: [
      {
        id: "shape-1", sheet_id: expectedSheet, label: roomCarpet.label, measure_role: "floor_area",
        condition_id: "c-cpt", verts_norm: toVertsNorm(roomCarpet.verts_px, width, height),
        computed: { area_sf: shoelaceArea(roomCarpet.verts_px) },
      },
      {
        id: "shape-2", sheet_id: expectedSheet, label: roomTile.label, measure_role: "floor_area",
        condition_id: "c-vct", verts_norm: toVertsNorm(roomTile.verts_px, width, height),
        computed: { area_sf: shoelaceArea(roomTile.verts_px) },
      },
    ],
  });
  const result = scoreCandidate(candidate, reference);
  assert.equal(result.pass, true);
  assert.equal(result.rooms.length, 2);
  assert.ok(result.rooms.every((row) => row.pass));
  assert.deepEqual(result.rooms.map((row) => row.finish).sort(), ["CPT-1", "VCT-1"]);
});

test("estimator-trace: both shapes collapsed onto one finish leaves one key duplicated and one missing", () => {
  // NOTE: with an exact (label, finish) matching key, collapsing both
  // candidate shapes onto the SAME valid finish tag necessarily produces a
  // duplicate at that key (2 shapes claim it) and a missing at the other
  // key (0 shapes claim it) -- there is no way for one of the two to
  // resolve as a clean "match" once both keys are identical, since the
  // match set is keyed exactly, not first-come-first-served. This is the
  // faithful outcome of "missing and duplicate keys fail like today's
  // missing/duplicate labels" for this profile.
  const { reference, width, height, roomCarpet, roomTile, expectedSheet } = buildDualFinishReference();
  const candidate = traceCandidate({
    expectedSheet,
    scale: reference.scale.feet_per_image_px,
    shapes: [
      {
        id: "shape-1", sheet_id: expectedSheet, label: roomCarpet.label, measure_role: "floor_area",
        condition_id: "c-cpt", verts_norm: toVertsNorm(roomCarpet.verts_px, width, height),
        computed: { area_sf: shoelaceArea(roomCarpet.verts_px) },
      },
      {
        // Should have been condition_id "c-vct" (finish VCT-1); mis-tagged
        // onto the same CPT-1 condition as shape-1.
        id: "shape-2", sheet_id: expectedSheet, label: roomTile.label, measure_role: "floor_area",
        condition_id: "c-cpt", verts_norm: toVertsNorm(roomTile.verts_px, width, height),
        computed: { area_sf: shoelaceArea(roomTile.verts_px) },
      },
    ],
  });
  const result = scoreCandidate(candidate, reference);
  assert.equal(result.pass, false);
  const cptRow = result.rooms.find((row) => row.finish === "CPT-1");
  const vctRow = result.rooms.find((row) => row.finish === "VCT-1");
  assert.match(cptRow.reason, /duplicate candidate labels/);
  assert.match(vctRow.reason, /missing candidate label/);
  // No third "extra" row: both mis-tagged shapes still key to a valid
  // reference (label, finish) pair, so the closed-world extra check does
  // not fire for either of them.
  assert.equal(result.rooms.length, 2);
});

test("estimator-trace: multi-page sheet id requires the #<page> suffix", () => {
  const { reference, width, height, plainRoom, plainArea } = buildTraceFixture();
  reference.source.page = 2;
  const wrongPageCandidate = traceCandidate({
    expectedSheet: "sample-finish-plan.pdf", // page-1 naming, missing "#2"
    scale: reference.scale.feet_per_image_px,
    shapes: [
      {
        id: "shape-1", sheet_id: "sample-finish-plan.pdf", label: plainRoom.label, measure_role: "floor_area",
        condition_id: "c-cpt", verts_norm: toVertsNorm(plainRoom.verts_px, width, height),
        computed: { area_sf: plainArea },
      },
    ],
  });
  const result = scoreCandidate(wrongPageCandidate, reference);
  assert.match(result.metadata_error, /wrong target sheet: expected sample-finish-plan\.pdf#2/);

  const rightPageCandidate = traceCandidate({
    expectedSheet: "sample-finish-plan.pdf#2",
    scale: reference.scale.feet_per_image_px,
    shapes: [
      {
        id: "shape-1", sheet_id: "sample-finish-plan.pdf#2", label: plainRoom.label, measure_role: "floor_area",
        condition_id: "c-cpt", verts_norm: toVertsNorm(plainRoom.verts_px, width, height),
        computed: { area_sf: plainArea },
      },
    ],
  });
  const okResult = scoreCandidate(rightPageCandidate, reference);
  assert.equal(okResult.metadata_error, null);
});


test("estimator-trace: a small room passes when the reported SF differs from the ring only by the 0.01 SF rounding quantum, and fails beyond it", () => {
  // 4.25 SF pantry at 36 px/ft: a 55.1 x 100 px ring is 5510 px^2 = 4.2515 SF; the server reports 4.25.
  const scale = 1 / 36;
  const reference = {
    reference_id: "rounding-quantum", profile: "estimator-trace",
    source: { path: "demo/tiny.pdf", sha256: "0", page: 1, pdf_points: { width: 500, height: 500 }, render_scale: 2 },
    scale: { feet_per_image_px: scale },
    rooms: [{ label: "PANTRY", finish: "LVP", verts_px: [[100, 100], [155.1, 100], [155.1, 200], [100, 200]] }],
    tolerances: { area_percent: 0.75, overlap_iou: 0.985, boundary_max_px: 2.5 },
  };
  const candidate = (areaSf) => ({
    sheets: [{ sheet_id: "tiny.pdf", units_per_px: scale, scale_source: "upp", scale_confirmed: false }],
    conditions: [{ id: "c1", finish_tag: "LVP" }],
    shapes: [{ id: "s1", sheet_id: "tiny.pdf", condition_id: "c1", measure_role: "floor_area", label: "PANTRY",
      verts_norm: reference.rooms[0].verts_px.map(([x, y]) => [x / 1000, y / 1000]), computed: { area_sf: areaSf } }],
  });
  const exact = 5510 * scale * scale; // 4.2515...
  assert.ok(Math.abs(exact - 4.25) / 4.25 * 100 > 0.01, "the fixture must exceed the 0.01 % gate by rounding alone");
  assert.equal(scoreCandidate(candidate(4.25), reference).pass, true);
  assert.equal(scoreCandidate(candidate(4.27), reference).pass, false);
});
