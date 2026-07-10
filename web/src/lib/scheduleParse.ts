// Finish/material-schedule → conditions importer (the "Import from schedule"
// marquee feature). PURE and pdfjs-free on purpose: it takes already-positioned
// text tokens and returns normalized rows, so the SAME parser serves both paths —
//   • vector plans: tokens come from the page text layer (sheets.extractRegionText)
//   • scanned plans: tokens come from a server OCR/VLM adapter that returns the
//     same {str,x,y,h} shape (or ScheduleRow[] directly).
// The dialog approves rows; rowToSeed() maps an approved row to a condition seed
// the canvas instantiates. Kept here (not in the canvas) so the column math is
// testable — the sheets.ts / oneclick.ts precedent.

export type Token = { str: string; x: number; y: number; h: number };

export type Category = "floor" | "base" | "wall" | "transition" | "ceiling" | "other";

export type ScheduleRow = {
  finish_tag: string;        // CODE cell, e.g. "CPT-1"
  section: string;           // raw section header it fell under, e.g. "FLOORING"
  category: Category;        // section → category; drives default color + the checkbox
  description: string;       // MATERIAL/PRODUCT cell
  manufacturer: string;      // MANUFACTURER cell
  style: string;             // STYLE cell
  spec_color: string;        // COLOR cell (the spec'd color, e.g. "1408 HIGH ROLLER")
  size: string;              // SIZE cell
  suggested: boolean;        // default-checked in the dialog (ceiling/other start off)
};

// Section header text → category. A flooring tool cares about floor/base/wall
// (+ transitions); ceilings and millwork are parsed but start UNCHECKED so the
// estimator never has to hunt them down — they can still opt one in per-row.
const SECTION_CATEGORY: Record<string, Category> = {
  FLOORING: "floor", FLOOR: "floor",
  BASE: "base", BASES: "base",
  WALLS: "wall", WALL: "wall",
  MISC: "transition", TRANSITIONS: "transition", TRANSITION: "transition", TRIM: "transition",
  MILLWORK: "other",
  CEILINGS: "ceiling", CEILING: "ceiling",
};
const SUGGESTED: Record<Category, boolean> = {
  floor: true, base: true, wall: true, transition: true, ceiling: false, other: false,
};

// The seven schedule columns, in order. We anchor bands off whichever header
// tokens we find (empty cells emit no token, so anchoring to the header — not to
// the nearest data word — is what keeps blank cells from stealing a neighbour).
const COLUMNS = ["CODE", "MATERIAL", "MANUFACTURER", "STYLE", "COLOR", "SIZE", "REMARKS"] as const;
type Column = (typeof COLUMNS)[number];

// A finish code: 1–4 caps, optional "-" + alphanumerics (CPT-1, PT-2, RB-1,
// ACT-1, PLAM-2, RES-W), or a lone letter (C = concrete sealer). Section words
// are caps too, so the caller checks those first.
const CODE_RE = /^[A-Z]{1,4}(-[A-Z0-9]{1,4})?$/;

const norm = (s: string) => (s || "").trim().toUpperCase();
const sectionKey = (s: string) => norm(s).replace(/[^A-Z]/g, "");

