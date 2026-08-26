// Multi-sheet image-markup export — a deterministic node integration test of the
// real buildMarkedSetPdf (no browser: mock pdf.js pages + a real source PDF). It
// proves image markups export to their OWN sheet's page across a multi-page set,
// that none is dropped, and that a rotated source page still gets its image (the
// rotated-sheet placement math itself is proven in markupImage.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarkedSetPdf } from "../src/lib/markedset.js";

const RS = 2.0; // RENDER_SCALE (web/src/lib/sheets.ts)
// a 1×1 PNG — enough for embedPng to produce a real image XObject
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// pdf.js-style viewport transform: rotate 0 → [s,0,0,-s,0,H·s]; a 90°-rotated page
// gets a swap-form transform so toPage carries rotation (exact pdf.js values don't
// matter here — only that the map is a valid, non-axis-aligned similarity).
function mockPage(wPt: number, hPt: number, rotate: number) {
  return {
    rotate,
    getViewport({ scale }: { scale: number }) {
      if (rotate === 90) return { width: hPt * scale, height: wPt * scale, transform: [0, scale, scale, 0, 0, 0] };
      return { width: wPt * scale, height: hPt * scale, transform: [scale, 0, 0, -scale, 0, hPt * scale] };
    },
  };
}

async function makeSourcePdf() {
  const { PDFDocument, degrees } = await import("pdf-lib");
  const src = await PDFDocument.create();
  src.addPage([612, 792]);                      // page 1 — upright
  const p2 = src.addPage([612, 792]);           // page 2 — rotated 90°
  p2.setRotation(degrees(90));
  return src.save();
}

async function imageXObjectsPerPage(bytes: Uint8Array): Promise<number[]> {
  // pdf-lib's low-level dict classes have protected constructors, so this walks
  // the resources with `any` casts rather than fighting the type-guards.
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const out = await PDFDocument.load(bytes);
  const imageName = String(PDFName.of("Image")); // "/Image"
  return out.getPages().map((page) => {
    const res: any = (page as any).node.Resources();
    const xobj: any = res && res.lookup(PDFName.of("XObject"));
    if (!xobj || typeof xobj.entries !== "function") return 0;
    let n = 0;
    for (const [, ref] of xobj.entries()) {
      const stream: any = out.context.lookup(ref);
      const sub = stream && stream.dict && stream.dict.lookup(PDFName.of("Subtype"));
      if (sub && String(sub) === imageName) n++;
    }
    return n;
  });
}

test("marked set: an image markup on each of two sheets exports to its own page (rotated included)", async () => {
  const srcBytes = await makeSourcePdf();
  const sheets = [
    { key: "S1", file: "plan.pdf", page: 1, label: "Sheet 1" },
    { key: "S2", file: "plan.pdf", page: 2, label: "Sheet 2 (rot 90)" },
  ];
  const markups = [
    { id: "mk1", type: "image", sheet_id: "S1", at: [0.5, 0.5], w: 0.3, aspect: 1, src: PNG },
    { id: "mk2", type: "image", sheet_id: "S2", at: [0.4, 0.6], w: 0.25, aspect: 1, src: PNG },
  ];
  const pages: Record<number, ReturnType<typeof mockPage>> = {
    1: mockPage(612, 792, 0),
    2: mockPage(612, 792, 90),
  };
  const { bytes } = await buildMarkedSetPdf({
    projectName: "Test", dark: false, units: "imperial",
    sheets, shapes: [], markups, approvals: [], rfis: [], conditions: [], company: undefined, clientInfo: undefined,
    getPage: async (_file: string, pageNum: number) => pages[pageNum],
    loadPdfData: async () => srcBytes,
  });

  const perPage = await imageXObjectsPerPage(bytes);
  // pages: [cover, sheet 1, sheet 2]
  assert.equal(perPage.length, 3, "cover + 2 sheet pages");
  assert.equal(perPage[0], 0, "cover carries no image markup");
  assert.equal(perPage[1], 1, "sheet 1 carries exactly its one image");
  assert.equal(perPage[2], 1, "sheet 2 (rotated) still carries its one image");
  assert.equal(perPage[1] + perPage[2], 2, "both images exported, none dropped or doubled");
});

