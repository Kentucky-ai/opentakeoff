// How tall can a seam patch get before the engine stops reading the line it
// was asked for? (#488, part 1.) Packing two patches into one makes a taller
// raster, and the one real measurement so far (n = 1, on the per-line engine)
// lost a line doing that.
//
// For each sheet: read the planned tiles with the real engine, ask the seam
// planner for its patches, then read every sampled straddling line again in a
// raster of the same length as its own patch and a range of heights, the line
// centred (and, with --offset, a quarter of the way down). The answer key is
// the sheet's own vector text, so only vector sheets can be measured.
//
//   node scripts/stage-ocr-model.mjs     # once
//   node --expose-gc --import tsx scripts/measure-ocr-patch-height.mts out.json \
//     public/demo/sample-finish-plan.pdf:2 [--pack] [--long --offset] [--only=k]
//
// bench/ocr-patch-height/README.md has the runs behind its committed results.
// A tile read here peaks around 7 GB of RSS: wrap it in a memory guard, and
// use --only with --tile-cache to read one line per process.
//
// Not a test. Same models and OCR_ENGINE_OPTIONS as the app, but ppu's Node
// build on native ORT and a pdf.js render on @napi-rs/canvas, not wasm in a
// browser. No split ink read (ocr.worker's recognition copy), which only
// changes colored text.
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PaddleOcrService } from "ppu-paddle-ocr";
import { OCR_ENGINE_OPTIONS } from "../src/lib/ocr/engineOptions.ts";
import { assignLines, joinPatches, planTiles, type Patch, type PatchGroup, type Rect, type TilePlan } from "../src/lib/ocr/seams.ts";
import { cropBoxToWord, OCR_DETECTION_PADDING, unpadCropBox } from "../src/lib/ocr/raster.ts";
import type { OcrWord } from "../src/lib/ocr/types.ts";
import { acrossOf, alongOf, bandRecall, keyFor, packed, runsOf, score } from "../bench/ocr-patch-height/pack.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(web, "package.json"));
const { createCanvas } = require("@napi-rs/canvas");

const flag = (name: string, dflt: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
const [out, ...sheets] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!out || !sheets.length) throw new Error("usage: measure-ocr-patch-height.mts out.json file.pdf:page ...");
const RS = 2; // a normal sheet's render scale: 216 DPI is zoom 1.5, maxSide 2729
const HEIGHTS = flag("heights", "128,256,408,600,800,1200,1600,2400,4000").split(",").map(Number); // render px
const MAX_GROUPS = Number(flag("groups", "12"));
const OFFSET = process.argv.includes("--offset");
/** Stretch each raster to the cap along the line, as an open-ended span is. */
const LONG = process.argv.includes("--long");
/** Read one sampled line and stop, so each process starts small. */
const ONLY = flag("only", "");
/** Keep a sheet's tile reads here between processes. */
const TILE_CACHE = flag("tile-cache", "");
/** Instead of the sweep: pack the planned patches under each height cap, read
 * them, join, and score the joined lines against the vector text. */
const PACK = process.argv.includes("--pack");
/** Use a fixture's recorded tile reads (the browser engine's) for the plan. */
const FIXTURE = flag("fixture", "");

