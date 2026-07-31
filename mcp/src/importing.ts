// import_takeoff (#151) — the way back in. export_takeoff has always been the
// one-way door out of a session; this consumes the same
// "opentakeoff.takeoff_canvas.v1" file back through the SAME tested merge
// rules the app's Sheet-menu import uses (web/src/lib/importTakeoff.js):
// finish-tag identity merges conditions onto the session's own, new ids
// append, duplicate ids skip (idempotent re-import), and the session's own
// calibration wins per sheet. One implementation, both surfaces.
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  parseTakeoffImport as parseJs,
  mergeTakeoffImport as mergeJs,
} from "../../web/src/lib/importTakeoff.js";
import { UserError } from "./format.ts";
import type { Session, Shape, Condition, Markup } from "./session.ts";

// untyped canvas JS — typed facades state the contract at the boundary
const parseTakeoffImport = parseJs as unknown as (text: string) => Record<string, unknown>;
interface MergeNote {
  replaced: boolean; shapes_added: number; shapes_pending: number;
  conditions_merged: number; conditions_added: number; scales_adopted: number;
  unknown_files: string[];
}
const mergeTakeoffImport = mergeJs as unknown as (
  current: Record<string, unknown>, imported: Record<string, unknown>, knownFiles: string[] | null,
) => { payload: Record<string, unknown>; note: MergeNote };

export async function importTakeoff(session: Session, filePath: string) {
  if (!session.file) throw new UserError("No plan loaded — call load_plan first (the import lands on the loaded document).");
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    throw new UserError(`Couldn't read ${JSON.stringify(filePath)} — is the path right?`);
  }
  let imported: Record<string, unknown>;
  try {
    imported = parseTakeoffImport(text);
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : String(e));
  }

  const prevShapeIds = new Set(session.shapes.map((s) => s.id));
  const { payload, note } = mergeTakeoffImport(session.exportPayload(), imported, session.files);

  session.conditions = (payload.conditions as Condition[]) ?? [];
  session.shapes = (payload.shapes as Shape[]) ?? [];
  session.markups = (payload.markups as Markup[]) ?? [];
  // scales: mergeTakeoffImport already applied "the session's calibration wins
  // per sheet" — adopt the merged rows onto sheets this document actually has
  for (const row of (payload.sheets as { sheet_id: string; units_per_px: number; scale_source?: string }[]) ?? []) {
    const s = session.sheetOrNull(row.sheet_id);
    if (s && s.upp == null && row.units_per_px > 0) {
      s.upp = row.units_per_px;
      s.scaleSource = row.scale_source ?? "upp";
    }
  }

  // the imported SHAPES journal as one reversible gesture; adopted conditions,
  // scales, and annotations stay on undo (documented on the tool) — an import
  // is a document merge, not a trace, and shapes are the half that moves totals
  const addedIds = session.shapes.filter((s) => !prevShapeIds.has(s.id)).map((s) => s.id);
  if (addedIds.length) session.journalCommit("import_takeoff", addedIds);

  return {
    file: path.basename(filePath),
    ...note,
    shapes_total: session.shapes.length,
    note: note.replaced
      ? "Empty session — the import IS the takeoff now. Unreviewed machine shapes stay pencil; verify with view_sheet overlay:true."
      : "Merged: same finish tags joined your conditions, new ids appended, duplicates skipped (re-import is idempotent), this session's calibration won per sheet.",
  };
}
