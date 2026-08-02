// Resolution invariance (RFC failure mode #3): feet-true thresholds and the
// minimum-passage rule keep One-Click verdicts a property of the DRAWING, not
// of the working raster's resolution. Every case here builds one image-space
// scene and probes it at two mask resolutions via buildMask's maxDim knob.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildMask, floodRegion, floodRegionSealed, dilateHardMask, sealRadiiFor, doorWedgeCapPx,
  minPassRadiusFor, MIN_PASS_FT, DETERMINISM_MIN_MPPF, MASK_MAX_DIM, baselineImgDims,
  traceRegion, ringArea, type FloodResult,
} from "../src/lib/oneclick.ts";
import { rasterMaskScale } from "../src/lib/rastermask.ts";
import { traceConfidence, floodSignals, CONF_COARSE } from "../src/lib/confidence.ts";

const sq = (x0: number, y0: number, x1: number, y1: number): number[] => [
  x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0,
];

test("minPassRadiusFor: off without a scale, feet-consistent with one", () => {
  assert.equal(minPassRadiusFor(0), 0);
  assert.equal(minPassRadiusFor(NaN), 0);
  assert.equal(minPassRadiusFor(-3), 0);
  for (const mppf of [6, 8, 9, 12, 18, 24, 36]) {
    const r = minPassRadiusFor(mppf);
    const closedFt = (2 * r) / mppf;                  // widest passage the rule closes
    // round-to-nearest radius ⇒ the effective threshold sits within ONE cell
    // of MIN_PASS_FT on either side (the tightest band a 2r dilation allows;
    // a floor bias closed a 0.42 ft slit at one resolution and not another)
    assert.ok(Math.abs(closedFt - MIN_PASS_FT) <= 1 / mppf + 1e-9, `mppf ${mppf}: closes ${closedFt} ft — more than a cell off ${MIN_PASS_FT}`);
  }
});

// Room A (10×10 ft) and chamber B (6×6 ft) share a wall with a 0.3 ft slit —
// annotation-tip scale, nothing flooring runs through. With the rule, a click
// in A must measure A alone at EVERY resolution; without it, the slit
// percolates and B rides along. PXFT = 24 keeps the half-res mask (12 px/ft)
// above the determinism floor.
const PXFT = 24;
function slitScene(slitPx: number) {
  const A = { x0: 100, y0: 100, x1: 340, y1: 340 };            // 10×10 ft
  const B = { x0: 340, y0: 100, x1: 484, y1: 244 };            // 6×6 ft
  const gapTop = 160, gapBot = 160 + slitPx;
  const segs = [
    // A's walls, right wall broken by the slit
    A.x0, A.y0, A.x1, A.y0, A.x0, A.y1, A.x1, A.y1, A.x0, A.y0, A.x0, A.y1,
    A.x1, A.y0, A.x1, gapTop, A.x1, gapBot, A.x1, A.y1,
    // B closes off the shared wall's far side
    B.x0, B.y0, B.x1, B.y0, B.x1, B.y0, B.x1, B.y1, B.x1, B.y1, B.x0, B.y1,
  ];
  return { segs, seedA: [220, 220] as [number, number] };
}

test("min-passage: a 0.3 ft slit never connects, at any resolution", () => {
  const { segs, seedA } = slitScene(0.3 * PXFT);
  for (const maxDim of [800, 400]) {                            // ws 1 and 0.5 → 24 and 12 px/ft
    const mo = buildMask(segs, 800, 500, maxDim, null, PXFT);
    const mppf = (mo.mppf ?? 0);
    assert.ok(mppf >= DETERMINISM_MIN_MPPF, `test scene must sit above the floor (got ${mppf})`);
    const f = floodRegionSealed(mo, seedA[0], seedA[1], 0.5, sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf));
    assert.equal(f.status, "ok");
    const sf = (f as { count: number }).count / (mppf * mppf);
    assert.ok(Math.abs(sf - 100) < 8, `ws ${mo.ws}: expected ~100 SF (A alone), got ${sf.toFixed(1)}`);
  }
});

