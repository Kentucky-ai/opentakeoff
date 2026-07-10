// Raster boundary mask — One-Click on scanned plans.
// Synthetic RGBA images through buildRasterMask, then the SAME floodRegion/
// traceRegion machinery the vector path uses (the mask shape is the contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRasterMask, toGray, adaptiveThreshold, closeMask, RASTER_RDP_EPS } from "../src/lib/rastermask.js";
import { floodRegion, traceRegion, ringArea } from "../src/lib/oneclick.js";

// deterministic PRNG (mulberry32) — noise tests never flake
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** white W×H RGBA image; draw(set) paints gray values (0=black ink, 255=paper) */
function makeImage(w: number, h: number, draw: (set: (x: number, y: number, v: number) => void) => void): Uint8Array {
  const rgba = new Uint8Array(w * h * 4).fill(255);
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
  };
  draw(set);
  return rgba;
}

/** rectangle outline of the given stroke width and ink value */
function rectOutline(set: (x: number, y: number, v: number) => void, x0: number, y0: number, x1: number, y1: number, stroke = 2, v = 0, skip?: (x: number, y: number) => boolean) {
  for (let s = 0; s < stroke; s++) {
    for (let x = x0; x <= x1; x++) {
      if (!skip?.(x, y0 + s)) set(x, y0 + s, v);
      if (!skip?.(x, y1 - s)) set(x, y1 - s, v);
    }
    for (let y = y0; y <= y1; y++) {
      if (!skip?.(x0 + s, y)) set(x0 + s, y, v);
      if (!skip?.(x1 - s, y)) set(x1 - s, y, v);
    }
  }
}

const W = 300, H = 300;
// the standard room: 100..200 square, interior ~96×96 after a 2px stroke
const room = (extra?: (set: (x: number, y: number, v: number) => void) => void, skip?: (x: number, y: number) => boolean) =>
  makeImage(W, H, (set) => { rectOutline(set, 100, 100, 200, 200, 2, 0, skip); extra?.(set); });

test("clean scanned room floods and traces at the right area", () => {
  const mo = buildRasterMask(room(), W, H, 1);
  assert.equal(mo.softCount, 0);
  const f = floodRegion(mo, 150, 150);
  assert.equal(f.status, "ok");
  assert.ok(!(f as any).hatchFiltered, "escalation must be structurally disabled on raster");
  const ring = traceRegion(f as any, RASTER_RDP_EPS);
  const area = ringArea(ring);
  // interior ≈ 96² = 9216; contour rides just inside the ink
  assert.ok(area > 8500 && area < 9800, `area ${area}`);
});

test("broken scan lines: leaks with bridging off, seals with the default closing", () => {
  // 1px slits through the full stroke thickness of the TOP wall — a faded-ink dropout
  const gaps = (x: number, y: number) => y <= 101 && x % 40 === 0 && x > 100 && x < 200;
  const img = room(undefined, gaps);
  const noBridge = buildRasterMask(img, W, H, 1, { bridge: false });
  const fNo = floodRegion(noBridge, 150, 150);
  assert.equal(fNo.status, "leak", "1px dropouts leak without closing");
  const bridged = buildRasterMask(img, W, H, 1);
  const fYes = floodRegion(bridged, 150, 150);
  assert.equal(fYes.status, "ok");
  const area = ringArea(traceRegion(fYes as any, RASTER_RDP_EPS));
  assert.ok(area > 8300 && area < 9800, `closing must not shrink the room (${area})`);
});

test("scanner noise never becomes barrier", () => {
  const r = rng(7);
  const img = makeImage(W, H, (set) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 200 + Math.floor(r() * 56)); // speckled paper
    rectOutline(set, 100, 100, 200, 200, 2, 0);
  });
  const mo = buildRasterMask(img, W, H, 1);
  // off-line ink fraction stays tiny
  let ink = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= 96 && x <= 204 && y >= 96 && y <= 204) continue; // skip the room band
    ink += mo.mask[y * mo.mw + x];
  }
  assert.ok(ink / (W * H) < 0.02, `noise ink fraction ${(ink / (W * H)).toFixed(4)}`);
  const f = floodRegion(mo, 150, 150);
  assert.equal(f.status, "ok");
});

