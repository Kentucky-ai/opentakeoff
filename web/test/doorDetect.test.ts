// The in-browser door detector (lib/doorDetect): tiling and decoding around
// the model call, the fusion with the door reader, the swing-box line fit,
// the false-find filters, and how the result reaches the Doors suite.
// Inputs are small and built by hand; parity with the Python prototype on
// whole sheets is checked by bench/doors/detectParity.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tileOrigins, cutTile, tileTensor, decodeTile, mergeBoxes, toPagePoints } from "../src/lib/doorDetect/tiles.ts";
import { fuseSheet, type FuseDoor } from "../src/lib/doorDetect/fuse.ts";
import { fitSwing, longestRun, clipMask, clipRect } from "../src/lib/doorDetect/swingfit.ts";
import { addSwingBoxes } from "../src/lib/doorDetect/swingAdd.ts";
import { dedupe, stallDoors, modalWidth, endProfile, type WallSegs } from "../src/lib/doorDetect/filters.ts";
import { wallEnds, nearestOval, stall2, legend2, features, restroomWords, legendLabels } from "../src/lib/doorDetect/filters2.ts";
import { doorTags, tagStage, type TagCandidate, type TextLine } from "../src/lib/doorDetect/tags.ts";
import { applyPipeline } from "../src/lib/doorDetect/apply.ts";
import { DOOR_DETECT_SETTINGS as S, runDoorPipeline, type PipelineResult } from "../src/lib/doorDetect/pipeline.ts";
import { pageText, extractWallSegs } from "../src/lib/doorDetect/pageInputs.ts";
import { inkBeyond, rint, arange, type DetBox, type Mask, type Pred } from "../src/lib/doorDetect/geom.ts";
import type { ReadDoor } from "../src/lib/doorReader.ts";

const PPF = 9;   // 1/8" = 1'-0"
const blank = (w: number, h: number, z = 1): Mask => ({ w, h, z, data: new Uint8Array(w * h) });
function line(m: Mask, x0: number, y0: number, x1: number, y1: number) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= n; i++) { const x = Math.round(x0 + ((x1 - x0) * i) / n), y = Math.round(y0 + ((y1 - y0) * i) / n); if (x >= 0 && y >= 0 && x < m.w && y < m.h) m.data[y * m.w + x] = 1; }
}
/** A reader door: hinge at (x, y), leaf pointing up, closing to the right, 3 ft. */
function swing(x: number, y: number, conf = 1, r = 3 * PPF): FuseDoor & ReadDoor {
  return {
    box: [x, y - r, x + r, y], jambLine: [[x, y], [x + r, y]], confidence: conf, pair: false, stall: false, dashed: false, doubts: [],
    leaves: [{ hinge: [x, y], tip: [x, y - r], radiusPt: r, sweepDeg: 90, drawn: "curve", misfitPt: 0, jambFt: 0.5, strike: true, leaf: "drawn" }],
  };
}

test("tiles: a stride apart, the last flush with the far edge", () => {
  assert.deepEqual(tileOrigins(1600, 640, 640, 480).map((t) => t[0]), [0, 480, 960]);
  assert.deepEqual(tileOrigins(500, 500, 640, 480), [[0, 0]]);
  assert.deepEqual(tileOrigins(1300, 640, 640, 480).map((t) => t[0]), [0, 480, 660]);
});

test("tiles: off-page area is white, and a tile with no ink is blank", () => {
  const gray = new Uint8Array(100 * 100).fill(255);
  assert.equal(cutTile(gray, 100, 100, 0, 0, 640, 240).blank, true);
  gray[50 * 100 + 50] = 0;
  const t = cutTile(gray, 100, 100, 0, 0, 640, 240);
  assert.equal(t.blank, false);
  assert.equal(t.px[50 * 640 + 50], 0);
  assert.equal(t.px[200 * 640 + 200], 255);
});

test("tiles: the model input is 3 normalized channels of the resized tile", () => {
  const px = new Uint8Array(4 * 4).fill(255);
  const x = tileTensor(px, 4, 8);
  assert.equal(x.length, 3 * 8 * 8);
  assert.ok(Math.abs(x[0] - (1 - 0.485) / 0.229) < 1e-5);
  assert.ok(Math.abs(x[64] - (1 - 0.456) / 0.224) < 1e-5);
  assert.ok(Math.abs(x[128] - (1 - 0.406) / 0.225) < 1e-5);
});