test("min-passage off (no rule): the slit percolates and B rides along — the rule is what does the work", () => {
  const { segs, seedA } = slitScene(0.3 * PXFT);
  const mo = buildMask(segs, 800, 500, 800, null, PXFT);      // canvas big enough that A+B clears the 30% leak cap
  const mppf = mo.mppf ?? 0;
  const f = floodRegionSealed(mo, seedA[0], seedA[1], 0.5, sealRadiiFor(mppf), doorWedgeCapPx(mppf), 0);
  assert.equal(f.status, "ok");
  const sf = (f as { count: number }).count / (mppf * mppf);
  assert.ok(sf > 120, `expected A+B (~136 SF) without the rule, got ${sf.toFixed(1)}`);
});

test("min-passage: a real 3 ft opening still connects, at any resolution", () => {
  const { segs, seedA } = slitScene(3 * PXFT);                  // same scene, door-width break
  for (const maxDim of [800, 400]) {
    const mo = buildMask(segs, 800, 500, maxDim, null, PXFT);
    const mppf = mo.mppf ?? 0;
    const f = floodRegionSealed(mo, seedA[0], seedA[1], 0.5, sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf));
    assert.equal(f.status, "ok");
    const sf = (f as { count: number }).count / (mppf * mppf);
    assert.ok(sf > 120, `ws ${mo.ws}: expected A+B through the 3 ft opening, got ${sf.toFixed(1)} SF`);
  }
});

test("hatch pitch cap is feet-true: a 1.6 ft rhythm stays hard at every resolution, a 1.0 ft one stays soft", () => {
  // 14 vertical hairlines, tangentially stacked — a classic family shape.
  const family = (pitchPx: number): { segs: number[]; meta: Uint8Array } => {
    const segs: number[] = [];
    for (let k = 0; k < 14; k++) segs.push(200 + k * pitchPx, 100, 200 + k * pitchPx, 500);
    return { segs, meta: new Uint8Array(segs.length >> 2) };
  };
  for (const maxDim of [900, 450]) {                            // ws 1 and 0.5
    const wide = family(1.6 * PXFT);
    const wideMask = buildMask(wide.segs, 900, 600, maxDim, wide.meta, PXFT);
    assert.equal(wideMask.softCount, 0, `ws ${wideMask.ws}: a 1.6 ft rhythm is walls, not hatch`);
    const tight = family(1.0 * PXFT);
    const tightMask = buildMask(tight.segs, 900, 600, maxDim, tight.meta, PXFT);
    assert.ok(tightMask.softCount >= 10, `ws ${tightMask.ws}: a 1 ft hatch family must classify soft (got ${tightMask.softCount})`);
  }
});

test("scale-blind masks keep the legacy px behavior bit-for-bit at the 18 px/ft calibration", () => {
  const segs = [...sq(2, 2, 598, 398), ...sq(100, 100, 316, 280)];
  const meta = new Uint8Array(segs.length >> 2);
  const blind = buildMask(segs, 600, 400, 600, meta);
  const scaled = buildMask(segs, 600, 400, 600, meta, 18);      // ws 1 → mppf 18 = the calibration point
  const fb = floodRegion(blind, 200, 190, 0.5);
  const fs = floodRegion(scaled, 200, 190, 0.5);
  assert.equal(fb.status, "ok");
  assert.equal(fs.status, "ok");
  assert.equal((fb as { count: number }).count, (fs as { count: number }).count);
});

test("confidence: a mask below the determinism floor is called out", () => {
  const coarse = traceConfidence({ mppf: DETERMINISM_MIN_MPPF - 1 });
  assert.equal(coarse.score, CONF_COARSE);
  assert.deepEqual(coarse.factors, ["coarse-mask"]);
  assert.deepEqual(traceConfidence({ mppf: DETERMINISM_MIN_MPPF }).factors, []);
  assert.deepEqual(traceConfidence({}).factors, [], "unknown scale is not penalized");
});

test("MASK_MAX_DIM export still caps ws at 1", () => {
  const mo = buildMask(sq(2, 2, 98, 98), 100, 100, MASK_MAX_DIM, null, 12);
  assert.equal(mo.ws, 1);
  assert.equal(mo.mppf, 12);
});

