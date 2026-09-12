// The ONE writer of the takeoff document ("opentakeoff.takeoff_canvas.v1").
// The canvas's autosave/export and the MCP server's export_takeoff both call
// buildTakeoffDocument, so the envelope — which keys exist, in what order,
// and which are omitted when empty — is decided in exactly one place. Plain
// JS with no DOM dependency: the Node bundle and `node --test` load it as-is.
//
// Conventions (the app's, kept byte-for-byte for existing projects):
// - `schema` is always first.
// - `units` is diff-only: imperial (the default) omits the key, so an old
//   imperial project's payload round-trips byte-identical; only metric writes it.
// - The navigation keys (`sheet_group`, `last_group`, `sheet_tabs`) and the
//   core collections are always present, even when empty.
// - Every additive key (`client_info`, `condition_columns`, `shape_labels`,
//   `palette`, `approvals`, `proposals`, `condition_edit_proposals`, `rules`,
//   `stitches`, `sheet_levels`, `layer_overrides`, `provenance_counters`) is
//   omitted when empty, so a document that never used the feature is
//   byte-identical to one written before the feature existed.
// - `palette` (pinned condition ids) drops ids that no longer resolve.
import { TAKEOFF_SCHEMA } from "./takeoffConstants.ts";

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** Canonical key order of the document. Optional keys appear in this order when present. */
export const TAKEOFF_DOCUMENT_KEYS = Object.freeze([
  "schema", "project_name", "units", "client_info", "sheets", "conditions", "condition_columns",
  "shape_labels", "palette", "shapes", "markups", "rfis", "approvals", "proposals",
  "condition_edit_proposals", "rules", "sheet_group", "last_group", "sheet_tabs", "stitches",
  "sheet_levels", "layer_overrides", "provenance_counters",
]);

/** One `sheets[]` entry. `scale_source` rides only when known; `scale_confirmed`
 *  only when explicitly false (absent = confirmed, the pre-flag reading).
 *  @param {{ sheet_id: string, units_per_px: number, scale_source?: string | null, scale_confirmed?: boolean | null }} e */
export function sheetEntry({ sheet_id, units_per_px, scale_source = undefined, scale_confirmed = undefined }) {
  return {
    sheet_id,
    units_per_px,
    ...(scale_source ? { scale_source } : {}),
    ...(scale_confirmed === false ? { scale_confirmed: false } : {}),
  };
}

/** Build the document from a field bag. Missing collections read as empty. */
export function buildTakeoffDocument(f = {}) {
  const conditions = arr(f.conditions);
  const pinned = arr(f.palette).filter((id) => conditions.some((c) => c && c.id === id));
  const clientInfo = obj(f.client_info);
  const hasClient = Object.values(clientInfo).some((v) => v && String(v).trim());
  const sheetLevels = obj(f.sheet_levels);
  const layerOverrides = obj(f.layer_overrides);
  const prov = f.provenance_counters;
  const hasProv = !!(prov && prov.shapes_deleted && Object.keys(prov.shapes_deleted).length);
  return {
    schema: TAKEOFF_SCHEMA,
    project_name: typeof f.project_name === "string" ? f.project_name : "",
    ...(f.units === "metric" ? { units: "metric" } : {}),
    ...(hasClient ? { client_info: clientInfo } : {}),
    sheets: arr(f.sheets),
    conditions,
    ...(arr(f.condition_columns).length ? { condition_columns: f.condition_columns } : {}),
    ...(arr(f.shape_labels).length ? { shape_labels: f.shape_labels } : {}),
    ...(pinned.length ? { palette: pinned } : {}),
    shapes: arr(f.shapes),
    markups: arr(f.markups),
    rfis: arr(f.rfis),
    ...(arr(f.approvals).length ? { approvals: f.approvals } : {}),
    ...(arr(f.proposals).length ? { proposals: f.proposals } : {}),
    ...(arr(f.condition_edit_proposals).length ? { condition_edit_proposals: f.condition_edit_proposals } : {}),
    ...(arr(f.rules).length ? { rules: f.rules } : {}),
    sheet_group: arr(f.sheet_group),
    last_group: arr(f.last_group),
    sheet_tabs: arr(f.sheet_tabs),
    ...(arr(f.stitches).length ? { stitches: f.stitches } : {}),
    ...(Object.keys(sheetLevels).length ? { sheet_levels: sheetLevels } : {}),
    ...(Object.keys(layerOverrides).length ? { layer_overrides: layerOverrides } : {}),
    ...(hasProv ? { provenance_counters: prov } : {}),
  };
}
