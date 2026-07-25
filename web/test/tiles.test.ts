import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TILE_SIZE, MAX_DENSITY, buildLevels, pickLevel, levelDims, tileGrid,
  tileKey, tileRect, visibleTiles, requiredDensity, TileLRU,
} from "../src/lib/tiles.ts";

test("buildLevels always includes native (1.0) and tops out at MAX_DENSITY", () => {
  const levels = buildLevels(5000, 3000);
  assert.ok(levels.includes(1));
  assert.equal(levels[levels.length - 1], MAX_DENSITY);
  for (let i = 1; i < levels.length; i++) assert.equal(levels[i], levels[i - 1] * 2);
});

test("buildLevels coarsest level keeps a huge (ingested-image) sheet's long edge near MIN_LEVEL_PX", () => {
  // the 07-21 regression sheet: a 7920x5280pt image page at RENDER_SCALE=2
  const levels = buildLevels(15840, 10560);
  const { w, h } = levelDims(15840, 10560, levels[0]);
  assert.ok(Math.max(w, h) <= 1536, `coarsest level too dense: ${w}x${h}`);
  assert.ok(Math.max(w, h) >= 384, `coarsest level too sparse: ${w}x${h}`);
});

test("buildLevels never produces a level denser than needed for a tiny sheet", () => {
  const levels = buildLevels(200, 100);
  assert.ok(levels[0] <= 1);
});

test("pickLevel picks the least-dense level that still covers the request", () => {
  const levels = [0.25, 0.5, 1, 2, 4, 8];
  assert.equal(pickLevel(levels, 0.1), 0);   // below the floor -> coarsest
  assert.equal(pickLevel(levels, 0.25), 0);  // exact match
  assert.equal(pickLevel(levels, 0.6), 2);   // between 0.5 and 1 -> next level up (1, index 2)
  assert.equal(pickLevel(levels, 1.15), 3);  // DETAIL_ENGAGE-equivalent -> next level up from native (2, index 3)
  assert.equal(pickLevel(levels, 100), 5);   // past the ceiling -> clamp to top, never grows unboundedly
});

test("levelDims / tileGrid agree on level pixel size", () => {
  const d = levelDims(5000, 3000, 1);
  const g = tileGrid(5000, 3000, 1);
  assert.equal(g.w, d.w); assert.equal(g.h, d.h);
  assert.equal(g.cols, Math.ceil(d.w / TILE_SIZE));
  assert.equal(g.rows, Math.ceil(d.h / TILE_SIZE));
});

test("tileKey is stable and distinct per coordinate", () => {
  assert.equal(tileKey("A-201", 2, 3, 4), "A-201:2:3:4");
  assert.notEqual(tileKey("A-201", 2, 3, 4), tileKey("A-201", 2, 4, 3));
});

test("tileRect clips edge tiles to the level bounds instead of overshooting", () => {
  const r = tileRect(0, 1, 0, 700, 400); // levelW=700 -> tile 1 only has 700-512=188px
  assert.equal(r.x, 512); assert.equal(r.w, 188); assert.equal(r.h, 400);
});

test("visibleTiles covers a small region with exactly the tiles that intersect it", () => {
  const levels = [1];
  const tiles = visibleTiles(2000, 2000, levels, 0, 500, 500, 600, 600);
  // region [500,600)x[500,600) at density 1 -> spans tile (0,0) only (0..512 covers 500..512, but 512..600 needs tile 1)
  const keys = tiles.map((t) => `${t.tx},${t.ty}`).sort();
  assert.deepEqual(keys, ["0,0", "1,0", "0,1", "1,1"].sort());
});

test("visibleTiles returns nothing for an out-of-bounds / degenerate region", () => {
  assert.deepEqual(visibleTiles(2000, 2000, [1], 0, 3000, 3000, 3100, 3100), []);
  assert.deepEqual(visibleTiles(2000, 2000, [1], 0, 100, 100, 100, 100), []);
});

test("requiredDensity matches the old DETAIL_ENGAGE quantity (stageScale * dpr)", () => {
  assert.equal(requiredDensity(1.15, 1), 1.15);
  assert.equal(requiredDensity(0.575, 2), 1.15);
});

test("TileLRU evicts least-recently-used tiles once over budget, protecting visible ones", () => {
  const lru = new TileLRU(300);
  lru.set("a", "A", 100);
  lru.set("b", "B", 100);
  lru.set("c", "C", 100);
  assert.equal(lru.size, 300);
  lru.get("a"); // touch a -> now MRU; LRU order is b, c, a
  lru.set("d", "D", 100); // over budget by 100 -> evicts b (the LRU, unprotected)
  assert.equal(lru.has("b"), false);
  assert.equal(lru.has("a"), true);
  assert.equal(lru.has("c"), true);
  assert.equal(lru.has("d"), true);
});

test("TileLRU.evictToBudget never evicts a protected (currently visible) key", () => {
  const lru = new TileLRU(150);
  lru.set("a", "A", 100);
  lru.set("b", "B", 100); // already over budget: 200 > 150, but only 'b' is protected
  lru.evictToBudget(new Set(["b"]));
  assert.equal(lru.has("b"), true);
  assert.equal(lru.has("a"), false);
});

test("TileLRU.set on an existing key replaces its byte accounting, not doubles it", () => {
  const lru = new TileLRU(1000);
  lru.set("a", "v1", 100);
  lru.set("a", "v2", 250);
  assert.equal(lru.size, 250);
  assert.equal(lru.get("a"), "v2");
});
