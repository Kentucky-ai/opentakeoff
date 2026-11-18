// Match-line stitching math + hydrate gates (lib/stitches.ts, #161 phase 1).
// The load-bearing contracts: the sanitize gate can never let a malformed
// stitch wedge hydrate (approvals precedent); offsets always normalize to a
// (0,0) min corner (verts_norm and extent depend on it); the seam split and
// the geometry merge keep hidden ink out of snap/mask inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStitchKey, mintStitchId, sanitizeStitches, normalizeMembers, autoButt,
  stitchExtent, memberBoxes, memberAtPoint, alignMembers, seamClips,
  mergePoints, mergeSegs, stitchAlive, stitchLayoutSig, stitchPagePlan, memberEmbed,
  checkSeamLinework,
} from "../src/lib/stitches.js";

const MAX = 4;
const dims = { A: { w: 100, h: 80 }, B: { w: 60, h: 80 }, C: { w: 40, h: 40 } };

test("keys: prefix discipline and minting", () => {
  assert.equal(isStitchKey("stitch:abc"), true);
  assert.equal(isStitchKey("plan.pdf#2"), false);
  assert.equal(isStitchKey(42), false);
  const id = mintStitchId();
  assert.ok(isStitchKey(id) && id.length > "stitch:".length);
});

test("sanitize: old payloads (no field) load as []", () => {
  assert.deepEqual(sanitizeStitches(undefined, MAX), []);
  assert.deepEqual(sanitizeStitches(null, MAX), []);
  assert.deepEqual(sanitizeStitches("nope", MAX), []);
});

test("sanitize: well-formed stitch passes, offsets normalized to (0,0)", () => {
  const out = sanitizeStitches([{ id: "stitch:x", name: "L1", members: [
    { key: "a.pdf", dx: 10, dy: 5 }, { key: "a.pdf#2", dx: 110, dy: 5 },
  ], created_at: "2026-08-01T00:00:00Z" }], MAX);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].members, [{ key: "a.pdf", dx: 0, dy: 0 }, { key: "a.pdf#2", dx: 100, dy: 0 }]);
  assert.equal(out[0].created_at, "2026-08-01T00:00:00Z");
});

test("sanitize: drops malformed entries without wedging the rest", () => {
  const good = { id: "stitch:ok", name: "ok", members: [{ key: "a", dx: 0, dy: 0 }, { key: "b", dx: 1, dy: 0 }] };
  const out = sanitizeStitches([
    null, 7, [],
    { id: "not-a-stitch", members: good.members },                              // bad id
    { id: "stitch:one", members: [{ key: "a", dx: 0, dy: 0 }] },                // < 2 members
    { id: "stitch:many", members: Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, dx: i, dy: 0 })) }, // > MAX
    { id: "stitch:nest", members: [{ key: "stitch:inner", dx: 0, dy: 0 }, { key: "b", dx: 1, dy: 0 }] },   // nesting
    { id: "stitch:dup", members: [{ key: "a", dx: 0, dy: 0 }, { key: "a", dx: 1, dy: 0 }] },               // dup member
    { id: "stitch:nan", members: [{ key: "a", dx: NaN, dy: 0 }, { key: "b", dx: 1, dy: 0 }] },             // non-finite
    good,
    { ...good },                                                                 // duplicate id — dropped
  ], MAX);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "stitch:ok");
});

test("sanitize: blank name falls back", () => {
  const out = sanitizeStitches([{ id: "stitch:x", name: "  ", members: [{ key: "a", dx: 0, dy: 0 }, { key: "b", dx: 1, dy: 0 }] }], MAX);
  assert.equal(out[0].name, "Stitched sheets");
});

test("normalizeMembers: no-op when already at origin (same content)", () => {
  const m = [{ key: "a", dx: 0, dy: 0 }, { key: "b", dx: 5, dy: 2 }];
  assert.deepEqual(normalizeMembers(m), m);
});

test("autoButt: flush left-to-right, no gap", () => {
  assert.deepEqual(autoButt(["A", "B"], dims), [{ key: "A", dx: 0, dy: 0 }, { key: "B", dx: 100, dy: 0 }]);
});

test("extent: bounding box over placed members", () => {
  const members = [{ key: "A", dx: 0, dy: 0 }, { key: "B", dx: 90, dy: 10 }];
  assert.deepEqual(stitchExtent(members, dims), { w: 150, h: 90 });
});