test("tiles: decode keeps scores at or over the floor and ignores the extra column", () => {
  const logit = (p: number) => Math.log(p / (1 - p));
  // 2 queries × 3 columns; 2 known classes, column 2 is the extra one
  const logits = [logit(0.9), logit(0.05), logit(0.99), logit(0.1), logit(0.3), logit(0.01)];
  const dets = [0.5, 0.5, 0.2, 0.1, 0.25, 0.25, 0.1, 0.1];
  const out = decodeTile(dets, logits, 3, 2, 640, 0.2, 300);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((b) => b[5]), [0, 1]);
  assert.ok(Math.abs(out[0][4] - 0.9) < 1e-6);
  assert.deepEqual(out[0].slice(0, 4).map(Math.round), [256, 288, 384, 352]);
});

test("tiles: one door, one box across overlapping tiles; a strip class can be set to compete only with strips", () => {
  const a: DetBox = [0, 0, 30, 30, 0.9, 0], b: DetBox = [2, 2, 30, 30, 0.8, 0], strip: DetBox = [0, 20, 30, 30, 0.7, 7];
  assert.equal(mergeBoxes([b, a], 0.4).length, 1);
  assert.equal(mergeBoxes([b, a], 0.4)[0][4], 0.9);
  // the strip lies wholly inside the swing box: dropped as its duplicate, as the published runner does
  assert.equal(mergeBoxes([a, strip], 0.4).length, 1);
  assert.equal(mergeBoxes([a, strip], 0.4, [7]).length, 2);
  assert.deepEqual(toPagePoints([[20, 40, 60, 80, 0.87654, 6]], 20 / 9), [[9, 18, 27, 36, 0.8765, 6]]);
});

test("shipped settings: the published runner's merge, round-4 model pinned", () => {
  assert.deepEqual(S.detect.strip_separate, []);
  assert.equal(S.model.sha256.length, 64);
  assert.equal(S.model.classes.length, 8);
  assert.equal(S.fusion.class_minimums["5"], undefined, "elevators are Division 14: never added");
  assert.equal(S.fusion.class_minimums["2"], undefined, "pocket doors are not added");
});

test("fusion: a withheld swing comes back with a swing box on it; a weak one with no box near is dropped", () => {
  const doors = [swing(100, 100), swing(300, 100, -0.2), swing(500, 100, 0.2), swing(700, 100, -0.2)];
  const det: DetBox[] = [[300, 73, 327, 100, 0.8, 0]];
  const r = fuseSheet(doors, det, PPF, S.fusion);
  assert.deepEqual(r.preds.map((p) => p.doors), [[0], [1]]);
  assert.equal(r.stats.rescued, 1);
  assert.equal(r.out[2], "vetoed");
  assert.equal(r.out[3], "withheld");
});

test("fusion: a doorway strip on a single leaf picks hinge to tip over hinge to closed end", () => {
  const d = swing(100, 100);
  d.jambLine = [[100, 100], [127, 100]];
  // a strip along the leaf (vertical), not along the closed-end line
  const r = fuseSheet([d], [[97, 73, 103, 100, 0.6, 7]], PPF, S.fusion);
  assert.deepEqual(r.preds[0].p2, [100, 73]);
  const r2 = fuseSheet([d], [], PPF, S.fusion);
  assert.deepEqual(r2.preds[0].p2, [127, 100]);
});

test("fusion: detector boxes are added only at their class minimum, away from reader doors, never elevators or pockets", () => {
  const doors = [swing(100, 100)];
  const det: DetBox[] = [
    [400, 100, 430, 106, 0.6, 6],    // cased opening over its minimum: added
    [600, 100, 630, 106, 0.4, 6],    // under it
    [100, 80, 127, 100, 0.95, 6],    // on the reader door
    [800, 100, 830, 130, 0.99, 5],   // elevator
    [900, 100, 930, 106, 0.99, 2],   // pocket
    [1000, 100, 1040, 106, 0.75, 1], // sliding over its minimum
  ];
  const r = fuseSheet(doors, det, PPF, S.fusion);
  const added = r.preds.filter((p) => p.src === "det");
  assert.deepEqual(added.map((p) => p.cls).sort(), [1, 6]);
  // a doorway box's line is its long centreline, shortened by the class pad
  const o = added.find((p) => p.cls === 6)!;
  assert.ok(Math.abs(Math.abs(o.p2[0] - o.p1[0]) - (30 - 0.3 * PPF)) < 1e-9);
  assert.equal(o.p1[1], 103);
});

