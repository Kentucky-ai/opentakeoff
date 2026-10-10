// OCR page cache (#471): the key, the stored value, and the lookup
// rules, over an in-memory fake of metaGet/metaPut. Plus the pure pieces the
// store uses: the hash check, startPdfHash, and the removal keep/delete rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPageCache, ocrCacheKey, ocrCacheOpts, OCR_CACHE_OPTS, OCR_CACHE_PARAMS, STALE_OK_OPTS } from "../src/lib/ocr/pageCache.ts";
import { EMPTY_SHA256, isPdfHash, ocrCachePrefix, ocrHashesToDrop, startPdfHash } from "../src/lib/ocr/pdfHash.ts";
import { readFileSync } from "node:fs";
import { OCR_ENGINE_OPTIONS as CORE_ENGINE_OPTIONS } from "../src/lib/ocr/workerCore.ts";
import { OCR_ENGINE_OPTIONS, OCR_INK, OCR_READ_DPI, OCR_SCAN_MAX_DIM, OCR_SEAM_RULES_VERSION, OCR_TILE_OVERLAP_PT } from "../src/lib/ocr/engineOptions.ts";
import { OCR_DETECTION_PADDING } from "../src/lib/ocr/raster.ts";
import { SCAN_MAX_DIM } from "../src/lib/scheduleScan.ts";
import { PICTURE_PARAMS_HASH } from "../src/lib/pictureParams.ts";
import { OCR_TARGET_DPI } from "../src/lib/ocr/rasterize.ts";
import { planTiles, SEAM_RULES_VERSION } from "../src/lib/ocr/seams.ts";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

function fakeMeta() {
  const m = new Map<string, unknown>();
  return {
    m,
    gets: 0,
    async metaGet(k: string) { this.gets++; return structuredClone(m.get(k)); },
    async metaPut(k: string, v: unknown) { m.set(k, structuredClone(v)); },
  };
}

const LINE = { str: "FT-1 CARPET", x: 100, y: 200, w: 80, h: 10, confidence: 0.9 };

test("key: ocr:v1:<sha256>:<page>; different hashes and pages give different keys; rev isn't in it", () => {
  assert.equal(ocrCacheKey(H1, 3), `ocr:v1:${H1}:3`);
  assert.notEqual(ocrCacheKey(H1, 3), ocrCacheKey(H2, 3));
  assert.notEqual(ocrCacheKey(H1, 3), ocrCacheKey(H1, 4));
  assert.equal(ocrCachePrefix(H1), `ocr:v1:${H1}:`);
  assert.ok(ocrCacheKey(H1, 3).startsWith(ocrCachePrefix(H1)));
});

test("hash check: lowercase 64-hex only; the sha256 of empty input is rejected", () => {
  assert.equal(EMPTY_SHA256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(isPdfHash(H1), true);
  for (const bad of [EMPTY_SHA256, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), null, undefined, 42, `${"a".repeat(63)}:`]) {
    assert.equal(isPdfHash(bad), false, String(bad));
  }
  assert.throws(() => ocrCacheKey(EMPTY_SHA256, 1), TypeError);
  assert.throws(() => ocrCacheKey("abc", 1), TypeError);
  assert.throws(() => ocrCachePrefix(EMPTY_SHA256), TypeError);
  for (const p of [0, -1, 1.5, NaN, "1"]) assert.throws(() => ocrCacheKey(H1, p as number), TypeError, String(p));
});

test("opts: a short stable string that changes with every input", () => {
  assert.match(OCR_CACHE_OPTS, /^[0-9a-f]{8}$/);
  assert.equal(ocrCacheOpts(OCR_CACHE_PARAMS), OCR_CACHE_OPTS);
  // key order doesn't matter
  const reordered = Object.fromEntries(Object.entries(OCR_CACHE_PARAMS).reverse()) as typeof OCR_CACHE_PARAMS;
  assert.equal(ocrCacheOpts(reordered), OCR_CACHE_OPTS);
  const P = OCR_CACHE_PARAMS;
  const variants = [
    { ...P, dpi: P.dpi + 1 },
    { ...P, overlapPt: P.overlapPt + 1 },
    { ...P, engine: { ...P.engine, detection: { ...P.engine.detection, paddingVertical: 0.5 } } },
    { ...P, engine: { ...P.engine, detection: { ...P.engine.detection, paddingHorizontal: 0.7 } } },
    { ...P, engine: { ...P.engine, detection: { ...P.engine.detection, maxSideLength: 2048 } } },
    { ...P, engine: { ...P.engine, recognition: { ...P.engine.recognition, maxCropSourceSideLength: 2000 } } },
    { ...P, engine: { ...P.engine, recognition: { ...P.engine.recognition, strategy: "per-line" as const } } },
    { ...P, engine: { ...P.engine, recognition: { ...P.engine.recognition, recBatchSize: 6 } } },
    { ...P, maxDim: 2048 },
    { ...P, ink: "other" },
  ];
  const seen = new Set([OCR_CACHE_OPTS]);
  for (const v of variants) {
    const o = ocrCacheOpts(v);
    assert.notEqual(o, OCR_CACHE_OPTS, JSON.stringify(v));
    seen.add(o);
  }
  assert.equal(seen.size, variants.length + 1);
});

