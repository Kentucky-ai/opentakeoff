// Pictures on a vector sheet (#489): where a page paints raster images, which
// placements make one picture, and whether its text layer can read it. A
// picture is unread when it covers at least PICTURE_MIN_SQIN and the text
// layer holds at most SCAN_MAX_TEXT_LINES lines over it.
//
// The op walk is pinned three ways: synthetic op lists for the paint ops
// getOperatorList() never emits (the *Repeat / *Group folds belong to the
// render intent's optimizer, not the op-list intent's), small PDFs built
// here for form matrices and annotation appearances, and the real files the
// rule's floor was measured on (the demo, Porterville A1-101, the scanned
// fixture and the synthetic hybrid of test/fixtures/hybridPlan.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, PDFName } from "pdf-lib";
import {
  PICTURE_MIN_SQIN, PICTURE_PARAMS_HASH, imageRectsOf, linesOverRegion, measurePage, mergePlacements,
  pictureRegions, placementRects, unreadPictures,
  type MeasurablePage, type PictureRegion, type Rect,
} from "../src/lib/pictures.ts";
import { extractVectorGeometry, type OpList } from "../src/lib/oneclick.ts";
import { SCAN_MAX_TEXT_LINES } from "../src/lib/planIndex.ts";
import { extractRegionText } from "../src/lib/sheets.ts";
import { RENDER_SCALE } from "../src/lib/takeoffConstants.ts";
import { buildHybridPlan, PICTURE } from "./fixtures/hybridPlan.ts";

const OPS = pdfjs.OPS as unknown as Record<string, number>;
const DEMO = new URL("../public/demo/sample-finish-plan.pdf", import.meta.url);
const PORTERVILLE = new URL("../../evals/mcp-workflow-bench/plan-set/porterville/porterville-adu-a1-101.pdf", import.meta.url);
const FREEZE = new URL("../../evals/mcp-workflow-bench/plan-set/FREEZE.json", import.meta.url);
const SCANNED = new URL("../../mcp/test/fixtures/scanned-plan.pdf", import.meta.url);
const PNG = new URL("./fixtures/hybrid/material-floor-base.png", import.meta.url);

const sqin = (r: Rect) => ((r.x1 - r.x0) / 72) * ((r.y1 - r.y0) / 72);
const near = (a: Rect, b: Rect, tol: number) =>
  Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;
const fmt = (r: Rect) => `${r.x0.toFixed(1)},${r.y0.toFixed(1)}–${r.x1.toFixed(1)},${r.y1.toFixed(1)}`;
const R = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 });

// ── loading, memoized: the demo paints ~12k images a page ───────────────────
type Doc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
type Page = Awaited<ReturnType<Doc["getPage"]>>;
const docs = new Map<string, Promise<Doc>>();
function open(name: string, bytes: () => Uint8Array | Promise<Uint8Array>): Promise<Doc> {
  let d = docs.get(name);
  if (!d) {
    d = Promise.resolve(bytes()).then((data) => pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, verbosity: 0 }).promise);
    docs.set(name, d);
  }
  return d;
}
const file = (u: URL) => () => new Uint8Array(readFileSync(u));
const demo = () => open("demo", file(DEMO));
const porterville = () => open("porterville", file(PORTERVILLE));
const scanned = () => open("scanned", file(SCANNED));
const hybrid = () => open("hybrid", () => buildHybridPlan("callouts"));
const hybridNotes = () => open("hybrid-notes", () => buildHybridPlan("notes"));
const hybridRotated = () => open("hybrid-rot", () => buildHybridPlan("callouts", 90));

/** measurePage at scale `s`, with a count of op-list fetches. */
async function measure(doc: Doc, n: number, s = 1) {
  const page: Page = await doc.getPage(n);
  const vp = page.getViewport({ scale: s });
  let opLists = 0;
  const spy: MeasurablePage = {
    getTextContent: () => page.getTextContent() as never,
    getOperatorList: () => { opLists++; return page.getOperatorList() as unknown as Promise<OpList>; },
  };
  const out = await measurePage(`k${n}`, spy, vp, OPS);
  return { ...out, opLists, page, vp };
}