test("fusion: two single leaves meeting at their closed ends become one pair", () => {
  const a = swing(100, 100), b = swing(154, 100);
  b.leaves[0].tip = [154, 73]; b.box = [127, 73, 154, 100]; b.jambLine = [[154, 100], [127, 100]];
  const r = fuseSheet([a, b], [], PPF, S.fusion);
  assert.equal(r.preds.length, 1);
  assert.deepEqual(r.preds[0].doors, [0, 1]);
  assert.deepEqual([r.preds[0].p1, r.preds[0].p2], [[100, 100], [154, 100]]);
});

test("geometry helpers follow numpy: half to even, float ranges", () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, 2.4, 2.6].map(rint), [0, 2, 2, -0, 2, 3]);
  assert.deepEqual(arange(0, 1, 0.25), [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(longestRun(Uint8Array.from([1, 1, 0, 0, 1, 0, 1, 1])), [4, 6]);
});

test("swing fit: an arc with its leaf gives hinge to closed end; a wall running on past the tip line flips it to the tip", () => {
  const pxf = 32, z = pxf / PPF, r = 3 * pxf;
  const draw = (wallPastTip: boolean) => {
    const m = blank(260, 260, z), hx = 60, hy = 180;
    line(m, hx, hy, hx, hy - r);                                                    // leaf, pointing up
    for (let a = 0; a <= 90; a += 0.25) { const t = (-a * Math.PI) / 180; m.data[Math.round(hy + r * Math.sin(t)) * m.w + Math.round(hx + r * Math.cos(t))] = 1; }
    if (wallPastTip) { for (const dx of [-2, -1, 0, 1, 2]) { line(m, hx + dx, hy, hx + dx, hy + 60); line(m, hx + dx, hy - r, hx + dx, hy - r - 60); } }
    else { for (const dy of [-2, -1, 0, 1, 2]) { line(m, hx, hy + dy, hx - 60, hy + dy); line(m, hx + r, hy + dy, hx + r + 60, hy + dy); } }
    return { m, box: [hx / z, (hy - r) / z, (hx + r) / z, hy / z] as [number, number, number, number], hinge: [hx / z, hy / z], closed: [(hx + r) / z, hy / z], tip: [hx / z, (hy - r) / z] };
  };
  const a = draw(false), fa = fitSwing(a.box, a.m, [0, 0], PPF);
  assert.equal(fa.kind, "single");
  assert.ok(fa.deg! >= 76 && fa.deg! <= 104, `sweep ${fa.deg}`);
  assert.ok(Math.hypot(fa.seg!.p1[0] - a.hinge[0], fa.seg!.p1[1] - a.hinge[1]) < 1, "hinge");
  assert.ok(Math.hypot(fa.seg!.p2[0] - a.closed[0], fa.seg!.p2[1] - a.closed[1]) < 1.5, "closed end");
  const b = draw(true), fb = fitSwing(b.box, b.m, [0, 0], PPF);
  assert.equal(fb.how, "tip/ink");
  assert.ok(Math.hypot(fb.seg!.p2[0] - b.tip[0], fb.seg!.p2[1] - b.tip[1]) < 1.5, "tip");
  assert.equal(fitSwing([0, 0, 1, 1], blank(50, 50, z), [0, 0], PPF).fail, "box too small");
  assert.equal(fitSwing(a.box, blank(260, 260, z), [0, 0], PPF).fail, "no arc with a leaf");
});

test("swing fit: the clip is the box's neighbourhood kept on the page; ink is darker than the clip's fill", () => {
  assert.deepEqual(clipRect([10, 10, 37, 37], PPF, 100, 100), [0, 0, 62.2, 62.2]);
  const g = new Uint8Array(100).fill(200); g[3] = 150; g[4] = 190;
  const m = clipMask(g, 10, 10, 1);
  assert.equal(m.data[3], 1); assert.equal(m.data[4], 0); assert.equal(m.data[0], 0);
});

