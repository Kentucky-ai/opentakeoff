// Revision Delta Ledger — tie each drawing change between issued sets
// to the takeoff quantity it moves, with per-sheet reconciliation:
//   delta = attributed + unattributed
// Pure and DOM-free; shared between the browser canvas and the MCP server.

import type { BoxSpan } from "./textjoin";
import {
  bboxToPolygon,
  diffTextSpans,
  diffVectorSegments,
  type ChangedRegion,
  type Polygon,
  type Segment,
  type TextDiffItem,
  type TransformOffset,
} from "./revisionDiff";
import { autoAlignSheets, type AlignmentResult } from "./sheetAlign";
import {
  matchSheetSets,
  shapeTouchesRegion,
  type MatchSetResult,
  type SheetEntry,
  type TakeoffShape,
} from "./slipsheet";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export type LedgerField = "floor_sf" | "wall_sf" | "border_sf" | "lf" | "ea";
export const LEDGER_FIELDS: LedgerField[] = ["floor_sf", "wall_sf", "border_sf", "lf", "ea"];

export type LedgerUnit = "SF" | "LF" | "EA";

export interface LedgerShapeRef {
  id: string;
  condition_id: string;
  finish_tag: string;
  measure_role: string;
  quantity: number;
  unit: LedgerUnit;
}

export interface LedgerQuantityDelta {
  field: LedgerField;
  unit: LedgerUnit;
  before: number;
  after: number | null;
  delta: number | null;
  exposure: number;
}

export interface LedgerSourceRegion {
  bounds: [number, number, number, number];
  hull: Polygon;
  segment_count: number;
  text?: string;
}

export interface AgentCheckState {
  checked: boolean;
  actor?: string;
  note?: string;
  ts?: string;
}

export interface EstimatorApprovalState {
  approved: boolean;
  actor?: string;
  note?: string;
  ts?: string;
}

export interface RevisionLedgerEntry {
  id: string;
  sheet_number: string;
  sheet_a: string;
  sheet_b: string;
  kind: "linework" | "text" | "mixed" | "cloud" | "unattributed";
  change_type: "added" | "removed" | "modified" | "unattributed";
  summary: string;
  source_region_a: LedgerSourceRegion | null;
  source_region_b: LedgerSourceRegion | null;
  shapes_a: LedgerShapeRef[];
  shapes_b: LedgerShapeRef[];
  quantities: LedgerQuantityDelta[];
  status: "exposure" | "measured" | "unchanged" | "unattributed";
  reasons: string[];
  agent_check: AgentCheckState;
  estimator_approval: EstimatorApprovalState;
}

export interface SheetReconciliationRow {
  field: LedgerField;
  unit: LedgerUnit;
  before: number;
  after: number | null;
  delta: number | null;
  attributed: number | null;
  unattributed: number | null;
  reconciles: boolean;
  exposure: number;
}

export interface SheetLedgerSummary {
  sheet_number: string;
  sheet_a: string;
  sheet_b: string;
  revised_measured: boolean;
  alignment: AlignmentResult;
  diff_method: "vector" | "raster";
  scale_a?: number | null;
  scale_b?: number | null;
  scale_mismatch: boolean;
  reconciliation: SheetReconciliationRow[];
  entry_ids: string[];
  unattributed_shape_ids: string[];
}

export interface RevisionLedger {
  set_a_label: string;
  set_b_label: string;
  created_at: string;
  paired_sheets: SheetLedgerSummary[];
  unpaired_sheets: {
    unmatched_base: Array<{ key: string; sheetNumber: string | null }>;
    unmatched_incoming: Array<{ key: string; sheetNumber: string | null }>;
    ambiguous: Array<{ sheetNumber: string; base_keys: string[]; incoming_keys: string[] }>;
  };
  entries: RevisionLedgerEntry[];
}

export interface SheetPairInput {
  sheetNumber: string;
  sheetA: SheetEntry & { widthPx: number; heightPx: number; scale?: number | null };
  sheetB: SheetEntry & { widthPx: number; heightPx: number; scale?: number | null };
  segsA: Segment[];
  segsB: Segment[];
  spansA?: BoxSpan[];
  spansB?: BoxSpan[];
  /** Optional precomputed changedRegions (e.g. from raster diff on scanned sheets). */
  precomputedRegions?: ChangedRegion[];
  diffMethod?: "vector" | "raster";
  alignment?: TransformOffset;
  /** Explicitly mark sheet B as measured even if it has 0 shapes (e.g. all deleted). */
  revisedMeasured?: boolean;
}