/** Every merged cluster (before the floor) of a page, in pt at scale 1. */
async function clusters(doc: Doc, n: number, s = 1): Promise<PictureRegion[]> {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: s });
  const ol = (await page.getOperatorList()) as unknown as OpList;
  const rects = imageRectsOf(ol, vp.transform, OPS).map((r) => R(r.x0 / s, r.y0 / s, r.x1 / s, r.y1 / s));
  return mergePlacements(rects);
}

// ── placement maths, per paint op (canvas.js argument shapes) ───────────────

const M0 = [1, 0, 0, 1, 0, 0];

test("placementRects: a single image op maps the unit square through the current transform", () => {
  const m = [100, 0, 0, -50, 10, 300];   // a 100 × 50 placement, y flipped as the viewport does
  for (const op of ["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject"]) {
    assert.deepEqual(placementRects(OPS[op], [{}], m, OPS), [R(10, 250, 110, 300)], op);
  }
  // rotated 45°: the bounds of the turned square, not its side
  const c = Math.SQRT1_2 * 10;
  const [r] = placementRects(OPS.paintImageXObject, ["img"], [c, c, -c, c, 0, 0], OPS);
  assert.ok(near(r, R(-c, 0, c, 2 * c), 1e-9), fmt(r));
});

test("placementRects: paintImageXObjectRepeat places one rect per position, scaled by its args", () => {
  // [objId, scaleX, scaleY, positions]; the ambient transform doubles everything
  const rs = placementRects(OPS.paintImageXObjectRepeat, ["img", 4, 3, [0, 0, 10, 20]], [2, 0, 0, 2, 5, 5], OPS);
  assert.deepEqual(rs, [R(5, 5, 13, 11), R(25, 45, 33, 51)]);
});

test("placementRects: paintImageMaskXObjectRepeat reads [img, scaleX, skewX, skewY, scaleY, positions]", () => {
  const rs = placementRects(OPS.paintImageMaskXObjectRepeat, [{}, 4, 0, 0, 3, [0, 0, 100, 0]], M0, OPS);
  assert.deepEqual(rs, [R(0, 0, 4, 3), R(100, 0, 104, 3)]);
  // the skew terms are part of each instance's transform
  const [sk] = placementRects(OPS.paintImageMaskXObjectRepeat, [{}, 4, 0, 2, 3, [0, 0]], M0, OPS);
  assert.deepEqual(sk, R(0, 0, 6, 3));
});

test("placementRects: the *Group ops read each entry's own transform", () => {
  const masks = placementRects(OPS.paintImageMaskXObjectGroup, [[
    { data: "a", width: 1, height: 1, transform: [10, 0, 0, 10, 0, 0] },
    { data: "b", width: 1, height: 1, transform: [5, 0, 0, 2, 50, 60] },
  ]], [1, 0, 0, 1, 1, 1], OPS);
  assert.deepEqual(masks, [R(1, 1, 11, 11), R(51, 61, 56, 63)]);
  const inline = placementRects(OPS.paintInlineImageXObjectGroup, [{}, [
    { transform: [8, 0, 0, 8, 0, 0], x: 0, y: 0, w: 1, h: 1 },
    { transform: [8, 0, 0, 8, 100, 0], x: 0, y: 0, w: 1, h: 1 },
  ]], M0, OPS);
  assert.deepEqual(inline, [R(0, 0, 8, 8), R(100, 0, 108, 8)]);
});

test("placementRects: a non-image op places nothing", () => {
  assert.deepEqual(placementRects(OPS.constructPath, [[], [], null], M0, OPS), []);
});

// ── the op walk ─────────────────────────────────────────────────────────────

test("imageRectsOf: save/restore and transform scope each placement", () => {
  const ol: OpList = {
    fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.transform, OPS.paintImageXObject],
    argsArray: [null, [10, 0, 0, 10, 0, 0], ["a"], null, [20, 0, 0, 20, 100, 100], ["b"]],
  };
  assert.deepEqual(imageRectsOf(ol, [2, 0, 0, 2, 0, 0], OPS), [R(0, 0, 20, 20), R(200, 200, 240, 240)]);
});

test("imageRectsOf: a form XObject's matrix applies inside it and ends with it", () => {
  const ol: OpList = {
    fnArray: [OPS.paintFormXObjectBegin, OPS.transform, OPS.paintImageXObject, OPS.paintFormXObjectEnd, OPS.transform, OPS.paintImageXObject],
    argsArray: [[[0.5, 0, 0, 0.5, 100, 50], [0, 0, 100, 100]], [40, 0, 0, 40, 0, 0], ["a"], null, [10, 0, 0, 10, 0, 0], ["b"]],
  };
  assert.deepEqual(imageRectsOf(ol, M0, OPS), [R(100, 50, 120, 70), R(0, 0, 10, 10)]);
});