test("swing boxes: added only where no prediction is, with a fitted line inside the sweep window", async () => {
  const preds: Pred[] = [{ p1: [100, 100], p2: [127, 100], src: "reader", conf: 1, box: [100, 73, 127, 100], doors: [0] }];
  const det: DetBox[] = [[100, 73, 127, 100, 0.95, 0], [300, 73, 327, 100, 0.8, 0], [500, 73, 527, 100, 0.8, 0], [700, 73, 727, 100, 0.6, 0]];
  const fits = new Map<number, number>([[300, 90], [500, 45]]);
  const out = await addSwingBoxes(preds, det, PPF, S.fusion.swing_box, (b) => ({ seg: { p1: [b[0], b[3]], p2: [b[2], b[3]] }, kind: "single", deg: fits.get(b[0]), score: 100, inkC: 0.5, inkT: 0, rFt: 3, hinge: [b[0], b[3]], tip: [b[0], b[1]], closed: [b[2], b[3]] }), null);
  assert.equal(out.length, 2);
  assert.equal(out[1].how, "swingbox-fit-closed/ink");
  assert.deepEqual(out[1].box, [300, 73, 327, 100]);
});

const segs = (rows: number[][]): WallSegs => ({ data: Float32Array.from(rows.flat()), n: rows.length });

test("linework: the usual stroke width, and the wall lines running on past a line's end", () => {
  const s = segs([[0, 0, 10, 0, 0.24, 0], [0, 5, 10, 5, 0.24, 0], [0, 9, 10, 9, 0.72, 0], [0, 0, 10, 10, 0, 1], [130, 100.75, 160, 100.75, 0.72, 0], [130, 104, 160, 104, 0.24, 0]]);
  assert.ok(Math.abs(modalWidth(s) - 0.24) < 1e-6);
  const pr = endProfile(s, [100, 100], [127, 100], PPF);
  assert.equal(pr[0].o.length, 2);            // past the end at b
  assert.equal(pr[1].o.length, 0);            // nothing past the end at a
  assert.ok(Math.abs(pr[0].o[0] - 1) < 1e-6); // 0.75 pt = 1 in at this scale
});

test("stall doors: a row of narrow doors at compartment pitch is dropped; ordinary doors are not", () => {
  const stallDoor = (x: number): Pred => ({ p1: [x, 100], p2: [x + 18, 100], src: "reader", conf: 0.8, box: [x, 82, x + 18, 100] });   // 24 in
  const row = [0, 27, 54, 81].map((k) => stallDoor(200 + k));
  const big: Pred = { p1: [600, 100], p2: [627, 100], src: "reader", conf: 1, box: [600, 73, 627, 100] };
  const drop = stallDoors([...row, big, stallDoor(900)], segs([]), PPF, 0, S.filters.stall!);
  assert.deepEqual([...drop].sort(), [0, 1, 2, 3]);
});

test("dedupe: a reader leaf lying on a wider opening is the second find; doors back to back in separate walls stay", () => {
  const wide: Pred = { p1: [100, 100], p2: [154, 100], src: "det", cls: 7, score: 0.8, box: [100, 97, 154, 103] };
  const leaf: Pred = { p1: [100, 101], p2: [127, 101], src: "reader", conf: 0.9, box: [100, 74, 127, 101] };
  const far: Pred = { p1: [100, 130], p2: [127, 130], src: "reader", conf: 0.9, box: [100, 103, 127, 130] };
  assert.deepEqual([...dedupe([wide, leaf, far], PPF, S.filters.dedupe!)], [1]);
  const twinA: Pred = { p1: [300, 100], p2: [327, 100], src: "reader", conf: 0.9, box: [300, 73, 327, 100] };
  const twinB: Pred = { p1: [301, 102], p2: [326, 102], src: "det", cls: 7, score: 0.99, box: [300, 99, 327, 105] };
  assert.deepEqual([...dedupe([twinA, twinB], PPF, S.filters.dedupe!)], [1], "the reader door is kept over a detector twin");
});

