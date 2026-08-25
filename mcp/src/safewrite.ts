// Don't silently destroy a file this server didn't write.
//
// The export path is deliberately unconstrained, and it stays that way: writing
// the marked set into the estimator's job folder IS the job, so confining these
// tools to the working directory would break the deliverable they exist to
// produce. What was never intended is losing an unrelated file because an agent
// picked a path that was already taken — nothing about "export the takeoff"
// implies "and destroy whatever is sitting there."
//
// So the line is drawn at authorship, not location: re-exporting over our OWN
// prior output overwrites silently, because that loop runs constantly (fix a
// condition, export again, same path). Anything else is refused until the caller
// says overwrite: true, which makes the destruction an explicit instruction
// instead of a side effect. An agent that genuinely means to replace a file can
// still do it in one call; one that fat-fingered a path gets told.
import { open, stat } from "node:fs/promises";
import { UserError } from "./format.ts";

/** Stamped as the PDF Producer on every marked set (web/src/lib/markedset.js),
 * which is what makes a prior marked set recognizable as ours here. Also plain
 * provenance: a distributed deliverable should say what produced it. */
export const PDF_PRODUCER = "OpenTakeoff";

export type ExportKind = "json" | "pdf" | "dxf";

/** First `n` bytes, without reading a large export into memory to look at its head. */
async function head(p: string, n: number): Promise<Buffer> {
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Is this an earlier export of ours? Unreadable, corrupt, or encrypted counts
 * as NO — an unknown file is exactly the thing worth protecting. */
async function isOwnExport(outPath: string, kind: ExportKind): Promise<boolean> {
  try {
    if (kind === "json") {
      // Both payloads stamp their schema as the first key, so the head is enough:
      // {"schema":"opentakeoff.takeoff_canvas.v1",…} / {"schema":"opentakeoff.report.v1",…}
      return /"schema"\s*:\s*"opentakeoff\./.test((await head(outPath, 4096)).toString("utf8"));
    }
    if (kind === "dxf") {
      // dxf.ts writes its authorship stamp as the very first comment group:
      // 999\nOpenTakeoff DXF export — …
      return /^999\r?\nOpenTakeoff DXF export/.test((await head(outPath, 64)).toString("utf8"));
    }
    if ((await head(outPath, 5)).toString("latin1") !== "%PDF-") return false;
    const { readFile } = await import("node:fs/promises");
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await readFile(outPath), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    return (doc.getProducer() ?? "").includes(PDF_PRODUCER);
  } catch {
    return false;
  }
}

/** Throws unless `outPath` is safe to write: absent, an earlier export of ours,
 * or explicitly consented to. */
export async function assertWritable(
  outPath: string,
  kind: ExportKind,
  overwrite?: boolean,
): Promise<void> {
  if (overwrite === true) return;
  let st;
  try {
    st = await stat(outPath);
  } catch {
    return; // nothing there — the ordinary case
  }
  if (st.isDirectory()) {
    throw new UserError(`${outPath} is a directory — pass the full file path to write, not the folder.`);
  }
  if (await isOwnExport(outPath, kind)) return;
  throw new UserError(
    `${outPath} already exists and is not an OpenTakeoff export, so writing there would destroy it. `
      + `Write somewhere else, or pass overwrite: true if replacing that exact file is what you mean to do.`,
  );
}

/** The one-line description the three export tools share for their overwrite flag. */
export const OVERWRITE_DESC =
  "Replace the file at path even when it is not an OpenTakeoff export. Off by default: "
  + "re-exporting over a previous export of your own already overwrites without this, so you only "
  + "need it to deliberately destroy an unrelated file.";