// ── A1: the working raster is a property of the SHEET, not of the render ─────
// Audit finding A1: MASK_MAX_DIM is a CAP, not a pin. Below it the mask followed
// the render scale, so the per-sheet "Hi-Res render" toggle changed measured
// square footage on the same click (11×17 at 1/8": 97.8 SF vs 134.0 SF, +37%).
// Above the cap the resolution was pinned but Math.round(seg*ws) still quantized
// in RENDER px, so cap-bound sheets shifted too.
//
// AUDIT F3 — WHY THIS BLOCK WAS REWRITTEN, and it is working rule 1's fifth
// instance in this repo. The first A1 fix mapped into the baseline by
// RECONSTRUCTING the baseline dims from the rendered ones (`imgW × basePxPerFt /
// pxPerFt`), and the guard that certified it fed `w: 900 * k * 2` — an UNROUNDED
// real — on a sheet whose baseline (1800×1400) sits under MASK_MAX_DIM. Both
// halves of that are wrong about production:
//   • production passes `Math.ceil(viewport.width)` (TakeoffCanvas.jsx's render
//     effect), and the ceil is exactly what the reconstruction carries back into
//     the baseline. With unrounded reals the reconstruction is exact and the
//     guard passes against the broken fix.
//   • the sheet was SUB-CAP, so the guard never ran the case the fix claimed.
//     Cap-bound, the cap cancels the correction factor outright
//     (ws = k·min(1, maxDim/(imgW·k)) = maxDim/imgW — the OLD formula), and the
//     fix is a measured no-op.
// So every scene here now feeds CEIL'D dims, and there are two sheets: one
// sub-cap and one cap-bound. Measured on this fixture with the `page` argument
// removed (i.e. against the pre-F3 engine): the sub-cap mask changes DIMS
// (1800×1400 → 1801×1401 at rs 2.07 and 5.374) and the cap-bound one keeps its
// dims but has 624 differing cells and drifts −0.205% in SF, with mppf sliding
// 12.5000 → 12.4974. With `page` all of that is zero.
const A1_PT_PER_FT = 9, A1_BASE_RS = 2;              // 1/8" = 1'-0" (9 pt per foot)
interface A1Sheet { name: string; pageW: number; pageH: number; capBound: boolean }
const A1_SHEETS: A1Sheet[] = [
  // 900×700 pt → baseline 1800×1400, under the 3000 cap
  { name: "sub-cap", pageW: 900, pageH: 700, capBound: false },
  // 2160×1680 pt → baseline 4320×3360, over the cap. This is the case 1a02b15
  // claimed and never tested; the VA plan (3024×2160 pt) is cap-bound too.
  { name: "cap-bound", pageW: 2160, pageH: 1680, capBound: true },
];
/** The room, drawn in PDF POINTS and rendered at `rs` — so `segs` are image px
 *  at this render and `w`/`h` are what production computes: ceil(pageDim × rs).
 *  Same room on both sheets; only the page around it grows. The right wall's
 *  16 pt (1.78 ft) break is a real opening the SEAL LADDER closes at r=16 mask
 *  cells (verified: raw flood leaks, sealed flood is ok with sealedPx 16), which
 *  is what makes this scene sensitive — the ladder runs on the mask grid. */
function a1Scene(sheet: A1Sheet, rs: number) {
  const segs: number[] = [];
  const L = (a: number, b: number, c: number, d: number) => segs.push(a * rs, b * rs, c * rs, d * rs);
  L(100, 100, 400, 100); L(400, 100, 400, 180); L(400, 196, 400, 340);   // right wall with a break
  L(400, 340, 100, 340); L(100, 340, 100, 100);
  L(150, 150, 380, 150); L(150, 200, 380, 200);                          // interior linework
  return {
    segs,
    w: Math.ceil(sheet.pageW * rs), h: Math.ceil(sheet.pageH * rs),      // PRODUCTION's dims
    pxPerFt: A1_PT_PER_FT * rs, base: A1_PT_PER_FT * A1_BASE_RS,
    page: { pageW: sheet.pageW, pageH: sheet.pageH, renderScale: rs, baseScale: A1_BASE_RS },
    seed: [250 * rs, 250 * rs] as [number, number],
  };
}
// 2.07 / 2.0704 are the VA sheet's quoted and true autoRenderScale (they differ,
// and the drift is rounding-sensitive: −0.83% vs −7.03% on the real sheet);
// 5.374 is the audit's worked Hi-Res example on an 11×17.
const A1_SCALES = [2.07, 2.0704, 3, 5.374];