test("raster: wall thickness at a line's ends, a thin partition, and no wall at all", () => {
  const z = 2, m = blank(600, 300, z), inch = (PPF / 12) * z;
  // a 6 in wall running on past the right end of the line y = 100 pt, a 1 in partition past the left end
  for (let y = Math.round(200 - 3 * inch); y <= Math.round(200 + 3 * inch); y++) line(m, 260, y, 330, y);
  line(m, 120, 200, 198, 200);
  const [e0, e1] = wallEnds(m, PPF, [100, 100], [127, 100]);
  assert.ok(e0 >= 5.5 && e0 <= 7, `thick wall ${e0}`);
  assert.ok(e1 >= 0 && e1 < 2, `thin partition ${e1}`);
  assert.deepEqual(wallEnds(blank(600, 300, z), PPF, [100, 100], [127, 100]), [-1, -1]);
});

test("raster: a bowl-sized oval is a fixture; a room-sized rectangle is not", () => {
  const z = 2.4, m = blank(500, 500, z), pin = (PPF * z) / 12;
  // an ellipse 12 in by 18 in, outlined, around (100 pt, 100 pt)
  for (let a = 0; a < 360; a += 0.5) { const t = (a * Math.PI) / 180; m.data[Math.round(240 + 9 * pin * Math.sin(t)) * m.w + Math.round(240 + 6 * pin * Math.cos(t))] = 1; }
  // close the outline against 4-connected leaks
  const d = Uint8Array.from(m.data);
  for (let y = 1; y < m.h - 1; y++) for (let x = 1; x < m.w - 1; x++) if (d[y * m.w + x]) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) m.data[(y + dy) * m.w + x + dx] = 1;
  const near = nearestOval(m, PPF, [103, 100]);
  assert.ok(near < 1, `oval at ${near} ft`);
  assert.equal(nearestOval(blank(500, 500, z), PPF, [103, 100]), 99);
});

test("stall2 and legend2: restroom evidence drops a narrow door on a thin partition; a legend's door symbol goes", () => {
  const pred: Pred[] = [
    { p1: [0, 0], p2: [18, 0], src: "reader", conf: 0.8, box: [0, -18, 18, 0] },
    { p1: [200, 0], p2: [227, 0], src: "reader", conf: 1, box: [200, -27, 227, 0] },
  ];
  const feats = [{ w: 24, cand: true, e0: 1, e1: 5, ov: 2, rd: 99, nb: 0 }, { w: 36, cand: true, e0: 5, e1: 5, ov: 99, rd: 99, nb: 0 }];
  assert.deepEqual([...stall2(pred, feats, 0.9, PPF, new Set(), S.filters.stall2!)], [[0, "S1a"]]);
  assert.equal(stall2(pred, feats, 0.5, PPF, new Set(), S.filters.stall2!).size, 0, "a sheet that doesn't draw wall thickness is left alone");
  assert.deepEqual(restroomWords([{ str: "(WOMEN)", c: [1, 2] }, { str: "OFFICE", c: [3, 4] }]), [[1, 2]]);
  const labels = legendLabels([{ str: "existing door to remain", c: [10, 10] }, { str: "new wall", c: [10, 20] }, { str: "DOOR TAG", c: [10, 30] }, { str: "CORRIDOR", c: [10, 40] }]);
  assert.equal(labels.length, 3);
  // the first door sits by three legend labels with one other door around; the second is over 20 ft from the labels
  assert.deepEqual([...legend2(pred, labels, PPF, S.filters.legend2!)], [0]);
  assert.equal(legend2(pred, labels.slice(0, 2), PPF, S.filters.legend2!).size, 0);
});

test("features: the share of ordinary doors standing in thick walls", () => {
  const z = 2, m = blank(900, 300, z), inch = (PPF / 12) * z;
  for (const [a, b] of [[40, 198], [256, 400]]) for (let y = Math.round(200 - 3 * inch); y <= Math.round(200 + 3 * inch); y++) line(m, a, y, b, y);
  const pred: Pred[] = [{ p1: [100, 100], p2: [127, 100], src: "reader", conf: 1, box: [100, 73, 127, 100] }];
  const { feats, share } = features(pred, m, PPF, []);
  assert.equal(share, 1);
  assert.equal(feats[0].cand, true);
  assert.equal(feats[0].rd, 99);
});