test("memberAtPoint: topmost wins inside overlap, nearest outside all", () => {
  const boxes = memberBoxes([{ key: "A", dx: 0, dy: 0 }, { key: "B", dx: 90, dy: 0 }], dims);
  assert.equal(memberAtPoint(boxes, 95, 40), 1);   // overlap strip → topmost (B)
  assert.equal(memberAtPoint(boxes, 10, 40), 0);   // clearly in A
  assert.equal(memberAtPoint(boxes, 200, 40), 1);  // off the row → nearest (B)
});

test("alignMembers: second click's member translates onto the anchor, then normalizes", () => {
  const members = [{ key: "A", dx: 0, dy: 0 }, { key: "B", dx: 100, dy: 0 }];
  // match point: (98, 40) on A ≡ (105, 44) on B → B moves by (-7, -4)
  const r = alignMembers(members, dims, [98, 40], [105, 44]);
  assert.ok("members" in r);
  assert.equal(r.movedKey, "B");
  assert.deepEqual(r.members, [{ key: "A", dx: 0, dy: 4 }, { key: "B", dx: 93, dy: 0 }]);
});

test("alignMembers: both clicks on one member is an error", () => {
  const members = [{ key: "A", dx: 0, dy: 0 }, { key: "B", dx: 100, dy: 0 }];
  const r = alignMembers(members, dims, [10, 10], [20, 20]);
  assert.ok("error" in r);
});

test("seamClips: horizontal overlap splits at the midline", () => {
  const members = [{ key: "A", dx: 0, dy: 0 }, { key: "B", dx: 80, dy: 0 }]; // A ends 100, B starts 80 → seam 90
  const clips = seamClips(members, dims);
  assert.equal(clips[0].x1, 90);
  assert.equal(clips[1].x0, 90);
  assert.equal(clips[0].x0, 0);
  assert.equal(clips[1].x1, 140);
});

test("seamClips: butt fit (no overlap) leaves full boxes", () => {
  const clips = seamClips(autoButt(["A", "B"], dims), dims);
  assert.deepEqual(clips[0], { x0: 0, y0: 0, x1: 100, y1: 80 });
  assert.deepEqual(clips[1], { x0: 100, y0: 0, x1: 160, y1: 80 });
});

test("seamClips: vertical chains split on y", () => {
  const members = [{ key: "A", dx: 0, dy: 0 }, { key: "C", dx: 0, dy: 60 }]; // A ends y=80, C starts y=60 → seam 70
  const clips = seamClips(members, dims);
  assert.equal(clips[0].y1, 70);
  assert.equal(clips[1].y0, 70);
});

test("mergePoints: offsets into stitch space, drops hidden (clipped-out) endpoints", () => {
  const clip = { x0: 0, y0: 0, x1: 90, y1: 80 };
  const pts = mergePoints([{ points: [[10, 10], [95, 10]], dx: 0, dy: 0, clip }]);
  assert.deepEqual(pts, [[10, 10]]);
});

test("mergeSegs: midpoint ownership — kept whole, never cut (hatch row spans survive)", () => {
  // A's row [0..100] (mid 50 ∈ A's box) rides whole even though it pokes past
  // the seam at 90; B's copy of the same strip [80..140]→ stage (mid 110 ∈ B's
  // box) also rides whole. Neither is cut — the classifier sees true spans.
  const A = { segs: [0, 5, 100, 5], meta: [7], imageArea: 50, dx: 0, dy: 0, clip: { x0: 0, y0: 0, x1: 90, y1: 80 } };
  const B = { segs: [0, 5, 60, 5], meta: [3], imageArea: 25, dx: 80, dy: 0, clip: { x0: 90, y0: 0, x1: 140, y1: 80 } };
  const m = mergeSegs([A, B]);
  assert.deepEqual(m.segs, [0, 5, 100, 5, 80, 5, 140, 5]);
  assert.deepEqual([...m.meta], [7, 3]);
  assert.equal(m.imageArea, 75);
});

