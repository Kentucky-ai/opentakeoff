// Tiled OCR seams against the REAL engine (#471). ocrSeams.test.ts pins the
// seam rules with a fake recognizer; this replays what the shipped engine
// actually returned. The fixture is the worker's raw per-job output for one
// page read of the demo plan's sheet 2 (the finish schedule) as an image-only
// PDF: every raster the read sent (6 tiles, then the patches the seams asked
// for) and the words the worker sent back, captured in Chrome by wrapping the
// worker's postMessage/onmessage. Replaying them through createSeamRun gives
// the lines the app stored for that read (checked at capture, on the raw
// replies: identical in text, geometry and order; the fixture drops
// confidence, which no seam rule reads).
//
// The answer key for text across a seam is the vector demo sheet itself
// (web/public/demo/sample-finish-plan.pdf page 2): its text-layer runs that a
// tile seam cuts must come back from OCR.
//
// If the first test fails, the seam planner no longer asks for the rasters
// the fixture holds: the fixture is stale and must be captured again from a
// real read (a fixture can't answer for rasters it never saw). So a rule
// change that changes the plan (the near margin, patch sizing, where a
// patch's edges go) makes this fixture stale rather than failing an
// assertion here: this test alone can't prove a planning rule. Those rules
// are pinned by ocrSeams.test.ts; this test shows what the real engine
// returns under the current plan. In particular, that the old 0.6·h near
// margin lost "PATCH" on the row at y ≈ 387 comes from the first capture
// (HEAD 576cb4d's fixture: tile 1 read "TCH FINISHES …" 8.2 px inside its
// edge, 0.72·h, and no patch was asked for) and from ocrSeams.test.ts's
// dropped-glyph case, not from this fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  assignLines, createSeamRun, nearMargin, planTiles,
  type Rect, type SeamLine, type TilePlan,
} from "../src/lib/ocr/seams.ts";
import { extractRegionText } from "../src/lib/sheets.ts";
import type { OcrWord } from "../src/lib/ocr/types.ts";

interface FixtureJob { kind: "tile" | "patch"; index: number; render: Rect; words: OcrWord[] }
interface Fixture { engine: string; page: { width: number; height: number }; rs: number; dpi: number; jobs: FixtureJob[] }

const FIX: Fixture = JSON.parse(readFileSync(new URL("./fixtures/ocr-seams/demo-sheet2-real.json", import.meta.url), "utf8"));
const DEMO = new URL("../public/demo/sample-finish-plan.pdf", import.meta.url);
const SHEET = 2;

const pageRect = (): Rect => ({ x0: 0, y0: 0, x1: FIX.page.width, y1: FIX.page.height });
const planOf = (): TilePlan => planTiles(pageRect(), FIX.rs, { dpi: FIX.dpi });
const tileJobs = FIX.jobs.filter((j) => j.kind === "tile");
const patchJobs = FIX.jobs.filter((j) => j.kind === "patch");

const box = (w: { x: number; y: number; w?: number; h: number; str: string }): Rect =>
  ({ x0: w.x, y0: w.y - w.h, x1: w.x + (w.w ?? w.str.length * 0.6 * w.h), y1: w.y });
const area = (b: Rect) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a: Rect, b: Rect) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const iou = (a: Rect, b: Rect) => { const i = inter(a, b), u = area(a) + area(b) - i; return u > 0 ? i / u : 0; };
const norm = (s: string) => s.replace(/\s+/g, "").toUpperCase();
const sameWord = (a: OcrWord, b: OcrWord) => a.str === b.str && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const close = (a: Rect, b: Rect) => Math.abs(a.x0 - b.x0) < 1e-6 && Math.abs(a.y0 - b.y0) < 1e-6 && Math.abs(a.x1 - b.x1) < 1e-6 && Math.abs(a.y1 - b.y1) < 1e-6;

/** Fewest edits that make `short` a substring of `long` (Sellers), spaces
 * ignored and case folded. */
function subDistance(long: string, short: string): number {
  const a = norm(long), b = norm(short);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let best = prev[b.length];
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    best = Math.min(best, cur[b.length]);
    prev = cur;
  }
  return best;
}
/** One edit per full ten characters of the run (seams.ts textHolds' allowance). */
const allowance = (s: string) => Math.floor(norm(s).length / 10);

/** Replay the fixture, checking each planned raster against the recorded one. */
function replay(): SeamLine[] {
  const run = createSeamRun(planOf());
  let i = 0;
  for (let job = run.next(); job; job = run.next(), i++) {
    const rec = FIX.jobs[i];
    const stale = `fixture is stale, capture it again: planned ${job.kind} ${job.index} ${JSON.stringify(job.render)}, recorded ${rec ? `${rec.kind} ${rec.index} ${JSON.stringify(rec.render)}` : "nothing"}`;
    assert.ok(rec && rec.kind === job.kind && rec.index === job.index && close(rec.render, job.render), stale);
    run.accept(job, rec.words);
  }
  assert.equal(i, FIX.jobs.length, `fixture is stale, capture it again: the plan ended after ${i} rasters, the fixture has ${FIX.jobs.length}`);
  return run.lines();
}