test("opts params are the ones the read actually uses", () => {
  // the worker starts the engine with the very same object
  assert.equal(CORE_ENGINE_OPTIONS, OCR_ENGINE_OPTIONS);
  assert.equal(OCR_CACHE_PARAMS.engine, OCR_ENGINE_OPTIONS);
  // engineOptions.ts has no imports, so it repeats these values: pin each
  // copy to its source
  assert.deepEqual(
    { vertical: OCR_ENGINE_OPTIONS.detection.paddingVertical, horizontal: OCR_ENGINE_OPTIONS.detection.paddingHorizontal },
    { ...OCR_DETECTION_PADDING },
  );
  assert.equal(OCR_SCAN_MAX_DIM, SCAN_MAX_DIM);
  assert.equal(OCR_ENGINE_OPTIONS.detection.maxSideLength, SCAN_MAX_DIM);
  assert.equal(OCR_ENGINE_OPTIONS.recognition.maxCropSourceSideLength, SCAN_MAX_DIM);
  assert.equal(OCR_READ_DPI, OCR_TARGET_DPI);
  assert.equal(OCR_CACHE_PARAMS.dpi, OCR_TARGET_DPI);
  assert.equal(OCR_CACHE_PARAMS.maxDim, SCAN_MAX_DIM);
  // seams.ts has no exported overlap constant; pin its default here
  assert.equal(planTiles({ x0: 0, y0: 0, x1: 1000, y1: 1000 }, 1).overlap, OCR_TILE_OVERLAP_PT);
  assert.equal(OCR_CACHE_PARAMS.overlapPt, OCR_TILE_OVERLAP_PT);
  // the seam rules' version: a change to the keep, patch or merge rules
  // changes what a read returns, so it shapes the cache key too
  assert.ok(Number.isInteger(SEAM_RULES_VERSION) && SEAM_RULES_VERSION >= 1);
  assert.equal(OCR_SEAM_RULES_VERSION, SEAM_RULES_VERSION);
  assert.equal(OCR_CACHE_PARAMS.seams, SEAM_RULES_VERSION);
  // the ink preprocessing the worker runs before ppu (#481); ocrInk.test.ts
  // pins ink.ts's re-export to this same value
  assert.equal(OCR_INK, "split-luma601-c8-24");
  assert.equal(OCR_CACHE_PARAMS.ink, OCR_INK);
});

test("a read saved under older seam rules is a miss", async () => {
  const meta = fakeMeta();
  const older = ocrCacheOpts({ ...OCR_CACHE_PARAMS, seams: SEAM_RULES_VERSION - 1 });
  assert.notEqual(older, OCR_CACHE_OPTS);
  await createPageCache(meta, { opts: older }).put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 1, rasters: 1, at: 1 });
  assert.equal(await createPageCache(meta).get(H1, 1, { rs: 2, rev: "r1" }), null);
  // and the same entry under the current rules is a hit
  await createPageCache(meta).put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 1, rasters: 1, at: 1 });
  assert.ok(await createPageCache(meta).get(H1, 1, { rs: 2, rev: "r1" }));
});

