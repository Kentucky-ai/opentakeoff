// Revision delta ledger: one record per change between two issued drawing
// sets, tying the SOURCE REGION on the sheet to the takeoff quantity it moved.
//
// The visual diff (revisionDiff.ts) says where ink changed. The quantity
// compare (revisions.js) says which totals moved. Neither says which change
// moved which total. This joins them: every changed region carries the takeoff
// shapes it touches on the base sheet and on the revised sheet, the quantity
// before and after, and a status that says whether anyone has dealt with it.
//
// Two rules the output keeps:
//   1. A delta is only stated once the revised side has been measured. Until
//      then the quantity is EXPOSURE (what is at stake), never a delta.
//   2. Every sheet reconciles: sheet delta = attributed + unattributed. A
//      quantity that moved where the drawing did not change is named, with the
//      shapes responsible, instead of hiding inside a total.
//
// Pure: no DOM, no I/O. Coordinates are image px in each sheet's own frame.

import { conditionTotals } from "./totals.js";
import type { ChangedRegion } from "./revisionDiff";
import { looksLikeDimension, type TextChange } from "./textDiff";
import { aabbOverlap, pointSegmentDistance, shapeTouchesRegion } from "./slipsheet";

export const REVISION_DELTA_SCHEMA = "opentakeoff.revision_delta.v1";

export type Box = [number, number, number, number];
type Pt = [number, number];

export interface LedgerShape {
  id: string;
  sheet_id: string;
  condition_id: string;
  measure_role?: string;
  verts_norm?: Pt[];
  origin?: object;
}

export interface LedgerSheetSide {
  key: string;
  width: number;
  height: number;
  /** Real feet per image px, null when the sheet has no scale set. */
  upp: number | null;
}

export interface LedgerPair {
  sheet_number: string;
  base: LedgerSheetSide;
  revised: LedgerSheetSide;
  /** Offset carrying revised-sheet px into the base frame. */
  alignment: { dx: number; dy: number; confidence: number; method: string };
  diff_method: "vector" | "raster";
  /** False when either sheet has no vector linework to compare. */
  comparable: boolean;
  regions: ChangedRegion[];
  text_changes: TextChange[];
}

export interface LedgerInput {
  pairs: LedgerPair[];
  added_sheets: { key: string; sheet_number: string | null }[];
  removed_sheets: { key: string; sheet_number: string | null }[];
  unpaired: { sheet_number: string | null; base: string[]; revised: string[]; reason: string }[];
  conditions: { id: string; finish_tag?: string }[];
  shapes: LedgerShape[];
  /** Shapes a person has approved (estimator seal). */
  approved_shape_ids?: Iterable<string>;
  /** Shapes an agent has marked checked (never the same as approved). */
  agent_checked_shape_ids?: Iterable<string>;
}

/** Measured quantity for one condition. Zero fields are omitted. */
export interface QtyRow {
  condition: string;
  condition_id: string;
  floor_sf?: number;
  wall_sf?: number;
  border_sf?: number;
  lf?: number;
  ea?: number;
}
const QTY_FIELDS = ["floor_sf", "wall_sf", "border_sf", "lf", "ea"] as const;

export type LedgerStatus =
  | "outside_takeoff"      // ink changed where nothing is measured on either side
  | "not_carried"          // base takeoff touched, revised sheet has no takeoff yet
  | "pending"              // carried forward unchanged, nobody has checked it
  | "agent_checked"        // carried forward unchanged, an agent marked it checked
  | "confirmed_unchanged"  // carried forward unchanged, a person approved it
  | "remeasured"           // revised takeoff differs from the base takeoff here
  | "added"                // takeoff exists only on the revised side
  | "removed"              // takeoff existed on the base side, none on the revised side
  | "unmeasured";          // a new sheet with no takeoff on it