test("imageRectsOf: a transparency group scopes the transform like save/restore; its matrix is not applied", () => {
  // canvas.js beginGroup is a save() (the group's scratch canvas starts from
  // the current transform, without group.matrix) and endGroup a restore()
  const ol: OpList = {
    fnArray: [OPS.beginGroup, OPS.transform, OPS.paintImageXObject, OPS.endGroup, OPS.transform, OPS.paintImageXObject],
    argsArray: [[{ matrix: [3, 0, 0, 3, 7, 7], bbox: [0, 0, 1, 1], isolated: true }], [10, 0, 0, 10, 50, 0], ["a"], [{}], [5, 0, 0, 5, 0, 0], ["b"]],
  };
  assert.deepEqual(imageRectsOf(ol, M0, OPS), [R(50, 0, 60, 10), R(0, 0, 5, 5)]);
});

test("imageRectsOf: an annotation starts from the base transform, not a dangling page cm", () => {
  // the page's content leaves a cm unbalanced; canvas.js beginAnnotation
  // restores the initial state and rebuilds from the base transform, then
  // applies the annotation's transform and its appearance's matrix
  const ol: OpList = {
    fnArray: [OPS.transform, OPS.save, OPS.beginAnnotation, OPS.transform, OPS.paintImageXObject, OPS.endAnnotation],
    argsArray: [[2, 0, 0, 2, 100, 100], null, ["id", [50, 50, 150, 100], [1, 0, 0, 1, 50, 50], [1, 0, 0, 1, 0, 0], false], [100, 0, 0, 50, 0, 0], ["a"], null],
  };
  assert.deepEqual(imageRectsOf(ol, [1, 0, 0, -1, 0, 500], OPS), [R(50, 400, 150, 450)]);
});

test("imageRectsOf: a form's matrix through pdf.js (pdf-lib embedPage with a non-identity matrix)", async () => {
  const src = await PDFDocument.create({ updateMetadata: false });
  const sp = src.addPage([200, 200]);
  sp.drawImage(await src.embedPng(readFileSync(PNG)), { x: 20, y: 30, width: 40, height: 50 });
  // saved and loaded first, so the image is a real object in the page's resources
  const [saved] = (await PDFDocument.load(await src.save(), { updateMetadata: false })).getPages();
  const out = await PDFDocument.create({ updateMetadata: false });
  const host = out.addPage([400, 300]);
  const form = await out.embedPage(saved, { left: 0, bottom: 0, right: 200, top: 200 }, [0.5, 0, 0, 0.5, 100, 50]);
  host.drawPage(form, { x: 0, y: 0 });
  const doc = await pdfjs.getDocument({ data: await out.save(), isEvalSupported: false, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const rects = imageRectsOf((await page.getOperatorList()) as unknown as OpList, vp.transform, OPS);
  // form space 20..60 × 30..80 → × 0.5 + (100, 50) → page 110..130 × 65..90 → from the top 210..235
  assert.equal(rects.length, 1);
  assert.ok(near(rects[0], R(110, 210, 130, 235), 1e-6), fmt(rects[0]));
  await doc.destroy();
});

// 1 × 1 grey PNG
const DOT = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64"));

test("imageRectsOf: an annotation's image stamp lands at its rect despite a dangling page cm", async () => {
  const out = await PDFDocument.create({ updateMetadata: false });
  const page = out.addPage([400, 300]);
  const ctx = out.context;
  page.node.addContentStream(ctx.register(ctx.stream("2 0 0 2 100 100 cm")));   // no q/Q around it
  const img = await out.embedPng(DOT);
  const ap = ctx.register(ctx.stream("q 100 0 0 50 0 0 cm /Im1 Do Q", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 50], Resources: { XObject: { Im1: img.ref } },
  }));
  const annot = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: [50, 50, 150, 100], F: 4, AP: { N: ap } }));
  page.node.set(PDFName.of("Annots"), ctx.obj([annot]));
  const doc = await pdfjs.getDocument({ data: await out.save(), isEvalSupported: false, verbosity: 0 }).promise;
  const pg = await doc.getPage(1);
  const ol = (await pg.getOperatorList()) as unknown as OpList;
  assert.ok(ol.fnArray.includes(OPS.beginAnnotation), "the stamp's appearance is in the op list");
  const rects = imageRectsOf(ol, pg.getViewport({ scale: 1 }).transform, OPS);
  // PDF 50..150 × 50..100 → from the top 200..250; under the leaked cm it would sit at 200..400
  assert.equal(rects.length, 1);
  assert.ok(near(rects[0], R(50, 200, 150, 250), 1e-6), fmt(rects[0]));
  await doc.destroy();
});

