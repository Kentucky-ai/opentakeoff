// Sheet zoning — plan regions vs annotation territory, decided BEFORE any
// wall reasoning (room-engine v2, Stage 0).
//
// A construction sheet is mostly not plan: title-block margins, schedule
// tables, general notes, legends. The wall classifier downstream cannot tell
// a schedule row rule from a wall face — both are parallel ink at plausible
// offsets — but the sheet's TEXT can: tables and notes are dense columns of
// aligned text rows, and the title block lives behind a full-height margin
// rule. Zoning is deterministic and text-driven; no geometry is trusted to
// prove it isn't annotation from linework alone.
//
// Inputs are text span BOXES in image px (same space as extractVectorGeometry
// segments): {str, x0, y0, x1, y1}. The canvas builds them from pdf.js item
// transforms; headless callers use mcp/src/pdf.ts textSpans().

export interface TextSpanBox { str: string; x0: number; y0: number; x1: number; y1: number }
export interface Zone { x0: number; y0: number; x1: number; y1: number; kind: "margin" | "table" }

/** Words that mark a text cluster as annotation regardless of its shape. */
const ZONE_WORDS = /\b(SCHEDULE|GENERAL\s+NOTES|LEGEND|ABBREVIATIONS?|KEYNOTES?|SHEET\s+INDEX)\b|^SCH[-.]/i;

/** A zone may never swallow the plan: cap on one zone's share of the sheet. */
const ZONE_MAX_FRAC = 0.2;

/** Annotation zones of a sheet.
 *  - MARGIN: everything right of the title-block rule — the leftmost
 *    near-vertical stroke spanning most of the sheet height in the right
 *    band. (A/E-size CDs carry the title block as a right-edge column; a
 *    sheet without one simply yields no margin zone.)
 *  - TABLE: schedule/notes/legend blocks — maximal runs of ≥5 text spans
 *    sharing a left edge at near-uniform row pitch (a table's mark column, a
 *    notes list, a legend's label column), merged with overlapping runs and
 *    with any ZONE_WORDS header nearby. Dimension strips along plan edges
 *    zone out the same way — they are annotation too and no wall lives in
 *    them.
 */
export function annotationZones(spans: TextSpanBox[], segs: number[], W: number, H: number): Zone[] {
  const zones: Zone[] = [];

  // ── margin: the title-block rule ─────────────────────────────────────────
  let marginX = Infinity;
  const n = segs.length >> 2;
  for (let i = 0; i < n; i++) {
    const dx = Math.abs(segs[i * 4 + 2] - segs[i * 4]);
    const dy = Math.abs(segs[i * 4 + 3] - segs[i * 4 + 1]);
    const x = Math.min(segs[i * 4], segs[i * 4 + 2]);
    if (dx <= 2 && dy >= 0.55 * H && x > 0.8 * W && x < marginX) marginX = x;
  }
  if (Number.isFinite(marginX)) zones.push({ x0: marginX - 2, y0: 0, x1: W, y1: H, kind: "margin" });

  // ── tables/notes: left-aligned uniform text columns ──────────────────────
  const plan = spans.filter((s) => s.str.trim().length >= 2 && (Number.isFinite(marginX) ? s.x0 < marginX : true));
  // bucket by left edge; a run = consecutive spans in a bucket whose row gaps
  // stay under ~3.2 text heights (a table row pitch; a paragraph line pitch)
  const buckets = new Map<number, TextSpanBox[]>();
  for (const s of plan) {
    const b = Math.round(s.x0 / 8);
    let a = buckets.get(b); if (!a) { a = []; buckets.set(b, a); }
    a.push(s);
  }
  const runs: TextSpanBox[][] = [];
  for (const a of buckets.values()) {
    if (a.length < 5) continue;
    a.sort((p, q) => p.y0 - q.y0);
    let run: TextSpanBox[] = [a[0]];
    for (let i = 1; i <= a.length; i++) {
      const prev = run[run.length - 1];
      const gapCap = 3.2 * Math.max(prev.y1 - prev.y0, 6);
      if (i < a.length && Math.abs(a[i].x0 - prev.x0) <= 6 && a[i].y0 - prev.y0 <= gapCap) run.push(a[i]);
      else { if (run.length >= 5) runs.push(run); run = i < a.length ? [a[i]] : []; }
    }
  }
  // keyword headers seed zones even without a qualifying column under them
  for (const s of plan) if (ZONE_WORDS.test(s.str)) runs.push([s]);
  // run bboxes, padded by a row height so the table's border rules fall inside
  let boxes = runs.map((r) => {
    const pad = Math.max(...r.map((s) => s.y1 - s.y0), 8) * 1.5;
    return {
      x0: Math.min(...r.map((s) => s.x0)) - pad, y0: Math.min(...r.map((s) => s.y0)) - pad,
      x1: Math.max(...r.map((s) => s.x1)) + pad, y1: Math.max(...r.map((s) => s.y1)) + pad,
    };
  });
  // merge overlapping boxes to fixpoint (a schedule = mark column + comment
  // column + header, each its own run over the same table)
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) {
        boxes[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
        boxes.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  for (const b of boxes) {
    if ((b.x1 - b.x0) * (b.y1 - b.y0) > ZONE_MAX_FRAC * W * H) continue;   // never swallow the plan
    zones.push({ ...b, kind: "table" });
  }
  return zones;
}

/** Is a point inside any zone? */
export function inZones(zones: Zone[], x: number, y: number): boolean {
  for (const z of zones) if (x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) return true;
  return false;
}

/** Text-decoration test for one segment: its midpoint sits inside an
 *  (inflated) text box and it is no longer than that text run — underlines,
 *  strikeouts, tag boxes, table rules WITHIN a cell. A wall PASSING under
 *  text is longer than the text and survives. The inflation is generous
 *  (±0.8·h sideways, ±1.0·h vertically) because room-tag BOXES pad beyond
 *  their text — and this architect parks tags AT door openings, where a
 *  surviving box rail cap-qualifies and steals the jamb's seal partner. */
export function isTextDecoration(spans: TextSpanBox[], grid: Map<number, number[]>, cell: number, x1: number, y1: number, x2: number, y2: number): boolean {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1);
  const b = grid.get(Math.floor(my / cell) * 131071 + Math.floor(mx / cell));
  if (!b) return false;
  for (const i of b) {
    const s = spans[i];
    const h = Math.max(s.y1 - s.y0, 4);
    if (mx >= s.x0 - h * 0.8 && mx <= s.x1 + h * 0.8 && my >= s.y0 - h && my <= s.y1 + h
        && len <= 1.6 * Math.max(s.x1 - s.x0, s.y1 - s.y0) + 6) return true;
  }
  return false;
}

/** Spatial hash of span boxes for isTextDecoration (cell should comfortably
 *  exceed a text height; 64 px matches the segment grids). */
export function spanGrid(spans: TextSpanBox[], cell = 64): Map<number, number[]> {
  const g = new Map<number, number[]>();
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    const h = Math.max(s.y1 - s.y0, 4);
    for (let cy = Math.floor((s.y0 - h) / cell); cy <= Math.floor((s.y1 + h) / cell); cy++)
      for (let cx = Math.floor((s.x0 - h) / cell); cx <= Math.floor((s.x1 + h) / cell); cx++) {
        const k = cy * 131071 + cx;
        let a = g.get(k); if (!a) { a = []; g.set(k, a); }
        a.push(i);
      }
  }
  return g;
}