test("mergeSegs: hidden phantom content (midpoint past the seam) is excluded exactly once", () => {
  // The same physical wall drawn by BOTH members (a cropbox-split set): L's
  // copy has its stage midpoint in R's territory → dropped from L, kept by R.
  const wallOnL = { segs: [3000, 10, 3100, 10], meta: [1], imageArea: 0, dx: 0, dy: 0, clip: { x0: 0, y0: 0, x1: 3024, y1: 100 } };
  const wallOnR = { segs: [278.5, 10, 378.5, 10], meta: [1], imageArea: 0, dx: 2721.5, dy: 0, clip: { x0: 3024, y0: 0, x1: 6048, y1: 100 } };
  const m = mergeSegs([wallOnL, wallOnR]);
  assert.equal(m.segs.length, 4);           // exactly one copy survives
  assert.deepEqual(m.segs, [3000, 10, 3100, 10]);
});

test("stitchAlive: every member's FILE must remain in the working set", () => {
  const st = { id: "stitch:x", name: "x", members: [{ key: "a.pdf", dx: 0, dy: 0 }, { key: "a.pdf#2", dx: 1, dy: 0 }] };
  assert.equal(stitchAlive(st, new Set(["a.pdf"])), true);
  assert.equal(stitchAlive(st, new Set(["b.pdf"])), false);
});

test("stitchLayoutSig: re-keys on offset changes, ignores non-stitch keys", () => {
  const st = [{ id: "stitch:x", name: "x", members: [{ key: "a", dx: 0, dy: 0 }, { key: "b", dx: 10, dy: 0 }] }];
  const s1 = stitchLayoutSig(["stitch:x", "plan.pdf"], st);
  const s2 = stitchLayoutSig(["stitch:x"], [{ ...st[0], members: [{ key: "a", dx: 0, dy: 0 }, { key: "b", dx: 12, dy: 0 }] }]);
  assert.notEqual(s1, s2);
  assert.equal(stitchLayoutSig(["plan.pdf"], st), "");
});

// ── marked-set composite page (#200) ────────────────────────────────────────

test("stitchPagePlan: extent + seam-clipped member boxes in one plan", () => {
  // A and B overlap 20px along x — the seam splits the overlap at its midline
  const members = [{ key: "A", dx: 0, dy: 0 }, { key: "B", dx: 80, dy: 0 }];
  const { extent, members: plan } = stitchPagePlan(members, dims);
  assert.deepEqual(extent, { w: 140, h: 80 });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { key: "A", dx: 0, dy: 0, clip: { x0: 0, y0: 0, x1: 90, y1: 80 } });
  assert.deepEqual(plan[1], { key: "B", dx: 80, dy: 0, clip: { x0: 90, y0: 0, x1: 140, y1: 80 } });
});

test("memberEmbed: matrix agrees with the definition for an unrotated page", () => {
  // pdf.js viewport transform at scale 2, unrotated page 300×200pt:
  // vx = 2·ux, vy = 2·(200 − uy) → T = [2, 0, 0, −2, 0, 400]
  const T = [2, 0, 0, -2, 0, 400];
  const m = { dx: 80, dy: 10, clip: { x0: 90, y0: 10, x1: 300, y1: 170 } };
  const pageH = 250;   // composite page height (points)
  const { bbox, matrix } = memberEmbed(T, m, pageH, 2);
  const [a, b, c, d, e, f] = matrix;
  const map = (ux: number, uy: number) => [a * ux + c * uy + e, b * ux + d * uy + f];
  // definition: page point = [(T(u).x + dx)/RS, pageH − (T(u).y + dy)/RS]
  const want = (ux: number, uy: number) => [(2 * ux + m.dx) / 2, pageH - (2 * (200 - uy) + m.dy) / 2];
  for (const [ux, uy] of [[0, 0], [300, 200], [123.4, 56.7]]) {
    const got = map(ux, uy), w = want(ux, uy);
    assert.ok(Math.abs(got[0] - w[0]) < 1e-9 && Math.abs(got[1] - w[1]) < 1e-9, `${ux},${uy}: ${got} vs ${w}`);
  }
  // bbox: the seam box mapped back to user space — member-local visual px
  // (clip − offset) through T⁻¹: x0v=10 → ux=5, y span [0,160]v → uy [120,200]
  assert.deepEqual(bbox, { left: 5, bottom: 120, right: 110, top: 200 });
});

