// Detect Rooms core tests — pure, DOM-free, pdfjs-free. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { roomLabelSeeds, detectRegions, sheetBounds, detectionReport, NO_TAG_CAVEAT, ROOM_LABEL_RE } from "../src/lib/detectRooms.ts";
import type { DetectionTally } from "../src/lib/detectRooms.ts";
import { buildMask, MASK_MAX_DIM } from "../src/lib/oneclick.ts";

// a closed square room, as flat boundary segments in image px
function squareSegs(x0: number, y0: number, x1: number, y1: number): number[] {
  return [
    x0, y0, x1, y0,
    x1, y0, x1, y1,
    x1, y1, x0, y1,
    x0, y1, x0, y0,
  ];
}

test("ROOM_LABEL_RE: 2-3 digits with an optional trailing letter", () => {
  for (const s of ["10", "134", "139A", "170"]) assert.ok(ROOM_LABEL_RE.test(s), s);
  for (const s of ["1", "1234", "AB12", "104-A", ""]) assert.ok(!ROOM_LABEL_RE.test(s), s);
});

test("roomLabelSeeds: keeps only room-number tokens, ANY token in a multi-word item counts", () => {
  const items = [
    { str: "OFFICE 101", x: 50, y: 60 },
    { str: "CORRIDOR 104", x: 70, y: 80 },
    { str: "FLOOR FINISH PLAN", x: 0, y: 0 },        // no digits — dropped
    { str: "SCALE: 1/4\" = 1'-0\"", x: 10, y: 10 },  // no matching token — dropped
    { str: "139A", x: 90, y: 90 },                    // bare number+letter
  ];
  const seeds = roomLabelSeeds(items);
  assert.deepEqual(seeds, [
    { str: "101", seed: [50, 60] },
    { str: "104", seed: [70, 80] },
    { str: "139A", seed: [90, 90] },
  ]);
});

test("roomLabelSeeds: empty/whitespace-only strings and items with no digits produce no seed", () => {
  assert.deepEqual(roomLabelSeeds([{ str: "", x: 0, y: 0 }, { str: "   ", x: 1, y: 1 }, { str: "LOBBY", x: 2, y: 2 }]), []);
});

test("detectRegions: a clean room floods and is kept, status-gated (leak/tiny dropped)", () => {
  const segs = squareSegs(20, 20, 100, 100); // 80x80 interior
  const mask = buildMask(segs, 300, 300);
  const seeds = [
    { str: "101", seed: [60, 60] as [number, number] },   // inside the room — clean
    { str: "999", seed: [5, 5] as [number, number] },      // outside the enclosure — leaks
  ];
  const found = detectRegions(mask, seeds);
  assert.equal(found.length, 1, "only the clean flood survives the status gate");
  assert.equal(found[0].str, "101");
  assert.equal(found[0].flood.status, "ok");
});

test("detectRegions: an empty seed list detects nothing", () => {
  const mask = buildMask(squareSegs(20, 20, 100, 100), 300, 300);
  assert.deepEqual(detectRegions(mask, []), []);
});

// ── parity with the click path (issue #184 round 9) ────────────────────────
// detectRegions used to call the raw floodRegion, so a batch detection
// measured with the pre-sealing engine while a click on the same room got
// sealing, door wedges and the minimum-passage rule. These two pin the
// halves of that gap that are cheapest to state: a room only reachable
// THROUGH the seal ladder, and two rooms that must not merge into one
// double-counted region.

const PXFT = 18;                                    // 1/4" = 1'-0" at render scale 1
const outer = squareSegs(2, 2, 998, 798);           // sheet border, as in the bench corpus

test("detectRegions: a 3 ft cased opening is sealed, not dropped (click-path parity)", () => {
  // the bench's cased-opening-3ft geometry: a 12×10 ft room whose bottom wall
  // has a 54 px (3 ft) gap. The raw flood walks straight out of it.
  const room = [
    100, 100, 316, 100, 316, 100, 316, 280, 316, 280, 262, 280,
    208, 280, 100, 280, 100, 280, 100, 100,
  ];
  const mask = buildMask([...outer, ...room], 1000, 800, MASK_MAX_DIM, null, PXFT);
  const found = detectRegions(mask, [{ str: "101", seed: [200, 190] }]);
  assert.equal(found.length, 1, "the sealed flood recovers a room the raw flood leaks out of");
  assert.ok((found[0].flood.sealedPx ?? 0) > 0, "the seal ladder actually ran");
});