test("A1/F3: the mask is bit-identical across render scales — sub-cap AND cap-bound", () => {
  for (const sheet of A1_SHEETS) {
    const base = a1Scene(sheet, A1_BASE_RS);
    const mb = buildMask(base.segs, base.w, base.h, MASK_MAX_DIM, null, base.pxPerFt, base.base, base.page);
    assert.equal(Math.max(mb.mw, mb.mh) === MASK_MAX_DIM, sheet.capBound,
      `${sheet.name}: the fixture must actually be ${sheet.capBound ? "cap-bound" : "sub-cap"} (mask ${mb.mw}×${mb.mh})`);
    for (const rs of A1_SCALES) {
      const s = a1Scene(sheet, rs);
      const m = buildMask(s.segs, s.w, s.h, MASK_MAX_DIM, null, s.pxPerFt, s.base, s.page);
      // mppf is render-independent ALGEBRAICALLY (pxPerFt·k·wsB = basePxPerFt·wsB),
      // but pxPerFt arrives already multiplied by this render's scale, so the
      // cancellation is a float multiply/divide and lands within one ULP — 12.5
      // vs 12.499999999999998 on the cap-bound sheet at rs 2.07. No grouping of
      // the products is exact for every (rs, page) pair, and 1 ULP cannot move a
      // Math.round in sealRadiiFor/minPassRadiusFor outside a measure-zero set,
      // so the tolerance is stated rather than engineered away. The assertions
      // that matter — the mask grid and every cell in it — stay EXACT below.
      assert.ok(Math.abs((m.mppf ?? 0) - (mb.mppf ?? 0)) <= 1e-12 * (mb.mppf ?? 1),
        `${sheet.name}: mppf drifted at rs ${rs}: ${m.mppf} vs ${mb.mppf}`);
      assert.equal(m.mw, mb.mw, `${sheet.name}: mask width drifted at rs ${rs} (${m.mw} vs ${mb.mw})`);
      assert.equal(m.mh, mb.mh, `${sheet.name}: mask height drifted at rs ${rs} (${m.mh} vs ${mb.mh})`);
      let diff = 0;
      for (let i = 0; i < mb.mask.length; i++) if (mb.mask[i] !== m.mask[i]) diff++;
      assert.equal(diff, 0, `${sheet.name}: ${diff} mask cells differ at rs ${rs} — the raster still follows the render scale`);
    }
  }
});

test("A1/F3: measured area is identical across render scales — sub-cap AND cap-bound", () => {
  for (const sheet of A1_SHEETS) {
    const areas = [A1_BASE_RS, ...A1_SCALES].map((rs) => {
      const s = a1Scene(sheet, rs);
      const mo = buildMask(s.segs, s.w, s.h, MASK_MAX_DIM, null, s.pxPerFt, s.base, s.page);
      const mppf = mo.mppf ?? 0;
      assert.ok(mppf >= DETERMINISM_MIN_MPPF, `${sheet.name}: fixture must sit above the determinism floor (mppf ${mppf})`);
      const f = floodRegionSealed(mo, s.seed[0], s.seed[1], 0.5,
        sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf));
      assert.equal(f.status, "ok", `${sheet.name} at rs ${rs}`);
      return ringArea(traceRegion(f)) / (s.pxPerFt * s.pxPerFt);
    });
    for (const a of areas) assert.ok(Math.abs(a - areas[0]) < 0.01,
      `${sheet.name}: SF drifted across render scales: ${areas.map((x) => x.toFixed(3)).join(" / ")}`);
  }
});