test("engineOptions.ts is a leaf: no imports, so the cache never depends on tree-shaking workerCore", () => {
  const src = readFileSync(new URL("../src/lib/ocr/engineOptions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\brequire\(|\bimport\(/);
  const cache = readFileSync(new URL("../src/lib/ocr/pageCache.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cache, /from "\.\/(workerCore|rasterize|seams|client)"/);
});

test("opts hash is pinned: a change here invalidates every cached page read, on purpose", () => {
  // If this fails, something that shapes a read changed (engine options,
  // DPI, tile overlap, raster cap, seam rules version, preprocessing) and old
  // cached reads are now misses. That is intended; update the literal in the
  // same change, and decide whether the old hash goes on STALE_OK_OPTS (its
  // reads kept, flagged stale) or not (dropped).
  assert.equal(OCR_CACHE_OPTS, "70e022ad");
});

test("a read saved before the luminance preprocessing (#481) is a miss", async () => {
  const meta = fakeMeta();
  // the opts every read was saved under before #481
  await createPageCache(meta, { opts: "d67721d4" }).put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 1, rasters: 1, at: 1 });
  assert.equal(await createPageCache(meta).get(H1, 1, { rs: 2, rev: "r1" }), null);
  assert.ok(!STALE_OK_OPTS.includes("d67721d4"));
});

test("the stale-ok hash is exactly the engine before #484: per-line at batch 6, ppu's defaults, all else the same", () => {
  const P = OCR_CACHE_PARAMS;
  const { strategy, recBatchSize, ...before } = P.engine.recognition;
  assert.deepEqual({ strategy, recBatchSize }, { strategy: "per-box", recBatchSize: 1 });
  // under the seam rules of its day (2)
  assert.equal(ocrCacheOpts({ ...P, seams: 2, engine: { ...P.engine, recognition: before } } as unknown as typeof P), "e2f8d8b4");
  assert.ok(STALE_OK_OPTS.includes("e2f8d8b4"));
  assert.ok(!STALE_OK_OPTS.includes(OCR_CACHE_OPTS), "the current engine's reads are fresh, not stale");
});

test("put then get: same rs and opts gives the stored read back", async () => {
  const meta = fakeMeta();
  const cache = createPageCache(meta);
  await cache.put(H1, 2, { rev: "r1", rs: 2, lines: [LINE], ms: 1234, rasters: 3, at: 99 });
  const stored = meta.m.get(ocrCacheKey(H1, 2)) as any;
  assert.deepEqual(stored, { v: 1, rev: "r1", opts: OCR_CACHE_OPTS, rs: 2, lines: [LINE], ms: 1234, rasters: 3, at: 99 });
  const hit = await cache.get(H1, 2, { rs: 2, rev: "r1" });
  assert.deepEqual(hit, { rev: "r1", rs: 2, lines: [LINE], ms: 1234, rasters: 3, at: 99, stale: false });
  assert.equal(await cache.get(H1, 3, { rs: 2 }), null);
  assert.equal(await cache.get(H2, 2, { rs: 2 }), null);
});

test("rs-only mismatch: lines rescaled to the requested rs", async () => {
  const meta = fakeMeta();
  const cache = createPageCache(meta);
  await cache.put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 1, rasters: 1, at: 1 });
  const hit = await cache.get(H1, 1, { rs: 3 });
  assert.ok(hit);
  assert.equal(hit.rs, 3);
  assert.deepEqual(hit.lines, [{ str: "FT-1 CARPET", x: 150, y: 300, w: 120, h: 15, confidence: 0.9 }]);
  // the stored entry isn't changed by a scaled read
  assert.equal((meta.m.get(ocrCacheKey(H1, 1)) as any).lines[0].x, 100);
});

test("a hit carries only the word fields (and a seam's clipped flag), scaled or not", async () => {
  const meta = fakeMeta();
  const cache = createPageCache(meta);
  const extra = { ...LINE, junk: { big: "x" } };
  const noConf = { str: "B", x: 1, y: 2, w: 3, h: 4, clipped: true };
  meta.m.set(ocrCacheKey(H1, 1), { v: 1, rev: "r", opts: OCR_CACHE_OPTS, rs: 2, lines: [extra, noConf], ms: 1, rasters: 1, at: 1 });
  const same = await cache.get(H1, 1, { rs: 2 });
  assert.deepEqual(same?.lines, [LINE, noConf]);
  assert.ok(!("confidence" in same!.lines[1]), "no confidence key invented");
  const scaled = await cache.get(H1, 1, { rs: 4 });
  assert.deepEqual(scaled?.lines, [{ ...LINE, x: 200, y: 400, w: 160, h: 20 }, { str: "B", x: 2, y: 4, w: 6, h: 8, clipped: true }]);
});