test("detectRegions: a sub-half-foot slit does not merge two rooms into double-counted floor", () => {
  // two rooms of DIFFERENT size sharing a wall with a 6 px (0.33 ft) slit —
  // under MIN_PASS_FT, so the minimum-passage rule must keep them apart. If
  // they merge, both labels return the same region and the same floor is
  // proposed twice.
  const shell = squareSegs(100, 100, 460, 280);     // 20×10 ft overall
  const wallX = 316;                                 // 12 ft from the left wall
  const sharedWall = [
    wallX, 100, wallX, 187,                          // upper stretch
    wallX, 193, wallX, 280,                          // lower stretch — 6 px slit between
  ];
  const mask = buildMask([...outer, ...shell, ...sharedWall], 1000, 800, MASK_MAX_DIM, null, PXFT);
  const found = detectRegions(mask, [
    { str: "101", seed: [200, 190] },                // the wide room
    { str: "102", seed: [400, 190] },                // the narrow room
  ]);
  assert.equal(found.length, 2, "both rooms detected");
  const [a, b] = found.map((r) => r.flood.count);
  const interior = found[0].flood.mw * found[0].flood.mh;   // generous upper bound
  assert.ok(a !== b, `merged regions would be identical (got ${a} and ${b})`);
  assert.ok(a > b, "the 12 ft room must read larger than the 8 ft one");
  assert.ok(a + b < interior, "neither room may swallow the other's floor");
});

// ── label precision (issue #184 round 9) ──────────────────────────────────
// Matching the number is not enough. On a real VA finish plan, 16 of 56
// pattern-matching numerals were not rooms, and the paper-space ones produced
// the largest "room" on the sheet — 847 SF of title block.

test("roomLabelSeeds: the plan's own printed areas are not room tags", () => {
  const items = [
    { str: "137", x: 10, y: 10 },
    { str: "557 SF", x: 20, y: 20 },        // the numeric token would survive tokenizing
    { str: "250 S.F.", x: 30, y: 30 },
    { str: "706 GSF", x: 40, y: 40 },
    { str: "OFFICE 101", x: 50, y: 50 },    // still a room
  ];
  assert.deepEqual(roomLabelSeeds(items).map((s) => s.str), ["137", "101"]);
});

test("roomLabelSeeds: dimensions, drawing numbers and title-block text are not room tags", () => {
  const items = [
    { str: "58'-5\"", x: 10, y: 10 },                 // dimension string
    { str: "08 - 6231", x: 20, y: 20 },               // drawing number
    { str: "RENOVATE BUILDING 28", x: 30, y: 30 },    // title-block sentence
    { str: "SHEET 12", x: 40, y: 40 },
    { str: "1 OF 12", x: 50, y: 50 },
    { str: "CORRIDOR 104", x: 60, y: 60 },            // still a room
    { str: "139A", x: 70, y: 70 },                    // still a room
  ];
  assert.deepEqual(roomLabelSeeds(items).map((s) => s.str), ["104", "139A"]);
});

test("roomLabelSeeds: the spatial gate drops sheet-margin numerals, and is opt-in", () => {
  const items = [
    { str: "10", x: 5, y: 5 },              // sheet corner
    { str: "33", x: 995, y: 795 },          // title block
    { str: "134", x: 500, y: 400 },         // a real room, mid-sheet
  ];
  assert.deepEqual(roomLabelSeeds(items).map((s) => s.str), ["10", "33", "134"], "no bounds ⇒ no spatial filtering");
  assert.deepEqual(
    roomLabelSeeds(items, { bounds: sheetBounds(1000, 800) }).map((s) => s.str),
    ["134"],
  );
});

test("sheetBounds: a symmetric inset of the sheet", () => {
  assert.deepEqual(sheetBounds(1000, 800, 0.1), { x0: 100, y0: 80, x1: 900, y1: 720 });
});

