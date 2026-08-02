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
import { pointInPoly } from "../../web/src/lib/geometry.js";
import { RENDER_SCALE } from "../../web/src/lib/sheets.ts";
import { UserError } from "./format.ts";
import type { Session, Shape } from "./session.ts";

/** The cover's assignment-provenance line (0.9.18): where the finish tags on
 * this document came from — schedule-resolved vs agent-asserted vs pending
 * human review — plus the rooms the last assign run withheld. Pure and
 * unit-testable: shapes + withheld in, string (or null) out, no PDF parsing.
 * Null for an all-human takeoff: the canvas path stays byte-identical.
 *
 * The staleness drop: a withheld room whose seed now falls inside a committed
 * area shape was answered by hand after the sweep — the cover must never
 * claim a room is withheld after the agent (or a human import) committed it.
 * Seeds and rings compare in verts_norm space (both normalized to sheet dims). */
export function assignmentDisclosure(
  shapes: Shape[],
  withheld: { sheet_id: string; seed_norm: [number, number] }[] = [],
): string | null {
  const agent = shapes.filter((s) => s.origin?.actor === "agent");
  const live = withheld.filter((w) => !shapes.some((s) =>
    s.sheet_id === w.sheet_id
    && (s.measure_role === "floor_area" || s.measure_role === "deduct")
    && s.verts_norm.length >= 3
    && pointInPoly(w.seed_norm[0], w.seed_norm[1], s.verts_norm)));
  if (!agent.length && !live.length) return null;
  const schedule = agent.filter((s) => s.origin?.assignment?.source === "schedule").length;
  const asserted = agent.filter((s) => s.origin?.assignment?.source === "asserted").length;
  const pending = agent.filter((s) => s.origin?.reviewed !== true).length;
  const parts: string[] = [];
  if (schedule) parts.push(`${schedule} schedule-resolved`);
  if (asserted) parts.push(`${asserted} agent-asserted`);
  if (pending) parts.push(`${pending} pending human review`);
  if (live.length) parts.push(`${live.length} room${live.length === 1 ? "" : "s"} withheld, unresolved against the schedule`);
  return parts.length ? `Finish assignment: ${parts.join(" · ")}` : null;
}

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
  // a sheet carrying only an approval mark still exports (markedset.js's own
  // rule — a seal is work on paper), so verdicts count toward "anything to mark"
  if (!session.shapes.length && !session.markups.length && !session.approvals.length) {
    throw new UserError("Nothing to mark yet — commit shapes (one_click / detect_rooms / measure_polygon / measure_line with a condition) or annotate before exporting the marked set.");
  }

  const sheetStates = session.sheetList();
  // #152: the working set can span documents — pages resolve per (file, page)
  const byFilePage = new Map(sheetStates.map((s) => [`${session.fileFor(s.key)}#${s.pageNum}`, s.page]));
  const sheets = sheetStates.map((s) => ({
    key: s.key,
    file: session.fileFor(s.key),
    page: s.pageNum,
    label: s.sheetNumber ? `${s.sheetNumber} · p${s.pageNum}` : s.key,
  }));

  // markedset.js speaks pdf.js pages; serve it a shim over the PageHandle. The
  // stored viewport is at RENDER_SCALE and every entry of a pdf.js viewport
  // transform is linear in scale, so any requested scale is a plain rescale.
  const getPage = async (srcFile: string, pageNum: number) => {
    const ph = byFilePage.get(`${srcFile}#${pageNum}`);
    if (!ph) throw new UserError(`No page ${pageNum} of ${srcFile} in the working set.`);
    return {
      rotate: ph.rotate,
      getViewport: ({ scale }: { scale: number }) => {
        const k = scale / RENDER_SCALE;
        const [a, b, c, d, e, f] = ph.viewport.transform;
        return { width: ph.viewport.width * k, height: ph.viewport.height * k, transform: [a * k, b * k, c * k, d * k, e * k, f * k] };
      },
    };
  };
  // bytes per source file (#152: a merged set has several), read once each
  const srcBytes = new Map<string, Uint8Array>();
  const loadPdfData = async (srcFile: string) => {
    let bytes = srcBytes.get(srcFile);
    if (!bytes) {
      const p = session.pathFor(srcFile);
      if (!p) throw new UserError(`No source path for ${srcFile} — is it loaded?`);
      bytes = new Uint8Array(await readFile(p));
      srcBytes.set(srcFile, bytes);
    }
    return bytes;
  };

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
    // approval marks (#176): the estimator's APPROVED rings and the agent's
    // AGENT diamonds burn in above the markups, and the cover tallies the
    // ink/pencil split — the same builder path the canvas's MARKED SET uses
    approvals: session.approvals,
    rfis: [],
    conditions: session.conditions,
    getPage,
    loadPdfData,
    credit,
    provenance: assignmentDisclosure(session.shapes, session.scheduleWithheld),
    coverTitle: "OpenTakeoff · Marked Set",
  });

  const outPath = path.resolve(opts.path ?? path.join(path.dirname(filePath), `${base} - marked set.pdf`));
  await writeFile(outPath, bytes);

  const markedKeys = new Set([...session.shapes.map((s) => s.sheet_id), ...session.markups.map((m) => m.sheet_id), ...session.approvals.map((a) => a.sheet_id)]);
  return {
    path: outPath,
    pages: 1 + markedKeys.size,
    sheets_marked: markedKeys.size,
    shapes_drawn: session.shapes.length,
    annotations_drawn: session.markups.length,
    approvals_drawn: session.approvals.length,
    note: "The takeoff burned into the plan sheets, with a legend cover — hand this to the user to review. To revise in the app, import the export_takeoff payload; agent shapes arrive as pencil proposals there until accepted.",
  };
}