test("opts mismatch is a miss", async () => {
  const meta = fakeMeta();
  await createPageCache(meta, { opts: "00000000" }).put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 1, rasters: 1, at: 1 });
  assert.equal(await createPageCache(meta).get(H1, 1, { rs: 2 }), null);
  assert.equal(await createPageCache(meta).get(H1, 1, { rs: 3 }), null);
});

test("the stale-ok list is pinned: the opts of reads still served after an engine change", () => {
  // Each entry is the opts hash of a past engine whose reads are worth
  // keeping (stale, so Read again shows) rather than dropping. Add the old
  // hash here only when the change that retires it says so.
  assert.deepEqual(STALE_OK_OPTS, ["e2f8d8b4"]);
});

test("a read saved under a stale-ok engine is a stale hit, the rev known or not", async () => {
  const meta = fakeMeta();
  const [earlier] = STALE_OK_OPTS;
  const now = "0000beef";
  await createPageCache(meta, { opts: earlier }).put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 7, rasters: 2, at: 5 });
  const cache = createPageCache(meta, { opts: now });
  for (const rev of [null, undefined, "r1", "r2"]) {
    const hit = await cache.get(H1, 1, { rs: 2, rev });
    assert.deepEqual(hit, { rev: "r1", rs: 2, lines: [LINE], ms: 7, rasters: 2, at: 5, stale: true }, String(rev));
  }
  // rescaled like any other hit
  assert.deepEqual((await cache.get(H1, 1, { rs: 4 }))?.lines, [{ ...LINE, x: 200, y: 400, w: 160, h: 20 }]);
  // a read saved again under the current engine replaces it, fresh
  await cache.put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 7, rasters: 2, at: 6 });
  assert.equal((await cache.get(H1, 1, { rs: 2 }))?.stale, false);
  assert.equal((await cache.get(H1, 1, { rs: 2, rev: "r1" }))?.stale, false);
});

test("other opts not on the stale-ok list stay a miss", async () => {
  const meta = fakeMeta();
  await createPageCache(meta, { opts: "12345678" }).put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 1, rasters: 1, at: 1 });
  assert.equal(await createPageCache(meta, { opts: "0000beef" }).get(H1, 1, { rs: 2 }), null);
  assert.equal(await createPageCache(meta, { opts: "0000beef" }).get(H1, 1, { rs: 2, rev: "r1" }), null);
});

test("an older model rev is still used, flagged stale; no known rev uses it as is", async () => {
  const meta = fakeMeta();
  const cache = createPageCache(meta);
  await cache.put(H1, 1, { rev: "old", rs: 2, lines: [LINE], ms: 1, rasters: 1, at: 1 });
  const stale = await cache.get(H1, 1, { rs: 2, rev: "new" });
  assert.ok(stale);
  assert.equal(stale.stale, true);
  assert.equal(stale.rev, "old");
  assert.deepEqual(stale.lines, [LINE]);
  const unknown = await cache.get(H1, 1, { rs: 2 });
  assert.ok(unknown);
  assert.equal(unknown.stale, false);
  const same = await cache.get(H1, 1, { rs: 2, rev: "old" });
  assert.equal(same?.stale, false);
});

test("a malformed hash never reaches meta: get is a miss, put throws", async () => {
  const meta = fakeMeta();
  const cache = createPageCache(meta);
  assert.equal(await cache.get(EMPTY_SHA256, 1, { rs: 2 }), null);
  assert.equal(await cache.get("nope", 1, { rs: 2 }), null);
  assert.equal(await cache.get(null, 1, { rs: 2 }), null);
  assert.equal(meta.gets, 0);
  await assert.rejects(cache.put(EMPTY_SHA256, 1, { rev: "r", rs: 2, lines: [], ms: 0, rasters: 0, at: 0 }), TypeError);
  assert.equal(meta.m.size, 0);
});

// ── picture reads (#489) ────────────────────────────────────────────────────
// A hybrid's read covers only its pictures, so its entry carries pp
// (pictures.ts's PICTURE_PARAMS_HASH) beside opts. A scan's entry stays as it
// was (no pp, opts unchanged), and a lookup that expects a pictures read
// never takes one without pp: that would be a whole-page read.