test("roomLabelSeeds: the seed drops clear of a tag box when the caller supplies glyph height", () => {
  // a rectangle drawn AROUND the room number is a common convention; the
  // anchor sits inside it, so the flood measures the box (~3.5 SF), not the
  // room. The box hugs the text horizontally but ends just under the baseline.
  const items = [{ str: "137", x: 100, y: 200, h: 10 }];
  assert.deepEqual(roomLabelSeeds(items), [{ str: "137", seed: [100, 215] }], "1.5 text heights below");
  assert.deepEqual(roomLabelSeeds(items, { gap: 3 }), [{ str: "137", seed: [100, 230] }]);
  assert.deepEqual(roomLabelSeeds(items, { placement: "anchor" }), [{ str: "137", seed: [100, 200] }]);
});

test("roomLabelSeeds: no glyph height ⇒ the anchor, unchanged", () => {
  // a caller that can't supply metrics keeps the original behavior rather than
  // guessing an offset in the wrong units
  assert.deepEqual(roomLabelSeeds([{ str: "137", x: 100, y: 200 }]), [{ str: "137", seed: [100, 200] }]);
  assert.deepEqual(roomLabelSeeds([{ str: "137", x: 100, y: 200, h: 0 }]), [{ str: "137", seed: [100, 200] }]);
  assert.deepEqual(
    roomLabelSeeds([{ str: "137", x: 100, y: 200 }], { placement: "below-box" }),
    [{ str: "137", seed: [100, 200] }],
    "asking for below-box without metrics cannot fabricate one",
  );
});

test("roomLabelSeeds: the drop happens after the spatial gate, not before", () => {
  // a tag just inside the bottom of the drawing extent: its dropped seed lands
  // outside. Gating on the moved seed would discard a legitimate room tag.
  const bounds = sheetBounds(1000, 800);                        // y1 = 752
  const items = [{ str: "134", x: 500, y: 750, h: 10 }];        // anchor inside, seed at 765
  const seeds = roomLabelSeeds(items, { bounds });
  assert.ok(750 < bounds.y1 && 765 > bounds.y1, "the fixture straddles the edge as intended");
  assert.equal(seeds.length, 1, "gated on the label's own position");
  assert.deepEqual(seeds[0].seed, [500, 765]);
});

// ── detectionReport — the honesty core ─────────────────────────────────────
// These pin the WORDING as behavior, because the wording is the feature: a
// batch detector that reports only its successes tells the estimator the sheet
// is measured when most of it isn't.

const tally = (o: Partial<DetectionTally> = {}): DetectionTally => ({
  textItems: 500, patternHits: 12, seeds: 12, regions: 9, proposals: 9, tiny: 0, ...o,
});

test("detectionReport: the headline always states the denominator", () => {
  const r = detectionReport(tally({ proposals: 9, seeds: 12 }));
  assert.equal(r.headline, "9 of 12 room tags produced a room.");
  assert.equal(r.empty, false);
});

test("detectionReport: the no-tag ceiling rides EVERY report, including a perfect one", () => {
  // the case that most invites "sheet done": every tag produced a room
  const perfect = detectionReport(tally({ patternHits: 4, seeds: 4, regions: 4, proposals: 4 }));
  assert.equal(perfect.headline, "4 of 4 room tags produced a room.");
  assert.equal(perfect.limits.at(-1), NO_TAG_CAVEAT);
  assert.match(perfect.message, /NOT detected/);
  // and on the other extreme
  for (const t of [tally({ seeds: 0, patternHits: 0, regions: 0, proposals: 0 }),
                   tally({ proposals: 0, regions: 0 }),
                   tally({ cancelled: true, proposals: 2 })]) {
    assert.equal(detectionReport(t).limits.at(-1), NO_TAG_CAVEAT);
  }
});

test("detectionReport: limits are never empty, and the caveat is always last", () => {
  const r = detectionReport(tally({ patternHits: 56, seeds: 41, regions: 40, proposals: 40, tiny: 11 }));
  assert.ok(r.limits.length >= 1);
  assert.equal(r.limits.at(-1), NO_TAG_CAVEAT);
  assert.match(r.limits[0], /^15 other numerals rejected as not a room tag/);
  assert.match(r.limits[1], /^1 tag produced nothing/);
  assert.match(r.limits[2], /^11 proposals under 4 SF/);
});

