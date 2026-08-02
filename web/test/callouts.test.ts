// Callout cross-check core tests — pure, DOM-free, pdfjs-free. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAreaCallouts, nearMissCallouts, nearbyText, clusterAreas, sweepOffsets, sweepOffsetsFor, sweepRadiusFt, checkCallouts, summarize } from "../bench/callouts.ts";

test("parseAreaCallouts: the drawing's own area annotations, and only those", () => {
  const items = [
    { str: "557 SF", x: 10, y: 10 },
    { str: "1,718 SF", x: 20, y: 20 },      // thousands separator
    { str: "250 S.F.", x: 30, y: 30 },      // punctuated
    { str: "40 sf", x: 40, y: 40 },         // lowercase
    { str: "12.5 SQ FT", x: 50, y: 50 },    // fractional, spelled out
    { str: "137", x: 60, y: 60 },           // room tag — a bare number is not a callout
    { str: "CPT-1", x: 70, y: 70 },         // finish tag
    { str: "CARPET 557 SF", x: 80, y: 80 }, // schedule row — anchor is in the schedule, not the room
    { str: "SF", x: 90, y: 90 },            // unit alone
    { str: "0 SF", x: 100, y: 100 },        // degenerate
  ];
  assert.deepEqual(parseAreaCallouts(items).map((c) => [c.sf, c.x]), [
    [557, 10], [1718, 20], [250, 30], [40, 40], [12.5, 50],
  ]);
});

test("nearbyText: nearest-first context within the radius, excluding the anchor itself", () => {
  const items = [
    { str: "557 SF", x: 0, y: 0 },
    { str: "CPT-1", x: 3, y: 0 },
    { str: "OFFICE 101", x: 10, y: 0 },
    { str: "FAR AWAY", x: 500, y: 0 },
  ];
  assert.deepEqual(nearbyText(items, 0, 0, 50), ["CPT-1", "OFFICE 101"]);
  assert.deepEqual(nearbyText(items, 0, 0, 50, 1), ["CPT-1"]);
});

test("clusterAreas: the modal region wins, ties break to the larger area", () => {
  // 619-ish three times, 15-ish twice
  const g = clusterAreas([619, 620.1, 15, 618.5, 15.2]);
  assert.equal(g.length, 2);
  assert.equal(g[0].members, 3);
  assert.ok(Math.abs(g[0].sf - 619.2) < 0.5, `modal ≈ 619, got ${g[0].sf}`);
  assert.equal(g[1].members, 2);

  assert.deepEqual(clusterAreas([]), []);
  const tie = clusterAreas([100, 200]);              // one member each — larger first
  assert.deepEqual(tie.map((x) => x.sf), [200, 100]);
});

test("sweepOffsets: a feet-true grid around the anchor, scaled by the sheet", () => {
  const offs = sweepOffsets(18, [-2, 0, 2]);
  assert.equal(offs.length, 9);
  assert.deepEqual(offs[0], [-36, -36]);
  assert.ok(offs.some(([dx, dy]) => dx === 0 && dy === 0), "the anchor itself is always swept");
  assert.deepEqual(sweepOffsets(9, [-2, 0, 2])[0], [-18, -18], "coarser sheet ⇒ same distance in feet");
});

test("checkCallouts: modal region, agreement count and seed sensitivity per callout", () => {
  const callouts = parseAreaCallouts([{ str: "500 SF", x: 0, y: 0 }]);
  // a stubbed engine: the anchor lands in stroke text (2 SF), the ring around
  // it reads the room (450 SF), and one seed leaks somewhere huge
  const measure = (x: number, y: number) => (x === 0 && y === 0 ? 2 : x > 0 && y > 0 ? 5000 : 450);
  const [row] = checkCallouts(callouts, measure, sweepOffsets(1, [-1, 0, 1]));
  assert.equal(row.printed_sf, 500);
  assert.equal(row.engine_sf, 450, "the modal region, not the glyph interior the anchor landed in");
  assert.ok(Math.abs(row.err! + 0.10) < 1e-9, "−10% vs the drawing");
  assert.equal(row.agreement, 7);
  assert.equal(row.seeds, 9);
  assert.equal(row.regions, 3, "glyph, room and leak are three distinct answers");
});

