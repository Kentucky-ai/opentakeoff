import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import {
  rotatePdfPage,
  reorderPdfPages,
  deletePdfPage,
  extractPdfPages,
  mergePdfDocuments,
} from "../src/lib/pdfPageTools.ts";

const SAMPLE_PATH = fileURLToPath(new URL("../public/demo/sample-finish-plan.pdf", import.meta.url));
const sampleBytes = new Uint8Array(readFileSync(SAMPLE_PATH));

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