export interface TakeoffConditionLike {
  id: string;
  finish_tag?: string;
}

function unitForRole(role?: string): { field: LedgerField; unit: LedgerUnit } {
  switch (role) {
    case "surface_area":
      return { field: "wall_sf", unit: "SF" };
    case "linear":
      return { field: "lf", unit: "LF" };
    case "count":
      return { field: "ea", unit: "EA" };
    case "deduct":
    case "floor_area":
    default:
      return { field: "floor_sf", unit: "SF" };
  }
}

function shapeQuantity(s: TakeoffShape): number {
  const cp = s.computed || {};
  switch (s.measure_role) {
    case "deduct":
      return -(cp.area_sf || 0);
    case "floor_area":
    case "surface_area":
      return cp.area_sf || 0;
    case "linear":
      return cp.perimeter_lf || 0;
    case "count":
      return cp.count || 1;
    default:
      return cp.area_sf || 0;
  }
}

function toShapeRef(s: TakeoffShape, condMap: Map<string, string>): LedgerShapeRef {
  const { unit } = unitForRole(s.measure_role);
  return {
    id: s.id,
    condition_id: s.condition_id,
    finish_tag: condMap.get(s.condition_id) || s.condition_id,
    measure_role: s.measure_role || "floor_area",
    quantity: round2(shapeQuantity(s)),
    unit,
  };
}