// F3, the sub-cap residual, stated as the thing it actually is: ONE sheet has
// TWO mask builders (vector linework and scan pixels) and their grids have to be
// the same grid, or a sheet that switches paths — or a scan wrapper with a little
// vector linework — measures two different rooms. They used to disagree by a
// cell (1225×1585 vs 1224×1584 at rs 2.07) because only the raster half read the
// page in points. `baselineImgDims` is now the single source for both.
test("F3: the vector and the raster mask of one sheet land on ONE grid, at every render scale", () => {
  for (const sheet of [...A1_SHEETS, { name: "letter", pageW: 612, pageH: 792, capBound: false },
    { name: "VA plan", pageW: 3024, pageH: 2160, capBound: true }]) {
    for (const rs of [A1_BASE_RS, ...A1_SCALES]) {
      const s = a1Scene(sheet, rs);
      const vec = buildMask(s.segs, s.w, s.h, MASK_MAX_DIM, null, s.pxPerFt, s.base, s.page);
      const ras = rasterMaskScale({ pageW: sheet.pageW, pageH: sheet.pageH, renderScale: rs, baseScale: A1_BASE_RS, maxDim: MASK_MAX_DIM });
      assert.equal(vec.mw, ras.mw, `${sheet.name} at rs ${rs}: vector mask ${vec.mw}×${vec.mh}, raster mask ${ras.mw}×${ras.mh}`);
      assert.equal(vec.mh, ras.mh, `${sheet.name} at rs ${rs}: vector mask ${vec.mw}×${vec.mh}, raster mask ${ras.mw}×${ras.mh}`);
      assert.ok(Math.abs(vec.ws - ras.ws) < 1e-12, `${sheet.name} at rs ${rs}: ws ${vec.ws} vs ${ras.ws} — image px → mask px must be one number`);
    }
  }
});

test("A1/F3: omitting `page` keeps the legacy px/ft behaviour exactly (no-op for existing callers)", () => {
  // The bench and every unit fixture call buildMask without `page`; that path
  // must not move, or goldens move with it.
  const s = a1Scene(A1_SHEETS[0], A1_BASE_RS);
  const withBase = buildMask(s.segs, s.w, s.h, MASK_MAX_DIM, null, s.pxPerFt, s.base);
  const without = buildMask(s.segs, s.w, s.h, MASK_MAX_DIM, null, s.pxPerFt);
  assert.equal(without.ws, withBase.ws);
  assert.equal(without.mppf, withBase.mppf);
  assert.deepEqual(Array.from(without.mask), Array.from(withBase.mask));
  // …and at the BASELINE render `page` is itself a no-op — same grid, same cells
  const withPage = buildMask(s.segs, s.w, s.h, MASK_MAX_DIM, null, s.pxPerFt, s.base, s.page);
  assert.equal(withPage.ws, withBase.ws);
  assert.equal(withPage.mw, withBase.mw);
  assert.equal(withPage.mh, withBase.mh);
  assert.deepEqual(Array.from(withPage.mask), Array.from(withBase.mask));
  // a malformed page (0 dims, missing scales) falls back rather than dividing by zero
  for (const bad of [{ ...s.page, pageW: 0 }, { ...s.page, baseScale: 0 }, { ...s.page, renderScale: NaN }]) {
    const m = buildMask(s.segs, s.w, s.h, MASK_MAX_DIM, null, s.pxPerFt, s.base, bad);
    assert.equal(m.ws, withBase.ws, `malformed page ${JSON.stringify(bad)} must fall back to the legacy path`);
    assert.equal(m.mw, withBase.mw);
  }
});

test("F3: baselineImgDims is ceil(pageDim × baseScale) and never zero", () => {
  assert.deepEqual(baselineImgDims(612, 792, 2), { w: 1224, h: 1584 });
  assert.deepEqual(baselineImgDims(611.5, 791.2, 2), { w: 1223, h: 1583 });   // ceil, both axes
  assert.deepEqual(baselineImgDims(612, 792, 1), { w: 612, h: 792 });
  assert.deepEqual(baselineImgDims(0, 0, 2), { w: 2, h: 2 });                 // degenerate page ⇒ 1 pt, never 0 px
  assert.deepEqual(baselineImgDims(NaN, -5, 2), { w: 2, h: 2 });
  assert.deepEqual(baselineImgDims(612, 792, 0), { w: 612, h: 792 });         // bad scale ⇒ 1
});

