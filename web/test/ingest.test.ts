// Ingest guardrails — the zip-bomb / nested-archive caps in lib/ingest.js, plus
// the image→PDF wrap. Real archives are built with fflate's zipSync so the caps
// run against genuine zip headers (originalSize, nesting) rather than mocks, and
// the image cases use real PNG bytes through pdf-lib's embedPng. Only the
// webp/gif/bmp branch is browser-only (createImageBitmap/canvas) and untested
// here; everything below stays DOM-free and node-runnable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { PDFDocument, PDFName } from "pdf-lib";
import { ingestFiles } from "../src/lib/ingest.js";

const enc = new TextEncoder();
const pdfBytes = (n = 1) => enc.encode("%PDF-1.4\n" + "x".repeat(n));
const zipFile = (name: string, tree: Record<string, Uint8Array>) =>
  new File([zipSync(tree)], name, { type: "application/zip" });

// 2x2 checkerboards, hand-encoded so no fixture file is needed: one opaque
// (color type 2, the shape a plan scan takes) and one with alpha (color type 6,
// what a screenshot takes) — the alpha case makes pdf-lib emit a second /Image
// XObject as the SMask.
const OPAQUE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNgYGD4//8/GDMwAAAp5AX71ZPZmwAAAABJRU5ErkJggg==";
const ALPHA_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAF0lEQVR4nGNgYGBo+P///38GMMHA0AAAT0oI+QstIkIAAAAASUVORK5CYII=";
const pngFile = (b64: string, name: string) =>
  new File([Buffer.from(b64, "base64")], name, { type: "image/png" });

/** Every /Image XObject in a saved PDF, as [ColorSpace, Interpolate] pairs. */
async function imageXObjects(file: File) {
  const doc = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
  const out: { cs: string; interpolate: string | undefined }[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = (obj as { dict?: { get(k: unknown): { toString(): string } | undefined } }).dict;
    if (!dict || dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
    out.push({
      cs: dict.get(PDFName.of("ColorSpace"))?.toString() ?? "",
      interpolate: dict.get(PDFName.of("Interpolate"))?.toString(),
    });
  }
  return out;
}

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

test("an ingested image becomes a .pdf sized in pixels-as-points", async () => {
  const { pdfs, skipped } = await ingestFiles([pngFile(OPAQUE_PNG, "finishplan-17.png")]);
  assert.equal(skipped.length, 0);
  assert.equal(pdfs[0].name, "finishplan-17.pdf");
  const doc = await PDFDocument.load(new Uint8Array(await pdfs[0].arrayBuffer()));
  assert.deepEqual(doc.getPage(0).getSize(), { width: 2, height: 2 });
});

test("an ingested image carries /Interpolate true so deep zoom stays smooth", async () => {
  // Without the flag pdf.js turns image smoothing OFF once the draw transform's
  // scale passes dpr * 96/72 (~2.67x on retina), so a wrapped scan snaps to hard
  // nearest-neighbor blocks exactly where an estimator is deciding a boundary.
  const { pdfs } = await ingestFiles([pngFile(OPAQUE_PNG, "scan.png")]);
  assert.deepEqual(await imageXObjects(pdfs[0]), [{ cs: "/DeviceRGB", interpolate: "true" }]);
});

test("only the drawn image needs the flag — an alpha PNG's SMask is not drawn on its own", async () => {
  // pdf.js reads Interpolate off the MAIN image dict and folds the SMask into
  // that image's alpha before one composed draw, so the mask never carries it.
  // Asserted rather than assumed: it's the reason this doesn't walk /SMask.
  const { pdfs } = await ingestFiles([pngFile(ALPHA_PNG, "shot.png")]);
  assert.deepEqual(await imageXObjects(pdfs[0]), [
    { cs: "/DeviceRGB", interpolate: "true" },
    { cs: "/DeviceGray", interpolate: undefined },
  ]);
});
