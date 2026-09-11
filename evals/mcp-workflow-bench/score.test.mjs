import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCandidate } from "./score.mjs";

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
