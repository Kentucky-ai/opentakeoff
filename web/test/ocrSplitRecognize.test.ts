// The split read (#481): detection on the tile as rendered, recognition on a
// copy with its colored pixels grayed. splitRecognizer mirrors ppu-paddle-ocr
// 6.6.0's recognize() through two of its protected fields, so the last tests
// pin that source: a ppu upgrade that changes recognize() fails here and the
// split gets checked again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitRecognizer, type PpuServiceInternals } from "../src/lib/ocr/splitRecognize.ts";
// The package's exports map doesn't expose this subpath, so it's imported by
// path, as splitRecognize.ts does.
import { groupResultsByLine } from "../node_modules/ppu-paddle-ocr/core/recognition/line-grouping.js";

const A = { canvas: "A" };
const B = { canvas: "B" };
const BOXES = [{ x: 10, y: 20, width: 30, height: 12 }, { x: 50, y: 21, width: 20, height: 12 }];
const RESULTS = [
  { text: "CPT-1", box: { x: 50, y: 21, width: 20, height: 12 }, confidence: 0.9 },
  { text: "RB-2", box: { x: 10, y: 20, width: 30, height: 12 }, confidence: 0.8 },
];

function fakeSvc(over: { boxes?: unknown[]; recognition?: Record<string, unknown> } = {}) {
  const detectCalls: unknown[] = [];
  const recCalls: unknown[][] = [];
  let destroyed = 0;
  const boxes = over.boxes ?? BOXES;
  const svc: PpuServiceInternals = {
    detector: { run: async (canvas: unknown) => { detectCalls.push(canvas); return boxes; } },
    recognitor: { run: async (...args: unknown[]) => { recCalls.push(args); return RESULTS; } },
    options: { recognition: over.recognition ?? { charactersDictionary: ["a", "b"] } },
    destroy: async () => { destroyed++; },
  };
  return { svc, detectCalls, recCalls, boxes, destroyed: () => destroyed };
}

test("detection reads the canvas as rendered, recognition the recognition canvas, with the same boxes", async () => {
  const f = fakeSvc();
  const out = await splitRecognizer(f.svc).recognize(A, { flatten: false, noCache: true, recognitionCanvas: B });
  assert.deepEqual(f.detectCalls, [A]);
  assert.equal(f.recCalls.length, 1);
  const [canvas, boxes, dict, strategy, opts] = f.recCalls[0];
  assert.equal(canvas, B);
  assert.equal(boxes, f.boxes); // the detector's own array, not a copy
  assert.equal(dict, f.svc.options.recognition!.charactersDictionary);
  assert.equal(strategy, "per-line");
  // ppu gets the caller's options without recognitionCanvas
  assert.deepEqual(opts, { flatten: false, noCache: true });
  assert.deepEqual(out, groupResultsByLine(RESULTS as Parameters<typeof groupResultsByLine>[0]));
});

test("no recognition canvas: recognition reads the same canvas detection did", async () => {
  const f = fakeSvc();
  await splitRecognizer(f.svc).recognize(A, { flatten: false, noCache: true });
  assert.deepEqual(f.detectCalls, [A]);
  assert.equal(f.recCalls[0][0], A);
  assert.deepEqual(f.recCalls[0][4], { flatten: false, noCache: true });
});

test("strategy: the read's option wins, then the service's recognition option, then per-line", async () => {
  let f = fakeSvc({ recognition: { charactersDictionary: ["x"], strategy: "cross-line" } });
  await splitRecognizer(f.svc).recognize(A, { flatten: false, noCache: true });
  assert.equal(f.recCalls[0][3], "cross-line");
  f = fakeSvc({ recognition: { charactersDictionary: ["x"], strategy: "cross-line" } });
  await splitRecognizer(f.svc).recognize(A, { flatten: false, noCache: true, strategy: "per-box" });
  assert.equal(f.recCalls[0][3], "per-box");
  assert.deepEqual(f.recCalls[0][4], { flatten: false, noCache: true, strategy: "per-box" });
  f = fakeSvc({ recognition: {} });
  await splitRecognizer(f.svc).recognize(A, { flatten: false, noCache: true });
  assert.equal(f.recCalls[0][3], "per-line");
  assert.equal(f.recCalls[0][2], undefined);
});

test("no boxes: ppu's empty grouped result, and recognition never runs", async () => {
  const f = fakeSvc({ boxes: [] });
  const out = await splitRecognizer(f.svc).recognize(A, { flatten: false, noCache: true, recognitionCanvas: B });
  assert.deepEqual(out, { text: "", lines: [], confidence: 0 });
  assert.equal(f.recCalls.length, 0);
});

test("a service with no detector or recognitor (destroyed) throws instead of reading", async () => {
  const f = fakeSvc();
  f.svc.detector = null;
  await assert.rejects(splitRecognizer(f.svc).recognize(A, { flatten: false, noCache: true }), /isn't initialized/);
  assert.equal(f.recCalls.length, 0);
});

test("destroy is the service's", async () => {
  const f = fakeSvc();
  await splitRecognizer(f.svc).destroy();
  assert.equal(f.destroyed(), 1);
});

// ── ppu pin ──────────────────────────────────────────────────────────────────

const PPU = new URL("../node_modules/ppu-paddle-ocr/", import.meta.url);

test("ppu pin: the version splitRecognizer mirrors is 6.6.0", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", PPU), "utf8")) as { version: string };
  assert.equal(pkg.version, "6.6.0");
});

test("ppu pin: recognize() still detects, recognizes the same canvas and groups the way splitRecognizer copies", () => {
  // If this fails, ppu changed recognize(): read the new one and bring
  // splitRecognize.ts back in line with it before updating these strings.
  const src = readFileSync(new URL("core/base-paddle-ocr.service.js", PPU), "utf8");
  const start = src.indexOf("async recognize(");
  const end = src.indexOf("async detect(", start);
  assert.ok(start >= 0 && end > start, "recognize() not found");
  const body = src.slice(start, end);
  for (const s of [
    "boxes=await this.detector.run(canvas)",
    'if(boxes.length===0){return options?.flatten?{text:"",results:[],confidence:0}:{text:"",lines:[],confidence:0}}',
    "let dict=this.options.recognition?.charactersDictionary",
    'let strategy=options?.strategy??this.options.recognition?.strategy??"per-line"',
    "this.recognitor.run(canvas,boxes,dict,strategy,options)",
    "groupResultsByLine(results)",
  ]) assert.ok(body.includes(s), `recognize() no longer contains ${s}`);
});