export interface LedgerEntry {
  id: string;
  kind: "linework" | "text" | "sheet_added" | "sheet_removed";
  sheet_number: string | null;
  base_sheet: string | null;
  revised_sheet: string | null;
  change?: "added" | "removed" | "modified";
  /** The source region, in each sheet's own px frame. */
  bounds_base?: Box;
  bounds_revised?: Box;
  segment_count?: number;
  text_changes: TextChange[];
  before: { shape_ids: string[]; quantities: QtyRow[] };
  after: { shape_ids: string[]; quantities: QtyRow[] };
  /** after − before. null until the revised side has been measured. */
  delta: QtyRow[] | null;
  /** Base quantity still waiting on a re-check (pending / not_carried). */
  exposure: QtyRow[];
  status: LedgerStatus;
  /** Why a person needs to look. Empty = nothing to decide. */
  review: string[];
}

export interface LedgerSheet {
  sheet_number: string;
  base_sheet: string;
  revised_sheet: string;
  alignment: LedgerPair["alignment"];
  diff_method: "vector" | "raster";
  changed_regions: number;
  /** Sub-2 px single-segment differences left out of the entries. */
  specks_ignored: number;
  text_changes: number;
  before: QtyRow[];
  /** null when the revised sheet has no takeoff yet. */
  after: QtyRow[] | null;
  delta: QtyRow[] | null;
  /** The part of delta that sits on changed regions. */
  attributed: QtyRow[] | null;
  /** The part of delta that sits where the drawing did not change. */
  unattributed: QtyRow[] | null;
  unattributed_shape_ids: { base: string[]; revised: string[] };
  review: string[];
}

