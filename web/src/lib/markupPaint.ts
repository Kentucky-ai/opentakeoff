// Paint order + per-sheet scope for markups — the one rule BOTH the primary
// canvas's markup layer (TakeoffCanvas.jsx) and the reference pane's
// READ-ONLY mirror (ReferencePane.jsx) apply, so the mirror can never stack a
// different order than the pane it mirrors, and a mirror-only filter can't
// drift out of step with the canvas's own.
//
// Three draw tiers, matching the three HIT tiers (TakeoffCanvas's selectAt),
// so on-screen z-order never contradicts selection priority: image at the back
// (0), highlight (1), everything else on top (2). Painting is document order,
// so tier 0 draws first/behind and tier 2 last/on top.

export interface PaintableMarkup {
  type?: string;
  sheet_id?: string;
  /** capture/image pin shown by the reference-pins rail, never on the sheet itself */
  reference_only?: boolean;
}

export const markupTier = (m: PaintableMarkup): 0 | 1 | 2 =>
  m.type === "image" ? 0 : m.type === "highlight" ? 1 : 2;

/** Paint-ordered COPY (Array#sort is stable, so same-tier markups keep their order). */
export function paintOrderedMarkups<T extends PaintableMarkup>(list: readonly T[]): T[] {
  return list.slice().sort((a, b) => markupTier(a) - markupTier(b));
}

/**
 * The reference pane's mirror scope: one sheet (its effective refKey), live
 * records only, in paint order. `reference_only` markups are pins for the
 * reference rail, not ink on a sheet, so they never mirror. A falsy key
 * mirrors nothing rather than falling through to every markup on the project.
 */
export function markupsForSheet<T extends PaintableMarkup>(markups: readonly T[], sheetKey: string | null | undefined): T[] {
  if (!sheetKey) return [];
  return paintOrderedMarkups(markups.filter((m) => !m.reference_only && m.sheet_id === sheetKey));
}
