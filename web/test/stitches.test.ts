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
  assert.equal(out[0].name, "", "blank name falls back to empty string (translated at display layer)");
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