test("checkCallouts: a callout no seed can measure reports null, never zero", () => {
  const callouts = parseAreaCallouts([{ str: "500 SF", x: 0, y: 0 }]);
  const [row] = checkCallouts(callouts, () => null, sweepOffsets(1, [0]));
  assert.equal(row.engine_sf, null);
  assert.equal(row.err, null);
  assert.equal(row.refused, 1);
  assert.equal(row.agreement, 0);
});

test("summarize: mixed signs rule out a scale error; a uniform tight sign does not", () => {
  const row = (printed: number, engine: number, stable = true) => ({
    raw: `${printed} SF`, printed_sf: printed, engine_sf: engine,
    err: (engine - printed) / printed, agreement: 1, seeds: 1, regions: 1, refused: 0, stable, context: [],
  });
  const mixed = summarize([row(100, 111), row(100, 92), row(100, 56)]);
  assert.equal(mixed.matched, 3);
  assert.equal(mixed.uniformSign, false);
  assert.match(mixed.verdict, /mixed signs/);
  assert.ok(Math.abs(mixed.minErr + 0.44) < 1e-9 && Math.abs(mixed.maxErr - 0.11) < 1e-9);

  const scale = summarize([row(100, 96), row(100, 95), row(100, 94)]);
  assert.equal(scale.uniformSign, true);
  assert.match(scale.verdict, /wrong sheet scale/);
  assert.ok(Math.abs(scale.fitFactor - 0.95) < 0.01, `best-fit multiplier ≈ 0.95, got ${scale.fitFactor}`);

  const biased = summarize([row(100, 96), row(100, 70), row(100, 60)]);
  assert.equal(biased.uniformSign, true);
  assert.match(biased.verdict, /not ONE scale error/);

  assert.match(summarize([]).verdict, /no callout produced a measurable region/);
});

test("summarize: a seed-unstable row is reported but never averaged", () => {
  const row = (printed: number, engine: number, stable: boolean) => ({
    raw: `${printed} SF`, printed_sf: printed, engine_sf: engine,
    err: (engine - printed) / printed, agreement: stable ? 9 : 2, seeds: 10, regions: stable ? 1 : 7,
    refused: 0, stable, context: [],
  });
  // one honest −10% reading plus a glyph-interior artifact that would drag any
  // average into nonsense
  const s = summarize([row(100, 90, true), row(100, 1, false)]);
  assert.equal(s.matched, 1);
  assert.equal(s.unstable, 1);
  assert.equal(s.total, 2);
  assert.ok(Math.abs(s.meanAbsErr - 0.10) < 1e-9, "the −99% artifact is excluded");
  assert.ok(Math.abs(s.medianAbsErr - 0.10) < 1e-9);

  const allBad = summarize([row(100, 1, false)]);
  assert.equal(allBad.matched, 0);
  assert.match(allBad.verdict, /every sweep was seed-sensitive/);
});

test("checkCallouts: stability is the modal region's share of the seeds", () => {
  const callouts = parseAreaCallouts([{ str: "500 SF", x: 0, y: 0 }]);
  // 8 of 9 seeds agree — stable
  const steady = checkCallouts(callouts, (x, y) => (x === 0 && y === 0 ? 2 : 450), sweepOffsets(1, [-1, 0, 1]));
  assert.equal(steady[0].stable, true);
  // every seed a different answer — no measurement, just sensitivity
  let n = 0;
  const scattered = checkCallouts(callouts, () => 100 * ++n, sweepOffsets(1, [-1, 0, 1]));
  assert.equal(scattered[0].stable, false);
  assert.equal(scattered[0].regions, 9);
});