export interface RevisionLedger {
  schema: typeof REVISION_DELTA_SCHEMA;
  sheets: LedgerSheet[];
  entries: LedgerEntry[];
  unpaired: LedgerInput["unpaired"];
  totals: {
    before: QtyRow[];
    after: QtyRow[];
    delta: QtyRow[];
    attributed: QtyRow[];
    unattributed: QtyRow[];
    exposure: QtyRow[];
  };
  counts: { entries: number; needs_review: number; by_status: Record<string, number> };
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function quantities(conditions: LedgerInput["conditions"], shapes: LedgerShape[]): QtyRow[] {
  if (!shapes.length) return [];
  const rows = conditionTotals(conditions, shapes) as Record<string, any>[];
  const out: QtyRow[] = [];
  for (const r of rows) {
    if (!r.shape_count) continue;
    const row: QtyRow = { condition: r.finish_tag || "", condition_id: r.id };
    for (const f of QTY_FIELDS) if (r[f]) row[f] = r[f];
    out.push(row);
  }
  return out;
}

/** b − a per condition, in a's order then b's; all-zero conditions dropped. */
export function subtractQty(b: QtyRow[], a: QtyRow[]): QtyRow[] {
  const byId = new Map<string, QtyRow>();
  const order: string[] = [];
  const touch = (r: QtyRow) => {
    if (!byId.has(r.condition_id)) { byId.set(r.condition_id, { condition: r.condition, condition_id: r.condition_id }); order.push(r.condition_id); }
    return byId.get(r.condition_id)!;
  };
  for (const r of a) { const t = touch(r); for (const f of QTY_FIELDS) if (r[f]) t[f] = round2((t[f] || 0) - r[f]!); }
  for (const r of b) { const t = touch(r); for (const f of QTY_FIELDS) if (r[f]) t[f] = round2((t[f] || 0) + r[f]!); }
  const out: QtyRow[] = [];
  for (const id of order) {
    const t = byId.get(id)!;
    const row: QtyRow = { condition: t.condition, condition_id: t.condition_id };
    let any = false;
    for (const f of QTY_FIELDS) if (t[f] && Math.abs(t[f]!) >= 0.005) { row[f] = t[f]; any = true; }
    if (any) out.push(row);
  }
  return out;
}
const addQty = (a: QtyRow[], b: QtyRow[]) => subtractQty(b, a.map((r) => {
  const neg: QtyRow = { condition: r.condition, condition_id: r.condition_id };
  for (const f of QTY_FIELDS) if (r[f]) neg[f] = -r[f]!;
  return neg;
}));

const px = (s: LedgerShape, side: LedgerSheetSide): Pt[] =>
  (s.verts_norm || []).map(([nx, ny]) => [nx * side.width, ny * side.height]);

/** The same shape drawn on both sheets: same condition and role, every vertex
 * within 1 px once the revised sheet is carried into the base frame. */
function sameGeometry(a: LedgerShape, aPx: Pt[], b: LedgerShape, bPx: Pt[], dx: number, dy: number): boolean {
  if (a.condition_id !== b.condition_id || a.measure_role !== b.measure_role || aPx.length !== bPx.length) return false;
  for (let i = 0; i < aPx.length; i++) {
    if (Math.abs(aPx[i][0] - (bPx[i][0] + dx)) > 1 || Math.abs(aPx[i][1] - (bPx[i][1] + dy)) > 1) return false;
  }
  return true;
}

const rectHull = (b: Box, pad: number): Pt[] => [[b[0] - pad, b[1] - pad], [b[2] + pad, b[1] - pad], [b[2] + pad, b[3] + pad], [b[0] - pad, b[3] + pad]];
const shiftBox = (b: Box, dx: number, dy: number): Box => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
const shiftPts = (p: Pt[], dx: number, dy: number): Pt[] => p.map(([x, y]) => [x + dx, y + dy]);

type Seg = [number, number, number, number];
interface Zone { kind: "linework" | "text"; id: string; change?: LedgerEntry["change"]; bounds: Box; hull: Pt[]; segments?: Seg[]; segment_count?: number; text: TextChange[] }

/** One stray segment shorter than 2 px: below what the diff's own 1 px
 * tolerance can tell apart from a rounding difference between two PDF
 * writers. Counted on the sheet row, never raised as a change. */
const isSpeck = (r: ChangedRegion) =>
  r.segmentCount === 1 && Math.hypot(r.bounds[2] - r.bounds[0], r.bounds[3] - r.bounds[1]) < 2;

/** Changed regions plus the text changes they contain; text changes outside
 * every region are grouped by proximity into text-only zones. */
function zonesFor(pair: LedgerPair): Zone[] {
  const zones: Zone[] = pair.regions.filter((r) => !isSpeck(r)).map((r) => ({
    kind: "linework" as const, id: r.id, change: r.type, bounds: r.bounds, hull: r.hull, segments: r.segments, segment_count: r.segmentCount, text: [],
  }));
  const loose: TextChange[] = [];
  for (const t of pair.text_changes) {
    // A text change belongs to a linework change when it sits beside the ink,
    // not merely inside a wide region's rectangle.
    const home = zones.find((z) => t.at[0] >= z.bounds[0] - 20 && t.at[0] <= z.bounds[2] + 20 && t.at[1] >= z.bounds[1] - 20 && t.at[1] <= z.bounds[3] + 20
      && (!z.segments || z.segments.some((g) => pointSegmentDistance(t.at, [g[0], g[1]], [g[2], g[3]]) <= 40)));
    if (home) home.text.push(t); else loose.push(t);
  }
  const groups: { bounds: Box; text: TextChange[] }[] = [];
  for (const t of loose) {
    const box: Box = [t.at[0], t.at[1], t.at[0], t.at[1]];
    const g = groups.find((x) => aabbOverlap([x.bounds[0] - 40, x.bounds[1] - 40, x.bounds[2] + 40, x.bounds[3] + 40], box));
    if (g) {
      g.text.push(t);
      g.bounds = [Math.min(g.bounds[0], box[0]), Math.min(g.bounds[1], box[1]), Math.max(g.bounds[2], box[2]), Math.max(g.bounds[3], box[3])];
    } else groups.push({ bounds: box, text: [t] });
  }
  groups.forEach((g, i) => {
    const kinds = new Set(g.text.map((t) => t.type));
    const change = kinds.size === 1 && kinds.has("added") ? "added" : kinds.size === 1 && kinds.has("removed") ? "removed" : "modified";
    zones.push({ kind: "text", id: `txt-${i + 1}`, change, bounds: g.bounds, hull: rectHull(g.bounds, 12), text: g.text });
  });
  return zones;
}

export function buildRevisionLedger(input: LedgerInput): RevisionLedger {
  const { conditions, shapes } = input;
  const approved = new Set(input.approved_shape_ids || []);
  const agentChecked = new Set(input.agent_checked_shape_ids || []);
  const bySheet = new Map<string, LedgerShape[]>();
  for (const s of shapes) {
    const list = bySheet.get(s.sheet_id);
    if (list) list.push(s); else bySheet.set(s.sheet_id, [s]);
  }
  const qty = (list: LedgerShape[]) => quantities(conditions, list);
  const originOf = (s: LedgerShape) => (s.origin || {}) as { reviewed?: boolean; flagged_for_revision?: boolean };
  const isApproved = (s: LedgerShape) => (approved.has(s.id) || originOf(s).reviewed === true) && !originOf(s).flagged_for_revision;

  const entries: LedgerEntry[] = [];
  const sheets: LedgerSheet[] = [];
  let tBefore: QtyRow[] = [], tAfter: QtyRow[] = [], tAttr: QtyRow[] = [], tUnattr: QtyRow[] = [], tExposure: QtyRow[] = [];

  for (const pair of input.pairs) {
    const { dx, dy } = pair.alignment;
    const baseShapes = bySheet.get(pair.base.key) || [];
    const revShapes = bySheet.get(pair.revised.key) || [];
    const basePx = new Map(baseShapes.map((s) => [s.id, px(s, pair.base)] as const));
    const revPx = new Map(revShapes.map((s) => [s.id, px(s, pair.revised)] as const));
    const revisedMeasured = revShapes.length > 0;

    const pairReview: string[] = [];
    if (!pair.comparable) pairReview.push("no_vector_linework");
    if (pair.alignment.confidence < 0.5) pairReview.push("alignment_low_confidence");
    if (pair.diff_method === "raster") pairReview.push("raster_diff");
    if (Math.abs(pair.base.width - pair.revised.width) > 1 || Math.abs(pair.base.height - pair.revised.height) > 1) pairReview.push("page_size_changed");
    if (pair.base.upp != null && pair.revised.upp != null && Math.abs(pair.base.upp - pair.revised.upp) > pair.base.upp * 0.001) pairReview.push("scale_changed");
    if (pair.base.upp != null && pair.revised.upp == null && revisedMeasured) pairReview.push("revised_scale_unset");

    const touchedBase = new Set<string>();
    const touchedRev = new Set<string>();
    const exposedBase = new Set<string>();

    for (const z of zonesFor(pair)) {
      const hullRev = shiftPts(z.hull, -dx, -dy);
      const boundsRev = shiftBox(z.bounds, -dx, -dy);
      const segsRev = z.segments?.map((g) => [g[0] - dx, g[1] - dy, g[2] - dx, g[3] - dy] as Seg);
      const before = baseShapes.filter((s) => shapeTouchesRegion(basePx.get(s.id)!, s.measure_role, z.hull, z.bounds, z.segments));
      const after = revShapes.filter((s) => shapeTouchesRegion(revPx.get(s.id)!, s.measure_role, hullRev, boundsRev, segsRev));
      before.forEach((s) => touchedBase.add(s.id));
      after.forEach((s) => touchedRev.add(s.id));

      let status: LedgerStatus;
      if (!before.length && !after.length) status = "outside_takeoff";
      else if (!revisedMeasured) status = "not_carried";
      else if (!before.length) status = "added";
      else if (!after.length) status = "removed";
      else {
        const pool = [...before];
        const identical = before.length === after.length && after.every((a) => {
          const k = pool.findIndex((b) => sameGeometry(b, basePx.get(b.id)!, a, revPx.get(a.id)!, dx, dy));
          if (k < 0) return false;
          pool.splice(k, 1);
          return true;
        });
        if (!identical) status = "remeasured";
        else if (after.every(isApproved)) status = "confirmed_unchanged";
        else if (after.every((s) => agentChecked.has(s.id) || isApproved(s))) status = "agent_checked";
        else status = "pending";
      }

      const beforeQ = qty(before);
      const afterQ = qty(after);
      const open = status === "pending" || status === "not_carried";
      if (open) before.forEach((s) => exposedBase.add(s.id));
      const delta = status === "outside_takeoff" ? [] : open ? null : subtractQty(afterQ, beforeQ);

      const review: string[] = [];
      if (status === "pending") review.push("recheck_takeoff");
      if (status === "not_carried") review.push("takeoff_not_carried");
      if (status === "removed") review.push("confirm_scope_removed");
      if (status === "agent_checked") review.push("agent_checked_unapproved");
      if ((status === "remeasured" || status === "added") && !after.every(isApproved)) review.push("revised_takeoff_unapproved");
      if (z.text.length && status !== "outside_takeoff") {
        review.push(z.text.some((t) => looksLikeDimension(t.before || "") || looksLikeDimension(t.after || "")) ? "dimension_text_changed" : "text_changed");
      }
      // Only entries that touch takeoff inherit the sheet-level cautions: a
      // shaky alignment matters where a quantity rides on it.
      if (status !== "outside_takeoff") for (const r of pairReview) if (r !== "no_vector_linework") review.push(r);

      entries.push({
        id: `${pair.sheet_number}/${z.id}`,
        kind: z.kind,
        sheet_number: pair.sheet_number,
        base_sheet: pair.base.key,
        revised_sheet: pair.revised.key,
        change: z.change,
        bounds_base: z.bounds.map(round2) as Box,
        bounds_revised: boundsRev.map(round2) as Box,
        ...(z.segment_count !== undefined ? { segment_count: z.segment_count } : {}),
        text_changes: z.text,
        before: { shape_ids: before.map((s) => s.id), quantities: beforeQ },
        after: { shape_ids: after.map((s) => s.id), quantities: afterQ },
        delta,
        exposure: open ? beforeQ : [],
        status,
        review,
      });
    }

    // Reconcile the sheet: whatever moved on shapes no change touches is
    // unattributed, and the shapes responsible are named.
    const beforeAll = qty(baseShapes);
    const afterAll = revisedMeasured ? qty(revShapes) : null;
    const untouchedBase = baseShapes.filter((s) => !touchedBase.has(s.id));
    const untouchedRev = revShapes.filter((s) => !touchedRev.has(s.id));
    let unattributed: QtyRow[] | null = null, attributed: QtyRow[] | null = null, delta: QtyRow[] | null = null;
    const orphanBase: string[] = [], orphanRev: string[] = [];
    if (afterAll) {
      delta = subtractQty(afterAll, beforeAll);
      unattributed = subtractQty(qty(untouchedRev), qty(untouchedBase));
      attributed = subtractQty(delta, unattributed);
      const pool = [...untouchedBase];
      for (const a of untouchedRev) {
        const k = pool.findIndex((b) => sameGeometry(b, basePx.get(b.id)!, a, revPx.get(a.id)!, dx, dy));
        if (k >= 0) pool.splice(k, 1); else orphanRev.push(a.id);
      }
      orphanBase.push(...pool.map((s) => s.id));
      if (unattributed.length) pairReview.push("quantity_changed_outside_drawing_change");
      tAfter = addQty(tAfter, afterAll);
      tAttr = addQty(tAttr, attributed);
      tUnattr = addQty(tUnattr, unattributed);
    }
    tBefore = addQty(tBefore, beforeAll);
    tExposure = addQty(tExposure, qty(baseShapes.filter((s) => exposedBase.has(s.id))));

    sheets.push({
      sheet_number: pair.sheet_number,
      base_sheet: pair.base.key,
      revised_sheet: pair.revised.key,
      alignment: pair.alignment,
      diff_method: pair.diff_method,
      changed_regions: pair.regions.length,
      specks_ignored: pair.regions.filter(isSpeck).length,
      text_changes: pair.text_changes.length,
      before: beforeAll,
      after: afterAll,
      delta,
      attributed,
      unattributed,
      unattributed_shape_ids: { base: orphanBase, revised: orphanRev },
      review: pairReview,
    });
  }

  for (const s of input.added_sheets) {
    const list = bySheet.get(s.key) || [];
    const q = qty(list);
    entries.push({
      id: `sheet/${s.sheet_number || s.key}/added`, kind: "sheet_added", sheet_number: s.sheet_number, base_sheet: null, revised_sheet: s.key,
      text_changes: [], before: { shape_ids: [], quantities: [] }, after: { shape_ids: list.map((x) => x.id), quantities: q },
      delta: list.length ? q : null, exposure: [], status: list.length ? "added" : "unmeasured",
      review: [list.length ? (list.every(isApproved) ? "new_sheet" : "revised_takeoff_unapproved") : "new_sheet_unmeasured"],
    });
    tAfter = addQty(tAfter, q);
    tAttr = addQty(tAttr, q);
  }
  for (const s of input.removed_sheets) {
    const list = bySheet.get(s.key) || [];
    const q = qty(list);
    entries.push({
      id: `sheet/${s.sheet_number || s.key}/removed`, kind: "sheet_removed", sheet_number: s.sheet_number, base_sheet: s.key, revised_sheet: null,
      text_changes: [], before: { shape_ids: list.map((x) => x.id), quantities: q }, after: { shape_ids: [], quantities: [] },
      delta: list.length ? subtractQty([], q) : [], exposure: [], status: list.length ? "removed" : "outside_takeoff",
      review: list.length ? ["confirm_scope_removed"] : [],
    });
    tBefore = addQty(tBefore, q);
    tAttr = addQty(tAttr, subtractQty([], q));
  }

  // What needs a person first, then what touches takeoff, then the rest.
  const rank = (e: LedgerEntry) => (e.review.length ? 0 : e.status === "outside_takeoff" ? 2 : 1);
  const ordered = entries.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e);