test("the seam planner asks for exactly the rasters the real read sent", () => {
  replay();
  assert.equal(tileJobs.length, planOf().tiles.length);
  // not vacuous: this real read needed patches across its seams
  assert.ok(patchJobs.length > 0, "the fixture holds no patches");
});

test("no line is kept twice across a seam (IoU ≥ 0.5 with the same text)", () => {
  const lines = replay();
  const dups: string[] = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    if (norm(lines[i].str) === norm(lines[j].str) && iou(box(lines[i]), box(lines[j])) >= 0.5) dups.push(lines[i].str);
  }
  assert.deepEqual(dups, []);
});

// A row read as two overlapping pieces (one per tile, each ending where its
// tile cut it) must come back as one line, not both: no two unclipped lines
// on one row (sharing half a line height) that overlap along it by half a
// line height or more.
test("no row's text is doubled: overlapping pieces of one row are not both kept", () => {
  const lines = replay().filter((l) => !l.clipped);
  const doubled: string[] = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = box(lines[i]), b = box(lines[j]), h = Math.min(lines[i].h, lines[j].h);
    const across = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0), along = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    if (across >= 0.5 * h && along >= 0.5 * h) doubled.push(`${lines[i].str} | ${lines[j].str}`);
  }
  assert.deepEqual(doubled, []);
});

test("every line cut in every tile is read whole by a patch: nothing is left clipped", () => {
  const lines = replay();
  assert.deepEqual(lines.filter((l) => l.clipped).map((l) => l.str), []);
});

// A patch is read for the fragments of lines a seam cut ("groups"). Its
// lines that count are the ones joinPatches considers: inside a group's band,
// over one of its fragments along the line, and clear of the patch's own
// inner edges. Accounted for means:
//   • each such patch line is in the final lines, or is a duplicate of an
//     unclipped one (IoU ≥ 0.5, or one holding 80% of its box and its text);
//   • each group fragment is either emitted, flagged clipped, or covered by
//     an unclipped final line on its row spanning 80% of it.
test("every line a patch was read for is accounted for", () => {
  const plan = planOf();
  const lines = replay();
  const a = assignLines(plan, tileJobs.map((j) => j.words));
  assert.equal(a.patches.length, patchJobs.length);
  let considered = 0, fragments = 0, clipped = 0;
  a.patches.forEach((p, k) => {
    const r = p.render, rect = plan.rect;
    const inner = { left: r.x0 > rect.x0, right: r.x1 < rect.x1, top: r.y0 > rect.y0, bottom: r.y1 < rect.y1 };
    const along = (b: Rect) => (p.axis === "h" ? [b.x0, b.x1] : [b.y0, b.y1]);
    const across = (b: Rect) => (p.axis === "h" ? [b.y0, b.y1] : [b.x0, b.x1]);
    for (const w of patchJobs[k].words) {
      const b = box(w), [lo, hi] = across(b), [a0, a1] = along(b);
      const mine = p.groups.some((g) => hi > g.band.lo && lo < g.band.hi
        && g.fragments.some((f) => { const [f0, f1] = along(box(f)); return a1 > f0 && a0 < f1; }));
      if (!mine) continue;
      const m = nearMargin(w, plan.zoom);
      const nearEdge = (inner.left && b.x0 - r.x0 <= m) || (inner.right && r.x1 - b.x1 <= m)
        || (inner.top && b.y0 - r.y0 <= m) || (inner.bottom && r.y1 - b.y1 <= m);
      if (nearEdge) continue;
      considered++;
      // a clipped fragment doesn't count: the patch read this line whole
      const ok = lines.some((l) => !l.clipped && (sameWord(l, w)
        || iou(box(l), b) >= 0.5
        || (inter(box(l), b) >= 0.8 * area(b) && subDistance(l.str, w.str) <= allowance(w.str))));
      assert.ok(ok, `patch ${k} line ${JSON.stringify(w.str)} is neither kept nor a duplicate of a kept line`);
    }
    for (const g of p.groups) for (const f of g.fragments) {
      fragments++;
      const fb = box(f), [f0, f1] = along(fb), [c0, c1] = across(fb);
      if (lines.some((l) => l.clipped && sameWord(l, f))) { clipped++; continue; }
      let span = 0;
      const runs = lines.filter((l) => !l.clipped).map((l) => box(l))
        .filter((lb) => { const [k0, k1] = across(lb); return Math.min(c1, k1) - Math.max(c0, k0) >= 0.5 * (c1 - c0); })
        .map((lb) => { const [l0, l1] = along(lb); return [Math.max(l0, f0), Math.min(l1, f1)]; })
        .filter(([s0, s1]) => s1 > s0).sort((x, y) => x[0] - y[0]);
      let end = -Infinity;
      for (const [s0, s1] of runs) if (s1 > end) { span += s1 - Math.max(s0, end); end = s1; }
      assert.ok(span >= 0.8 * (f1 - f0), `fragment ${JSON.stringify(f.str)} is neither clipped nor covered by a kept line`);
    }
  });
  assert.ok(considered > 0 && fragments > 0, "no patch line to account for");
  assert.equal(clipped, lines.filter((l) => l.clipped).length - a.oversize.length);
});

