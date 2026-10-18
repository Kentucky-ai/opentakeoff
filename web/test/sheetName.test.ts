// The Sheets tree's number reader (sheetName.ts): the title block's number
// label anchors the number. Checked three ways: public plan PDFs with known
// numbers, built pages for each rule, and answer-for-answer against the probe
// reader it was tuned as (sheetNameOracle.ts), which is quadratic and test-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readSheetNumber, sheetItems, MAX_ITEMS, type SheetItem, type SheetPage } from "../src/lib/sheetName.ts";
import { extractSheetNumber, RENDER_SCALE } from "../src/lib/sheets.ts";
import { oracleSheetNumber } from "./sheetNameOracle.ts";
import { densePage } from "./denseSheetPage.ts";

const pdf = (rel: string) => new URL(rel, import.meta.url);
async function pdfPages(url: URL) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(url)), isEvalSupported: false, verbosity: 0 }).promise;
  const out: { page: SheetPage; tc: any; vp: any }[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n);
    const vp = p.getViewport({ scale: RENDER_SCALE });
    const tc = await p.getTextContent();
    out.push({ page: sheetItems(tc, vp), tc, vp });
  }
  await doc.destroy();
  return out;
}

const PUBLIC: [string, (string | null)[]][] = [
  ["../public/demo/sample-finish-plan.pdf", ["AF101", "AF600"]],
  ["../../evals/four-asks-2026-09-02/sheets/va-dublin-bldg9a-finish-plan-A601.pdf", ["A-601"]],
  ["../../evals/four-asks-2026-09-02/sheets/va-shreveport-fisher-house-site-utility-C300.pdf", ["C-300"]],
  ["../../evals/mcp-workflow-bench/plan-set/porterville/porterville-adu-a1-101.pdf", ["A1-101"]],
  ["../../mcp/test/fixtures/mep-set.pdf", [null, null]],          // its numbers have no label
  ["../../mcp/test/fixtures/multibuilding-set.pdf", [null, null, null, null, null]],
];

test("public plan sheets read their labelled number", async () => {
  for (const [rel, want] of PUBLIC) {
    const pages = await pdfPages(pdf(rel));
    assert.deepEqual(pages.map((p) => readSheetNumber(p.page)), want, rel);
  }
});

test("where today's picker reads a door tag, the label reads the sheet", async () => {
  const [p] = await pdfPages(pdf("../../evals/mcp-workflow-bench/plan-set/porterville/porterville-adu-a1-101.pdf"));
  assert.equal(extractSheetNumber(p.tc, p.vp), "X1");
  assert.equal(readSheetNumber(p.page), "A1-101");
});

test("any viewport scale reads the same", async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdf("../public/demo/sample-finish-plan.pdf"))), isEvalSupported: false, verbosity: 0 }).promise;
  const p = await doc.getPage(1);
  const tc = await p.getTextContent();
  for (const scale of [1, 1.5, 2, 3]) assert.equal(readSheetNumber(sheetItems(tc, p.getViewport({ scale }))), "AF101", `scale ${scale}`);
  await doc.destroy();
});

// built pages, 7200 × 4800 px (a 36 × 24 sheet at scale 2)
const W = 7200, H = 4800;
const it = (s: string, X: number, Y: number, h: number, a = 0): SheetItem =>
  ({ s, x: +(X / W).toFixed(4), y: +(Y / H).toFixed(4), h, a, w: +((s.length * h * 0.6) / W).toFixed(4) });
