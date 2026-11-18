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
  doc.setProducer("OpenTakeoff");

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

  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const totalPages = doc.getPageCount();

  if (pageOrder.length !== totalPages) {
    throw new Error(
      `pageOrder length (${pageOrder.length}) must match document page count (${totalPages})`
    );
  }

  const seen = new Set<number>();
  for (const p of pageOrder) {
    if (p < 1 || p > totalPages || seen.has(p)) {
      throw new Error(`Invalid pageOrder: ${pageOrder.join(",")}`);
    }
    seen.add(p);
  }

  let isIdentity = true;
  for (let i = 0; i < totalPages; i++) {
    if (pageOrder[i] !== i + 1) {
      isIdentity = false;
      break;
    }
  }
  if (isIdentity) return pdfBytes;

  // In-place reordering on the same document:
  // Appends pages in the new desired order to the page tree, then removes the original pages.
  // Preserves document Catalog dictionary (/OCProperties / layers) verbatim.
  const originalPages = doc.getPages();
  for (const p of pageOrder) {
    doc.addPage(originalPages[p - 1]);
  }
  for (let i = 0; i < totalPages; i++) {
    doc.removePage(0);
  }
  doc.setProducer("OpenTakeoff");

  return await doc.save({ useObjectStreams: false });
}

/**
 * Delete a single page from a PDF document.
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
    throw new Error("Cannot delete the only page in a document");
  }

  if (pageNumber < 1 || pageNumber > totalPages) {
    throw new Error(`Page ${pageNumber} out of range (1..${totalPages})`);
  }

  doc.removePage(pageNumber - 1);
  doc.setProducer("OpenTakeoff");
  return await doc.save({ useObjectStreams: false });
}

/**
 * Extract specific pages into a new PDF document.
 * @param pdfBytes Raw PDF bytes
 * @param pageNumbers Array of 1-based page numbers to extract
 * @returns Extracted PDF bytes
 */
export async function extractPdfPages(
  pdfBytes: Uint8Array,
  pageNumbers: number[]
): Promise<Uint8Array> {
  if (!Array.isArray(pageNumbers) || pageNumbers.length === 0) {
    throw new Error("Must specify at least one page to extract");
  }

  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const totalPages = doc.getPageCount();

  for (const p of pageNumbers) {
    if (p < 1 || p > totalPages) {
      throw new Error(`Page ${p} out of range (1..${totalPages})`);
    }
  }

  // In-place extraction on source document:
  // Appends desired pages in order, then removes the original pages.
  // Preserves document Catalog (/OCProperties / layers) and document-level resources.
  const originalPages = doc.getPages();
  for (const p of pageNumbers) {
    doc.addPage(originalPages[p - 1]);
  }
  for (let i = 0; i < totalPages; i++) {
    doc.removePage(0);
  }
  doc.setProducer("OpenTakeoff");

  return await doc.save({ useObjectStreams: false });
}

/**
 * Merge multiple PDF documents into a single document.
 * Preserves Catalog dictionary and /OCProperties (layers).
 * @param pdfs Array of PDF byte arrays in order of concatenation
 * @returns Merged PDF bytes
 */
export async function mergePdfDocuments(
  pdfs: Uint8Array[]
): Promise<Uint8Array> {
  if (!Array.isArray(pdfs) || pdfs.length === 0) {
    throw new Error("Must provide at least one PDF to merge");
  }
  if (pdfs.length === 1) return pdfs[0];

  // Base the merged document on the first PDF so its Catalog, metadata,
  // and /OCProperties (layers) are preserved.
  const mergedDoc = await PDFDocument.load(pdfs[0], { updateMetadata: false });
  const { PDFName } = await import("pdf-lib");
  const ocPropsName = PDFName.of("OCProperties");

  for (let i = 1; i < pdfs.length; i++) {
    const srcDoc = await PDFDocument.load(pdfs[i], { updateMetadata: false });
    const indices = srcDoc.getPageIndices();
    const copiedPages = await mergedDoc.copyPages(srcDoc, indices);
    for (const p of copiedPages) {
      mergedDoc.addPage(p);
    }
    if (!mergedDoc.catalog.has(ocPropsName) && srcDoc.catalog.has(ocPropsName)) {
      const ocProp = srcDoc.catalog.get(ocPropsName);
      if (ocProp && typeof (ocProp as any).clone === "function") {
        mergedDoc.catalog.set(ocPropsName, (ocProp as any).clone(mergedDoc.context));
      }
    }
  }

  mergedDoc.setProducer("OpenTakeoff");
  return await mergedDoc.save({ useObjectStreams: false });
}

/**
 * Insert pages from source PDF into target PDF at a given page index.
 * @param targetBytes Target PDF bytes
 * @param sourceBytes Source PDF bytes to insert
 * @param insertAfterPage 1-based page index to insert after (0 = at start, targetPageCount = at end)
 * @returns Modified PDF bytes and number of pages inserted
 */
export async function insertPdfPages(
  targetBytes: Uint8Array,
  sourceBytes: Uint8Array,
  insertAfterPage: number
): Promise<{ pdfBytes: Uint8Array; insertedCount: number }> {
  const targetDoc = await PDFDocument.load(targetBytes, { updateMetadata: false });
  const sourceDoc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  const totalTarget = targetDoc.getPageCount();
  const insertIndex = Math.max(0, Math.min(totalTarget, insertAfterPage));

  const sourcePageIndices = Array.from({ length: sourceDoc.getPageCount() }, (_, i) => i);
  const copiedPages = await targetDoc.copyPages(sourceDoc, sourcePageIndices);

  for (let i = 0; i < copiedPages.length; i++) {
    targetDoc.insertPage(insertIndex + i, copiedPages[i]);
  }

  targetDoc.setProducer("OpenTakeoff");
  const pdfBytes = await targetDoc.save({ useObjectStreams: false });
  return { pdfBytes, insertedCount: copiedPages.length };
}
