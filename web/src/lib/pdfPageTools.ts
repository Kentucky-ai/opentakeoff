// PDF document page operations with pdf-lib (#578).
// Pure async functions operating on Uint8Array PDF bytes.
// Client-side execution in browser and node environments.

import { PDFDocument, degrees } from "pdf-lib";
import { normalizeAngle } from "./pageTransforms.ts";

/**
 * Rotate a single page in a PDF document by 90°, 180°, or 270° clockwise.
 * @param pdfBytes Raw PDF bytes
 * @param pageNumber 1-based page number
 * @param angle Clockwise angle: 90, 180, or 270
 * @returns Modified PDF bytes
 */
export async function rotatePdfPage(
  pdfBytes: Uint8Array,
  pageNumber: number,
  angle: number
): Promise<Uint8Array> {
  const normAngle = normalizeAngle(angle);
  if (normAngle === 0) return pdfBytes;

  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const totalPages = doc.getPageCount();
  if (pageNumber < 1 || pageNumber > totalPages) {
    throw new Error(`Page ${pageNumber} out of range (1..${totalPages})`);
  }

  const page = doc.getPage(pageNumber - 1);
  const currentAngle = page.getRotation().angle;
  const newAngle = ((currentAngle + normAngle) % 360 + 360) % 360;
  page.setRotation(degrees(newAngle));

  return await doc.save({ useObjectStreams: false });
}

/**
 * Reorder pages in a PDF document.
 * @param pdfBytes Raw PDF bytes
 * @param pageOrder Array of 1-based page numbers in the new desired order (e.g. [2, 1, 3])
 * @returns Modified PDF bytes
 */
export async function reorderPdfPages(
  pdfBytes: Uint8Array,
  pageOrder: number[]
): Promise<Uint8Array> {
  if (!Array.isArray(pageOrder) || pageOrder.length === 0) return pdfBytes;

  const srcDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const totalPages = srcDoc.getPageCount();

  if (pageOrder.length !== totalPages) {
    throw new Error(`pageOrder length (${pageOrder.length}) must match total pages (${totalPages})`);
  }

  const indices = pageOrder.map((p) => {
    if (p < 1 || p > totalPages) {
      throw new Error(`Invalid page number ${p} in pageOrder`);
    }
    return p - 1;
  });

  const destDoc = await PDFDocument.create();
  const copiedPages = await destDoc.copyPages(srcDoc, indices);
  for (const p of copiedPages) {
    destDoc.addPage(p);
  }

  return await destDoc.save({ useObjectStreams: false });
}

/**
 * Delete a page from a PDF document.
 * @param pdfBytes Raw PDF bytes
 * @param pageNumber 1-based page number to remove
 * @returns Modified PDF bytes
 */
export async function deletePdfPage(
  pdfBytes: Uint8Array,
  pageNumber: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const totalPages = doc.getPageCount();
  if (totalPages <= 1) {
    throw new Error("Cannot delete the only page in a PDF document");
  }
  if (pageNumber < 1 || pageNumber > totalPages) {
    throw new Error(`Page ${pageNumber} out of range (1..${totalPages})`);
  }

  doc.removePage(pageNumber - 1);
  return await doc.save({ useObjectStreams: false });
}

/**
 * Extract a subset of pages into a new PDF document.
 * @param pdfBytes Raw PDF bytes
 * @param pageNumbers Array of 1-based page numbers to extract
 * @returns New PDF bytes containing only the requested pages
 */
export async function extractPdfPages(
  pdfBytes: Uint8Array,
  pageNumbers: number[]
): Promise<Uint8Array> {
  if (!Array.isArray(pageNumbers) || pageNumbers.length === 0) {
    throw new Error("Must specify at least one page to extract");
  }

  const srcDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const totalPages = srcDoc.getPageCount();

  const indices = pageNumbers.map((p) => {
    if (p < 1 || p > totalPages) {
      throw new Error(`Page ${p} out of range (1..${totalPages})`);
    }
    return p - 1;
  });

  const destDoc = await PDFDocument.create();
  const copiedPages = await destDoc.copyPages(srcDoc, indices);
  for (const p of copiedPages) {
    destDoc.addPage(p);
  }

  return await destDoc.save({ useObjectStreams: false });
}

/**
 * Merge multiple PDF documents into a single document.
 * @param pdfs Array of PDF byte arrays in order of concatenation
 * @returns Merged PDF bytes
 */
export async function mergePdfDocuments(
  pdfs: Uint8Array[]
): Promise<Uint8Array> {
  if (!Array.isArray(pdfs) || pdfs.length === 0) {
    throw new Error("Must provide at least one PDF to merge");
  }

  const destDoc = await PDFDocument.create();

  for (const bytes of pdfs) {
    const srcDoc = await PDFDocument.load(bytes, { updateMetadata: false });
    const indices = srcDoc.getPageIndices();
    const copiedPages = await destDoc.copyPages(srcDoc, indices);
    for (const p of copiedPages) {
      destDoc.addPage(p);
    }
  }

  return await destDoc.save({ useObjectStreams: false });
}