const tag = (str: string, x: number, y: number, size = 6): TextLine => ({ str, box: [x - 8, y - 4, x + 8, y + 4], c: [x, y], size });

test("door tags: a text style is a door-tag style when its numbers sit by doors and do not repeat", () => {
  const doors = [0, 1, 2, 3, 4].map((k) => [100 + k * 100, 73, 127 + k * 100, 100] as [number, number, number, number]);
  const cands: TagCandidate[] = [
    ...doors.map((b, k) => ({ ...tag(`10${k}`, b[0] + 10, 110), mark: `10${k}`, kind: "plain" as const })),
    ...[0, 1, 2, 3].map((k) => ({ ...tag("3", 100 + k * 100, 400, 9), mark: "3", kind: "plain" as const })),   // a keynote repeated, away from doors
  ];
  const tags = doorTags(cands, doors, PPF, S.tags);
  assert.deepEqual(tags.map((t) => t.mark), ["100", "101", "102", "103", "104"]);
});

test("tag stage: a lone tag brings in a detector box under its cutoff; on a tagged sheet an untagged weak find goes", () => {
  const n = 9;
  const preds: Pred[] = Array.from({ length: n }, (_, k) => ({ p1: [100 + k * 100, 100], p2: [127 + k * 100, 100], src: "reader" as const, conf: 1, box: [100 + k * 100, 73, 127 + k * 100, 100] as [number, number, number, number], doors: [k] }));
  const weak: Pred = { p1: [100, 400], p2: [130, 400], src: "det", cls: 6, score: 0.5, box: [100, 397, 130, 403] };
  const lines = [...preds.map((p, k) => tag(`1${String(k).padStart(2, "0")}`, p.p1[0] + 13, 112)), tag("150", 1213, 112)];
  const det: DetBox[] = [[1200, 97, 1230, 103, 0.3, 6]];
  const r = tagStage([...preds, weak], lines, [], det, PPF, S.tags, blank(10, 10, 16 / PPF), 16);
  assert.equal(r.info.tags, 10);
  assert.equal(r.info.detectorBox, 1);
  assert.equal(r.info.untaggedDropped, 1);
  assert.equal(r.preds.length, 10);
  assert.equal(r.preds[9].how, "tag-box");
  assert.equal(Object.values(r.dropped)[0], "no door tag on a sheet whose doors are tagged");
});

test("ink past a line's ends", () => {
  const m = blank(200, 100, 1);
  line(m, 0, 50, 199, 50);
  // a single line carries on under the middle one of the three tracks
  assert.ok(Math.abs(inkBeyond(m, [80, 50], [120, 50], 16) - 1 / 3) < 1e-9);
  for (const dy of [-3, -2, -1, 1, 2, 3]) line(m, 0, 50 + dy, 199, 50 + dy);
  assert.equal(inkBeyond(m, [80, 50], [120, 50], 16), 1, "a wall under all three tracks");
  assert.ok(inkBeyond(m, [100, 10], [100, 30], 16) < 0.6, "a line that only runs into the wall at one end");
  assert.equal(inkBeyond(blank(200, 100, 1), [80, 50], [120, 50], 16), 0);
});

test("the pipeline end to end on a hand-built sheet, and what the suite is handed", async () => {
  const doors = [swing(100, 100), swing(300, 100, -0.2), swing(500, 100, 0.2)];
  const det: DetBox[] = [[300, 73, 327, 100, 0.8, 0], [700, 97, 730, 103, 0.7, 6], [900, 100, 930, 130, 0.99, 5]];
  const z = 20 / PPF, ink = blank(Math.ceil(1100 * z), Math.ceil(200 * z), z);
  const r: PipelineResult = await runDoorPipeline(doors, det, { ppf: PPF, ink, inkPxf: 20, wallInk: ink, fitSwing: () => null, lines: [], rest: [], labels: [], segs: segs([]) });
  assert.deepEqual(r.preds.map((p) => p.src), ["reader", "reader", "det"]);
  const f = applyPipeline(doors, r, S.model.classes, PPF);
  assert.equal(f.doors.length, 4);
  assert.deepEqual(f.withheld, [false, false, true, false]);
  assert.deepEqual(f.hidden, [false, false, false, false]);
  assert.equal(f.added, 1); assert.equal(f.rescued, 1); assert.equal(f.setAside, 1);
  assert.deepEqual(f.byKind, { opening: 1 });
  assert.equal(f.doors[2].doubts[0], "weak swing with no detector box near it");
  assert.equal(f.doors[3].added?.kind, "opening");
  assert.equal(f.doors[3].leaves.length, 0);
});

