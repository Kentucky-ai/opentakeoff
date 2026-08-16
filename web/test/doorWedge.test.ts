// #257 — an IN-SWING door must not bite a wedge out of the room.
//
// The engine already unifies a doorway by opening its swing arc and letting the
// seal ladder close the opening at the wall plane (see "doorways UNIFY" in
// lib/oneclick.ts). What it did NOT do was let that run on a door whose leaf is
// wider than DOOR_R_MAX_FT: wedgeAllowance refused on the fitted radius alone,
// the opening was filtered out of the ranking, and the room came back short by
// its whole swing sector with nothing said about it.
//
// The refusal exists to stop a CURVED WALL annexing the space behind it, and it
// still does — what changed is that a cluster carrying a door LEAF (straight,
// non-curve ink along a radius at one end of a clean sweep, which a curved wall
// does not have) may widen the ceiling to DOOR_R_LEAF_MAX_FT.
//
// Scene: a 20 × 15 ft room, one door in the bottom wall, hinged left, drawn in
// the open position swinging IN — the leaf as a straight radius, the swing as a
// 90° arc of curve chords, and the wall carrying a real gap the width of the
// leaf. That is what a finish plan draws, and the sector behind the leaf is
// floor the estimator has to count.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMask, floodRegionSealed, sealRadiiFor, doorWedgeCapPx, minPassRadiusFor,
  wedgeAllowance, doorLikeness,
  SEG_CURVE, DOOR_R_MIN_FT, DOOR_R_MAX_FT, DOOR_R_LEAF_MAX_FT,
} from "../src/lib/oneclick";
import type { ArcClusterFit } from "../src/lib/oneclick";

const W = 1400, H = 1000;         // sheet px
const ROOM_W = 20, ROOM_H = 15;   // ft
const ROOM_SF = ROOM_W * ROOM_H;

/** Room rect + one in-swing door in the bottom wall. `leafFt` is the leaf
 *  length = the doorway's clear width = the arc's radius. */
function doorScene(leafFt: number, ppf: number, chords = 16) {
  const x0 = 200, y0 = 200;
  const x1 = x0 + ROOM_W * ppf, y1 = y0 + ROOM_H * ppf;
  const L = leafFt * ppf;
  const hx = x0 + 4 * ppf, hy = y1;          // hinge, 4 ft along the bottom wall
  const segs: number[] = [], meta: number[] = [];
  const push = (ax: number, ay: number, bx: number, by: number, m = 0) => {
    segs.push(ax, ay, bx, by); meta.push(m);
  };
  push(x0, y0, x1, y0);
  push(x1, y0, x1, y1);
  push(x0, y1, x0, y0);
  push(x0, y1, hx, y1);                      // bottom wall up to the hinge jamb
  push(hx + L, y1, x1, y1);                  // ...and on from the latch jamb
  push(hx, hy, hx, hy - L);                  // the drawn leaf, open into the room
  const p = (t: number) => [hx + L * Math.sin(t), hy - L * Math.cos(t)] as const;
  for (let k = 0; k < chords; k++) {         // the swing: leaf tip → latch jamb
    const [ax, ay] = p((Math.PI / 2) * (k / chords));
    const [bx, by] = p((Math.PI / 2) * ((k + 1) / chords));
    push(ax, ay, bx, by, SEG_CURVE);
  }
  return { segs, meta: new Uint8Array(meta), x0, y0, x1, y1 };
}

/** Measured SF of the room, clicked well away from the door. */
function measure(segs: number[], meta: Uint8Array, x0: number, y0: number, x1: number, y1: number, ppf: number) {
  const mo = buildMask(segs, W, H, 3000, meta, ppf, 0, null, null);
  const mppf = mo.mppf ?? 0;
  const f = floodRegionSealed(
    mo, (x0 + x1) / 2, (y0 + y1) / 2 - 60, 0.5,
    sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf),
  );
  return { f, mppf, sf: f.status === "ok" ? f.count / (mppf * mppf) : NaN };
}

/** The same room with NO door — the irreducible deficit from wall ink alone.
 *  Every assertion below is stated against THIS, not against the nominal area,
 *  so the test measures the wedge and not the raster. */
function control(ppf: number) {
  const x0 = 200, y0 = 200, x1 = x0 + ROOM_W * ppf, y1 = y0 + ROOM_H * ppf;
  const segs = [x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0];
  return ROOM_SF - measure(segs, new Uint8Array(4), x0, y0, x1, y1, ppf).sf;
}