const PUBLIC = join(web, "public");
const manifest = JSON.parse(readFileSync(join(PUBLIC, "models/ocr/manifest.json"), "utf8")) as { files: { name: string; url: string }[] };
const modelFile = (name: string) => new Uint8Array(readFileSync(join(PUBLIC, manifest.files.find((f) => f.name === name)!.url.replace(/^\//, "")))).buffer;
const makeService = () => new PaddleOcrService({
  model: { detection: modelFile("det"), recognition: modelFile("rec"), charactersDictionary: modelFile("dict") },
  ...OCR_ENGINE_OPTIONS,
  // native ORT's arena holds on to every tile's peak; the browser's wasm heap has no such pool
  session: { ...OCR_ENGINE_OPTIONS.session, enableCpuMemArena: false, enableMemPattern: false },
} as ConstructorParameters<typeof PaddleOcrService>[0]);

let service = makeService();
/** ppu's Node build keeps native memory between reads, about 1 GB per tile:
 * start it again before it matters. */
async function keepSmall() {
  if (process.memoryUsage().rss < 6 * 2 ** 30) return;
  await service.destroy();
  (globalThis as { gc?: () => void }).gc?.();
  service = makeService();
  await service.initialize();
}

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>["getPage"]>>;
/** Render `rect` (image px) and read it, as rasterizeRegion and workerCore do. */
async function read(page: Page, rect: Rect, zoom: number): Promise<{ words: OcrWord[]; ms: number; width: number; height: number }> {
  const width = Math.max(1, Math.round((rect.x1 - rect.x0) * zoom)), height = Math.max(1, Math.round((rect.y1 - rect.y0) * zoom));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: RS * zoom }), transform: [1, 0, 0, 1, -rect.x0 * zoom, -rect.y0 * zoom] } as never).promise;
  const png = canvas.toBuffer("image/png") as Buffer;
  await keepSmall();
  const t0 = performance.now();
  const res = await service.recognize(new Uint8Array(png).buffer, { flatten: false, noCache: true }) as { lines?: { text?: string; confidence: number; box?: { x: number; y: number; width: number; height: number } }[][] };
  const ms = performance.now() - t0;
  canvas.width = canvas.height = 1; // release the native bitmap now, not at the next GC
  (globalThis as { gc?: () => void }).gc?.();
  if (process.env.OT_RSS) console.error(`    ${width}x${height} ${Math.round(ms)} ms, rss ${(process.memoryUsage().rss / 2 ** 30).toFixed(1)} GB`);
  const words: OcrWord[] = [];
  for (const line of res.lines ?? []) for (const cell of line ?? []) {
    const str = (cell.text ?? "").trim();
    if (!str || !cell.box) continue;
    const { x, y, width: w, height: h } = cell.box;
    const ink = unpadCropBox({ x0: x, y0: y, x1: x + w, y1: y + h }, { width, height }, OCR_DETECTION_PADDING);
    words.push(cropBoxToWord(str, ink, { rect, zoom }, cell.confidence));
  }
  return { words, ms, width, height };
}

/** The sheet's vector runs, image px. */
async function vectorRuns(page: Page) {
  const vp = page.getViewport({ scale: RS });
  const { items } = await page.getTextContent();
  return runsOf(items as Parameters<typeof runsOf>[0], RS, vp.transform, pdfjs.Util.transform as (a: number[], b: number[]) => number[]);
}

function rectFor(plan: TilePlan, p: Patch, g: PatchGroup, renderH: number, where: number): Rect {
  const across = renderH / plan.zoom;
  const r = plan.rect;
  const [ca0, ca1] = p.axis === "h" ? [r.y0, r.y1] : [r.x0, r.x1];
  const mid = (g.band.lo + g.band.hi) / 2;
  let lo = mid - across * where;
  lo = Math.max(ca0, Math.min(lo, ca1 - across));
  const hi = Math.min(ca1, lo + across);
  const [a0, a1] = alongOf(p.axis, p.render);
  const [ra0, ra1] = p.axis === "h" ? [r.x0, r.x1] : [r.y0, r.y1];
  const start = LONG ? Math.max(ra0, Math.min((a0 + a1) / 2 - plan.maxSide / 2, ra1 - plan.maxSide)) : a0;
  const end = LONG ? Math.min(ra1, start + plan.maxSide) : a1;
  return p.axis === "h" ? { x0: start, x1: end, y0: lo, y1: hi } : { x0: lo, x1: hi, y0: start, y1: end };
}

