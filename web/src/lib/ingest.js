// File ingest — turn anything a contractor drops (a plan PDF, a scan or
// screenshot image, or a .zip plan set straight off a bid platform) into the
// PDF "sheets" the canvas already knows how to render.
//
// Everything happens in the browser: zips are unpacked and images are wrapped
// into a one-page PDF locally — nothing is uploaded. Because every input becomes
// a PDF, the rest of the app (sheets, scale, One-Click, render) is unchanged.
//
//   ingestFiles(fileList, { onProgress }) -> { pdfs: File[], skipped: [{name, reason}] }
//
// The returned File objects are all application/pdf, ready for store.addPdf().
// fflate (unzip) and pdf-lib (image→PDF) are loaded on demand — only when a user
// actually drops a zip or image — so they never weigh down the initial page load.

const PDF_EXT = /\.pdf$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const ZIP_EXT = /\.zip$/i;

// Guardrails against hostile archives (zip bombs and self-nesting "zip quines").
// Everything here runs in the user's browser tab, so an unbounded archive is a
// local denial-of-service — a wedged or OOM-killed tab. Three caps bound one
// ingest: recursion depth into nested zips, total decompressed bytes, and total
// entries expanded. The entry cap catches what the byte cap can't — an archive
// of millions of tiny or zero-byte files drains no byte budget but still wedges
// the tab on sheer iteration. Past any limit an entry is reported as skipped.
// All three are overridable via ingestFiles opts so the caps are cheap to test.
const MAX_ZIP_DEPTH = 8;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB of decompressed output
const MAX_TOTAL_ENTRIES = 10_000;               // files expanded across one ingest

const isPdf = (name, type = "") => PDF_EXT.test(name) || type === "application/pdf";
const isImage = (name, type = "") => IMAGE_EXT.test(name) || (type || "").startsWith("image/");
const isZip = (name, type = "") => ZIP_EXT.test(name) || /zip/i.test(type);

const baseName = (path) => path.split("/").pop() || path;

// macOS / Windows archive cruft and hidden files inside zips
const isJunk = (path) =>
  path.endsWith("/") ||
  /(^|\/)__MACOSX\//.test(path) ||
  /(^|\/)\._/.test(path) ||
  /(^|\/)\.DS_Store$/i.test(path) ||
  /(^|\/)Thumbs\.db$/i.test(path);

// First-bytes sniff so a mislabeled or extension-less zip still works (PK\x03\x04).
async function looksLikeZip(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } catch { return false; }
}