const body = (): SheetItem[] => [it("FLOOR PLAN", 400, 300, 30), it("WALL TYPE A", 900, 1400, 14), it("SEE SHEET A-501 FOR DETAILS", 1200, 2000, 14), it("SHEET", 3000, 2600, 14), it("A-901", 3000, 2640, 40)];
const BUILT: [string, SheetPage, string | null][] = [
  ["cell under the label, lower right", { W, H, items: [...body(), it("SHEET NUMBER", 6600, 4500, 12), it("A1-101", 6600, 4540, 40)] }, "A1-101"],
  ["inline SHEET NO:", { W, H, items: [...body(), it("SHEET NO: E-201", 6400, 4650, 24)] }, "E-201"],
  ["vertical title strip", { W, H, items: [...body(), it("SHEET NUMBER", 6950, 3000, 12), it("M-101", 6950, 3030, 44)] }, "M-101"],
  ["rotated label", { W, H, items: [...body(), it("SHEET NUMBER", 6900, 4400, 12, -90), it("S-301", 6940, 4400, 40, -90)] }, "S-301"],
  ["a cover index's SHEET column does not anchor", { W, H, items: [it("SHEET", 4000, 600, 9), it("G-001", 4000, 630, 14), it("A-101", 4000, 670, 14), it("A-102", 4000, 710, 14), it("A-201", 4000, 750, 14)] }, null],
  ["…while one number under a small SHEET label does", { W, H, items: [it("SHEET", 4000, 600, 9), it("G-001", 4000, 630, 14)] }, "G-001"],
  ["a body note mentioning a sheet is not a label", { W, H, items: [it("SEE SHEET A-501", 5000, 3000, 14), it("REFER TO SHEET", 5200, 3400, 14)] }, null],
  ["no label at all", { W, H, items: [it("M-101", 6600, 4540, 40), it("MECHANICAL PLAN", 6000, 4400, 20)] }, null],
  ["a number not bigger than its label does not anchor", { W, H, items: [it("SHEET NUMBER", 6600, 4500, 12), it("A1-101", 6600, 4530, 14)] }, null],
];

test("built pages: one per rule", () => {
  for (const [name, page, want] of BUILT) assert.equal(readSheetNumber(page), want, name);
});

test("answers match the probe reader on every page above and on dense copies", async () => {
  const pages: SheetPage[] = BUILT.map(([, p]) => p);
  for (const [rel] of PUBLIC) for (const p of await pdfPages(pdf(rel))) pages.push(p.page);
  for (let seed = 1; seed <= 6; seed++) pages.push(densePage(3000, seed, seed * 20));
  for (const p of pages) assert.equal(readSheetNumber(p), oracleSheetNumber(p));
});

test("label-row filtering preserves neighbouring angles, height changes and pixel-bucket ties", () => {
  for (const bucketSize of [2, 32, 33, 80]) {
    const extras = Array.from({ length: bucketSize }, (_, i) =>
      it("NOTE", 700 - (i % 9) * 10, 600 + (i % 2) * 0.1, 8 + (i % 3) * 8));
    for (const angle of [-90, 0, 90]) {
      const page: SheetPage = { W, H, items: [
        ...extras,
        it("SHEET", 6600, 4500, 12, angle),
        it("NUMBER", 6644, 4500, 12, angle),
        it("A-101", 6600, 4540, 40, angle),
        it("NOTE", 6650, 4500, 8, angle + 1),
        it("NOTE", 6650, 4503, 28, angle - 1),
      ] };
      for (const items of [page.items, [...page.items].reverse()]) {
        const p = { ...page, items };
        assert.equal(readSheetNumber(p), oracleSheetNumber(p), `${bucketSize} items, angle ${angle}`);
      }
    }
  }
});

// V8 coverage adds work to every hot-loop branch. Keep the same real-runtime
// budgets when the parent runs test:coverage, rather than timing the probes.
// All answer/oracle tests above still execute in the instrumented parent.
type Timing = { ratio: number; dense: { items: number; ms: number }[]; noLabelMs: number };
let measured: Timing | undefined;
function timings(): Timing {
  if (!measured) {
    const env = { ...process.env };
    delete env.NODE_V8_COVERAGE;
    measured = JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./sheetNamePerformance.ts", import.meta.url))],
      { env, encoding: "utf8", timeout: 15000 }));
  }
  return measured!;
}

test("cost grows about linearly with the page's text", () => {
  const big = densePage(30000);
  assert.equal(readSheetNumber(big), "A-101");
  const { ratio } = timings();
  // linear-ish runs at 3-5x on a busy machine; a quadratic reader is ~16x
  assert.ok(ratio <= 10, `4x the items cost ${ratio.toFixed(1)}x the time`);
});

test("a dense page reads within the main-thread budget", () => {
  for (const { items, ms } of timings().dense) {
    assert.ok(ms <= 50, `${items} items took ${ms.toFixed(1)} ms`);
  }
});

test("past MAX_ITEMS a page is not read", () => {
  const p = densePage(MAX_ITEMS + 10);
  assert.equal(readSheetNumber(p), null);
});

test("a page with no label word returns before grouping", () => {
  const items = densePage(30000).items.filter((i) => !/sheet|dwg|drawing/i.test(i.s));
  const ms = timings().noLabelMs;
  assert.equal(readSheetNumber({ W, H, items }), null);
  assert.ok(ms <= 5, `${ms.toFixed(1)} ms`);
});