// The production wiring, which no web test can execute: TakeoffCanvas.jsx is a
// React component and this suite has no DOM. What is checkable is that
// `ensureMask` still hands buildMask a POINTS-derived page baseline — reverting
// that one argument silently restores the pre-F3 behaviour with every test above
// still green, because the tests call buildMask directly.
test("F3: TakeoffCanvas.ensureMask still pins the mask to the page in POINTS", () => {
  const text = readFileSync(fileURLToPath(new URL("../src/pages/TakeoffCanvas.jsx", import.meta.url)), "utf8");
  const call = text.match(/mo = buildMask\([^;]*?\);/s);
  assert.ok(call, "ensureMask's buildMask call not found — re-point this guard");
  const site = call[0];
  assert.match(site, /baseScale:\s*RENDER_SCALE/, "the baseline must be RENDER_SCALE, the pin");
  assert.match(site, /renderScale:\s*rsNow/, "…and k must come from this sheet's own render scale");
  assert.match(site, /pageW:\s*pgVp\.width[\s\S]*pageH:\s*pgVp\.height/, "…over the page in POINTS");
  assert.match(text, /pgVp = pageObjsRef\.current\.get\(key\)\?\.getViewport\(\{ scale: 1 \}\)/,
    "the points must come from a scale-1 viewport, not from the panel bitmap dims");
});

// ── audit A3: the minimum-passage path is a DILATION path, and it must take
// the seal ladder's own two gates and report its own provenance. ────────────
// Before this, `minPassPx > 0` — true on every scaled sheet — returned from
// sealAttempt BEFORE the room-size cap and BEFORE the ≥75%-real-boundary rule,
// and without setting any provenance at all. So the project's advertised
// "guarded by a room-size cap and a >=75%-real-boundary rule" was vacuous on
// the PRIMARY path, and traceConfidence scored the result a verbatim 1.00.

test("A3: the min-passage rule reports how much of the verbatim flood it removed", () => {
  const { segs, seedA } = slitScene(0.3 * PXFT);
  for (const maxDim of [800, 400]) {
    const mo = buildMask(segs, 800, 500, maxDim, null, PXFT);
    const mppf = mo.mppf ?? 0;
    const f = floodRegionSealed(mo, seedA[0], seedA[1], 0.5, sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf)) as Extract<FloodResult, { status: "ok" }>;
    assert.equal(f.status, "ok");
    assert.equal(f.minPassPx, minPassRadiusFor(mppf), "the radius that ran is on the record");
    // chamber B is 36% of room A's area, so the rule removes ~26% of the
    // verbatim flood's region — the same 35.8% change of the MEASUREMENT the
    // audit reported, expressed against the flood it replaced
    assert.ok(Math.abs((f.minPassDelta ?? 0) - 0.263) < 0.01, `expected ~26.3% removed, got ${f.minPassDelta}`);
    const c = traceConfidence(floodSignals(f, { areaSF: f.count / (mppf * mppf) }));
    assert.ok(c.score < 1, `a measurement the rule moved by a third cannot score 1.00 (got ${c.score})`);
    assert.match(c.factors.join(" "), /min-passage-rule/);
  }
});

test("A3: a rule that changed nothing costs nothing and says nothing", () => {
  const segs = [...sq(100, 100, 340, 340)];
  const mo = buildMask(segs, 800, 500, 800, null, PXFT);
  const mppf = mo.mppf ?? 0;
  const f = floodRegionSealed(mo, 220, 220, 0.5, sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf)) as Extract<FloodResult, { status: "ok" }>;
  assert.equal(f.status, "ok");
  assert.ok(minPassRadiusFor(mppf) > 0, "the rule really is on for this sheet");
  assert.equal(f.minPassPx, undefined, "provenance for 'a rule ran and did not matter' is noise");
  assert.equal(f.minPassDelta, undefined);
  assert.equal(traceConfidence(floodSignals(f)).score, 1);
});

// Room A's ONLY opening is a sub-½ft slot: the verbatim linework does not
// enclose it at all, so the dilation is not trimming a connection — it is
// BRIDGING an opening, which is the seal ladder's job under another name.
function slottedRoom(slotPx: number) {
  const segs = [
    100, 100, 340, 100, 100, 340, 340, 340, 100, 100, 100, 340,
    340, 100, 340, 200, 340, 200 + slotPx, 340, 340,
  ];
  return { segs, seed: [220, 220] as [number, number] };
}