// Cluster tokens into visual rows by y, then order each row left→right. A row's
// y is the running average so a tall cell doesn't split. tolFrac scales the gap
// test to the text height so it works at any raster/zoom.
function clusterRows(tokens: Token[]): Token[][] {
  const toks = [...tokens].filter((t) => t.str && t.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Token[][] = [];
  let cur: Token[] = [];
  let cy = 0;
  for (const t of toks) {
    const tol = Math.max(t.h * 0.6, 4);
    if (cur.length && Math.abs(t.y - cy) > tol) { rows.push(cur); cur = []; }
    cur.push(t);
    cy = cur.reduce((s, w) => s + w.y, 0) / cur.length;
  }
  if (cur.length) rows.push(cur);
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

const cx = (t: Token) => t.x + 0; // x is the left edge; header cells left-align, so left edge anchors best

// Find the header row and return its column anchors (x of each found header
// token, sorted). Requires CODE plus one of MANUFACTURER/COLOR so we don't
// mistake a data row for the header.
function findAnchors(rows: Token[][]): { col: Column; x: number }[] | null {
  for (const r of rows) {
    const ups = r.map((t) => norm(t.str).replace(/[^A-Z]/g, ""));
    const hasCode = ups.includes("CODE");
    const hasAnchor = ups.includes("MANUFACTURER") || ups.includes("COLOR");
    if (!hasCode || !hasAnchor) continue;
    const anchors: { col: Column; x: number }[] = [];
    for (const t of r) {
      const u = norm(t.str).replace(/[^A-Z]/g, "");
      for (const c of COLUMNS) if (u.startsWith(c.slice(0, 5))) { anchors.push({ col: c, x: cx(t) }); break; }
    }
    // de-dupe (a wrapped header can repeat) keeping the leftmost, need ≥3 to band
    const seen = new Set<string>();
    const uniq = anchors.filter((a) => (seen.has(a.col) ? false : (seen.add(a.col), true))).sort((a, b) => a.x - b.x);
    if (uniq.length >= 3) return uniq;
  }
  return null;
}

// Which column a token's x falls in: nearest-anchor with fixed midpoint bounds.
function columnFor(x: number, anchors: { col: Column; x: number }[]): Column {
  let best = anchors[0];
  for (const a of anchors) if (Math.abs(a.x - x) < Math.abs(best.x - x)) best = a;
  return best.col;
}

/**
 * Parse positioned tokens (already cropped to the marquee region) into rows.
 * Returns [] when no header/section structure is found — the caller shows
 * "no schedule detected here" rather than inventing rows.
 */
export function parseSchedule(tokens: Token[]): ScheduleRow[] {
  const rows = clusterRows(tokens);
  const anchors = findAnchors(rows);
  if (!anchors) return [];

  let section: string | null = null;
  const out: ScheduleRow[] = [];
  for (const r of rows) {
    const first = r[0];
    const key = sectionKey(first.str);
    const joined = r.map((t) => t.str).join(" ").trim();
    // a lone-ish section header row
    if (SECTION_CATEGORY[key] && joined.length < 24) { section = key; continue; }
    // data rows need a section and a code-shaped first cell
    const codeTok = norm(first.str).replace(/[^A-Z0-9-]/g, "");
    if (!section || !CODE_RE.test(codeTok)) continue;

    const cells: Record<Column, string[]> = { CODE: [], MATERIAL: [], MANUFACTURER: [], STYLE: [], COLOR: [], SIZE: [], REMARKS: [] };
    for (const t of r) cells[columnFor(cx(t), anchors)].push(t.str.trim());
    const category = SECTION_CATEGORY[section] ?? "other";
    out.push({
      finish_tag: codeTok,
      section,
      category,
      description: cells.MATERIAL.join(" ").trim(),
      manufacturer: cells.MANUFACTURER.join(" ").trim(),
      style: cells.STYLE.join(" ").trim(),
      spec_color: cells.COLOR.join(" ").trim(),
      size: cells.SIZE.join(" ").trim(),
      suggested: SUGGESTED[category],
    });
  }
  return out;
}

// Default line/fill palette when the canvas doesn't pass its own — mirrors the
// canvas PALETTE order loosely; the estimator can recolor after.
const FALLBACK_PALETTE = ["#2f7d54", "#2563eb", "#9333ea", "#be185d", "#b8860b", "#0d9488", "#475569", "#c96442"];
// Category → default hatch + waste so an imported floor reads like a floor and a
// base like a base without the estimator touching the appearance editor.
const CAT_HATCH: Record<Category, string> = { floor: "solid", base: "horiz", wall: "grid", transition: "vert", ceiling: "solid", other: "solid" };
const CAT_WASTE: Record<Category, number> = { floor: 5, base: 10, wall: 10, transition: 0, ceiling: 0, other: 0 };

export type ConditionSeed = {
  finish_tag: string;
  color: string;
  hatch: string;
  waste_pct: number;
  materials: never[];
  // product spec, for the canvas to drop into condition attrs / report columns
  spec: { manufacturer: string; style: string; color: string; size: string };
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
    spec: { manufacturer: row.manufacturer, style: row.style, color: row.spec_color, size: row.size },
    category: row.category,
  };
}