const results: unknown[] = [];
await service.initialize();
try {
  for (const spec of sheets) {
    const at = spec.lastIndexOf(":");
    const file = spec.slice(0, at), pageNo = Number(spec.slice(at + 1));
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(resolve(file))),
      standardFontDataUrl: join(web, "node_modules/pdfjs-dist/standard_fonts/"),
      cMapUrl: join(web, "node_modules/pdfjs-dist/cmaps/"), cMapPacked: true,
      disableFontFace: true, isEvalSupported: false,
    }).promise;
    const page = await doc.getPage(pageNo);
    const vp = page.getViewport({ scale: RS });
    const plan = planTiles({ x0: 0, y0: 0, x1: vp.width, y1: vp.height }, RS);
    const runs = await vectorRuns(page);
    console.error(`${file}:${pageNo} ${Math.round(vp.width)}x${Math.round(vp.height)} px, ${plan.tiles.length} tiles, ${runs.length} vector runs`);
    let tileReads: OcrWord[][] = [];
    let tileMs = 0;
    const cachePath = TILE_CACHE && join(TILE_CACHE, `${spec.replace(/[^A-Za-z0-9]+/g, "_")}.json`);
    if (FIXTURE) {
      const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as { jobs: { kind: string; words: OcrWord[] }[] };
      tileReads = fx.jobs.filter((j) => j.kind === "tile").map((j) => j.words);
    } else if (cachePath && existsSync(cachePath)) tileReads = JSON.parse(readFileSync(cachePath, "utf8"));
    else {
      for (const t of plan.tiles) { const r = await read(page, t.render, plan.zoom); tileReads.push(r.words); tileMs += r.ms; }
      if (cachePath) writeFileSync(cachePath, JSON.stringify(tileReads));
    }
    const a = assignLines(plan, tileReads);
    if (PACK) {
      const seen = new Map<string, { words: OcrWord[]; ms: number }>();
      const arms = [];
      for (const cap of [0, ...HEIGHTS]) {
        const plan2 = cap ? packed(a, cap) : a;
        const reads: OcrWord[][] = [];
        let ms = 0;
        for (const p of plan2.patches) {
          const k = JSON.stringify(p.render);
          if (!seen.has(k)) { const r = await read(page, p.render, plan.zoom); seen.set(k, r); }
          reads.push(seen.get(k)!.words);
          ms += seen.get(k)!.ms;
        }
        const lines = joinPatches(plan2, reads);
        const rec = bandRecall(a, lines, runs);
        arms.push({ cap: cap || "main", patches: plan2.patches.length, heights: plan2.patches.map((p) => { const [c0, c1] = acrossOf(p.axis, p.render); return Math.round((c1 - c0) * plan.zoom); }), lengths: plan2.patches.map((p) => { const [a0, a1] = alongOf(p.axis, p.render); return Math.round((a1 - a0) * plan.zoom); }), lines: lines.length, clipped: lines.filter((l) => (l as { clipped?: boolean }).clipped).length, recall: `${rec.read}/${rec.wanted}`, ms: Math.round(ms), missed: rec.missed });
        console.error(`  cap ${cap || "main"}: ${plan2.patches.length} patches, ${lines.length} lines, recall ${rec.read}/${rec.wanted}, ${Math.round(ms)} ms`);
      }
      results.push({ sheet: spec, fixture: FIXTURE || undefined, tiles: plan.tiles.length, arms });
      writeFileSync(out, JSON.stringify({ issue: "#488", mode: "pack", results }, null, 1));
      await doc.destroy();
      continue;
    }
    const groups = a.patches.flatMap((p) => p.groups.map((g) => ({ p, g, key: keyFor(p, g, runs) }))).filter((x) => x.key.length);
    const stride = Math.max(1, groups.length / MAX_GROUPS);
    let sample = Array.from({ length: Math.min(MAX_GROUPS, groups.length) }, (_, i) => groups[Math.floor(i * stride)]);
    if (ONLY) { if (Number(ONLY) >= sample.length) { console.error("no such line"); process.exit(3); } sample = [sample[Number(ONLY)]]; }
    const sizes = a.patches.map((p) => { const [c0, c1] = acrossOf(p.axis, p.render); return Math.round((c1 - c0) * plan.zoom); });
    console.error(`  ${a.patches.length} patches, ${groups.length} straddling lines with a vector key, sampling ${sample.length}; own patch heights ${sizes.join(",")} render px; tiles ${(tileMs / 1000).toFixed(1)} s`);
    const rows = [];
    for (const { p, g, key } of sample) {
      const own = await read(page, p.render, plan.zoom);
      const entry: Record<string, unknown> = {
        key: key.join(" | "), runs: key.length, axis: p.axis,
        own: { h: p.axis === "h" ? own.height : own.width, read: score(p, g, key, own.words), ms: Math.round(own.ms) },
        heights: {} as Record<string, unknown>,
      };
      for (const where of OFFSET ? [0.5, 0.25] : [0.5]) for (const h of HEIGHTS) {
        const r = await read(page, rectFor(plan, p, g, h, where), plan.zoom);
        const tall = p.axis === "h" ? r.height : r.width;
        (entry.heights as Record<string, unknown>)[where === 0.5 ? String(h) : `${h}@q`] = { actual: tall, read: score(p, g, key, r.words), ms: Math.round(r.ms) };
      }
      rows.push(entry);
      console.error(`  ${JSON.stringify(key.join(" | ").slice(0, 60))} own ${(entry.own as { read: number }).read}/${key.length} ` + Object.entries(entry.heights as Record<string, { read: number }>).map(([h, v]) => `${h}:${v.read}`).join(" "));
    }
    results.push({ sheet: spec, width: vp.width, height: vp.height, tiles: plan.tiles.length, patches: a.patches.length, ownHeights: sizes, straddlers: groups.length, rows });
    writeFileSync(out, JSON.stringify({ issue: "#488", rs: RS, zoom: plan.zoom, heights: HEIGHTS, results }, null, 1));
    await doc.destroy();
  }
} finally { await service.destroy(); }
