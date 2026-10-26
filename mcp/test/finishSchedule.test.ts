// The bundled demo's MATERIAL SCHEDULE (demo/sample-finish-plan.pdf, sheet
// AF600), read by the sheet graph the way an agent's resolve_tag reads it.
// The sheet prints six section headings (FLOORING, BASE, WALLS, MILLWORK,
// CEILINGS, MISC. FINISHES) in the key column and a code legend right beside
// REMARKS. The expected rows below are read off the rendered sheet, not off
// this engine's output: 28 rows, in order, each under its printed section;
// eight REMARKS cells; no legend text in any cell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";
import type { ScheduleTable } from "../../web/src/lib/sheetgraph.ts";

const PLAN_PDF = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));

const KEYS = [
  "CPT-1", "CPT-2", "VCT-1", "PT-1", "PT-2", "C",
  "RB-1", "CBT-1", "CT-3",
  "P-1", "P-2", "P-3", "CT-1", "CT-2", "CT-4", "SC-1",
  "PLAM-1", "PLAM-2", "S-1", "S-2",
  "ACT-1", "ACT-2",
  "PR-1", "TS-1", "TS-2", "HR-1", "CR-1", "CG-1",
];
const SECTIONS: Array<[string, number]> = [["FLOORING", 6], ["BASE", 3], ["WALLS", 7], ["MILLWORK", 4], ["CEILINGS", 2], ["MISC", 6]];

let session: Session | null = null;
async function load() {
  if (!session) { session = new Session(); await session.loadPlan(PLAN_PDF); }
  return session;
}
async function materialSchedule(): Promise<ScheduleTable> {
  const s = await load();
  await s.sheetGraph();
  const t = (s as unknown as { graph: { tables: ScheduleTable[] } }).graph.tables.filter((x) => x.kind === "finish");
  assert.equal(t.length, 1, "one material schedule on the set");
  return t[0];
}

test("the demo material schedule reads its 28 rows, in order, with no heading or legend row", async () => {
  const t = await materialSchedule();
  assert.deepEqual(t.rows.map((r) => r.key), KEYS);
  const s = await load();
  const found = await s.findSchedule("finish");
  assert.equal(found.matches[0].rows, 28);
});

test("every row carries the section printed above it", async () => {
  const t = await materialSchedule();
  let at = 0;
  for (const [section, n] of SECTIONS) {
    const rows = t.rows.slice(at, at + n);
    assert.deepEqual(rows.map((r) => r.section), Array(n).fill(section), `${section}: ${rows.map((r) => r.key).join(", ")}`);
    at += n;
  }
  assert.equal(at, t.rows.length);
});

test("cells: the paint rows keep MATERIAL, REMARKS holds its eight cells, and no legend text lands anywhere", async () => {
  const t = await materialSchedule();
  const cell = (k: string, col: string) => t.rows.find((r) => r.key === k)?.cells[col]?.text;
  for (const k of ["P-1", "P-2", "P-3"]) {
    assert.equal(cell(k, "CODE"), k);
    assert.equal(cell(k, "MATERIAL"), "PAINT");
  }
  const remarks = Object.fromEntries(t.rows.filter((r) => r.cells.REMARKS).map((r) => [r.key, r.cells.REMARKS.text]));
  assert.deepEqual(Object.keys(remarks), ["PT-1", "PT-2", "CT-1", "CT-2", "CT-4", "PLAM-1", "PLAM-2", "S-1"]);
  for (const k of ["PT-1", "PT-2", "CT-1", "CT-2", "CT-4"]) assert.match(remarks[k], /^GROUT: /, k);
  assert.doesNotMatch(remarks["PT-2"], /FLOOR FINISH/);
  assert.equal(remarks["PLAM-1"], "60 MATTE");
  assert.equal(remarks["PLAM-2"], "38 FINE VELVET");
  assert.equal(remarks["S-1"], "MATTE");
  // the legend beside REMARKS spells out codes the schedule does not use
  const all = t.rows.flatMap((r) => Object.values(r.cells).map((c) => c.text));
  for (const legend of ["GYPSUM WALLBACK", "RESINOUS", "RUBBER FLOORING", "WELDED SEAM", "LUXURY VINYL", "SPECIAL FACED", "CORNER GUARD AF", "PROTECTION", "NOT ALL SYMBOLS"]) {
    assert.ok(!all.some((c) => c.includes(legend)), `legend text "${legend}" is in no cell`);
  }
  assert.ok(!all.some((c) => /^(FLOORING|BASE|WALLS|MILLWORK|CEILINGS|MISC\. FINISHES)$/.test(c)), "no heading in any cell");
});

test("resolve_tag chains a room's paint to its definition: P-1 is PAINT", async () => {
  const s = await load();
  const res = await s.resolveRoomTag("3A");
  assert.equal(res.status, "resolved");
  if (res.status !== "resolved") return;
  const north = res.finishes.find((f) => f.surface === "NORTH");
  assert.equal(north?.code, "P-1");
  assert.equal(north?.definition?.cells.CODE, "P-1");
  assert.equal(north?.definition?.cells.MATERIAL, "PAINT");
  assert.equal(north?.definition?.cells.REMARKS, undefined, "no legend text in the definition");
});
