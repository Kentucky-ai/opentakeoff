// A stored PDF as something pdf.js can read by byte range (#580), not a
// whole-file buffer. A Blob the browser holds on disk (an IndexedDB record, a
// dropped File) costs nothing to hand around: opening it reads the
// cross-reference table and the pages asked for, so open time and memory
// follow what is on screen, not the size of the set. Posting it to a worker
// passes a handle, where posting bytes copied the file once per worker.
// No pdf.js import: the main bundle and the tile worker each pass their own.

export interface PdfSource {
  blob: Blob;
  /** The identity of the bytes: equal keys mean equal bytes, and the key
   * changes whenever the file's bytes do. A tile worker keeps one document
   * per key. */
  key: string;
}

export function isPdfSource(v: unknown): v is PdfSource {
  return !!v && typeof v === "object" && typeof Blob !== "undefined" && (v as PdfSource).blob instanceof Blob && typeof (v as PdfSource).key === "string";
}

/** pdf.js asks for ranges in multiples of this. A local read has no network
 * round trip to save, so the trade is between reading more than a page needs
 * and the count of reads (each one a trip through the event loop, and a
 * restart of the parse that was waiting on it). */
export const RANGE_CHUNK = 256 * 1024;

/** The getDocument() parameters that read `blob` by range. `Transport` is
 * pdf.js's PDFDataRangeTransport. Nothing is read ahead: with auto-fetch and
 * streaming on, pdf.js would pull the whole file in behind the first page. */
export function rangeParams<T extends { onDataRange(begin: number, chunk: Uint8Array): void }>(
  Transport: new (length: number, initialData: Uint8Array | null) => T,
  blob: Blob,
) {
  let aborted = false;
  const range = new Transport(blob.size, null);
  const read = (begin: number, end: number, retry: boolean) => {
    blob.slice(begin, end).arrayBuffer().then(
      (buf) => { if (!aborted) range.onDataRange(begin, new Uint8Array(buf)); },
      (err) => {
        if (aborted) return;
        if (retry) { read(begin, end, false); return; }
        // pdf.js has no error path for a range: the page waiting on it
        // stays blank. Say why, where someone will look.
        console.error(`[pdf] couldn't read bytes ${begin}-${end} of a stored PDF`, err);
      },
    );
  };
  // the two methods pdf.js calls on a transport, set on the instance: the
  // base class's own are a no-op request and an unimplemented abort
  Object.assign(range, {
    requestDataRange(begin: number, end: number) { read(begin, end, true); },
    abort() { aborted = true; },
  });
  return { range, length: blob.size, rangeChunkSize: RANGE_CHUNK, disableAutoFetch: true, disableStream: true };
}