// Decompress only the entries we can use (saves memory on big plan sets); report
// anything else as skipped via onSkip rather than silently dropping it.
//
// `budget` tracks the decompressed bytes AND the entry count still allowed for
// this whole ingest. fflate runs the filter per entry, reading originalSize from
// the zip's CENTRAL DIRECTORY (authoritative even for data-descriptor entries
// whose local header declares 0), and caps each entry's output buffer to that
// declared size. So refusing an entry whose declared size blows the budget is
// what stops a real zip bomb — which must declare its true size to inflate to
// it. A dishonest header that UNDER-declares can't OOM either: fflate clamps the
// output to the declared size, yielding a truncated file, not a runaway alloc.
// The entry-count half covers what bytes can't: an archive of countless tiny or
// zero-byte files, each of which passes the byte check but drowns us in work.
async function unzipBytes(bytes, onSkip, budget) {
  const { unzip } = await import("fflate");
  return new Promise((resolve, reject) => {
    unzip(bytes, {
      filter: (f) => {
        if (isJunk(f.name)) return false;
        const bn = baseName(f.name);
        if (!(isPdf(bn) || isImage(bn) || isZip(bn))) { onSkip?.(bn, "unsupported type"); return false; }
        if (budget.entries <= 0) { onSkip?.(bn, "too many files"); return false; }
        const size = f.originalSize || 0;
        if (size > budget.bytes) { onSkip?.(bn, "archive too large"); return false; }
        budget.bytes -= size;
        budget.entries -= 1;
        return true;
      },
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// Wrap a raster image into a single-page PDF at its native pixel size so it flows
// through the same pdf.js path as a real plan. JPG/PNG embed directly; webp/gif/
// bmp are decoded by the browser and re-encoded as PNG.
async function imageToPdf(file) {
  const { PDFDocument } = await import("pdf-lib");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await PDFDocument.create();
  let img, w, h;
  if (/\.jpe?g$/i.test(file.name) || file.type === "image/jpeg") {
    img = await doc.embedJpg(bytes); w = img.width; h = img.height;
  } else if (/\.png$/i.test(file.name) || file.type === "image/png") {
    img = await doc.embedPng(bytes); w = img.width; h = img.height;
  } else {
    const bmp = await createImageBitmap(new Blob([bytes], { type: file.type || "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    img = await doc.embedPng(new Uint8Array(await blob.arrayBuffer())); w = bmp.width; h = bmp.height;
  }
  doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  const name = baseName(file.name).replace(IMAGE_EXT, "") + ".pdf";
  return new File([await doc.save()], name, { type: "application/pdf" });
}

export async function ingestFiles(
  fileList,
  {
    onProgress,
    maxZipDepth = MAX_ZIP_DEPTH,
    maxTotalBytes = MAX_TOTAL_BYTES,
    maxTotalEntries = MAX_TOTAL_ENTRIES,
  } = {},
) {
  const incoming = Array.from(fileList || []);
  const pdfs = [];
  const skipped = [];
  const used = new Set();
  // Shared across every (possibly nested) archive in this ingest, so a bomb
  // split over many entries or sibling zips still hits one combined ceiling.
  const budget = { bytes: maxTotalBytes, entries: maxTotalEntries };

  // store keys by name; de-dupe within the batch so two "A1.pdf" from different
  // zip folders don't overwrite each other
  const uniqueName = (name) => {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = name, i = 2;
    while (used.has(n.toLowerCase())) n = `${stem} (${i++})${ext}`;
    used.add(n.toLowerCase());
    return n;
  };
  const pushPdf = (file) => {
    const name = uniqueName(file.name);
    pdfs.push(name === file.name ? file : new File([file], name, { type: "application/pdf" }));
  };

  async function process(file, depth) {
    const name = file.name || "file";
    try {
      if (isPdf(name, file.type)) { pushPdf(file); return; }
      if (isImage(name, file.type)) { onProgress?.(`Converting ${baseName(name)}…`); pushPdf(await imageToPdf(file)); return; }
      if (isZip(name, file.type) || (await looksLikeZip(file))) {
        // Stop runaway recursion from self-nesting archives before we even read
        // the bytes — a zip that contains itself would otherwise loop forever.
        if (depth >= maxZipDepth) { skipped.push({ name: baseName(name), reason: "nested too deep" }); return; }
        onProgress?.(`Unzipping ${baseName(name)}…`);
        const entries = await unzipBytes(new Uint8Array(await file.arrayBuffer()),
          (bn, reason) => skipped.push({ name: bn, reason }), budget);
        const paths = Object.keys(entries);
        if (!paths.length) { skipped.push({ name: baseName(name), reason: "no plans found in zip" }); return; }
        for (const path of paths) {
          const bn = baseName(path);
          if (isPdf(bn)) pushPdf(new File([entries[path]], bn, { type: "application/pdf" }));
          else if (isImage(bn)) { onProgress?.(`Converting ${bn}…`); pushPdf(await imageToPdf(new File([entries[path]], bn))); }
          else if (isZip(bn)) await process(new File([entries[path]], bn, { type: "application/zip" }), depth + 1);
        }
        return;
      }
      skipped.push({ name: baseName(name), reason: "unsupported type" });
    } catch (e) {
      skipped.push({ name: baseName(name), reason: (e && e.message) || "couldn't read" });
    }
  }

  for (const f of incoming) await process(f, 0);
  return { pdfs, skipped };
}