test("imageRectsOf: a surplus Q inside a form pops the form's own save, as canvas.js does", async () => {
  // canvas.js paintFormXObjectBegin is a save() and paintFormXObjectEnd a
  // restore() on the same state stack as q/Q, and pdf.js hands a form's
  // surplus Q through as a plain restore. So the form's leading Q drops its
  // matrix ([1 0 0 1 0 100]) but keeps the page's 300 pt shift; the form's
  // end then pops the page's q, and the page's own Q has nothing left to pop.
  // Expected rects are what a canvas render draws (scratchpad excessq.mts).
  const out = await PDFDocument.create({ updateMetadata: false });
  const page = out.addPage([600, 400]);
  const ctx = out.context;
  const img = await out.embedPng(DOT);
  const fm = ctx.register(ctx.stream("Q 100 0 0 50 0 0 cm /Im1 Do", {
    Type: "XObject", Subtype: "Form", BBox: [-1000, -1000, 2000, 2000], Matrix: [1, 0, 0, 1, 0, 100], Resources: { XObject: { Im1: img.ref } },
  }));
  page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { Fm1: fm, Im1: img.ref } }));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("q 1 0 0 1 300 0 cm /Fm1 Do Q 100 0 0 50 0 0 cm /Im1 Do")));
  const doc = await pdfjs.getDocument({ data: await out.save(), isEvalSupported: false, verbosity: 0 }).promise;
  const pg = await doc.getPage(1);
  const ol = (await pg.getOperatorList()) as unknown as OpList;
  const names = ol.fnArray.map((f) => Object.keys(OPS).find((k) => OPS[k] === f));
  assert.deepEqual(names.slice(0, 4), ["save", "transform", "paintFormXObjectBegin", "restore"], "the surplus Q reaches the op list as a restore");
  const rects = imageRectsOf(ol, pg.getViewport({ scale: 1 }).transform, OPS);
  assert.equal(rects.length, 2);
  assert.ok(near(rects[0], R(300, 350, 400, 400), 1e-6), `form image ${fmt(rects[0])}`);
  assert.ok(near(rects[1], R(0, 350, 100, 400), 1e-6), `page image ${fmt(rects[1])}`);
  await doc.destroy();
});

// ── merging and the floor ───────────────────────────────────────────────────

test("mergePlacements: overlapping, touching and chained placements make one region; a gap past the slack splits", () => {
  const regions = mergePlacements([
    R(0, 0, 10, 10), R(11.5, 0, 20, 10),     // 1.5 pt apart: within the 2 pt slack
    R(20, 0, 30, 10),                         // touches the one before (a chain A–B–C)
    R(5, 5, 8, 8),                            // inside the first
    R(32.5, 0, 40, 10),                       // 2.5 pt past the chain: its own
  ]);
  assert.equal(regions.length, 2);
  const [a, b] = regions.sort((p, q) => p.bbox.x0 - q.bbox.x0);
  assert.deepEqual(a.bbox, R(0, 0, 30, 10));
  assert.equal(a.rects.length, 4);
  assert.deepEqual(b.bbox, R(32.5, 0, 40, 10));
  assert.deepEqual(b.rects, [R(32.5, 0, 40, 10)]);
  // near in x but far in y: apart
  assert.equal(mergePlacements([R(0, 0, 10, 10), R(0, 100, 10, 110)]).length, 2);
});

test("mergePlacements: sort-and-sweep compares only placements whose x spans overlap", () => {
  // 80 columns of 50 small marks, columns 33 pt apart: each mark meets only
  // the earlier marks of its own column, 80 × (0 + 1 + … + 49) comparisons
  const rects: Rect[] = [];
  for (let i = 0; i < 80; i++) for (let j = 0; j < 50; j++) rects.push(R(i * 37, j * 41, i * 37 + 4, j * 41 + 4));
  const stats = { comparisons: 0 };
  const regions = mergePlacements(rects, stats);
  assert.equal(regions.length, rects.length);
  assert.equal(stats.comparisons, 80 * (50 * 49) / 2);
});