test("text islands inside the room don't block or shrink the fill", () => {
  const img = room((set) => {
    // a few word-blob islands
    for (const [bx, by] of [[130, 140], [155, 160], [140, 175]]) {
      for (let y = 0; y < 6; y++) for (let x = 0; x < 18; x++) set(bx + x, by + y, 0);
    }
  });
  const mo = buildRasterMask(img, W, H, 1);
  const f = floodRegion(mo, 110, 110);   // seed in open floor, not on a blob
  assert.equal(f.status, "ok");
  const area = ringArea(traceRegion(f as any, RASTER_RDP_EPS));
  // outer contour ignores islands — full room, same semantics as vector columns
  assert.ok(area > 8500 && area < 9800, `area ${area}`);
});

test("gray-shaded room floods to its boundary (adaptive beats global)", () => {
  const img = makeImage(W, H, (set) => {
    for (let y = 102; y <= 198; y++) for (let x = 102; x <= 198; x++) set(x, y, 190); // light-gray fill
    rectOutline(set, 100, 100, 200, 200, 2, 0);
  });
  const mo = buildRasterMask(img, W, H, 1);
  const f = floodRegion(mo, 150, 150);
  assert.equal(f.status, "ok", "a shaded interior must read as paper, not barrier");
  const area = ringArea(traceRegion(f as any, RASTER_RDP_EPS));
  assert.ok(area > 8000 && area < 9800, `area ${area}`);
});

test("a real doorway gap leaks (closing can't bridge 12px)", () => {
  const img = room(undefined, (x, y) => y <= 103 && x >= 144 && x <= 156);  // 13px opening in the top wall
  const mo = buildRasterMask(img, W, H, 1);
  const f = floodRegion(mo, 150, 150);
  assert.equal(f.status, "leak");
});

test("a tiny enclosed speck reports tiny", () => {
  const img = room((set) => rectOutline(set, 148, 148, 153, 153, 1, 0));  // 4×4 interior < TINY_PX
  const mo = buildRasterMask(img, W, H, 1);
  const f = floodRegion(mo, 150, 150);
  assert.equal(f.status, "tiny");
});

test("negative scan (blueprint) inverts and floods", () => {
  const img = makeImage(W, H, (set) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 30);  // dark paper
    rectOutline(set, 100, 100, 200, 200, 2, 220);                          // light ink
  });
  const mo = buildRasterMask(img, W, H, 1);
  const f = floodRegion(mo, 150, 150);
  assert.equal(f.status, "ok");
  const area = ringArea(traceRegion(f as any, RASTER_RDP_EPS));
  assert.ok(area > 8000 && area < 9800, `area ${area}`);
});

test("thick solid walls stay solid (absolute dark floor)", () => {
  const img = makeImage(W, H, (set) => rectOutline(set, 96, 96, 204, 204, 8, 0));  // 8px band
  const mo = buildRasterMask(img, W, H, 1);
  // the wall core must be barrier — without the dark floor the adaptive rule
  // hollows a thick band into a paper corridor
  let core = 0;
  for (let x = 120; x <= 180; x++) core += mo.mask[99 * mo.mw + x];
  assert.ok(core > 55, `wall core mostly ink (${core}/61)`);
  const f = floodRegion(mo, 150, 150);
  assert.equal(f.status, "ok");
});

test("illumination gradient alone produces no ink", () => {
  const img = makeImage(W, H, (set) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 255 - Math.round((x / W) * 85)); // 255→170 sweep
  });
  const { gray } = toGray(img, W * H);
  const mask = adaptiveThreshold(gray, W, H);
  let ink = 0;
  for (let i = 0; i < mask.length; i++) ink += mask[i];
  assert.equal(ink, 0, "a smooth gradient is illumination, not ink");
});

test("closeMask is width-preserving where there is no gap", () => {
  const img = room();
  const { gray } = toGray(img, W * H);
  const before = adaptiveThreshold(gray, W, H);
  const after = closeMask(before, W, H);
  let nBefore = 0, nAfter = 0;
  for (let i = 0; i < before.length; i++) { nBefore += before[i]; nAfter += after[i]; }
  // closing may add a handful of corner px but must not thicken lines wholesale
  assert.ok(nAfter <= nBefore * 1.05, `ink grew ${nBefore} → ${nAfter}`);
});