test("text the vector sheet runs across a tile seam comes back from OCR", async () => {
  const plan = planOf();
  const lines = replay();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(DEMO)), isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(SHEET);
    const vp = page.getViewport({ scale: FIX.rs });
    assert.deepEqual([vp.width, vp.height], [FIX.page.width, FIX.page.height], "the vector sheet and the OCR read differ in size");
    const tc = await page.getTextContent();
    const runs = extractRegionText(tc as never, vp as never, { x0: 0, y0: 0, x1: vp.width, y1: vp.height });
    // the seams: the tile cores' interior cuts
    const xs = [...new Set(plan.tiles.map((t) => t.core.x0))].filter((v) => v > plan.rect.x0);
    const ys = [...new Set(plan.tiles.map((t) => t.core.y0))].filter((v) => v > plan.rect.y0);
    const level = runs.filter((t) => Math.round(t.ang ?? 0) % 360 === 0);
    const crosses = (b: Rect) => xs.some((x) => b.x0 < x && b.x1 > x) || ys.some((y) => b.y0 < y && b.y1 > y);
    const straddlers = level.filter((t) => crosses(box(t)));
    // Rotated runs (31 on this sheet, all at 270°) are counted, not matched:
    // none crosses a seam here, and the engine reading rotated text isn't shown.
    const rotated = runs.filter((t) => Math.round(t.ang ?? 0) % 360 !== 0);
    assert.equal(rotated.filter((t) => {
      const len = t.w ?? t.str.length * 0.6 * t.h; // a 270° run goes up from (x, y)
      return crosses({ x0: t.x - t.h, y0: t.y - len, x1: t.x, y1: t.y });
    }).length, 0);
    // Cut in every tile: no tile's raster holds the run whole, so only a patch can read it whole.
    const cutEverywhere = (b: Rect) => !plan.tiles.some((tl) => b.x0 >= tl.render.x0 && b.x1 <= tl.render.x1 && b.y0 >= tl.render.y0 && b.y1 <= tl.render.y1);
    // the OCR lines over the run holding its text (one edit in ten allowed)
    const matches = (t: (typeof runs)[number]) => {
      const b = box(t), tol = 0.5 * t.h;
      return lines.filter((l) => {
        const lb = box(l);
        return lb.x0 < b.x1 + tol && b.x0 < lb.x1 + tol && lb.y0 < b.y1 + tol && b.y0 < lb.y1 + tol
          && subDistance(l.str, t.str) <= allowance(t.str);
      });
    };
    const found = (t: (typeof runs)[number]) => matches(t).length > 0;
    // A seam cuts a line at an end: the run's first and last three
    // characters must be there exactly, so a line that lost the glyphs past
    // a cut ("TCH" for "PATCH") is not counted as read just because the edit
    // allowance covers it. (A glyph misread inside the line is the engine's,
    // not the seam's, and the allowance takes it.)
    const endsIntact = (t: (typeof runs)[number]) => {
      const r = norm(t.str), head = r.slice(0, 3), tail = r.slice(-3);
      return matches(t).some((l) => { const s = norm(l.str); return s.includes(head) && s.includes(tail); });
    };
    const hard = straddlers.filter((t) => cutEverywhere(box(t)));
    const hits = straddlers.filter(found), hardHits = hard.filter(found);
    const truncated = straddlers.filter((t) => found(t) && !endsIntact(t)).map((t) => t.str);
    // 28 runs on this sheet cross a seam, 4 of them cut in every tile. All
    // must come back, with both ends intact.
    assert.ok(straddlers.length >= 20, `only ${straddlers.length} runs cross a seam`);
    assert.ok(hard.length >= 1, "no run is cut in every tile");
    assert.deepEqual(straddlers.filter((t) => !found(t)).map((t) => t.str), [], "seam-crossing runs not read");
    assert.equal(hardHits.length, hard.length, `${hardHits.length} of ${hard.length} runs cut in every tile found`);
    assert.deepEqual(truncated, [], "seam-crossing runs read with an end lost at the seam");
    assert.equal(hits.length, straddlers.length);
  } finally {
    await doc.destroy();
  }
});
