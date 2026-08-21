// Project archive (.otk) — the whole job as ONE portable file (#300).
//
// "Export takeoff…" (#285) deliberately writes the annotation record alone; the
// fair follow-up ask was a self-contained bundle that carries the plans too, so
// a job can be archived, moved to another machine, or handed to another
// estimator without hunting down the original PDFs. This is that bundle:
//
//   project.otk  =  zip {
//     opentakeoff.project.json   — versioned manifest + the EXACT autosave
//                                  payload (takeoff_canvas.v1, no export-only
//                                  shape), same document Export takeoff writes
//     plans/<file>.pdf           — every stored plan, bytes verbatim
//   }
//
// Plans are stored at compression level 0 — PDF streams are already deflated,
// so recompressing a 500 MB set buys nothing and costs the whole export wait.
// The manifest is tiny and compresses normally.
//
// Versioned by `schema`: readers refuse unknown MAJOR shapes loudly instead of
// half-loading them. Additive fields ride on the manifest without a bump, the
// same convention as the annotations payload itself.
//
// fflate is imported on demand (the ingest precedent) so the archive machinery
// never weighs down the initial page load.

const MANIFEST_NAME = "opentakeoff.project.json";
const ARCHIVE_SCHEMA = "opentakeoff.project_archive.v1";
const PLANS_DIR = "plans/";

// The same hostile-archive budgets as ingest.js — a .otk is still a zip a
// browser tab has to inflate. Sizes read from the central directory (see
// ingest.js's unzipBytes comment for why that bounds a real bomb).
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_ENTRIES = 10_000;

export function isProjectArchive(name) {
  return /\.otk$/i.test(name || "");
}

/**
 * Pack the current project into .otk bytes.
 * @param {{
 *   takeoff: object,                          // { schema, ...buildPayload() } — written verbatim
 *   sheets: { name: string }[],               // the working set (store.listSheets shape)
 *   loadPdfData: (name: string) => Promise<Uint8Array>,
 *   projectName?: string,
 *   onProgress?: (msg: string) => void,
 * }} opts
 * @returns {Promise<Uint8Array>}
 */
export async function buildProjectArchive({ takeoff, sheets, loadPdfData, projectName, onProgress }) {
  const { zip, strToU8 } = await import("fflate");
  const entries = {};
  const packed = [];
  for (const s of sheets) {
    onProgress?.(`Packing ${s.name}…`);
    const bytes = await loadPdfData(s.name);
    entries[PLANS_DIR + s.name] = [bytes, { level: 0 }];
    packed.push(s.name);
  }
  const manifest = {
    schema: ARCHIVE_SCHEMA,
    app: "opentakeoff",
    created: new Date().toISOString(),
    ...(projectName ? { project_name: projectName } : {}),
    plans: packed,
    takeoff,
  };
  entries[MANIFEST_NAME] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];
  onProgress?.("Writing archive…");
  return new Promise((resolve, reject) => zip(entries, {}, (err, data) => (err ? reject(err) : resolve(data))));
}

/**
 * Read .otk bytes back into { takeoff, pdfs, projectName }. Throws a
 * "Couldn't open project…" error (the sticky-danger copy convention) on
 * anything that isn't a well-formed v1 archive.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ takeoff: object, pdfs: File[], projectName: string }>}
 */
export async function parseProjectArchive(bytes) {
  const { unzip, strFromU8 } = await import("fflate");
  const budget = { bytes: MAX_TOTAL_BYTES, entries: MAX_TOTAL_ENTRIES };
  const entries = await new Promise((resolve, reject) => {
    unzip(bytes, {
      filter: (f) => {
        if (budget.entries <= 0) return false;
        const size = f.originalSize || 0;
        if (size > budget.bytes) return false;
        budget.bytes -= size;
        budget.entries -= 1;
        return f.name === MANIFEST_NAME || (f.name.startsWith(PLANS_DIR) && /\.pdf$/i.test(f.name));
      },
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });
  const raw = entries[MANIFEST_NAME];
  if (!raw) throw new Error(`Couldn't open project: no ${MANIFEST_NAME} inside — this isn't an OpenTakeoff project archive.`);
  let manifest;
  try { manifest = JSON.parse(strFromU8(raw)); }
  catch { throw new Error("Couldn't open project: the archive's manifest isn't valid JSON."); }
  if (manifest?.schema !== ARCHIVE_SCHEMA) {
    // refuse loudly rather than half-load: a FUTURE major shape may relocate
    // load-bearing data, and "opened but empty" is worse than a clear refusal
    throw new Error(`Couldn't open project: archive version "${manifest?.schema || "unknown"}" — this build reads ${ARCHIVE_SCHEMA}. Update OpenTakeoff and try again.`);
  }
  const takeoff = manifest.takeoff;
  if (!takeoff || typeof takeoff !== "object" || Array.isArray(takeoff)) {
    throw new Error("Couldn't open project: the archive carries no takeoff document.");
  }
  const pdfs = Object.entries(entries)
    .filter(([path]) => path.startsWith(PLANS_DIR))
    .map(([path, data]) => new File([data], path.slice(PLANS_DIR.length), { type: "application/pdf" }))
    .filter((f) => f.name);
  return { takeoff, pdfs, projectName: typeof manifest.project_name === "string" ? manifest.project_name : "" };
}

/** Browser download of archive bytes (the downloadText pattern, binary-safe). */
export function downloadArchive(filename, bytes) {
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
