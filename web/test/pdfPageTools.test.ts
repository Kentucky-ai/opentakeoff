import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName } from "pdf-lib";
import {
  rotatePdfPage,
  reorderPdfPages,
  deletePdfPage,
  extractPdfPages,
  mergePdfDocuments,
  insertPdfPages,
} from "../src/lib/pdfPageTools.ts";

const SAMPLE_PATH = fileURLToPath(new URL("../public/demo/sample-finish-plan.pdf", import.meta.url));
const sampleBytes = new Uint8Array(readFileSync(SAMPLE_PATH));

const LAYERED_PATH = fileURLToPath(new URL("../../mcp/test/fixtures/layered-plan.pdf", import.meta.url));
const layeredBytes = new Uint8Array(readFileSync(LAYERED_PATH));

test("rotatePdfPage: rotates page 1 and accumulates rotations", async () => {
  const origDoc = await PDFDocument.load(sampleBytes);
  const origRot = origDoc.getPage(0).getRotation().angle;

  const r90Bytes = await rotatePdfPage(sampleBytes, 1, 90);
  const doc90 = await PDFDocument.load(r90Bytes);
  assert.equal(doc90.getPage(0).getRotation().angle, (origRot + 90) % 360);

  const r180Bytes = await rotatePdfPage(r90Bytes, 1, 90);
  const doc180 = await PDFDocument.load(r180Bytes);
  assert.equal(doc180.getPage(0).getRotation().angle, (origRot + 180) % 360);

  const r270Bytes = await rotatePdfPage(r180Bytes, 1, 90);
  const doc270 = await PDFDocument.load(r270Bytes);
  assert.equal(doc270.getPage(0).getRotation().angle, (origRot + 270) % 360);

  const r360Bytes = await rotatePdfPage(r270Bytes, 1, 90);
  const doc360 = await PDFDocument.load(r360Bytes);
  assert.equal(doc360.getPage(0).getRotation().angle, origRot);
});

test("reorderPdfPages: swaps page order", async () => {
  const origDoc = await PDFDocument.load(sampleBytes);
  const count = origDoc.getPageCount();
  assert.equal(count, 2);

  const reorderedBytes = await reorderPdfPages(sampleBytes, [2, 1]);
  const doc = await PDFDocument.load(reorderedBytes);
  assert.equal(doc.getPageCount(), 2);
});

test("deletePdfPage: removes one page from a multi-page document", async () => {
  const deletedBytes = await deletePdfPage(sampleBytes, 2);
  const doc = await PDFDocument.load(deletedBytes);
  assert.equal(doc.getPageCount(), 1);
});

test("extractPdfPages: extracts specified pages into a new document", async () => {
  const extractedBytes = await extractPdfPages(sampleBytes, [2]);
  const doc = await PDFDocument.load(extractedBytes);
  assert.equal(doc.getPageCount(), 1);
});

test("mergePdfDocuments: combines two documents into one", async () => {
  const mergedBytes = await mergePdfDocuments([sampleBytes, sampleBytes]);
  const doc = await PDFDocument.load(mergedBytes);
  assert.equal(doc.getPageCount(), 4);
});

test("insertPdfPages: inserts pages after specified page index", async () => {
  const res = await insertPdfPages(sampleBytes, sampleBytes, 1);
  assert.equal(res.insertedCount, 2);
  const doc = await PDFDocument.load(res.pdfBytes);
  assert.equal(doc.getPageCount(), 4);
});

test("PDF layers (/OCProperties) are preserved across reorder, extract, delete, and merge", async () => {
  const ocProps = PDFName.of("OCProperties");
  const origDoc = await PDFDocument.load(layeredBytes);
  assert.ok(origDoc.catalog.has(ocProps), "layered fixture must have /OCProperties");

  // Create a 2-page layered document to test reorder and delete
  const p1 = origDoc.getPages()[0];
  origDoc.addPage(p1);
  const twoPageLayered = await origDoc.save();

  // 1. Reorder in-place preserves /OCProperties
  const reordered = await reorderPdfPages(twoPageLayered, [2, 1]);
  const docReordered = await PDFDocument.load(reordered);
  assert.equal(docReordered.getPageCount(), 2);
  assert.ok(docReordered.catalog.has(ocProps), "reorder must preserve /OCProperties");

  // 2. Extract in-place preserves /OCProperties
  const extracted = await extractPdfPages(twoPageLayered, [2]);
  const docExtracted = await PDFDocument.load(extracted);
  assert.equal(docExtracted.getPageCount(), 1);
  assert.ok(docExtracted.catalog.has(ocProps), "extract must preserve /OCProperties");

  // 3. Delete in-place preserves /OCProperties
  const deleted = await deletePdfPage(twoPageLayered, 2);
  const docDeleted = await PDFDocument.load(deleted);
  assert.equal(docDeleted.getPageCount(), 1);
  assert.ok(docDeleted.catalog.has(ocProps), "delete must preserve /OCProperties");

  // 4. Merge preserves /OCProperties
  const merged = await mergePdfDocuments([layeredBytes, sampleBytes]);
  const docMerged = await PDFDocument.load(merged);
  assert.equal(docMerged.getPageCount(), 3);
  assert.ok(docMerged.catalog.has(ocProps), "merge must preserve /OCProperties");
});
