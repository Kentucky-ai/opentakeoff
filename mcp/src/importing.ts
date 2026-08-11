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
import { sanitizeApprovals, type Session, type Shape, type Condition, type Markup } from "./session.ts";
import type { Rule } from "../../web/src/lib/rules.ts";

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
  // approvals (#176): transport, not minting — an estimator seal arriving by
  // file stays an estimator seal (the actor field is the authority; only
  // mark_verdict MINTS, and only agent). The same load gate the canvas
  // hydrate runs (sanitizeApprovals) applies before anything lands, so one
  // corrupt record in a hand-edited file can't wedge the session.
  session.approvals = sanitizeApprovals(payload.approvals);
  // scales: mergeTakeoffImport already applied "the session's calibration wins
  // per sheet" — adopt the merged rows onto sheets this document actually has
  for (const row of (payload.sheets as { sheet_id: string; units_per_px: number; scale_source?: string; scale_confirmed?: boolean }[]) ?? []) {
    const s = session.sheetOrNull(row.sheet_id);
    if (s && s.upp == null && row.units_per_px > 0) {
      s.upp = row.units_per_px;
      s.scaleSource = row.scale_source ?? "upp";
      // scale gate — transport, not minting (the approvals rule): an
      // unconfirmed agent scale arriving by file STAYS unconfirmed; absent
      // means confirmed (a human-era payload, or one a human confirmed)
      if (row.scale_confirmed === false) s.scaleConfirmed = false;
    }
  }

  // correction rules (#207): the canvas merge deliberately keeps the OPERATOR'S
  // rules (a workspace concern there) — but a headless session HAS no rules of
  // its own, and the file's rules are the estimator's taught corrections, the
  // exact cargo apply_rules exists to re-run. Hydrate them from the file
  // directly, seed_condition_id re-pointed through the merge's own tag-identity
  // rule (an imported condition that merged onto a session condition changed
  // id; the rule follows its condition). A rule whose condition can't be
  // resolved rides along unmapped — apply_rules reports it skipped, named.
  const tagKey = (t: unknown) => String(t || "").trim().toUpperCase();
  const importedConds = Array.isArray(imported.conditions) ? imported.conditions as Condition[] : [];
  const tagById = new Map(importedConds.map((c) => [c.id, tagKey(c.finish_tag)]));
  const sessionByTag = new Map(session.conditions.map((c) => [tagKey(c.finish_tag), c.id]));
  const knownRuleIds = new Set(session.rules.map((r) => r.id));
  let rulesImported = 0;
  for (const raw of (Array.isArray(imported.rules) ? imported.rules as Rule[] : [])) {
    if (!raw || typeof raw !== "object" || !raw.id || knownRuleIds.has(raw.id)) continue;
    if (raw.predicate?.kind !== "enclosed_subpolygon_deduct" || !(raw.predicate.max_area_sf > 0)) continue;
    const mapped = sessionByTag.get(tagById.get(raw.seed_condition_id) ?? "");
    session.rules.push({ ...raw, applied_to: [...(raw.applied_to ?? [])], seed_condition_id: mapped ?? raw.seed_condition_id });
    knownRuleIds.add(raw.id);
    rulesImported++;
  }

  // the imported SHAPES journal as one reversible gesture; adopted conditions,
  // scales, annotations, and approval marks stay on undo (documented on the
  // tool) — an import is a document merge, not a trace, and shapes are the
  // half that moves totals
  const addedIds = session.shapes.filter((s) => !prevShapeIds.has(s.id)).map((s) => s.id);
  if (addedIds.length) session.journalCommit("import_takeoff", addedIds);

  return {
    file: path.basename(filePath),
    ...note,
    rules_imported: rulesImported,
    shapes_total: session.shapes.length,
    note: (note.replaced
      ? "Empty session — the import IS the takeoff now. Unreviewed machine shapes stay pencil; verify with view_sheet overlay:true."
      : "Merged: same finish tags joined your conditions, new ids appended, duplicates skipped (re-import is idempotent), this session's calibration won per sheet.")
      + (rulesImported ? ` ${rulesImported} correction rule(s) arrived — apply_rules re-runs them.` : ""),
  };
}