test("A3: a room bounded only by the min-passage rule reports itself as SEALED, not as verbatim", () => {
  const { segs, seed } = slottedRoom(0.4 * PXFT);
  const mo = buildMask(segs, 800, 500, 800, null, PXFT);
  const mppf = mo.mppf ?? 0;
  assert.equal(floodRegion(mo, seed[0], seed[1], 0.5).status, "leak", "without the rule this space is not enclosed");
  const f = floodRegionSealed(mo, seed[0], seed[1], 0.5, sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf)) as Extract<FloodResult, { status: "ok" }>;
  assert.equal(f.status, "ok");
  assert.equal(f.minPassDelta, 1, "the verbatim flood bounded nothing — the rule is the whole measurement");
  assert.equal(f.sealedPx, minPassRadiusFor(mppf), "so it reports a seal, and the readout says 'sealed'");
  assert.equal(typeof f.virtualFrac, "number", "with the ladder's own virtual-boundary fraction");
  const c = traceConfidence(floodSignals(f, { areaSF: f.count / (mppf * mppf) }));
  assert.ok(c.score <= 0.90, `an unenclosed space must not come back confidently bounded (got ${c.score})`);
  assert.match(c.factors.join(" "), /undecidable-passage/);
});

// D-1: the room-size cap and the ≥75%-real-boundary rule now apply to the
// min-passage path too. This scene is where that BITES: a rectangle drawn as a
// picket line of 4-px dashes 18 px apart. The min-passage dilation closes every
// gap, so the primary flood comes back a clean "ok" — and the region it returns
// has most of its boundary sitting in open space, which is exactly what the
// ≥75% rule exists to refuse. Before A3 this returned that region, unguarded,
// with no provenance, at confidence 1.00.
function picketRoom(gapPx: number, dashPx: number) {
  const segs: number[] = [];
  const dashes = (x0: number, y0: number, x1: number, y1: number) => {
    const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(L / (dashPx + gapPx)));
    for (let k = 0; k < n; k++) {
      const t0 = (k * (dashPx + gapPx)) / L, t1 = Math.min(1, (k * (dashPx + gapPx) + dashPx) / L);
      segs.push(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0, x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
    }
  };
  dashes(200, 200, 800, 200); dashes(800, 200, 800, 700); dashes(800, 700, 200, 700); dashes(200, 700, 200, 200);
  return segs;
}

test("A3/D-1: the min-passage path takes the ladder's ≥75%-real-boundary rule — a region it refuses is refused", () => {
  const PICKET_PXFT = 72;                       // ⇒ minPassRadiusFor = 18 px
  const segs = picketRoom(18, 4);
  const mo = buildMask(segs, 1400, 1000, 1400, null, PICKET_PXFT);
  const mppf = mo.mppf ?? 0;
  const r = minPassRadiusFor(mppf);
  assert.ok(r > 0);
  // the dilated flood itself succeeds — so it is the GUARD, not the flood,
  // that must refuse here. Without the guard this returns "ok".
  const dilated = floodRegion(dilateHardMask(mo, r), 500, 450, 0.5);
  assert.equal(dilated.status, "ok", "the min-passage flood is clean; only the guard stands between it and a bogus room");
  const f = floodRegionSealed(mo, 500, 450, 0.5, sealRadiiFor(mppf), doorWedgeCapPx(mppf), r);
  assert.notEqual(f.status, "ok", `a region >25% synthetic boundary must be refused, not measured (got ${f.status})`);
});

test("A3/D-1: the guard does not fire on ordinary rooms — the corpus refusal rate stays 0", () => {
  // the same construction with a SOLID boundary: the guard must be silent.
  const segs = picketRoom(0, 600);
  const mo = buildMask(segs, 1400, 1000, 1400, null, 72);
  const mppf = mo.mppf ?? 0;
  const f = floodRegionSealed(mo, 500, 450, 0.5, sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf));
  assert.equal(f.status, "ok");
});