test("summarize: a 1/8\"-read-as-1/4\" mix-up is caught, not explained away", () => {
  const row = (printed: number, engine: number) => ({
    raw: `${printed} SF`, printed_sf: printed, engine_sf: engine,
    err: (engine - printed) / printed, agreement: 9, seeds: 10, regions: 1, refused: 0, stable: true, context: [],
  });
  // true ×4 area scale (linear ×2) with ±1% per-room convention noise. The old
  // rule tested the spread of RELATIVE error, which this inflates to 8 points,
  // so it reported "not a scale error" — the single most common real mistake.
  const s = summarize([row(100, 4 * 101), row(300, 4 * 297), row(700, 4 * 706)]);
  assert.ok(Math.abs(s.fitFactor - 4) < 0.05, `best-fit ≈ ×4, got ${s.fitFactor}`);
  assert.ok(s.fitSpread < 0.05, `one multiplier explains it, got log-sd ${s.fitSpread}`);
  assert.match(s.verdict, /wrong sheet scale/);
});

test("summarize: two rows cannot accuse the sheet scale of anything", () => {
  const row = (printed: number, engine: number) => ({
    raw: `${printed} SF`, printed_sf: printed, engine_sf: engine,
    err: (engine - printed) / printed, agreement: 9, seeds: 10, regions: 1, refused: 0, stable: true, context: [],
  });
  const s = summarize([row(100, 97)]);
  assert.match(s.verdict, /too few to say anything about the sheet scale/);
  assert.match(summarize([row(100, 97), row(200, 194)]).verdict, /too few/);
});

test("sweepRadiusFt: the window is the room the callout claims, not a fixed grid", () => {
  assert.ok(Math.abs(sweepRadiusFt(16) - 2) < 1e-9, "a 16 SF closet is sampled within ±2 ft");
  assert.ok(Math.abs(sweepRadiusFt(557) - 8) < 1e-9, "a big room saturates at the cap");
  assert.equal(sweepRadiusFt(0.04), 0.75, "never smaller than the floor");
  assert.equal(sweepRadiusFt(undefined), 4);

  // the concrete failure: an 8 ft grid around a 4x4 ft closet puts seeds in
  // other rooms, which then agree with each other
  const closet = sweepOffsetsFor(18, 16);
  assert.equal(closet.length, 25);
  assert.ok(Math.max(...closet.map(([dx]) => Math.abs(dx))) <= 2 * 18 + 1e-9);
  assert.ok(Math.max(...sweepOffsetsFor(18, 557).map(([dx]) => Math.abs(dx))) > 100);
});

test("nearMissCallouts: an area this parser can't read is reported, not silently absent", () => {
  const items = [
    { str: "557 SF", x: 0, y: 0 },        // matched — not a near miss
    { str: "± 557 SF", x: 1, y: 1 },
    { str: "(250 SF)", x: 2, y: 2 },
    { str: "706 GSF", x: 3, y: 3 },
    { str: "411 SF NET", x: 4, y: 4 },
    { str: "CORRIDOR", x: 5, y: 5 },
    { str: "137", x: 6, y: 6 },
  ];
  const misses = nearMissCallouts(items);
  assert.deepEqual(misses, ["± 557 SF", "(250 SF)", "706 GSF", "411 SF NET"]);
  assert.deepEqual(parseAreaCallouts(items).map((c) => c.sf), [557]);
});

test("parseAreaCallouts: a decimal comma is not a thousands separator", () => {
  // "1,5 SF" used to become 15 — the comma was stripped unconditionally, so a
  // metric-authored or malformed number silently became the wrong denominator
  assert.deepEqual(parseAreaCallouts([{ str: "1,5 SF", x: 0, y: 0 }]), []);
  assert.deepEqual(parseAreaCallouts([{ str: ",557 SF", x: 0, y: 0 }]), []);
  assert.deepEqual(parseAreaCallouts([{ str: "1,718 SF", x: 0, y: 0 }]).map((c) => c.sf), [1718]);
  assert.deepEqual(parseAreaCallouts([{ str: "12.5 SF", x: 0, y: 0 }]).map((c) => c.sf), [12.5]);
});

test("clusterAreas: the answer is a function of the multiset, not the input order", () => {
  // greedy first-fit over input order chained 100-104-108 into one cluster or
  // two depending on which arrived first, moving the reported modal area
  const a = clusterAreas([100, 104, 108]);
  const b = clusterAreas([104, 100, 108]);
  const c = clusterAreas([108, 104, 100]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);

  const shuffled = clusterAreas([112, 109, 106, 103, 100]);
  assert.deepEqual(clusterAreas([100, 103, 106, 109, 112]), shuffled);
});