test("applying: a second find of an opening is hidden, a reader stall door stays held, a fitted swing gets a leaf", () => {
  const doors = [swing(100, 100), swing(300, 100), { ...swing(500, 100), stall: true }];
  const preds: Pred[] = [
    { p1: [100, 100], p2: [127, 100], src: "reader", conf: 1, box: [100, 73, 127, 100], doors: [0] },
    { p1: [500, 100], p2: [527, 100], src: "reader", conf: 1, box: [500, 73, 527, 100], doors: [2] },
    { p1: [700, 100], p2: [727, 100], src: "det", cls: 0, score: 0.9, box: [700, 73, 727, 100], how: "swingbox-fit-closed/ink", fit: { hinge: [700, 100], tip: [700, 73], closed: [727, 100], rFt: 3 } },
  ];
  const r = { preds, dropped: [{ pred: { p1: [300, 100], p2: [327, 100], src: "reader", conf: 1, box: [300, 73, 327, 100], doors: [1] } as Pred, why: "dedupe" }], readerOut: {} } as unknown as PipelineResult;
  const f = applyPipeline(doors, r, S.model.classes, PPF);
  assert.deepEqual(f.hidden, [false, true, false, false]);
  assert.deepEqual(f.withheld, [false, false, true, false]);
  assert.equal(f.doors[3].leaves.length, 1);
  assert.ok(Math.abs(f.doors[3].leaves[0].sweepDeg - 90) < 1e-6);
  assert.equal(f.doors[3].leaves[0].radiusPt, 27);
});

test("page inputs: text lines and words in the page frame; straight segments with their stroke width", () => {
  const vt = [1, 0, 0, -1, 0, 792];   // unrotated viewport at scale 1
  const { lines, words } = pageText([{ str: "MEN  101", transform: [8, 0, 0, 8, 100, 692], width: 40, height: 8 }, { str: "  ", transform: [8, 0, 0, 8, 0, 0], width: 5, height: 8 }], vt);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].size, 8);
  assert.deepEqual(lines[0].box.map((v) => Math.round(v * 10) / 10), [100, 93.6, 140, 101.6]);
  assert.deepEqual(words.map((w) => w.str), ["MEN", "101"]);
  assert.ok(words[0].c[0] < words[1].c[0]);
  const OPS = { save: 1, restore: 2, transform: 3, constructPath: 4, stroke: 5, fill: 6, setLineWidth: 7, moveTo: 10, lineTo: 11, curveTo: 12, curveTo2: 13, curveTo3: 14, closePath: 15, rectangle: 16, endPath: 17, clip: 18, eoClip: 19, eoFill: 20, fillStroke: 21, eoFillStroke: 22, closeStroke: 23, closeFillStroke: 24, closeEOFillStroke: 25, paintFormXObjectBegin: 26, paintFormXObjectEnd: 27, setGState: 28 };
  const ops = {
    fnArray: [OPS.setLineWidth, OPS.constructPath, OPS.stroke, OPS.constructPath, OPS.fill, OPS.constructPath, OPS.endPath],
    argsArray: [[2], [[OPS.moveTo, OPS.lineTo], [0, 0, 10, 0]], null, [[OPS.rectangle], [0, 0, 4, 2]], null, [[OPS.moveTo, OPS.lineTo], [0, 0, 5, 5]], null],
  };
  const s = extractWallSegs(ops as never, vt, OPS as never);
  assert.equal(s.n, 5);
  assert.deepEqual(Array.from(s.data.slice(0, 6)), [0, 792, 10, 792, 2, 0]);
  assert.deepEqual([s.data[10], s.data[11]], [0, 1], "a filled-not-stroked path has width 0 and the fill flag");
});