test("a pictures read is stored with pp, and comes back fresh under the same pp", async () => {
  const meta = fakeMeta();
  const cache = createPageCache(meta);
  await cache.put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 5, rasters: 2, at: 9, pictures: true });
  assert.deepEqual(meta.m.get(ocrCacheKey(H1, 1)), { v: 1, rev: "r1", opts: OCR_CACHE_OPTS, pp: PICTURE_PARAMS_HASH, rs: 2, lines: [LINE], ms: 5, rasters: 2, at: 9 });
  const want = { rev: "r1", rs: 2, lines: [LINE], ms: 5, rasters: 2, at: 9, stale: false };
  assert.deepEqual(await cache.get(H1, 1, { rs: 2, rev: "r1", expect: "pictures" }), want);
  assert.deepEqual(await cache.get(H1, 1, { rs: 2, rev: "r1" }), want, "a lookup that doesn't say what it expects takes it too");
});

test("a scan's read is stored without pp, as before", async () => {
  const meta = fakeMeta();
  await createPageCache(meta).put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 5, rasters: 2, at: 9 });
  assert.ok(!("pp" in (meta.m.get(ocrCacheKey(H1, 1)) as object)));
});

test("a pictures read under other picture params is served stale (Read again), whatever else matches", async () => {
  const meta = fakeMeta();
  await createPageCache(meta, { pp: "0000beef" }).put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 5, rasters: 2, at: 9, pictures: true });
  const cache = createPageCache(meta);
  for (const o of [{ rs: 2, rev: "r1", expect: "pictures" as const }, { rs: 2, rev: "r1" }, { rs: 2 }]) {
    assert.deepEqual(await cache.get(H1, 1, o), { rev: "r1", rs: 2, lines: [LINE], ms: 5, rasters: 2, at: 9, stale: true }, JSON.stringify(o));
  }
});

test("a lookup that expects a pictures read misses an entry without pp; a scan's lookup still finds it", async () => {
  const meta = fakeMeta();
  const cache = createPageCache(meta);
  await cache.put(H1, 1, { rev: "r1", rs: 2, lines: [LINE], ms: 5, rasters: 2, at: 9 });
  assert.equal(await cache.get(H1, 1, { rs: 2, rev: "r1", expect: "pictures" }), null);
  assert.equal((await cache.get(H1, 1, { rs: 2, rev: "r1" }))?.stale, false);
});

test("a stored pp must be a string", async () => {
  const meta = fakeMeta();
  const good = { v: 1, rev: "r", opts: OCR_CACHE_OPTS, pp: PICTURE_PARAMS_HASH, rs: 2, lines: [LINE], ms: 1, rasters: 1, at: 1 };
  meta.m.set(ocrCacheKey(H1, 1), good);
  assert.ok(await createPageCache(meta).get(H1, 1, { rs: 2 }), "the good value is a hit");
  for (const pp of [null, 7, {}]) {
    meta.m.set(ocrCacheKey(H1, 1), { ...good, pp });
    assert.equal(await createPageCache(meta).get(H1, 1, { rs: 2 }), null, String(pp));
  }
});

test("malformed stored values are misses", async () => {
  const good = { v: 1, rev: "r", opts: OCR_CACHE_OPTS, rs: 2, lines: [LINE], ms: 1, rasters: 1, at: 1 };
  const bad: unknown[] = [
    undefined, null, 42, "x", [],
    { ...good, v: 2 },
    { ...good, rev: 7 },
    { ...good, opts: undefined },
    { ...good, rs: 0 }, { ...good, rs: -1 }, { ...good, rs: NaN }, { ...good, rs: "2" },
    { ...good, lines: "x" }, { ...good, lines: [null] },
    { ...good, lines: [{ ...LINE, str: 5 }] }, { ...good, lines: [{ ...LINE, x: NaN }] },
    { ...good, lines: [{ ...LINE, w: -1 }] }, { ...good, lines: [{ ...LINE, h: Infinity }] },
    { ...good, lines: [{ ...LINE, confidence: "x" }] }, { ...good, lines: [{ ...LINE, confidence: NaN }] },
    { ...good, lines: [{ ...LINE, clipped: "yes" }] },
    { ...good, ms: -1 }, { ...good, rasters: 1.5 }, { ...good, at: "t" },
  ];
  const meta = fakeMeta();
  const cache = createPageCache(meta);
  meta.m.set(ocrCacheKey(H1, 1), good);
  assert.ok(await cache.get(H1, 1, { rs: 2 }), "the good value is a hit");
  for (const v of bad) {
    meta.m.set(ocrCacheKey(H1, 1), v);
    assert.equal(await cache.get(H1, 1, { rs: 2 }), null, JSON.stringify(v));
  }
});

