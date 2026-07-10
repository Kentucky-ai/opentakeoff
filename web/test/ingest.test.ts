// Ingest guardrails — the zip-bomb / nested-archive caps in lib/ingest.js.
// Real archives are built with fflate's zipSync so the caps run against genuine
// zip headers (originalSize, nesting) rather than mocks. The image→PDF path is
// browser-only (createImageBitmap/canvas) and deliberately untouched here; every
// case uses PDF entries so the test stays DOM-free and node-runnable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { ingestFiles } from "../src/lib/ingest.js";

const enc = new TextEncoder();
const pdfBytes = (n = 1) => enc.encode("%PDF-1.4\n" + "x".repeat(n));
const zipFile = (name: string, tree: Record<string, Uint8Array>) =>
  new File([zipSync(tree)], name, { type: "application/zip" });

test("a plain zip of PDFs extracts them all", async () => {
  const zip = zipFile("plans.zip", { "A1.pdf": pdfBytes(), "A2.pdf": pdfBytes() });
  const { pdfs, skipped } = await ingestFiles([zip]);
  assert.deepEqual(pdfs.map((f) => f.name).sort(), ["A1.pdf", "A2.pdf"]);
  assert.equal(skipped.length, 0);
});

test("nested zips are refused past the depth cap instead of recursing forever", async () => {
  // outer.zip → inner.zip → A1.pdf. With maxZipDepth:1 the outer unzips (depth 0)
  // but inner (depth 1) is refused, so A1.pdf never surfaces and we don't loop.
  const inner = zipSync({ "A1.pdf": pdfBytes() });
  const outer = zipFile("outer.zip", { "inner.zip": inner });
  const { pdfs, skipped } = await ingestFiles([outer], { maxZipDepth: 1 });
  assert.equal(pdfs.length, 0);
  assert.ok(skipped.some((s) => s.name === "inner.zip" && s.reason === "nested too deep"));
});

test("nested zips within the depth cap still extract their contents", async () => {
  const inner = zipSync({ "A1.pdf": pdfBytes() });
  const outer = zipFile("outer.zip", { "inner.zip": inner });
  const { pdfs } = await ingestFiles([outer], { maxZipDepth: 2 });
  assert.deepEqual(pdfs.map((f) => f.name), ["A1.pdf"]);
});

test("an entry whose declared size exceeds the byte budget is refused (zip-bomb guard)", async () => {
  // fflate reads originalSize from the central directory and caps the entry's
  // output buffer to it, so refusing on declared size is what bounds a real bomb.
  const zip = zipFile("bomb.zip", { "huge.pdf": pdfBytes(200) });
  const { pdfs, skipped } = await ingestFiles([zip], { maxTotalBytes: 100 });
  assert.equal(pdfs.length, 0);
  assert.ok(skipped.some((s) => s.name === "huge.pdf" && s.reason === "archive too large"));
});

test("the entry-count cap bounds a zip of many tiny files", async () => {
  // Five 1-byte PDFs, budget of three entries. The byte cap alone would never
  // fire (they're tiny), so this exercises the separate entry-count guard — the
  // defense against an archive of countless empty files wedging the tab.
  const tree: Record<string, Uint8Array> = {};
  for (let i = 0; i < 5; i++) tree[`A${i}.pdf`] = pdfBytes(1);
  const { pdfs, skipped } = await ingestFiles([zipFile("many.zip", tree)], { maxTotalEntries: 3 });
  assert.equal(pdfs.length, 3);
  assert.ok(skipped.some((s) => s.reason === "too many files"));
});

test("the byte budget is shared across sibling entries in one ingest", async () => {
  // Two 80-byte PDFs, 120-byte budget: the first fits (budget → 40), the second
  // (80 > 40) is refused. Proves the budget accumulates rather than resetting.
  const zip = zipFile("two.zip", { "A1.pdf": pdfBytes(80), "A2.pdf": pdfBytes(80) });
  const { pdfs, skipped } = await ingestFiles([zip], { maxTotalBytes: 120 });
  assert.equal(pdfs.length, 1);
  assert.ok(skipped.some((s) => s.reason === "archive too large"));
});
