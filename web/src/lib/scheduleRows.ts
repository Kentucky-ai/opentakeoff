// Import from schedule — the row contract and the row → condition seed step.
// Kept LIGHT on purpose: no reader in here, so the canvas can seed conditions
// from approved rows without loading the sheet graph (scheduleRead.ts, loaded
// on demand, is the reader). The reader emits ScheduleRow, and the approval
// dialog takes ScheduleRow.

/** A positioned text token as extractRegionText emits it: baseline-left
 *  origin (x, y) in image px, glyph height h, no width. */
export type Token = { str: string; x: number; y: number; h: number };

/** A takeoff category. "wall_protection" is its own (a CSI division of its
 *  own); "unassigned" is a row the schedule gives no section and whose words
 *  name no item — the dialog lists it under "No section". */
export type Category = "floor" | "base" | "wall" | "wall_protection" | "transition" | "ceiling" | "other" | "unassigned";

/** Where a row's category came from: a printed section heading, the row's
 *  own item words ("RUBBER WALL BASE") or nothing (unassigned). The dialog
 *  flags a category read from the words. */
export type CategorySource = "heading" | "text" | "none";

export type ScheduleRow = {
  finish_tag: string;        // key cell (CODE / TAG / MARK / SYMBOL), e.g. "CPT-1"
  section: string;           // printed section heading it fell under, e.g. "FLOORING" ("" = none)
  category: Category;        // drives default color + the checkbox
  category_source: CategorySource;
  description: string;       // MATERIAL / DESCRIPTION / PRODUCT cells
  manufacturer: string;      // MANUFACTURER cell
  style: string;             // STYLE cell
  spec_color: string;        // COLOR cell (the spec'd color, e.g. "1408 RIVERSTONE")
  size: string;              // SIZE cell
  remarks: string;           // REMARKS cell (else COMMENTS)
  suggested: boolean;        // default-checked in the dialog
};

// Default line/fill palette when the canvas doesn't pass its own — mirrors the
// canvas PALETTE order loosely; the estimator can recolor after.
const FALLBACK_PALETTE = ["#2f7d54", "#2563eb", "#9333ea", "#be185d", "#b8860b", "#0d9488", "#475569", "#c96442"];
// Category → default hatch + waste so an imported floor reads like a floor and a
// base like a base without the estimator touching the appearance editor.
const CAT_HATCH: Record<Category, string> = { floor: "solid", base: "horiz", wall: "grid", wall_protection: "horiz", transition: "vert", ceiling: "solid", other: "solid", unassigned: "solid" };
const CAT_WASTE: Record<Category, number> = { floor: 5, base: 10, wall: 10, wall_protection: 0, transition: 0, ceiling: 0, other: 0, unassigned: 0 };

export type ConditionSeed = {
  finish_tag: string;
  color: string;
  hatch: string;
  waste_pct: number;
  materials: never[];
  // product spec, for the canvas to drop into condition attrs / report columns.
  // `description` (the MATERIAL/PRODUCT cell, e.g. "WOOD WALL PANEL") rides along
  // so the most human-readable label survives import instead of being dropped.
  // `remarks` is present only when the schedule printed some.
  spec: { manufacturer: string; style: string; color: string; size: string; description: string; remarks?: string };
  category: Category;
};

/** Map an approved row to a condition seed (no ids — the canvas mints those). */
export function rowToSeed(row: ScheduleRow, index: number, palette: string[] = FALLBACK_PALETTE): ConditionSeed {
  const color = palette[index % palette.length] || FALLBACK_PALETTE[0];
  return {
    finish_tag: row.finish_tag,
    color,
    hatch: CAT_HATCH[row.category],
    waste_pct: CAT_WASTE[row.category],
    materials: [],
    spec: {
      manufacturer: row.manufacturer, style: row.style, color: row.spec_color, size: row.size, description: row.description,
      ...(row.remarks ? { remarks: row.remarks } : {}),
    },
    category: row.category,
  };
}