test("detectionReport: no tags at all is a stated outcome, not an empty screen", () => {
  const none = detectionReport(tally({ patternHits: 0, seeds: 0, regions: 0, proposals: 0 }));
  assert.equal(none.headline, "No room-number tags on this sheet — detection has nothing to seed from.");
  assert.equal(none.empty, true);
  // numerals present but all rejected reads differently — the reason matters
  const filtered = detectionReport(tally({ patternHits: 7, seeds: 0, regions: 0, proposals: 0 }));
  assert.equal(filtered.headline, "No room-number tags on this sheet — all 7 matching numerals were rejected as something else.");
  assert.equal(filtered.empty, true);
  // …and with zero seeds there is no "N of the seeds were junk" line to add
  assert.equal(filtered.limits.length, 1);
});

test("detectionReport: tags found but nothing floodable says both halves", () => {
  const r = detectionReport(tally({ patternHits: 12, seeds: 12, regions: 0, proposals: 0 }));
  assert.equal(r.headline, "No rooms detected: 12 room tags found, none produced a usable region.");
  assert.equal(r.empty, true);
  assert.match(r.message, /12 tags produced nothing/);
});

test("detectionReport: a cancelled pass says the rest were never tried", () => {
  const r = detectionReport(tally({ cancelled: true, seeds: 41, regions: 6, proposals: 6 }));
  assert.match(r.limits[0], /Stopped early/);
  assert.equal(r.empty, false);
});

test("detectionReport: singular/plural, and the tiny threshold is the caller's", () => {
  const one = detectionReport(tally({ patternHits: 2, seeds: 1, regions: 1, proposals: 0, tiny: 0 }));
  assert.match(one.headline, /1 room tag found/);
  assert.match(one.message, /1 tag produced nothing/);
  const t = detectionReport(tally({ proposals: 9, tiny: 1 }), 6);
  assert.match(t.message, /1 proposal under 6 SF .* Reject it\./);
});

test("detectionReport: message is the headline plus every limit, in order", () => {
  const r = detectionReport(tally({ tiny: 3 }));
  assert.equal(r.message, [r.headline, ...r.limits].join(" "));
});

// ── a cancelled pass must not launder untried tags into failures ───────────
// (Copilot review, PR #190). "Nobody tried this tag" and "the fill leaked out
// of this room" are different facts, and only the second is a reason to
// distrust the engine on this sheet.

const cancelTally = (over: Partial<DetectionTally> = {}): DetectionTally => ({
  textItems: 100, patternHits: 12, seeds: 10, tried: 10, regions: 8, proposals: 8, tiny: 0, ...over,
});

test("detectionReport: a cancelled pass counts failures against what was TRIED", () => {
  // 10 tags on the sheet, stopped after 4, of which 3 produced a room
  const r = detectionReport(cancelTally({ tried: 4, regions: 3, proposals: 3, cancelled: true }));
  assert.match(r.headline, /3 of 4 room tags produced a room \(10 on the sheet\)/);
  assert.ok(r.limits.some((l) => /Stopped early — 6 room tags were never tried/.test(l)),
    `must say what was skipped, got ${JSON.stringify(r.limits)}`);
  assert.ok(r.limits.some((l) => /^1 tag produced nothing/.test(l)),
    `only the ONE tried-and-failed tag is a failure, got ${JSON.stringify(r.limits)}`);
  assert.ok(!r.limits.some((l) => /^7 tags produced nothing/.test(l)),
    "the 6 untried tags must never be reported as fill failures");
});

test("detectionReport: cancelling before the first flood claims nothing", () => {
  const r = detectionReport(cancelTally({ tried: 0, regions: 0, proposals: 0, cancelled: true }));
  assert.match(r.headline, /none was tried/);
  assert.ok(r.limits.some((l) => /never tried/.test(l)));
  assert.ok(!r.limits.some((l) => /produced nothing/.test(l)), "nothing was tried, so nothing failed");
  assert.equal(r.empty, true);
});

test("detectionReport: a completed pass is unchanged, and a caller with no `tried` still reads right", () => {
  const complete = detectionReport(cancelTally({ regions: 8, proposals: 8 }));
  assert.match(complete.headline, /8 of 10 room tags produced a room\./);
  assert.ok(!complete.headline.includes("on the sheet"), "no cancellation aside on a full pass");
  assert.ok(complete.limits.some((l) => /^2 tags produced nothing/.test(l)));

  const legacy = detectionReport({ ...cancelTally({ proposals: 8, regions: 8 }), tried: undefined });
  assert.deepEqual(legacy.limits, complete.limits, "absent `tried` means everything was tried");
  assert.equal(legacy.headline, complete.headline);
});
