// A PDF's content hash as the OCR page cache's identity (#471), and the rule
// for which cached reads go when a local file is removed. No imports: the
// store (main bundle) uses this file, so it must not pull OCR code in.

/** sha256 of zero bytes. A detached or empty buffer hashes to this, so it is
 * never a PDF's identity: every file would share one cache slot. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Lowercase 64-hex sha256, and not the empty-input hash. */
export function isPdfHash(h: unknown): h is string {
  return typeof h === "string" && /^[0-9a-f]{64}$/.test(h) && h !== EMPTY_SHA256;
}

/** The meta-store key prefix of every cached OCR read (all PDFs). */
export const OCR_CACHE_ROOT = "ocr:v1:";

/** The meta-store key prefix of every cached OCR read of one PDF. */
export function ocrCachePrefix(hash: string): string {
  if (!isPdfHash(hash)) throw new TypeError("not a PDF sha256");
  return `${OCR_CACHE_ROOT}${hash}:`;
}

/** Start hashing `bytes` now and resolve its sha256 hex, or null when it can't
 * be one (no crypto.subtle outside a secure context, empty or detached bytes).
 * crypto.subtle.digest copies the bytes when it is called, so a caller can
 * hand the same buffer to pdf.js (which may detach it) right after. */
export function startPdfHash(bytes: ArrayBuffer | ArrayBufferView): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || !bytes || !bytes.byteLength) return Promise.resolve(null);
  let digest: Promise<ArrayBuffer>;
  try {
    digest = subtle.digest("SHA-256", bytes as Parameters<typeof subtle.digest>[1]);
  } catch {
    return Promise.resolve(null);
  }
  return digest.then((d) => {
    const hex = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
    return isPdfHash(hex) ? hex : null;
  }, () => null);
}

/** Which of a removed file's hashes (its current bytes and every revision)
 * lose their cached OCR reads: those no remaining file or revision carries.
 * Junk and duplicates in either list are ignored. */
export function ocrHashesToDrop(removed: Iterable<unknown>, remaining: Iterable<unknown>): string[] {
  const keep = new Set<string>();
  for (const h of remaining) if (isPdfHash(h)) keep.add(h);
  const out = new Set<string>();
  for (const h of removed) if (isPdfHash(h) && !keep.has(h)) out.add(h);
  return [...out];
}