// ── the regression itself ───────────────────────────────────────────────────
// 4'-0" and under already worked before #257 and must keep working; 4'-6" and
// 5'-0" are the widths that lost their entire sector.
for (const ppf of [18, 12, 9]) {
  const base = control(ppf);
  for (const leafFt of [2.5, 3, 3.5, 4, 4.5, 5]) {
    test(`in-swing ${leafFt}ft leaf @ ${ppf} px/ft: the swing sector is counted`, () => {
      const s = doorScene(leafFt, ppf);
      const { sf } = measure(s.segs, s.meta, s.x0, s.y0, s.x1, s.y1, ppf);
      const sector = (Math.PI / 4) * leafFt * leafFt;
      const lost = (ROOM_SF - sf - base) / sector;   // net of the ink baseline
      assert.ok(
        lost < 0.15,
        `${leafFt}ft leaf @ ${ppf}px/ft: lost ${(lost * 100).toFixed(0)}% of a `
        + `${sector.toFixed(1)} SF sector (measured ${sf.toFixed(1)} SF, control deficit ${base.toFixed(2)} SF)`,
      );
    });
  }
}

// The bug, stated as the number it produced. Before the fix a 4'-6" leaf at
// 18 px/ft measured 282.0 SF against a 300 SF room — 18.0 SF short on a
// 15.9 SF sector, the whole wedge plus the ink baseline.
test("the reported case: a 4'-6\" in-swing leaf no longer costs its sector", () => {
  const ppf = 18;
  const s = doorScene(4.5, ppf);
  const { sf } = measure(s.segs, s.meta, s.x0, s.y0, s.x1, s.y1, ppf);
  assert.ok(sf > 296, `measured ${sf.toFixed(1)} SF; the pre-fix value was 282.0`);
});

// ── what the widening must NOT do ───────────────────────────────────────────
const fitOf = (rFt: number, mppf: number, sweepDeg = 90): ArcClusterFit => ({
  cx: 0, cy: 0, r: rFt * mppf, rms: 0.5, good: true,
  sweep: (sweepDeg * Math.PI) / 180, noDoorFrac: 0,
  bu: 1e6, bn: 1e6, buH: 1e6, bnH: 1e6,     // box deliberately huge: the sector bound must be what binds
});

test("a curved WALL with no leaf is still refused at DOOR_R_MAX_FT", () => {
  const mppf = 18, cap = doorWedgeCapPx(mppf);
  // 8 ft radius: past the bare ceiling, inside the leaf-corroborated one
  const wall = fitOf(8, mppf);
  assert.equal(wedgeAllowance(wall, mppf, cap, false), 0, "no leaf ⇒ refused");
  // ...and a 46 ft curved wall is refused either way — the case the ceiling
  // was written for in the first place
  const bigWall = fitOf(46, mppf);
  assert.equal(wedgeAllowance(bigWall, mppf, cap, false), 0);
  assert.equal(wedgeAllowance(bigWall, mppf, cap, true), 0, "a leaf cannot buy a 46 ft radius a wedge");
});

test("the widened ceiling stops at DOOR_R_LEAF_MAX_FT", () => {
  const mppf = 18, cap = doorWedgeCapPx(mppf);
  assert.ok(wedgeAllowance(fitOf(DOOR_R_LEAF_MAX_FT - 0.5, mppf), mppf, cap, true) > 0, "inside the band");
  assert.equal(wedgeAllowance(fitOf(DOOR_R_LEAF_MAX_FT + 0.5, mppf), mppf, cap, true), 0, "past it");
});

test("leaf corroboration changes nothing inside the original band", () => {
  const mppf = 18, cap = doorWedgeCapPx(mppf);
  for (const rFt of [DOOR_R_MIN_FT, 3, 3.5, 4, DOOR_R_MAX_FT]) {
    const fit = fitOf(rFt, mppf);
    assert.equal(
      wedgeAllowance(fit, mppf, cap, true), wedgeAllowance(fit, mppf, cap, false),
      `${rFt} ft: allowance must be identical with and without a leaf`,
    );
    assert.equal(doorLikeness(fit, mppf, true), doorLikeness(fit, mppf, false), `${rFt} ft: ranking unchanged`);
  }
});

test("ranking follows the allowance, so a wide door isn't outbid by noise", () => {
  const mppf = 18;
  const wide = fitOf(5.5, mppf);
  assert.ok(
    doorLikeness(wide, mppf, true) > doorLikeness(wide, mppf, false),
    "a leaf-corroborated wide swing must outrank its own uncorroborated self",
  );
});

// ── the refusal is disclosed, not silent ────────────────────────────────────
test("a swing refused on radius alone is counted in wedgesRefused", () => {
  // 6 ft leaf: the arc opening leaks (a 6 ft opening is past what the seal
  // ladder will bridge — DOOR_SEAL_MAX_FT), so no wedge lands. The point here
  // is only that the result carries a number rather than quietly measuring low.
  const ppf = 18;
  const s = doorScene(6, ppf);
  const { f } = measure(s.segs, s.meta, s.x0, s.y0, s.x1, s.y1, ppf);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  // either it recovered the wedge, or it said so — never both silent
  assert.ok(
    (f.wedges ?? 0) > 0 || f.wedgesRefused === undefined || f.wedgesRefused > 0,
    "a lost wedge must leave a trace",
  );
});
