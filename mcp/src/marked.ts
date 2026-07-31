// export_marked_pdf — the deliverable half of a takeoff. A construction
// takeoff is reviewed on marked-up drawings, not on a numbers report, so this
// writes the planset with the committed work burned in: vector copies of the
// source sheets carrying condition-colored shapes, hatch linework, per-shape
// quantity chips, and annotations, plus a legend cover — built by the SAME
// module the canvas's MARKED SET button uses (web/src/lib/markedset.js), one
// implementation for both surfaces.
//
// Light mode only, deliberately: light pages are pdf-lib vector copies of the
// source, so this tool needs no raster and runs even where view_sheet's
// optional @napi-rs/canvas never installed. (Dark mode is the one markedset.js
// path that touches the DOM — it stays a canvas feature.)
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { buildMarkedSetPdf as buildMarkedSetPdfJs } from "../../web/src/lib/markedset.js";
import { RENDER_SCALE } from "../../web/src/lib/sheets.ts";
import { UserError } from "./format.ts";
import type { Session } from "./session.ts";

// The builder is untyped canvas JS; tsc infers parameter types from its
// destructuring DEFAULTS (credit = null ⇒ "null only"), so a typed facade at
// the boundary states the real contract instead of the inferred one.
const buildMarkedSetPdf = buildMarkedSetPdfJs as unknown as
  (opts: Record<string, unknown>) => Promise<{ bytes: Uint8Array; filename: string }>;

export interface MarkedPdfOpts {
  path?: string;
  project_name?: string;
}

export async function exportMarkedPdf(session: Session, opts: MarkedPdfOpts) {
  const { file, filePath } = session;
  if (!file || !filePath) throw new UserError("No plan loaded — call load_plan first.");
  if (!session.shapes.length && !session.markups.length) {
    throw new UserError("Nothing to mark yet — commit shapes (one_click / detect_rooms / measure_polygon / measure_line with a condition) or annotate before exporting the marked set.");
  }

  const sheetStates = session.sheetList();
  const byPage = new Map(sheetStates.map((s) => [s.pageNum, s.page]));
  const sheets = sheetStates.map((s) => ({
    key: s.key,
    file,
    page: s.pageNum,
    label: s.sheetNumber ? `${s.sheetNumber} · p${s.pageNum}` : s.key,
  }));

  // markedset.js speaks pdf.js pages; serve it a shim over the PageHandle. The
  // stored viewport is at RENDER_SCALE and every entry of a pdf.js viewport
  // transform is linear in scale, so any requested scale is a plain rescale.
  const getPage = async (_file: string, pageNum: number) => {
    const ph = byPage.get(pageNum);
    if (!ph) throw new UserError(`No page ${pageNum} in the loaded plan.`);
    return {
      rotate: ph.rotate,
      getViewport: ({ scale }: { scale: number }) => {
        const k = scale / RENDER_SCALE;
        const [a, b, c, d, e, f] = ph.viewport.transform;
        return { width: ph.viewport.width * k, height: ph.viewport.height * k, transform: [a * k, b * k, c * k, d * k, e * k, f * k] };
      },
    };
  };
  // one source file per session; read once, share across page copies
  let srcBytes: Uint8Array | null = null;
  const loadPdfData = async () => (srcBytes ??= new Uint8Array(await readFile(filePath)));

  const base = file.replace(/\.pdf$/i, "");
  // truth-in-provenance: everything this server commits is reviewed:false, and
  // the marked set draws shapes in full condition colors — so the document
  // itself must say a machine traced it and a human hasn't signed off yet.
  const machine = session.shapes.filter((s) => s.origin?.reviewed !== true).length;
  const credit = machine
    ? `Machine-traced via OpenTakeoff MCP — ${machine} shape${machine === 1 ? "" : "s"} pending human review`
    : null;

  const { bytes } = await buildMarkedSetPdf({
    projectName: opts.project_name || base,
    dark: false,
    units: "imperial",
    sheets,
    shapes: session.shapes,
    markups: session.markups,
    rfis: [],
    conditions: session.conditions,
    getPage,
    loadPdfData,
    credit,
    coverTitle: "OpenTakeoff · Marked Set",
  });

  const outPath = path.resolve(opts.path ?? path.join(path.dirname(filePath), `${base} - marked set.pdf`));
  await writeFile(outPath, bytes);

  const markedKeys = new Set([...session.shapes.map((s) => s.sheet_id), ...session.markups.map((m) => m.sheet_id)]);
  return {
    path: outPath,
    pages: 1 + markedKeys.size,
    sheets_marked: markedKeys.size,
    shapes_drawn: session.shapes.length,
    annotations_drawn: session.markups.length,
    note: "The takeoff burned into the plan sheets, with a legend cover — hand this to the user to review. To revise in the app, import the export_takeoff payload; agent shapes arrive as pencil proposals there until accepted.",
  };
}