test("marked set: an image on ONLY sheet 2 does not bleed onto sheet 1's page", async () => {
  const srcBytes = await makeSourcePdf();
  const sheets = [
    { key: "S1", file: "plan.pdf", page: 1, label: "Sheet 1" },
    { key: "S2", file: "plan.pdf", page: 2, label: "Sheet 2" },
  ];
  const markups = [{ id: "mk2", type: "image", sheet_id: "S2", at: [0.5, 0.5], w: 0.3, aspect: 1, src: PNG }];
  const pages: Record<number, ReturnType<typeof mockPage>> = { 1: mockPage(612, 792, 0), 2: mockPage(612, 792, 0) };
  const { bytes } = await buildMarkedSetPdf({
    projectName: "Test", dark: false, units: "imperial",
    sheets, shapes: [], markups, approvals: [], rfis: [], conditions: [], company: undefined, clientInfo: undefined,
    getPage: async (_file: string, pageNum: number) => pages[pageNum],
    loadPdfData: async () => srcBytes,
  });
  const perPage = await imageXObjectsPerPage(bytes);
  // only S2 has a markup, so S1 is not a "marked" sheet → pages: [cover, sheet 2]
  assert.equal(perPage.length, 2, "cover + only the one marked sheet");
  assert.equal(perPage[0], 0, "cover has no image");
  assert.equal(perPage[1], 1, "the single image lands on sheet 2's page only");
});

// ── source caption (task 2) ───────────────────────────────────────────────────
// The caption chip's on-screen POSITION has no node-test surface (SVG/React) —
// that's the named slice-5 live-verify check (a rotated-page marked-set export
// must show the caption glued to the image). What IS node-testable here, on
// this same real-buildMarkedSetPdf harness, is that the new caption code path
// (parseSheetKey/sheetBaseLabelFromKey/sourceCaption + the imageDrawParams-built
// rotated chip) runs to completion without throwing and without disturbing the
// image export — on the hardest case (a rotated source page) and on the
// suppression case (a stitch-key source).
test("marked set: a capture image with a caption on a ROTATED source page still exports its image", async () => {
  const srcBytes = await makeSourcePdf();
  const sheets = [
    { key: "S1", file: "plan.pdf", page: 1, label: "Sheet 1" },
    { key: "S2", file: "plan.pdf", page: 2, label: "Sheet 2 (rot 90)" },
  ];
  const markups = [
    // captured FROM sheet 1, PLACED on sheet 2 (the rotated page) — exercises
    // the rotated imageDrawParams path for both the image and its caption box.
    {
      id: "mk1", type: "image", sheet_id: "S2", at: [0.5, 0.5], w: 0.3, aspect: 1, src: PNG,
      source: "capture", source_label: true, src_sheet_id: "plan.pdf#1",
      src_rect: [[0.1, 0.1], [0.4, 0.4]],
    },
  ];
  const pages: Record<number, ReturnType<typeof mockPage>> = {
    1: mockPage(612, 792, 0),
    2: mockPage(612, 792, 90),
  };
  const { bytes } = await buildMarkedSetPdf({
    projectName: "Test", dark: false, units: "imperial",
    sheets, shapes: [], markups, approvals: [], rfis: [], conditions: [], company: undefined, clientInfo: undefined,
    getPage: async (_file: string, pageNum: number) => pages[pageNum],
    loadPdfData: async () => srcBytes,
  });
  const perPage = await imageXObjectsPerPage(bytes);
  assert.equal(perPage.length, 2, "cover + the one marked sheet (S2)");
  assert.equal(perPage[1], 1, "the image still embeds even though the caption chip also draws on this rotated page");
});

test("marked set: a capture image whose src_sheet_id is a STITCH key exports with the caption suppressed, no crash", async () => {
  const srcBytes = await makeSourcePdf();
  const sheets = [{ key: "S1", file: "plan.pdf", page: 1, label: "Sheet 1" }];
  const markups = [{
    id: "mk1", type: "image", sheet_id: "S1", at: [0.5, 0.5], w: 0.3, aspect: 1, src: PNG,
    source: "capture", source_label: true, src_sheet_id: "stitch:abc",
    src_rect: [[0.1, 0.1], [0.4, 0.4]],
  }];
  const pages: Record<number, ReturnType<typeof mockPage>> = { 1: mockPage(612, 792, 0) };
  const { bytes } = await buildMarkedSetPdf({
    projectName: "Test", dark: false, units: "imperial",
    sheets, shapes: [], markups, approvals: [], rfis: [], conditions: [], company: undefined, clientInfo: undefined,
    getPage: async (_file: string, pageNum: number) => pages[pageNum],
    loadPdfData: async () => srcBytes,
  });
  const perPage = await imageXObjectsPerPage(bytes);
  assert.equal(perPage.length, 2, "cover + the one marked sheet");
  assert.equal(perPage[1], 1, "the image still exports even though sheetBaseLabelFromKey suppresses a stitch-key caption");
});