  const by_status: Record<string, number> = {};
  for (const e of ordered) by_status[e.status] = (by_status[e.status] || 0) + 1;

  return {
    schema: REVISION_DELTA_SCHEMA,
    sheets,
    entries: ordered,
    unpaired: input.unpaired,
    totals: {
      before: tBefore, after: tAfter, delta: addQty(tAttr, tUnattr),
      attributed: tAttr, unattributed: tUnattr, exposure: tExposure,
    },
    counts: { entries: ordered.length, needs_review: ordered.filter((e) => e.review.length).length, by_status },
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sf = (r?: QtyRow) => (r ? round2((r.floor_sf || 0) + (r.wall_sf || 0) + (r.border_sf || 0)) : 0);

/** One row per ledger entry per condition: the audit trail as a spreadsheet. */
export function revisionLedgerCsv(ledger: RevisionLedger): string {
  const head = ["entry", "sheet", "kind", "change", "status", "review", "condition",
    "before_sf", "after_sf", "delta_sf", "before_lf", "after_lf", "delta_lf", "before_ea", "after_ea", "delta_ea",
    "region_base_px", "text_changes"];
  const lines = [head.join(",")];
  for (const e of ledger.entries) {
    const ids = new Map<string, string>();
    for (const r of [...e.before.quantities, ...e.after.quantities]) ids.set(r.condition_id, r.condition);
    const text = e.text_changes.map((t) => (t.type === "changed" ? `${t.before} -> ${t.after}` : t.type === "added" ? `+ ${t.after}` : `- ${t.before}`)).join(" | ");
    const common = [e.id, e.sheet_number || "", e.kind, e.change || "", e.status, e.review.join(" ")];
    const tail = [e.bounds_base ? e.bounds_base.join(" ") : "", text];
    if (!ids.size) { lines.push([...common, "", "", "", "", "", "", "", "", "", "", ...tail].map(csvCell).join(",")); continue; }
    for (const [id, tag] of ids) {
      const b = e.before.quantities.find((r) => r.condition_id === id);
      const a = e.after.quantities.find((r) => r.condition_id === id);
      const d = e.delta ? e.delta.find((r) => r.condition_id === id) : undefined;
      const stated = e.delta !== null;
      lines.push([...common, tag,
        sf(b), stated ? sf(a) : "", stated ? sf(d) : "",
        b?.lf || 0, stated ? a?.lf || 0 : "", stated ? d?.lf || 0 : "",
        b?.ea || 0, stated ? a?.ea || 0 : "", stated ? d?.ea || 0 : "",
        ...tail].map(csvCell).join(","));
    }
  }
  return lines.join("\n") + "\n";
}