test("pictureRegions: the 15 sq in floor applies to the merged region, not its pieces", () => {
  // two 3 × 3 in tiles (9 sq in each) side by side: neither passes, together 18 sq in do
  const tiles = [R(0, 0, 216, 216), R(216, 0, 432, 216)];
  assert.deepEqual(pictureRegions([tiles[0]]), []);
  const [r] = pictureRegions(tiles);
  assert.deepEqual(r.bbox, R(0, 0, 432, 216));
  assert.equal(r.sqin, 18);
  assert.ok(r.sqin >= PICTURE_MIN_SQIN);
});

// ── lines over a region ─────────────────────────────────────────────────────

test("linesOverRegion: counts runs inside any member rect, not the bounding box's empty corner", () => {
  // an L: a wide bar on top and a tall bar down its left side
  const L: PictureRegion = { bbox: R(0, 0, 300, 300), rects: [R(0, 0, 300, 100), R(0, 100, 100, 300)], sqin: 0 };
  const run = (str: string, x: number, y: number) => ({ str, x, y, h: 10, w: 40, ang: 0 });
  const items = [
    run("BAR TOP", 150, 50),        // in the top bar
    run("SIDE ONE", 20, 150),       // in the side bar
    run("SIDE TWO", 20, 250),       // in the side bar
    run("CORNER", 200, 200),        // in the bbox, outside both bars
    run("OUTSIDE", 400, 50),
  ];
  assert.equal(linesOverRegion(items, L), 3);
  // rects are in pt; runs at scale 2 are in px
  const px = items.map((it) => ({ ...it, x: it.x * 2, y: it.y * 2 }));
  assert.equal(linesOverRegion(px, L, 2), 3);
});

test("unreadPictures: at most SCAN_MAX_TEXT_LINES lines over a region leaves it unread", () => {
  const a: PictureRegion = { bbox: R(0, 0, 400, 400), rects: [R(0, 0, 400, 400)], sqin: 30.9 };
  const b: PictureRegion = { bbox: R(500, 0, 900, 400), rects: [R(500, 0, 900, 400)], sqin: 30.9 };
  const lines = new Map([[a, SCAN_MAX_TEXT_LINES], [b, SCAN_MAX_TEXT_LINES + 1]]);
  assert.deepEqual(unreadPictures([a, b], (r) => lines.get(r)!), [a]);
});

test("PICTURE_PARAMS_HASH: pinned, so a change to the rule's parameters or rev is deliberate", () => {
  // {"rev":1,"minSqIn":15,"slackPt":2,"maxLines":8}, FNV-1a 32
  assert.equal(PICTURE_PARAMS_HASH, "335a437f");
});

// ── real files ──────────────────────────────────────────────────────────────

test("demo sheets: no picture (the logo stays under the floor)", async () => {
  const d = await demo();
  for (const n of [1, 2]) {
    const m = await measure(d, n);
    assert.deepEqual(m.pictures, [], `page ${n}`);
    assert.ok(m.index.lineCount > SCAN_MAX_TEXT_LINES, `page ${n} is a vector sheet`);
  }
});

test("demo sheets: the merge's comparison count stays near n²/48", async () => {
  // not ≪ n²: measured when this was pinned, n = 12,433 placements and
  // 3,220,769 comparisons, about n²/48. A regression past n²/40 shows here.
  const d = await demo();
  const page = await d.getPage(1);
  const rects = imageRectsOf((await page.getOperatorList()) as unknown as OpList, page.getViewport({ scale: 1 }).transform, OPS);
  const stats = { comparisons: 0 };
  mergePlacements(rects, stats);
  const n = rects.length;
  assert.ok(n > 10000, `${n} placements`);
  assert.ok(stats.comparisons <= (n * n) / 40, `${stats.comparisons} comparisons for n = ${n} (n²/${((n * n) / stats.comparisons).toFixed(1)})`);
});