test("put rejects a malformed value instead of storing it", async () => {
  const meta = fakeMeta();
  const cache = createPageCache(meta);
  await assert.rejects(cache.put(H1, 1, { rev: "r", rs: 0, lines: [], ms: 0, rasters: 0, at: 0 }), TypeError);
  await assert.rejects(cache.put(H1, 1, { rev: "r", rs: 2, lines: [{ str: "x" }] as any, ms: 0, rasters: 0, at: 0 }), TypeError);
  assert.equal(meta.m.size, 0);
});

test("startPdfHash: sha256 hex of the bytes, begun before the buffer is detached", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7 fake");
  const expected = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  const copy = new Uint8Array(bytes);
  const p = startPdfHash(copy);
  // what pdf.js getDocument may do to the buffer right after
  structuredClone(copy.buffer, { transfer: [copy.buffer] });
  assert.equal(copy.byteLength, 0, "buffer detached");
  assert.equal(await p, expected);
  // a view on part of a larger buffer hashes just the view
  const big = new Uint8Array(bytes.length + 8);
  big.set(bytes, 4);
  assert.equal(await startPdfHash(big.subarray(4, 4 + bytes.length)), expected);
  assert.equal(await startPdfHash(bytes.buffer.slice(0)), expected);
});

test("startPdfHash: empty or detached bytes resolve null (never the empty-input hash)", async () => {
  assert.equal(await startPdfHash(new Uint8Array(0)), null);
  const u = new Uint8Array([1, 2, 3]);
  structuredClone(u.buffer, { transfer: [u.buffer] });
  assert.equal(await startPdfHash(u), null);
});

test("startPdfHash: no crypto.subtle (non-secure context) resolves null", async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    assert.equal(await startPdfHash(new Uint8Array([1, 2, 3])), null);
  } finally {
    Object.defineProperty(globalThis, "crypto", desc);
  }
  assert.ok(await startPdfHash(new Uint8Array([1, 2, 3])));
});

test("removal decision: a file with revisions drops every hash nothing else carries", () => {
  assert.deepEqual(ocrHashesToDrop([H1, H2], []).sort(), [H1, H2]);
  // duplicates and junk collapse away
  assert.deepEqual(ocrHashesToDrop([H1, H1, null, undefined, "", EMPTY_SHA256], []), [H1]);
});

test("removal decision: a hash another file still carries is kept", () => {
  const H3 = "c".repeat(64);
  // H1 is another file's current bytes; H2 is another file's revision
  assert.deepEqual(ocrHashesToDrop([H1, H2, H3], [H1, "d".repeat(64)]).sort(), [H2, H3]);
  assert.deepEqual(ocrHashesToDrop([H1, H2, H3], [H2]).sort(), [H1, H3]);
  assert.deepEqual(ocrHashesToDrop([H1], [null, undefined, H1]), []);
});

test("a hit's lines are cleaned of border glyphs (#482); a line of ruling only is dropped; a clean entry comes back unchanged", async () => {
  const meta = fakeMeta();
  const cache = createPageCache(meta);
  const bordered = { str: "[P-1", x: 1, y: 2, w: 3, h: 4, confidence: 0.8 };
  const rule = { str: "__", x: 5, y: 2, w: 3, h: 4 };
  meta.m.set(ocrCacheKey(H1, 1), { v: 1, rev: "r", opts: OCR_CACHE_OPTS, rs: 2, lines: [bordered, rule, LINE], ms: 1, rasters: 1, at: 1 });
  const hit = await cache.get(H1, 1, { rs: 2 });
  assert.deepEqual(hit?.lines, [{ ...bordered, str: "P-1" }, LINE]);
  // scaled too
  assert.deepEqual((await cache.get(H1, 1, { rs: 4 }))?.lines.map((l) => l.str), ["P-1", "FT-1 CARPET"]);
  await cache.put(H2, 1, { rev: "r", rs: 2, lines: [LINE], ms: 1, rasters: 1, at: 1 });
  assert.deepEqual((await cache.get(H2, 1, { rs: 2 }))?.lines, [LINE]);
});
