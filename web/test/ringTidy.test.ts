// ringTidy tests — the tidy pass is pure (no DOM), so it runs straight under
// node. Synthetic rings with known tidy answers. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorFlags, axisLockPoint, tidyRing } from "../src/lib/ringTidy";
import { ringArea } from "../src/lib/oneclick";
import type { Point, NearestFn } from "../src/lib/oneclick";

const corners: Point[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
const nearest: NearestFn = (x, y, d) => {
  let best: Point | null = null, bd = d;
  for (const c of corners) {
    const dd = Math.hypot(c[0] - x, c[1] - y);
    if (dd <= bd) { bd = dd; best = c; }
  }
  return best;
};

// 100-vertex staircase square whose corners sit ±0.6 px off CAD endpoints.
function staircase(): Point[] {
  const out: Point[] = [];
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = corners[k], [bx, by] = corners[(k + 1) % 4];
    for (let t = 0; t < 25; t++) {
      const u = t / 25;
      const x = ax + (bx - ax) * u, y = ay + (by - ay) * u;
      out.push(bx !== ax ? [x, y + (t % 2 ? 0.6 : -0.6)] : [x + (t % 2 ? 0.6 : -0.6), y]);
    }
  }
  return out;
}

test("tidyRing collapses a staircase square to its CAD corners, axis-true", () => {
  const r = tidyRing(staircase(), { nearest });
  assert.equal(r.changed, true);
  assert.ok(r.ring.length <= 8, `expected ≤8 verts, got ${r.ring.length}`);
  assert.ok(Math.abs(Math.abs(ringArea(r.ring)) - 10000) / 10000 < 0.03, "area drifted");
  for (const c of corners) {
    assert.ok(r.ring.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < 0.01), `corner ${c} lost`);
  }
  for (let i = 0; i < r.ring.length; i++) {
    const p = r.ring[i], q = r.ring[(i + 1) % r.ring.length];
    assert.ok(Math.abs(p[0] - q[0]) < 1e-9 || Math.abs(p[1] - q[1]) < 1e-9, "wall not axis-true");
  }
});

test("tidyRing leaves a genuinely angled wall alone and holds area", () => {
  const angled: Point[] = [[0, 0], [100, 0], [100, 60], [40, 60], [0, 20]]; // 45° cut corner
  const r = tidyRing(angled, { nearest: null });
  const hasDiag = r.ring.some((p, i) => {
    const q = r.ring[(i + 1) % r.ring.length];
    return Math.abs(p[0] - q[0]) > 5 && Math.abs(p[1] - q[1]) > 5;
  });
  assert.ok(hasDiag, "45° wall was flattened");
  const a0 = Math.abs(ringArea(angled));
  assert.ok(Math.abs(Math.abs(ringArea(r.ring)) - a0) / a0 < 0.03, "area drifted");
});

test("tidyRing never returns something worse than the input", () => {
  const tiny: Point[] = [[0, 0], [1, 0], [0, 1]];
  const r = tidyRing(tiny, { nearest: null, minGapPx: 5 }); // collapse would degenerate it
  assert.ok(r.ring.length >= 3);
});

test("axisLockPoint locks a near-vertical drag to the neighbor's x", () => {
  const l = axisLockPoint([50.4, 80], [50, 0], null, 2);
  assert.equal(l.locked, true);
  assert.deepEqual(l.pt, [50, 80]);
});

test("axisLockPoint locks both axes near a square corner", () => {
  const l = axisLockPoint([99.2, 0.7], [100, 50], [0, 0], 2);
  assert.deepEqual(l.pt, [100, 0]);
});

test("axisLockPoint leaves a far point unlocked", () => {
  assert.equal(axisLockPoint([70, 80], [50, 0], null, 2).locked, false);
});

test("anchorFlags flags only vertices within tolerance of an endpoint", () => {
  const f = anchorFlags([[0, 0.5], [50, 50]], nearest);
  assert.deepEqual(f, [true, false]);
});