test("demo sheets at RENDER_SCALE: the same answer, and the largest cluster (the logo) under 15 sq in", async () => {
  const d = await demo();
  for (const n of [1, 2]) {
    assert.deepEqual((await measure(d, n, RENDER_SCALE)).pictures, [], `page ${n}`);
    const cs = await clusters(d, n, RENDER_SCALE);
    const top = Math.max(...cs.map((c) => c.sqin));
    assert.ok(top > 5 && top < PICTURE_MIN_SQIN, `page ${n}: largest cluster ${top.toFixed(2)} sq in`);
  }
});

test("imageArea on the demo sheets is unchanged (extractVectorGeometry untouched)", async () => {
  const d = await demo();
  for (const n of [1, 2]) {
    const page = await d.getPage(n);
    const g = extractVectorGeometry((await page.getOperatorList()) as unknown as OpList, page.getViewport({ scale: 1 }).transform, OPS);
    assert.ok(Math.abs(g.imageArea - DEMO_IMAGE_AREA) < 1e-6, `page ${n}: imageArea ${g.imageArea}`);
  }
});
/** extractVectorGeometry's imageArea on demo pages 1 and 2 at scale 1, measured before #489. */
const DEMO_IMAGE_AREA = 93959.8416000065;

test("Porterville A1-101: the raster table is the one unread picture; the seal is under the floor", async () => {
  const freeze = JSON.parse(readFileSync(FREEZE, "utf8"));
  const sha = createHash("sha256").update(readFileSync(PORTERVILLE)).digest("hex");
  assert.equal(sha, freeze.sha256["evals/mcp-workflow-bench/plan-set/porterville/porterville-adu-a1-101.pdf"], "the frozen file");
  const m = await measure(await porterville(), 1);
  assert.ok(Array.isArray(m.pictures) && m.pictures.length === 1, JSON.stringify(m.pictures));
  const [t] = m.pictures as Rect[];
  assert.ok(near(t, R(1469, 453, 1843, 713), 1), fmt(t));
  assert.ok(Math.abs(sqin(t) - 18.81) < 0.1, `${sqin(t).toFixed(2)} sq in`);
  // the seal, measured among the clusters, stays under the floor
  const cs = await clusters(await porterville(), 1);
  const under = cs.filter((c) => c.sqin < PICTURE_MIN_SQIN).map((c) => c.sqin);
  assert.ok(under.some((a) => Math.abs(a - 8.9) < 0.1), `clusters under the floor: ${under.map((a) => a.toFixed(2)).join(", ")}`);
});

const HYBRID_PICTURE = R(PICTURE.x0, PICTURE.y0, PICTURE.x1, PICTURE.y1);

/** Lines over the hybrid's picture region, counted from the page's runs at scale `s`. */
async function linesOverPicture(doc: Doc, s = 1): Promise<number> {
  const [region] = (await clusters(doc, 1, s)).filter((c) => c.sqin >= PICTURE_MIN_SQIN);
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: s });
  const tokens = extractRegionText(await page.getTextContent() as never, vp, { x0: 0, y0: 0, x1: vp.width, y1: vp.height });
  return linesOverRegion(tokens, region, s);
}

test("hybrid sheet: one unread picture where it was placed, with 2 lines over it", async () => {
  const m = await measure(await hybrid(), 1);
  assert.ok(m.index.lineCount > SCAN_MAX_TEXT_LINES, `${m.index.lineCount} lines: not a scan`);
  assert.ok(Array.isArray(m.pictures) && m.pictures.length === 1, JSON.stringify(m.pictures));
  const [p] = m.pictures as Rect[];
  assert.ok(near(p, HYBRID_PICTURE, 1), fmt(p));
  assert.ok(Math.abs(sqin(p) - 45.49) < 0.05, `${sqin(p).toFixed(2)} sq in`);
  assert.equal(await linesOverPicture(await hybrid()), 2);
});

test("hybrid sheet, 9 note lines over the picture: read by the text layer, not unread", async () => {
  const d = await hybridNotes();
  assert.equal(await linesOverPicture(d), SCAN_MAX_TEXT_LINES + 1);
  assert.deepEqual((await measure(d, 1)).pictures, []);
});

test("hybrid sheet, measured at RENDER_SCALE: the same rect in pt", async () => {
  const m = await measure(await hybrid(), 1, RENDER_SCALE);
  assert.ok(Array.isArray(m.pictures) && m.pictures.length === 1, JSON.stringify(m.pictures));
  assert.ok(near((m.pictures as Rect[])[0], HYBRID_PICTURE, 1), fmt((m.pictures as Rect[])[0]));
  assert.equal(await linesOverPicture(await hybrid(), RENDER_SCALE), 2);
});