/** Inverse-transform a bounding box from sheet A space back into sheet B space. */
function inverseAlignBounds(
  bounds: [number, number, number, number],
  align: TransformOffset
): [number, number, number, number] {
  const scale = align.scale ?? 1;
  const rot = align.rotationDeg ?? 0;
  const invPoint = (x: number, y: number): [number, number] => {
    let px = x - align.dx;
    let py = y - align.dy;
    if (rot !== 0) {
      const rad = (-rot * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      const rx = px * c - py * s;
      const ry = px * s + py * c;
      px = rx;
      py = ry;
    }
    return [px / scale, py / scale];
  };
  const corners: Array<[number, number]> = [
    invPoint(bounds[0], bounds[1]),
    invPoint(bounds[2], bounds[1]),
    invPoint(bounds[2], bounds[3]),
    invPoint(bounds[0], bounds[3]),
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [cx, cy] of corners) {
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  return [round2(minX), round2(minY), round2(maxX), round2(maxY)];
}

/** Merge nearby text regions into nearby linework regions when they overlap, keeping standalone text regions. */
function mergeLineworkAndTextRegions(
  lineRegions: ChangedRegion[],
  textItems: TextDiffItem[]
): Array<{
  region: ChangedRegion;
  kind: "linework" | "text" | "mixed" | "cloud";
  textItems: TextDiffItem[];
}> {
  const out = lineRegions.map((r) => ({
    region: r,
    kind: (r.isCloud ? "cloud" : "linework") as "linework" | "text" | "mixed" | "cloud",
    textItems: [] as TextDiffItem[],
  }));

  const pad = 18;
  for (const t of textItems) {
    const match = out.find((o) => {
      const b = o.region.bounds;
      return (
        t.bounds[0] - pad <= b[2] &&
        t.bounds[2] + pad >= b[0] &&
        t.bounds[1] - pad <= b[3] &&
        t.bounds[3] + pad >= b[1]
      );
    });
    if (match) {
      match.textItems.push(t);
      if (match.kind === "linework") match.kind = "mixed";
    } else {
      out.push({
        region: {
          id: t.id,
          type: t.type,
          bounds: t.bounds,
          hull: bboxToPolygon(t.bounds, 4),
          segmentCount: 0,
          textChanges: [t],
        },
        kind: "text",
        textItems: [t],
      });
    }
  }

  return out;
}

function formatTextSummary(items: TextDiffItem[]): string {
  if (!items.length) return "";
  const first = items[0];
  if (first.type === "modified") {
    return `Text changed: "${first.textA}" -> "${first.textB}"${items.length > 1 ? ` (+${items.length - 1} more)` : ""}`;
  }
  if (first.type === "added") {
    return `Text added: "${first.textB}"${items.length > 1 ? ` (+${items.length - 1} more)` : ""}`;
  }
  return `Text removed: "${first.textA}"${items.length > 1 ? ` (+${items.length - 1} more)` : ""}`;
}

function summarizeQuantities(
  shapesA: TakeoffShape[],
  shapesB: TakeoffShape[],
  revisedMeasured: boolean
): LedgerQuantityDelta[] {
  const byField = new Map<LedgerField, { unit: LedgerUnit; before: number; after: number }>();
  for (const s of shapesA) {
    const { field, unit } = unitForRole(s.measure_role);
    const cur = byField.get(field) || { unit, before: 0, after: 0 };
    cur.before += shapeQuantity(s);
    byField.set(field, cur);
  }
  for (const s of shapesB) {
    const { field, unit } = unitForRole(s.measure_role);
    const cur = byField.get(field) || { unit, before: 0, after: 0 };
    cur.after += shapeQuantity(s);
    byField.set(field, cur);
  }

  const out: LedgerQuantityDelta[] = [];
  for (const field of LEDGER_FIELDS) {
    const row = byField.get(field);
    if (!row) continue;
    const before = round2(row.before);
    const after = revisedMeasured ? round2(row.after) : null;
    const delta = revisedMeasured ? round2(row.after - row.before) : null;
    const exposure = revisedMeasured ? 0 : before;
    out.push({ field, unit: row.unit, before, after, delta, exposure });
  }
  return out;
}

/**
 * Build a complete Revision Delta Ledger for two issued drawing sets.
 */
export function buildRevisionLedger(params: {
  setALabel?: string;
  setBLabel?: string;
  baseSheets?: SheetEntry[];
  incomingSheets?: SheetEntry[];
  pairs: SheetPairInput[];
  shapesA: TakeoffShape[];
  shapesB: TakeoffShape[];
  conditionsA?: TakeoffConditionLike[];
  conditionsB?: TakeoffConditionLike[];
}): RevisionLedger {
  const {
    setALabel = "Base Issue",
    setBLabel = "Revised Issue",
    baseSheets,
    incomingSheets,
    pairs,
    shapesA,
    shapesB,
    conditionsA = [],
    conditionsB = [],
  } = params;

  const condMapA = new Map(conditionsA.map((c) => [c.id, c.finish_tag || c.id]));
  const condMapB = new Map(conditionsB.map((c) => [c.id, c.finish_tag || c.id]));

  let matchSet: MatchSetResult = { matched: [], unmatchedBase: [], unmatchedIncoming: [], ambiguous: [] };
  if (baseSheets && incomingSheets) {
    matchSet = matchSheetSets(baseSheets, incomingSheets);
  }

  const entries: RevisionLedgerEntry[] = [];
  const pairedSummaries: SheetLedgerSummary[] = [];
  let entrySeq = 1;

  for (const pair of pairs) {
    const { sheetNumber, sheetA, sheetB, segsA, segsB, spansA = [], spansB = [] } = pair;
    const align: AlignmentResult = pair.alignment
      ? { dx: pair.alignment.dx, dy: pair.alignment.dy, scale: pair.alignment.scale, rotationDeg: pair.alignment.rotationDeg, confidence: 1, method: "manual" }
      : autoAlignSheets(segsA, segsB, sheetA.widthPx, sheetA.heightPx);

    let lineRegions: ChangedRegion[];
    let diffMethod: "vector" | "raster" = pair.diffMethod || "vector";
    if (pair.precomputedRegions) {
      lineRegions = pair.precomputedRegions;
    } else {
      const vDiff = diffVectorSegments(segsA, segsB, align, 1.5);
      lineRegions = vDiff.changedRegions;
    }

    const textDiff = diffTextSpans(spansA, spansB, align);
    const mergedChanges = mergeLineworkAndTextRegions(lineRegions, textDiff.items);

    const sheetShapesA = shapesA.filter((s) => s.sheet_id === sheetA.key);
    const sheetShapesB = shapesB.filter((s) => s.sheet_id === sheetB.key);
    const revisedMeasured = pair.revisedMeasured ?? sheetShapesB.length > 0;

    const scaleMismatch =
      sheetA.scale != null &&
      sheetB.scale != null &&
      Math.abs(sheetA.scale - sheetB.scale) > 1e-4;

    const attributedIdsA = new Set<string>();
    const attributedIdsB = new Set<string>();
    const sheetEntryIds: string[] = [];

    for (const chg of mergedChanges) {
      const regA = chg.region;
      const boundsB = inverseAlignBounds(regA.bounds, align);

      // Test shapes on sheet A against region in sheet A coords
      const touchedA = sheetShapesA.filter((s) => {
        const vertsPx = (s.verts_norm || []).map(([nx, ny]): [number, number] => [
          nx * sheetA.widthPx,
          ny * sheetA.heightPx,
        ]);
        return shapeTouchesRegion(vertsPx, regA, s.measure_role);
      });

      // Test shapes on sheet B against region in sheet B coords
      const regB: ChangedRegion = {
        ...regA,
        bounds: boundsB,
        hull: bboxToPolygon(boundsB, 4),
        segments: regA.segments?.map((s) => {
          const b0 = inverseAlignBounds([s[0], s[1], s[0], s[1]], align);
          const b1 = inverseAlignBounds([s[2], s[3], s[2], s[3]], align);
          return [b0[0], b0[1], b1[0], b1[1]] as Segment;
        }),
      };
      const touchedB = sheetShapesB.filter((s) => {
        const vertsPx = (s.verts_norm || []).map(([nx, ny]): [number, number] => [
          nx * sheetB.widthPx,
          ny * sheetB.heightPx,
        ]);
        return shapeTouchesRegion(vertsPx, regB, s.measure_role);
      });

      for (const s of touchedA) attributedIdsA.add(s.id);
      for (const s of touchedB) attributedIdsB.add(s.id);

      const quantities = summarizeQuantities(touchedA, touchedB, revisedMeasured);
      const touchedAny = [...touchedA, ...touchedB];
      const reasons: string[] = [];
      if (touchedAny.some((s) => s.measure_role === "count" || (s.verts_norm?.length || 0) === 1)) {
        reasons.push("Count mark touches changed ink");
      }
      if (touchedAny.some((s) => s.measure_role === "linear" || (s.verts_norm?.length || 0) === 2)) {
        reasons.push("Linear run crosses changed ink");
      }
      if (touchedAny.some((s) => (s.verts_norm?.length || 0) >= 3 && s.measure_role !== "linear" && s.measure_role !== "count")) {
        reasons.push(chg.kind === "cloud" ? "Shape enclosed by revision cloud" : "Takeoff polygon touches changed ink");
      }
      if (chg.textItems.length > 0) {
        reasons.push("Text changed in region");
      }
      if (scaleMismatch) {
        reasons.push(`Sheet scale differs (${sheetA.scale} vs ${sheetB.scale})`);
      }
      if (!reasons.length && (touchedA.length > 0 || touchedB.length > 0)) {
        reasons.push("Takeoff shape intersects drawing change");
      }
      if (!reasons.length) {
        reasons.push("Drawing changed with no takeoff shapes touched");
      }

      const textBefore = chg.textItems.map((t) => t.textA).filter(Boolean).join("; ") || undefined;
      const textAfter = chg.textItems.map((t) => t.textB).filter(Boolean).join("; ") || undefined;

      let summary = "";
      if (chg.kind === "text") {
        summary = formatTextSummary(chg.textItems);
      } else if (chg.kind === "cloud") {
        summary = `Revision cloud (${regA.segmentCount} segments)`;
      } else if (chg.kind === "mixed") {
        summary = `${regA.segmentCount} changed segments + ${formatTextSummary(chg.textItems)}`;
      } else {
        summary = `${regA.segmentCount} changed ${diffMethod === "raster" ? "raster cells" : "segments"} (${regA.type})`;
      }

      const hasExposure = !revisedMeasured && touchedA.length > 0;
      const anyDelta = quantities.some((q) => q.delta !== null && Math.abs(q.delta) >= 0.01);
      const status: RevisionLedgerEntry["status"] = hasExposure
        ? "exposure"
        : revisedMeasured
          ? anyDelta || touchedA.length > 0 || touchedB.length > 0
            ? "measured"
            : "unchanged"
          : "unchanged";

      const id = `chg-${entrySeq++}`;
      sheetEntryIds.push(id);
      entries.push({
        id,
        sheet_number: sheetNumber,
        sheet_a: sheetA.key,
        sheet_b: sheetB.key,
        kind: chg.kind,
        change_type: regA.type,
        summary,
        source_region_a: {
          bounds: regA.bounds,
          hull: regA.hull,
          segment_count: regA.segmentCount,
          ...(textBefore ? { text: textBefore } : {}),
        },
        source_region_b: {
          bounds: boundsB,
          hull: bboxToPolygon(boundsB, 4),
          segment_count: regA.segmentCount,
          ...(textAfter ? { text: textAfter } : {}),
        },
        shapes_a: touchedA.map((s) => toShapeRef(s, condMapA)),
        shapes_b: touchedB.map((s) => toShapeRef(s, condMapB)),
        quantities,
        status,
        reasons,
        agent_check: { checked: false },
        estimator_approval: { approved: false },
      });
    }

    // Per-sheet reconciliation: delta = attributed + unattributed (to 0.01)
    const unattrShapesA = sheetShapesA.filter((s) => !attributedIdsA.has(s.id));
    const unattrShapesB = sheetShapesB.filter((s) => !attributedIdsB.has(s.id));

    const sumField = (list: TakeoffShape[], field: LedgerField) =>
      list.reduce((acc, s) => (unitForRole(s.measure_role).field === field ? acc + shapeQuantity(s) : acc), 0);

    const reconciliation: SheetReconciliationRow[] = [];
    let hasUnattributedDelta = false;

    for (const field of LEDGER_FIELDS) {
      const unit = field === "lf" ? "LF" : field === "ea" ? "EA" : "SF";
      const before = round2(sumField(sheetShapesA, field));
      const afterRaw = sumField(sheetShapesB, field);
      const after = revisedMeasured ? round2(afterRaw) : null;
      const delta = revisedMeasured ? round2(afterRaw - sumField(sheetShapesA, field)) : null;

      const attrA = sheetShapesA.filter((s) => attributedIdsA.has(s.id));
      const attrB = sheetShapesB.filter((s) => attributedIdsB.has(s.id));
      const attributed = revisedMeasured ? round2(sumField(attrB, field) - sumField(attrA, field)) : null;
      const unattributed = revisedMeasured ? round2(sumField(unattrShapesB, field) - sumField(unattrShapesA, field)) : null;

      if (before === 0 && (after === null || after === 0)) continue;
      if (unattributed !== null && Math.abs(unattributed) >= 0.01) {
        hasUnattributedDelta = true;
      }

      const reconciles =
        delta === null || attributed === null || unattributed === null
          ? true
          : Math.abs(round2(attributed + unattributed) - delta) <= 0.01;

      reconciliation.push({
        field,
        unit,
        before,
        after,
        delta,
        attributed,
        unattributed,
        reconciles,
        exposure: revisedMeasured ? 0 : before,
      });
    }

    // Also check if unattributed shapes changed even if net delta happened to cancel
    const unattrAIds = new Map(unattrShapesA.map((s) => [s.id, round2(shapeQuantity(s))]));
    const unattrBIds = new Map(unattrShapesB.map((s) => [s.id, round2(shapeQuantity(s))]));
    const changedUnattrA: TakeoffShape[] = [];
    const changedUnattrB: TakeoffShape[] = [];
    for (const s of unattrShapesA) {
      const qb = unattrBIds.get(s.id);
      if (qb === undefined || Math.abs(qb - round2(shapeQuantity(s))) >= 0.01) {
        changedUnattrA.push(s);
      }
    }
    for (const s of unattrShapesB) {
      const qa = unattrAIds.get(s.id);
      if (qa === undefined || Math.abs(round2(shapeQuantity(s)) - qa) >= 0.01) {
        changedUnattrB.push(s);
      }
    }

    const unattributedShapeIds = Array.from(
      new Set([...changedUnattrA.map((s) => s.id), ...changedUnattrB.map((s) => s.id)])
    );

    if (revisedMeasured && (hasUnattributedDelta || unattributedShapeIds.length > 0)) {
      const id = `chg-${entrySeq++}`;
      sheetEntryIds.push(id);
      entries.push({
        id,
        sheet_number: sheetNumber,
        sheet_a: sheetA.key,
        sheet_b: sheetB.key,
        kind: "unattributed",
        change_type: "unattributed",
        summary: `Quantity changed outside drawing changes (${unattributedShapeIds.length} shape${unattributedShapeIds.length === 1 ? "" : "s"})`,
        source_region_a: null,
        source_region_b: null,
        shapes_a: changedUnattrA.map((s) => toShapeRef(s, condMapA)),
        shapes_b: changedUnattrB.map((s) => toShapeRef(s, condMapB)),
        quantities: summarizeQuantities(changedUnattrA, changedUnattrB, true),
        status: "unattributed",
        reasons: ["Quantity changed where the drawing did not"],
        agent_check: { checked: false },
        estimator_approval: { approved: false },
      });
    }

    pairedSummaries.push({
      sheet_number: sheetNumber,
      sheet_a: sheetA.key,
      sheet_b: sheetB.key,
      revised_measured: revisedMeasured,
      alignment: align,
      diff_method: diffMethod,
      scale_a: sheetA.scale ?? null,
      scale_b: sheetB.scale ?? null,
      scale_mismatch: scaleMismatch,
      reconciliation,
      entry_ids: sheetEntryIds,
      unattributed_shape_ids: unattributedShapeIds,
    });
  }

  return {
    set_a_label: setALabel,
    set_b_label: setBLabel,
    created_at: new Date().toISOString(),
    paired_sheets: pairedSummaries,
    unpaired_sheets: {
      unmatched_base: matchSet.unmatchedBase.map((s) => ({ key: s.key, sheetNumber: s.sheetNumber ?? null })),
      unmatched_incoming: matchSet.unmatchedIncoming.map((s) => ({ key: s.key, sheetNumber: s.sheetNumber ?? null })),
      ambiguous: matchSet.ambiguous.map((a) => ({
        sheetNumber: a.sheetNumber,
        base_keys: a.base.map((b) => b.key),
        incoming_keys: a.incoming.map((i) => i.key),
      })),
    },
    entries,
  };
}

export function ledgerToCsv(ledger: RevisionLedger): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const row = (cells: unknown[]) => cells.map(esc).join(",");
  const lines: string[] = [];
  lines.push(`# Revision Delta Ledger: ${ledger.set_a_label} -> ${ledger.set_b_label}`);
  lines.push(
    row([
      "Entry ID",
      "Sheet",
      "Kind",
      "Status",
      "Summary",
      "Shapes Before",
      "Shapes After",
      "Unit",
      "Before",
      "After",
      "Delta",
      "Exposure",
      "Reasons",
      "Agent Checked",
      "Estimator Approved",
    ])
  );
  for (const e of ledger.entries) {
    const q = e.quantities[0];
    lines.push(
      row([
        e.id,
        e.sheet_number,
        e.kind,
        e.status,
        e.summary,
        e.shapes_a.map((s) => `${s.finish_tag}:${s.id}`).join("; "),
        e.shapes_b.map((s) => `${s.finish_tag}:${s.id}`).join("; "),
        q ? q.unit : "",
        q ? q.before : "",
        q && q.after !== null ? q.after : "",
        q && q.delta !== null ? q.delta : "",
        q ? q.exposure : "",
        e.reasons.join("; "),
        e.agent_check.checked ? "yes" : "no",
        e.estimator_approval.approved ? "yes" : "no",
      ])
    );
  }
  if (ledger.paired_sheets.length) {
    lines.push("");
    lines.push(row(["Sheet", "Field", "Unit", "Before", "After", "Delta", "Attributed", "Unattributed", "Reconciles"]));
    for (const s of ledger.paired_sheets) {
      for (const r of s.reconciliation) {
        lines.push(
          row([
            s.sheet_number,
            r.field,
            r.unit,
            r.before,
            r.after ?? "",
            r.delta ?? "",
            r.attributed ?? "",
            r.unattributed ?? "",
            r.reconciles ? "yes" : "no",
          ])
        );
      }
    }
  }
  return lines.join("\n");
}