test("memberEmbed: holds for a rotated (b,c ≠ 0) viewport transform", () => {
  // a 90°-rotated page's transform shape: vx = s·uy, vy = s·ux (one of the
  // quarter-turn forms) — the algebra must hold with a=d=0
  const s = 2, T = [0, s, s, 0, 0, 0];
  const m = { dx: 40, dy: 20, clip: { x0: 40, y0: 20, x1: 140, y1: 220 } };
  const pageH = 300;
  const { bbox, matrix } = memberEmbed(T, m, pageH, s);
  const [a, b, c, d, e, f] = matrix;
  const map = (ux: number, uy: number) => [a * ux + c * uy + e, b * ux + d * uy + f];
  const want = (ux: number, uy: number) => [(s * uy + m.dx) / s, pageH - (s * ux + m.dy) / s];
  for (const [ux, uy] of [[0, 0], [70, 30], [12.5, 99]]) {
    const got = map(ux, uy), w = want(ux, uy);
    assert.ok(Math.abs(got[0] - w[0]) < 1e-9 && Math.abs(got[1] - w[1]) < 1e-9, `${ux},${uy}: ${got} vs ${w}`);
  }
  // clip corners through T⁻¹: v=(0..100, 0..200) local → u=(v.y/s, v.x/s)
  assert.deepEqual(bbox, { left: 0, bottom: 0, right: 100, top: 50 });
});

test("checkSeamLinework: collinear alignment, offsets, and rotation gates", () => {
  const members = [{ key: "A", dx: 0, dy: 0 }, { key: "B", dx: 80, dy: 0 }];
  const testDims = { A: { w: 100, h: 100 }, B: { w: 100, h: 100 } };
  const upp = 0.05555555555555555; // 1/8" = 1'-0" (1.5 px = 1 inch)

  // 1. Clean alignment
  const segsA = new Float32Array([70, 50, 95, 50]);
  const segsB = new Float32Array([5, 50, 30, 50]);
  const exact = checkSeamLinework(members, testDims, { A: segsA, B: segsB }, upp);
  assert.equal(exact.passed, true);
  assert.equal(exact.withheld, false);
  assert.equal(exact.max_in, 0);
  assert.equal(exact.median_in, 0);
  assert.equal(exact.leftover_rotation_deg, 0);
  assert.equal(exact.sample_count, 1);
  assert.equal(exact.withheld_reasons.length, 0);

  // 2. 3" displacement (4.5 px) -> withheld (exceeds 0.50" tolerance)
  const segsB_off = new Float32Array([5, 54.5, 30, 54.5]);
  const off = checkSeamLinework(members, testDims, { A: segsA, B: segsB_off }, upp);
  assert.equal(off.passed, false);
  assert.equal(off.withheld, true);
  assert.equal(off.max_in, 3);
  assert.equal(off.median_in, 3);
  assert.ok(off.withheld_reasons[0].includes('exceeds 0.50" tolerance'));
  assert.equal(off.discrepancies.length, 1);
  assert.equal(off.discrepancies[0].at[0], 90);

  // 3. Rotation > 0.25 deg -> withheld
  // 25 px run with 2 px rise = atan2(2, 25) = ~4.57 degrees
  const segsB_rot = new Float32Array([5, 50, 30, 52]);
  const rot = checkSeamLinework(members, testDims, { A: segsA, B: segsB_rot }, upp);
  assert.equal(rot.passed, false);
  assert.equal(rot.withheld, true);
  assert.ok(rot.leftover_rotation_deg > 0.25);
  assert.ok(rot.withheld_reasons.some((r) => r.includes("Leftover rotation")));

  // 4. One wall 6" off among 25+ aligned walls -> true max_in catches it while p95_in/median_in stay 0
  const mTopBottom = [{ key: "A", dx: 0, dy: 0 }, { key: "B", dx: 0, dy: 150 }];
  const dimsTopBottom = { A: { w: 1500, h: 300 }, B: { w: 1500, h: 300 } };
  const segA25: number[] = [];
  const segB25: number[] = [];
  for (let i = 0; i < 25; i++) {
    const x = 100 + i * 35;
    segA25.push(x, 190, x, 260);
    segB25.push(x, 40, x, 110); // +150 = 190..260 exact alignment
  }
  segA25.push(1200, 190, 1200, 260);
  segB25.push(1209, 40, 1209, 110); // single wall shifted 9 px = 6" at 1/8" scale
  const singleOff = checkSeamLinework(
    mTopBottom,
    dimsTopBottom,
    { A: new Float32Array(segA25), B: new Float32Array(segB25) },
    upp,
  );
  assert.equal(singleOff.sample_count, 26);
  assert.equal(singleOff.median_in, 0);
  assert.equal(singleOff.p95_in, 0);
  assert.equal(singleOff.max_in, 6);
  assert.equal(singleOff.passed, false);
  assert.equal(singleOff.withheld, true);
  assert.ok(singleOff.withheld_reasons.some((r) => r.includes('max 6.00"') && r.includes('exceeds 0.50"')));

  // 5. Zero matched lines across seam -> passed: false, withheld: true, explicit message
  const zeroMatched = checkSeamLinework(members, testDims, { A: new Float32Array(), B: new Float32Array() }, upp);
  assert.equal(zeroMatched.sample_count, 0);
  assert.equal(zeroMatched.passed, false);
  assert.equal(zeroMatched.withheld, true);
  assert.ok(zeroMatched.withheld_reasons.some((r) => r.includes("No linework crossed the seam")));

  // 6. 3-member stitch: seam 1 aligned, seam 2 has 0 crossing lines -> withheld on missing seam 2
  const mThree = [{ key: "A", dx: 0, dy: 0 }, { key: "B", dx: 80, dy: 0 }, { key: "C", dx: 180, dy: 0 }];
  const dimsThree = { A: { w: 100, h: 100 }, B: { w: 120, h: 100 }, C: { w: 100, h: 100 } };
  const multi = checkSeamLinework(
    mThree,
    dimsThree,
    {
      A: new Float32Array([70, 50, 95, 50]),
      B: new Float32Array([-10, 50, 15, 50]), // only matches seam 1 (80+15 = 95), nothing near seam 2 (180..200)
      C: new Float32Array(),
    },
    upp,
  );
  assert.equal(multi.passed, false);
  assert.equal(multi.withheld, true);
  assert.ok(multi.withheld_reasons.some((r) => r.includes("seam 2") && r.includes("B") && r.includes("C")));
});

