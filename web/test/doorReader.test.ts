// The door reader (engine/door-reader, Rust → WebAssembly) on the bundled
// public demo plan: the committed module loads, reads the plan's swings at the
// drawing's own scale, and answers the same way twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractDoorVectors } from "../src/lib/doorVectors.ts";
import { readDoors, readDoorsSync, splitDoors, DOOR_CUTOFFS, DOOR_DOUBTS } from "../src/lib/doorReader.ts";
import type { OpsTable } from "../src/lib/oneclick.ts";

async function demoVectors() {
  const data = new Uint8Array(readFileSync(new URL("../../demo/sample-finish-plan.pdf", import.meta.url)));
  const doc = await pdfjs.getDocument({ data, verbosity: 0, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const v = extractDoorVectors((await page.getOperatorList()) as never, page.getViewport({ scale: 1, rotation: 0 }).transform, pdfjs.OPS as unknown as OpsTable);
  await doc.destroy();
  return v;
}

test("door reader reads the demo plan's swings at its 1/8\" scale", async () => {
  const v = await demoVectors();
  const got = await readDoors(v);
  assert.equal(got.scaleSource, "arcs");
  assert.ok(Math.abs(1 / (got.fpp as number) - 9) < 0.1, `points per foot ${1 / (got.fpp as number)}`);   // 1/8" = 1'-0" is 9 pt/ft
  // measured 2026-11-12 on engine/door-reader as committed; a rule change that moves this must say why in its PR
  assert.equal(got.doors.length, 81);
  for (const d of got.doors) {
    assert.ok(d.box[2] > d.box[0] && d.box[3] > d.box[1]);
    for (const l of d.leaves) assert.ok(l.radiusPt * (got.fpp as number) >= 1.45 && l.radiusPt * (got.fpp as number) <= 4.6);
  }
  assert.equal(got.doors.filter((d) => d.pair).length, 2);
  // the jamb-to-jamb line: hinge to hinge for a pair; for one leaf, from its hinge and one leaf long (to the closed end or the leaf's tip)
  for (const d of got.doors) {
    const [p, q] = d.jambLine, len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    assert.deepEqual(p, d.leaves[0].hinge);
    if (d.pair) assert.deepEqual(q, d.leaves[1].hinge);
    else assert.ok(Math.abs(len - d.leaves[0].radiusPt) <= 0.25 * d.leaves[0].radiusPt, `jamb line ${len} pt for a ${d.leaves[0].radiusPt} pt leaf`);
  }
  // measured 2026-11-14: on this plan the wall runs on past the leaf line, not the closed line, for this many single doors
  const onTip = got.doors.filter((d) => !d.pair && d.jambLine[1][0] === d.leaves[0].tip[0] && d.jambLine[1][1] === d.leaves[0].tip[1]).length;
  assert.equal(onTip, 16);
  // committed / withheld at the frozen cutoffs (round 2): every withheld door keeps its reasons
  assert.equal(splitDoors(got, DOOR_CUTOFFS.foundFirst).committed.length, 81);
  const p = splitDoors(got, DOOR_CUTOFFS.precisionFirst);
  assert.equal(p.committed.length, 78);
  for (const d of p.withheld) { assert.ok(d.doubts.length > 0); assert.ok(d.doubts.every((x) => (DOOR_DOUBTS as readonly string[]).includes(x))); }
});

test("door reader is deterministic and honours a given scale", async () => {
  const v = await demoVectors();
  const a = await readDoors(v);
  const b = readDoorsSync(v);
  assert.deepEqual(a, b);
  const given = readDoorsSync(v, 1 / 9);
  assert.equal(given.scaleSource, "given");
  assert.equal(given.doors.length, a.doors.length);
});

test("door reader returns nothing on an empty page", async () => {
  const got = await readDoors({ items: new Float64Array(0), paths: new Float64Array(0), nItems: 0, nPaths: 0 });
  assert.deepEqual(got, { doors: [], fpp: null, scaleSource: "none", arcs: 0 });
  assert.deepEqual(splitDoors(got), { committed: [], withheld: [] });
});