test("hybrid sheet rotated 90°: the picture turns with the page", async () => {
  const m = await measure(await hybridRotated(), 1);
  const H = 2160;
  const [a, b, c, d] = m.vp.convertToViewportRectangle([PICTURE.x0, H - PICTURE.y1, PICTURE.x1, H - PICTURE.y0]);
  const want = R(Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d));
  assert.ok(Array.isArray(m.pictures) && m.pictures.length === 1, JSON.stringify(m.pictures));
  assert.ok(near((m.pictures as Rect[])[0], want, 1), `${fmt((m.pictures as Rect[])[0])} vs ${fmt(want)}`);
  assert.ok(want.y1 - want.y0 > want.x1 - want.x0, "the picture stands on its side");
});

test("the text index is the same at scale 1 and at RENDER_SCALE (the scan decision rides on it)", async () => {
  for (const [name, d] of [["demo", demo], ["hybrid", hybrid], ["scanned", scanned]] as const) {
    const doc = await d();
    assert.deepEqual((await measure(doc, 1, RENDER_SCALE)).index, (await measure(doc, 1)).index, name);
  }
});

test("a scan: no pictures, and the op list is never fetched", async () => {
  const m = await measure(await scanned(), 1);
  assert.ok(m.index.lineCount <= SCAN_MAX_TEXT_LINES);
  assert.deepEqual(m.pictures, []);
  assert.equal(m.opLists, 0);
});

test("a full-page image with more than 8 lines of text over it: no unread picture", async () => {
  const out = await PDFDocument.create({ updateMetadata: false });
  const page = out.addPage([1224, 792]);
  page.drawImage(await out.embedPng(readFileSync(PNG)), { x: 0, y: 0, width: 1224, height: 792 });
  for (let i = 0; i < SCAN_MAX_TEXT_LINES + 1; i++) page.drawText(`GENERAL NOTE ${i + 1}`, { x: 100, y: 700 - i * 30, size: 12 });
  const doc = await pdfjs.getDocument({ data: await out.save(), isEvalSupported: false, verbosity: 0 }).promise;
  const m = await measure(doc, 1);
  assert.equal(m.opLists, 1);
  assert.deepEqual(m.pictures, []);
  await doc.destroy();
});

test("measurePage: a viewport with offsets is refused (stored rects carry only the page's own transform)", async () => {
  const page = await (await hybrid()).getPage(1);
  const spy: MeasurablePage = { getTextContent: () => page.getTextContent() as never, getOperatorList: () => page.getOperatorList() as never };
  for (const off of [{ offsetX: 10 }, { offsetY: -5 }]) {
    await assert.rejects(measurePage("k", spy, page.getViewport({ scale: 1, ...off }), OPS), /offset/, JSON.stringify(off));
  }
});

test("an op list that rejects: pictures \"failed\", the text entry intact", async () => {
  const page = await (await hybrid()).getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const good = await measurePage("k", { getTextContent: () => page.getTextContent() as never, getOperatorList: () => page.getOperatorList() as never }, vp, OPS);
  const bad = await measurePage("k", {
    getTextContent: () => page.getTextContent() as never,
    getOperatorList: () => Promise.reject(new Error("worker gone")),
  }, vp, OPS);
  assert.equal(bad.pictures, "failed");
  assert.equal(bad.index.pictures, "failed");
  assert.deepEqual({ ...bad.index, pictures: good.pictures }, good.index);
  assert.ok(bad.index.lineCount > SCAN_MAX_TEXT_LINES);
});

test("measurePage's index carries the text pass's flag and the pictures, for search (planIndex isScan / isHybrid)", async () => {
  const h = await measure(await hybrid(), 1, RENDER_SCALE);
  assert.equal(h.index.textLayer, true);
  assert.deepEqual(h.index.pictures, h.pictures);
  const d = await measure(await demo(), 1);
  assert.equal(d.index.textLayer, true);
  assert.deepEqual(d.index.pictures, []);
  const s = await measure(await scanned(), 1);
  assert.equal(s.index.textLayer, false);
  assert.deepEqual(s.index.pictures, []);
});