test("mergeSegs: preserves optional lum, layerOf/layerIds, and remaps subpaths across seam clips", () => {
  const m1Subpaths = [
    { i0: 0, i1: 2, x0: 10, y0: 10, x1: 90, y1: 10, closed: true, flags: 0, fillLum: 0 },
    { i0: 2, i1: 4, x0: 95, y0: 20, x1: 120, y1: 20, closed: true, flags: 0, fillLum: 128 },
  ];
  const merged = mergeSegs([
    {
      segs: [10, 10, 50, 10, 50, 10, 90, 10, 95, 20, 105, 20, 105, 20, 120, 20],
      meta: [1, 2, 3, 4],
      lum: [0, 50, 100, 150],
      layerOf: [0, 1, 0, -1],
      layerIds: ["walls", "grid"],
      subpaths: m1Subpaths,
      imageArea: 10,
      dx: 0,
      dy: 0,
      clip: { x0: 0, y0: 0, x1: 100, y1: 100 }, // drops seg 3 (mid x=112.5 > 100)
    },
    {
      segs: [20, 30, 40, 30],
      meta: [5],
      lum: [200],
      layerOf: [0],
      layerIds: ["walls"], // shared layer id with member 1
      subpaths: [{ i0: 0, i1: 1, x0: 20, y0: 30, x1: 40, y1: 30, closed: false, flags: 0, fillLum: 0 }],
      imageArea: 5,
      dx: 100,
      dy: 0,
      clip: { x0: 100, y0: 0, x1: 200, y1: 100 },
    },
  ]);

  assert.equal(merged.segs.length >> 2, 4);
  assert.deepEqual(Array.from(merged.lum!), [0, 50, 100, 200]);
  assert.deepEqual(merged.layerIds, ["walls", "grid"]);
  assert.deepEqual(Array.from(merged.layerOf!), [0, 1, 0, 0]);
  assert.equal(merged.subpaths!.length, 3);
  assert.equal(merged.subpaths![0].i0, 0);
  assert.equal(merged.subpaths![0].i1, 2);
  assert.equal(merged.subpaths![0].closed, true);
  // Clipped second subpath only kept 1 of 2 segments -> marked unclosed
  assert.equal(merged.subpaths![1].i0, 2);
  assert.equal(merged.subpaths![1].i1, 3);
  assert.equal(merged.subpaths![1].closed, false);
  // Second member subpath translated +100 px in x
  assert.equal(merged.subpaths![2].i0, 3);
  assert.equal(merged.subpaths![2].i1, 4);
  assert.equal(merged.subpaths![2].x0, 120);
  assert.equal(merged.subpaths![2].x1, 140);
});
