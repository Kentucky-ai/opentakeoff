// hatchFamilies — the context view of the hatch sweep (issue #29).
//
// The classifier (classifyHatchSegs) and the family view (hatchFamilies) share
// one sweep; these tests pin the family half: the (angle, pitch, pen-width)
// signature is reported faithfully, and the content-derived id delivers the
// property the feature exists for — two instances of the same pattern spec,
// drawn in different places (a legend swatch and the plan region it labels),
// get the SAME id, while a different spec gets a different one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hatchFamilies, classifyHatchSegs, SEG_CURVE } from "../src/lib/oneclick.ts";

/** A vertical-line hatch field: lines at `pitch` apart, penW in the meta high
 * nibble — the synthetic pattern geometry.test.ts already floods against. */
function hatchField(x0: number, y0: number, x1: number, y1: number, pitch: number, penW: number, segs: number[], meta: number[]): void {
  for (let x = x0; x <= x1; x += pitch) {
    segs.push(x, y0, x, y1);
    meta.push(penW << 4);
  }
}

test("hatchFamilies: signature reported faithfully — angle, pitch, pen width, rows", () => {
  const segs: number[] = [], meta: number[] = [];
  hatchField(100, 100, 700, 500, 4, 1, segs, meta);
  const fams = hatchFamilies(segs, Uint8Array.from(meta));
  assert.equal(fams.length, 1, "one field, one family");
  const f = fams[0];
  assert.equal(f.angle_deg, 90, "vertical lines fold to 90°");
  assert.equal(f.pitch_px, 4, "the drawing pitch, in image px");
  assert.equal(f.pen_w_px, 1);
  assert.equal(f.rows, segs.length >> 2, "every line is a row");
  assert.equal(f.segments, segs.length >> 2);
  // tight bbox over the members
  assert.deepEqual(f.bbox, [100, 100, 700, 500]);
  // memberIdx addresses the caller's segs array
  assert.ok(f.memberIdx.every((i) => i >= 0 && i < (segs.length >> 2)));
});

test("hatchFamilies: the legend-match property — same spec, different place, SAME id", () => {
  const segs: number[] = [], meta: number[] = [];
  hatchField(100, 100, 400, 400, 6, 1, segs, meta);   // "plan region"
  hatchField(900, 700, 1000, 760, 6, 1, segs, meta);  // "legend swatch", far away
  const fams = hatchFamilies(segs, Uint8Array.from(meta));
  assert.equal(fams.length, 2, "two instances, reported separately");
  assert.equal(fams[0].id, fams[1].id, "same (angle, pitch, penW) spec ⇒ same id — matching is id === id");
  assert.notDeepEqual(fams[0].bbox, fams[1].bbox, "…but they are distinct instances in distinct places");
});

test("hatchFamilies: a different pattern spec gets a different id", () => {
  const segs: number[] = [], meta: number[] = [];
  hatchField(100, 100, 400, 400, 6, 1, segs, meta);   // 6px pitch, hairline
  hatchField(900, 100, 1200, 400, 12, 2, segs, meta); // 12px pitch, heavier pen
  const fams = hatchFamilies(segs, Uint8Array.from(meta));
  assert.equal(fams.length, 2);
  assert.notEqual(fams[0].id, fams[1].id, "pitch and pen width both separate the ids");
});

test("hatchFamilies: id is deterministic across calls and unaffected by unrelated linework", () => {
  const base: number[] = [], baseMeta: number[] = [];
  hatchField(100, 100, 400, 400, 6, 1, base, baseMeta);
  const alone = hatchFamilies(base, Uint8Array.from(baseMeta));

  // same field plus walls and a door swing elsewhere on the sheet
  const segs = base.slice(), meta = baseMeta.slice();
  segs.push(600, 100, 1100, 100); meta.push(4 << 4);          // a heavy wall
  segs.push(600, 100, 600, 500); meta.push(4 << 4);
  segs.push(700, 300, 760, 360); meta.push(SEG_CURVE);        // door-swing chord
  const crowded = hatchFamilies(segs, Uint8Array.from(meta));

  assert.equal(alone.length, 1);
  assert.equal(crowded.length, 1, "walls and curves never join a family");
  assert.equal(alone[0].id, crowded[0].id, "the id depends on the pattern, not the neighborhood");
});

test("hatchFamilies and classifyHatchSegs agree on membership (one sweep, two views)", () => {
  const segs: number[] = [], meta: number[] = [];
  hatchField(100, 100, 700, 500, 4, 1, segs, meta);
  const n = segs.length >> 2;
  // heavy-pen overprint riding the field's rhythm — a member, but wall-guarded
  segs.push(400.5, 100, 400.5, 500); meta.push(4 << 4);
  const fams = hatchFamilies(segs, Uint8Array.from(meta));
  const soft = classifyHatchSegs(segs, Uint8Array.from(meta), 1);
  assert.equal(fams.length, 1);
  const members = new Set(fams[0].memberIdx);
  // every softened segment is a member of some family…
  for (let i = 0; i <= n; i++) if (soft[i]) assert.ok(members.has(i), `soft ${i} must be a family member`);
  // …but membership is wider than softness: the guards keep walls hard
  assert.ok(members.has(n), "the heavy overprint is a member of the family");
  assert.equal(soft[n], 0, "…and still hard — the wall guard held");
});
