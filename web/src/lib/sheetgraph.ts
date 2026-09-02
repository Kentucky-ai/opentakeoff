// The sheet graph (#87, phases 1–3) — a pure, client-side plan-set index built
// from positioned text spans: sheet roles, schedule tables (including tables
// that CONTINUE across sheets and tables with rotated column headers), room
// tags qualified by building, detail callouts, revision markers (delta
// triangles / REV tags — the flag that a row's answer changed under an
// addendum), and the resolution room tag → schedule row → finish definition.
// No pdf.js, no DOM — the MCP server and the canvas both feed it spans.
//
// Doctrine (the RFC's): every edge carries an EVIDENCE pointer (sheet, text,
// bbox) — an edge without provenance is a hallucination with extra steps and
// is never created. A room on the plan with no schedule row comes back
// UNRESOLVED WITH A REASON, never silently omitted — the omission is how a
// bid gets lost. A room number reused across buildings is AMBIGUOUS until the
// tag is qualified ("A-134"), and the refusal lists the candidates rather
// than picking the first match. A set with no text layer degrades to
// "unavailable", cleanly.
//
// Composes the machinery the repo already trusts: scheduleParse's header-
// anchor table idiom (generalized here to arbitrary header vocabularies),
// detectRooms' room-tag pattern, and the span shape the MCP server already
// serves (sheet_context.text.spans).

import { ROOM_LABEL_RE } from "./detectRooms";

/** rot: text rotation in degrees, clockwise in device space (y down). Absent
 * or 0 = horizontal; 90/270 = a quarter-turn — the rotated-header case. When
 * rot is not provided (older span sources), a span at least four characters
 * long whose box is more than twice as tall as it is wide is treated as
 * vertical — a real horizontal token that long cannot be taller than wide. */
export interface GraphSpan { str: string; x: number; y: number; w: number; h: number; rot?: number }
/** segs (optional): the sheet's vector linework as flat [x1,y1,x2,y2, ...] in
 * the same px space as the spans (VectorGeometry.segs) — feeds the drawn
 * delta-triangle hunt. Text-only callers omit it and lose only that lane. */
export interface SheetSpans { key: string; sheet_number?: string | null; spans: GraphSpan[]; segs?: ArrayLike<number> }

export type SheetRole = "plan" | "schedule" | "legend" | "detail" | "elevation" | "demolition" | "unknown";
export type Bbox = [number, number, number, number];
export interface Evidence { sheet: string; text: string; bbox: Bbox }

const bboxOf = (s: GraphSpan): Bbox => [s.x, s.y, s.x + (s.w || 0), s.y + (s.h || 0)];
const merge = (a: Bbox, b: Bbox): Bbox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const norm = (s: string) => (s || "").trim().toUpperCase();
const isVertical = (s: GraphSpan): boolean =>
  s.rot != null
    ? Math.abs(s.rot % 180) === 90
    : (s.str || "").trim().length >= 4 && (s.w || 0) > 0 && (s.h || 0) > 2 * s.w;

// ── sheet role ──────────────────────────────────────────────────────────────
// Title text first (what the sheet SAYS it is), sheet-number convention as a
// weak fallback. Wrong-here poisons everything downstream, so mixed signals
// lower confidence instead of picking a winner silently — and a sheet can
// legitimately be a plan that CARRIES schedules (the common case); schedules
// are found per-region below regardless of the sheet's role.
// A standalone schedule TITLE ("ROOM FINISH SCHEDULE - FIRST FLOOR") is a far
// stronger signal than the word SCHEDULE appearing in running text.
// Apostrophes arrive both ways: ASCII ' and the typographic ’ (U+2019 —
// pdf.js maps a Type1 quoteright there), so every CONT'D pattern accepts both.
const SCHEDULE_TITLE_RE = /^[A-Z][A-Z ()/&.'’-]* SCHEDULE( *[-–] *[A-Z0-9 ()/&.'’-]+)?( *\(?(?:CONTINUATION|CONTINUED|CONT['’]?D?)\.?\)?)?$/;
const ROLE_SIGNALS: Array<{ re: RegExp; role: SheetRole; conf: number }> = [
  { re: /DEMOLITION\s+PLAN|DEMO\s+PLAN/, role: "demolition", conf: 0.9 },
  // every discipline draws plans, not just finishes — an M-sheet's "SECOND
  // FLOOR DUCTWORK PLAN" is as much a plan title as an A-sheet's finish plan
  { re: /(?:FINISH|FLOOR|FURNITURE|CEILING|DUCTWORK|PIPING|MECHANICAL|ELECTRICAL|LIGHTING|POWER|PLUMBING|SPRINKLER|HVAC|FRAMING|FOUNDATION|ROOF|SITE|EQUIPMENT)\s+PLAN\b/, role: "plan", conf: 0.85 },
  { re: SCHEDULE_TITLE_RE, role: "schedule", conf: 0.85 },
  { re: /SCHEDULE/, role: "schedule", conf: 0.5 },
  { re: /LEGEND/, role: "legend", conf: 0.5 },
  { re: /ELEVATIONS?\b/, role: "elevation", conf: 0.7 },
  { re: /DETAILS?\b|SECTIONS?\b/, role: "detail", conf: 0.6 },
];
// Running-text references are not titles: "SEE FINISH PLAN FOR ADDITIONAL
// INFORMATION" in a remark cell must never make a schedule sheet a plan.
const REFERENCE_RE = /^(SEE|REFER|PER|NOTED|AS SHOWN)\b|REFER TO/;

export function classifySheetRole(sheet: SheetSpans): { role: SheetRole; confidence: number; evidence: Evidence | null } {
  const hits: Array<{ role: SheetRole; conf: number; span: GraphSpan }> = [];
  for (const sp of sheet.spans) {
    const u = norm(sp.str);
    if (u.length < 4 || u.length > 60 || REFERENCE_RE.test(u)) continue;
    for (const sig of ROLE_SIGNALS) if (sig.re.test(u)) { hits.push({ role: sig.role, conf: sig.conf, span: sp }); break; }
  }
  if (!hits.length) {
    // sheet-number fallback: <discipline>-1xx is conventionally a plan — weak, stated as weak
    const n = norm(sheet.sheet_number || "");
    if (/^(A|M|E|P|S|FP)-?1\d\d/.test(n)) return { role: "plan", confidence: 0.4, evidence: null };
    return { role: "unknown", confidence: 0, evidence: null };
  }
  // strongest signal wins; disagreement between DISTINCT roles halves confidence
  hits.sort((a, b) => b.conf - a.conf);
  const best = hits[0];
  const dissent = hits.some((h) => h.role !== best.role && h.conf >= best.conf - 0.1);
  return {
    role: best.role,
    confidence: dissent ? best.conf / 2 : best.conf,
    evidence: { sheet: sheet.key, text: best.span.str.trim(), bbox: bboxOf(best.span) },
  };
}

// ── building context (#87 phase 2: the multi-building room key) ─────────────
// Multi-building sets reuse room numbers — room 134 in Building A is not room
// 134 in Building B, so the room key is (building, number), not the number
// alone. A building designator enters the vocabulary three ways: "BUILDING A"
// / "BLDG 2" text on a sheet or a table title, a qualified schedule row key
// ("A-134"), or a BLDG/BUILDING schedule column. Qualified PLAN tags are only
// accepted for designators the set actually names somewhere — otherwise every
// title-block sheet number ("A-601") would mint a phantom room.
const BUILDING_RE = /\b(?:BUILDING|BLDG\.?)\s+([A-Z]\d?|\d{1,2})\b/g;
const DESIGNATOR_RE = /^([A-Z]\d?|\d{1,2}|[A-Z]{2})$/;

function buildingMentions(text: string): string[] {
  const u = norm(text);
  if (u.length > 80 || REFERENCE_RE.test(u)) return [];
  return [...u.matchAll(BUILDING_RE)].map((m) => m[1]);
}

/** The sheet's own building context: set when the sheet names exactly ONE
 * building. A schedule sheet carrying two buildings' tables names two — no
 * sheet-level context; each table's own title decides. */
export function sheetBuilding(sheet: SheetSpans): { building: string; evidence: Evidence } | null {
  const seen = new Map<string, GraphSpan>();
  for (const sp of sheet.spans) {
    for (const b of buildingMentions(sp.str)) if (!seen.has(b)) seen.set(b, sp);
  }
  if (seen.size !== 1) return null;
  const [building, span] = [...seen.entries()][0];
  return { building, evidence: { sheet: sheet.key, text: span.str.trim(), bbox: bboxOf(span) } };
}

// ── revision markers (#87 phase 3) ──────────────────────────────────────────
// A delta triangle ("Δ2", "2▲") or a REV tag ("REV 2") is drafting's flag that
// the ink nearby CHANGED under a revision — the printed value is the current
// answer, but reading it without surfacing the delta is how a superseded
// number gets priced confidently. Two failure modes this section kills:
//   - a delta sitting left of a schedule row's key column used to strip to its
//     bare digit and MINT a room ("Δ2" → row key "2") — markers are excluded
//     from banding entirely;
//   - a revised row read as if nothing happened — the marker attaches to the
//     row (and to a plan tag it sits beside) and rides every resolution.
// The honest limit, named: a revision CLOUD is linework, not text — a clouded
// row with no delta/REV text is invisible to a spans-only pass. That gap is
// phase 4 (geometry), not something to fake here.
export interface RevisionMarker { rev: string; sheet: string; bbox: Bbox; drawn?: boolean }
export interface RowRevision { rev: string; source: Evidence; drawn?: boolean }
/** Per-sheet drawn-delta index: the bare-digit span → its triangle's bbox. */
export type DeltaIndex = Map<GraphSpan, Bbox>;
const DELTA_MARK_RE = /^[Δ∆△▲]\s*(\d{1,2}[A-Z]?)$|^(\d{1,2}[A-Z]?)\s*[Δ∆△▲]$/;
const REV_MARK_RE = /^REV(?:ISION)?\.?\s*#?\s*(\d{1,2}[A-Z]?)$/;

/** The revision a span IS a marker for, or null. Tight on purpose: a bare
 * number is never a marker, and running text never matches (whole-span only). */
export const revisionOf = (s: string): string | null => {
  const t = norm(s);
  if (!t || t.length > 12) return null;
  const d = t.match(DELTA_MARK_RE);
  if (d) return d[1] ?? d[2];
  const r = t.match(REV_MARK_RE);
  return r ? r[1] : null;
};

// ── drawn delta triangles ───────────────────────────────────────────────────
// Real CAD sets rarely EMIT "Δ2" as text: the convention is a drawn triangle
// (three linework segments) with a bare digit inside, and the text layer
// carries just "2" — which the text pass rightly refuses (a bare number can't
// be a marker, or every dimension becomes a revision). The geometry closes
// that gap: a 1–2 digit span becomes a marker exactly when three segments of
// digit scale close into a triangle around it. Guards, each killing a real
// false-positive class: side length is bounded to digit scale (a roof slope
// or a big triangular region never qualifies), the three sides must roughly
// agree (max/min ≤ 2.5 — drafting deltas are near-equilateral), the loop must
// CLOSE corner-to-corner (a circle's many short chords never form a 3-cycle,
// so grid bubbles and detail circles stay out), and a dense neighbourhood
// (hatch) refuses rather than guesses.
const BARE_DIGIT_RE = /^\d{1,2}$/;

/** segs: flat [x1,y1,x2,y2, ...] in the SAME px space as the spans (the
 * VectorGeometry.segs shape the engine already extracts). Returns each bare-
 * digit span that sits inside a digit-scale drawn triangle, with the
 * triangle's bbox. Pure; O(spans·nearby) with a coarse grid prefilter. */
export function drawnDeltaMarkers(spans: GraphSpan[], segs: ArrayLike<number>): Array<{ span: GraphSpan; tri: Bbox }> {
  const cands = spans.filter((s) => BARE_DIGIT_RE.test((s.str || "").trim()));
  if (!cands.length || !segs.length) return [];
  // coarse grid over segment midpoints, digit-scale segments only
  const CELL = 64;
  const grid = new Map<string, number[]>();
  const nSeg = Math.floor(segs.length / 4);
  for (let i = 0; i < nSeg; i++) {
    const dx = segs[i * 4 + 2] - segs[i * 4], dy = segs[i * 4 + 3] - segs[i * 4 + 1];
    const len = Math.hypot(dx, dy);
    if (len < 4 || len > 400) continue;                     // digit-scale window, generous
    const mx = (segs[i * 4] + segs[i * 4 + 2]) / 2, my = (segs[i * 4 + 1] + segs[i * 4 + 3]) / 2;
    const k = `${Math.floor(mx / CELL)},${Math.floor(my / CELL)}`;
    let cell = grid.get(k);
    if (!cell) grid.set(k, (cell = []));
    cell.push(i);
  }
  const out: Array<{ span: GraphSpan; tri: Bbox }> = [];
  for (const sp of cands) {
    const h = Math.max(sp.h || 8, 6);
    const cx = sp.x + (sp.w || 0) / 2, cy = sp.y + h / 2;
    const R = h * 5;
    const near: number[] = [];
    for (let gx = Math.floor((cx - R) / CELL); gx <= Math.floor((cx + R) / CELL); gx++) {
      for (let gy = Math.floor((cy - R) / CELL); gy <= Math.floor((cy + R) / CELL); gy++) {
        for (const i of grid.get(`${gx},${gy}`) || []) {
          const mx = (segs[i * 4] + segs[i * 4 + 2]) / 2, my = (segs[i * 4 + 1] + segs[i * 4 + 3]) / 2;
          const len = Math.hypot(segs[i * 4 + 2] - segs[i * 4], segs[i * 4 + 3] - segs[i * 4 + 1]);
          if (Math.hypot(mx - cx, my - cy) <= R && len >= h * 1.2 && len <= h * 8) near.push(i);
        }
      }
    }
    if (near.length < 3 || near.length > 60) continue;      // dense hatch → refuse, never guess
    const tol = Math.max(2, h * 0.35);
    let best: Bbox | null = null;
    let bestArea = Infinity;
    const P = (i: number, end: 0 | 1): [number, number] => [segs[i * 4 + end * 2], segs[i * 4 + 1 + end * 2]];
    const close = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
    for (let a = 0; a < near.length; a++) for (let b = a + 1; b < near.length; b++) for (let c = b + 1; c < near.length; c++) {
      // a 3-cycle: each segment's ends pair corner-to-corner with the other two
      for (const fa of [0, 1] as const) for (const fb of [0, 1] as const) for (const fc of [0, 1] as const) {
        const [a0, a1] = [P(near[a], fa), P(near[a], (1 - fa) as 0 | 1)];
        const [b0, b1] = [P(near[b], fb), P(near[b], (1 - fb) as 0 | 1)];
        const [c0, c1] = [P(near[c], fc), P(near[c], (1 - fc) as 0 | 1)];
        if (!close(a1, b0) || !close(b1, c0) || !close(c1, a0)) continue;
        const v: Array<[number, number]> = [a0, b0, c0];
        const side = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
        const s01 = side(v[0], v[1]), s12 = side(v[1], v[2]), s20 = side(v[2], v[0]);
        const mx = Math.max(s01, s12, s20), mn = Math.min(s01, s12, s20);
        if (mn < h * 1.2 || mx > h * 8 || mx / mn > 2.5) continue;
        // the digit strictly inside (consistent cross-product sign)
        const cross = (p: [number, number], q: [number, number]) => (q[0] - p[0]) * (cy - p[1]) - (q[1] - p[1]) * (cx - p[0]);
        const d0 = cross(v[0], v[1]), d1 = cross(v[1], v[2]), d2 = cross(v[2], v[0]);
        if (!((d0 > 0 && d1 > 0 && d2 > 0) || (d0 < 0 && d1 < 0 && d2 < 0))) continue;
        const area = Math.abs((v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[2][0] - v[0][0]) * (v[1][1] - v[0][1])) / 2;
        if (area < bestArea) {
          bestArea = area;
          best = [Math.min(v[0][0], v[1][0], v[2][0]), Math.min(v[0][1], v[1][1], v[2][1]), Math.max(v[0][0], v[1][0], v[2][0]), Math.max(v[0][1], v[1][1], v[2][1])];
        }
      }
    }
    if (best) out.push({ span: sp, tri: best });
  }
  return out;
}

// ── row clustering (the scheduleParse idiom, span-shaped) ───────────────────
function clusterRows(spans: GraphSpan[]): GraphSpan[][] {
  const toks = spans.filter((t) => t.str && t.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: GraphSpan[][] = [];
  let cur: GraphSpan[] = [];
  let cy = 0;
  for (const t of toks) {
    // TIGHTER than scheduleParse's marquee clustering (0.6·h): this runs over
    // WHOLE sheets where side-by-side regions (legend beside schedule)
    // interleave in y — at 0.6·h their rows glue into mega-rows and the
    // header hunt dies. 0.35·h separates a real sheet's interleaved bands
    // while same-row jitter (~1–2 px) stays well inside.
    const tol = Math.max((t.h || 8) * 0.35, 3);
    if (cur.length && Math.abs(t.y - cy) > tol) { rows.push(cur); cur = []; }
    cur.push(t);
    cy = cur.reduce((s, w) => s + w.y, 0) / cur.length;
  }
  if (cur.length) rows.push(cur);
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}
const rowY = (r: GraphSpan[]) => r.reduce((s, t) => s + t.y, 0) / r.length;

// ── schedule tables ─────────────────────────────────────────────────────────
// Generalized header-anchor extraction: a header row is a row where ≥ minHits
// tokens match the vocabulary; data cells band to the nearest anchor. Every
// cell keeps its evidence bbox. Two vocabularies ship: the room-finish
// schedule (rooms → finishes — THE resolution target) and the finish/material
// schedule (codes → products, scheduleParse's own gate re-stated).
export type TableKind = "room-finish" | "finish" | "unknown";
export interface TableCell { text: string; bbox: Bbox }
/** A schedule row. `sheet` is the sheet that CARRIES the row — under a
 * continuation it differs from the table's base sheet, and the row's evidence
 * must cite where the ink actually is. `building` is the row-level qualifier
 * (a qualified key's prefix, or the BLDG column) when one exists. */
export interface TableRow { key: string; sheet: string; building?: string; cells: Record<string, TableCell>; revision?: RowRevision }
export interface TablePart { sheet: string; title: string; rows: number; region: Bbox; rotated_headers?: boolean }
export interface ScheduleTable {
  kind: TableKind;
  sheet: string;
  title: Evidence | null;
  headers: string[];
  rows: TableRow[];
  region: Bbox;
  /** Building context the whole table answers for (its title's "BUILDING X",
   * else the sheet's), when one exists. Row-level qualifiers override it. */
  building?: string;
  /** True when the header row was read at a quarter-turn (rotated headers). */
  rotated_headers?: boolean;
  /** Present when the table continues across sheets: every fragment,
   * base first. rows[] above is already the union. */
  parts?: TablePart[];
  /** Header anchors (label + x), kept for continuation adoption. */
  anchors?: Anchor[];
}

/** Columns that ARE a surface in their own right — never renamed by a parent. */
const SURFACE_WORDS = new Set(["FLOOR", "BASE", "WALL", "WALLS", "CEILING", "NORTH", "SOUTH", "EAST", "WEST", "WAINSCOT"]);
const ROOM_HEADERS = ["ROOM", "NO", "NUMBER", "NAME", "MARK", "LOCATION", "FLOOR", "BASE", "WALL", "WALLS", "NORTH", "SOUTH", "EAST", "WEST", "CEILING", "WAINSCOT", "REMARKS", "CLG", "HT", "HEIGHT", "FINISH", "MAT", "MATERIAL", "COMMENTS", "CASEWORK", "CABINET", "COUNTER", "COUNTERTOP", "BLDG", "BUILDING"];
// MAT / MATERIAL joined the vocabulary for #374: a Revit room-finish schedule
// splits BASE and WAINSCOT into MAT | HT sub-columns, and an un-anchored MAT
// column banded its codes into whichever neighbour was nearest.
// TAG joined the vocabulary AND the key set for #356: a materials schedule keyed
// TAG | MANUFACTURER | STYLE | COLOR scores six clean header hits and was still refused,
// because TAG was in neither list. Common convention when a set has no room-finish schedule.
const FINISH_HEADERS = ["CODE", "MARK", "SYMBOL", "TAG", "MATERIAL", "MANUFACTURER", "PRODUCT", "STYLE", "COLOR", "SIZE", "REMARKS", "DESCRIPTION", "PATTERN", "COMMENTS"];
// A header CELL is often a multi-word span ("FLOOR FINISH", "CEILING FINISH")
// — the vocabulary word inside it names the column.
/** A column anchor. `x` is the header's center. A two-tier SUB-column also
 * carries explicit bounds [x0, x1]: sub-columns under a merged parent are
 * equal-width by drafting convention, and bounds are the only honest way to
 * band them — nearest-center puts a left-aligned wall code in the BASE
 * column when BASE is narrow and the wall column is wide. */
type Anchor = { label: string; x: number; x0?: number; x1?: number };

const headerLabel = (s: string, vocab: string[]): string | null => headerLabels(s, vocab)[0] ?? null;
/** EVERY vocabulary word in a header cell, in order. A cell can name more than
 * one column's worth of vocabulary — "ROOM #" and "ROOM NAME" both lead with
 * ROOM — so the anchor builder falls through to the next word when the first
 * is already taken. Without that, the NAME column loses its anchor and the
 * room name merges into the finish column beside it. */
const headerLabels = (s: string, vocab: string[]): string[] => {
  const out: string[] = [];
  for (const w of norm(s).split(/[^A-Z]+/)) if (w && vocab.includes(w) && !out.includes(w)) out.push(w);
  return out;
};

/** The vocabulary labels a row carries, in x order (duplicates kept — two
 * columns can both be headed FINISH, one under FLOOR and one under CEILING).
 * A cell naming more than one vocabulary word ("ROOM NO.", "ROOM NAME")
 * claims the first one this row hasn't already claimed, not blindly its own
 * first word — otherwise every column qualified with the same leading word
 * (ROOM NO, ROOM NAME, ROOM FINISH …) collapses onto ONE distinct hit and a
 * real, well-formed schedule starves below minHits. Only when a cell's every
 * word is already spoken for does it fall back to its own first word — still
 * a real hit, just an ambiguous one the anchor pass resolves later. */
function headerHits(row: GraphSpan[], vocab: string[]): Array<{ label: string; span: GraphSpan }> {
  const out: Array<{ label: string; span: GraphSpan }> = [];
  const used = new Set<string>();
  for (const t of row) {
    const words = headerLabels(t.str, vocab);
    if (!words.length) continue;
    // "EAST NORTH SOUTH" set as ONE text run over three columns (#374): every
    // word is a surface, so each is a column, laid out across the run's width
    const all = norm(t.str).split(/[^A-Z]+/).filter(Boolean);
    if (all.length >= 2 && all.every((w) => SURFACE_WORDS.has(w))) {
      const n = all.length, w = (t.w || 0) / n;
      all.forEach((word, k) => { used.add(word); out.push({ label: word, span: { ...t, x: t.x + w * k, w } }); });
      continue;
    }
    const w = words.find((word) => !used.has(word)) ?? words[0];
    used.add(w);
    out.push({ label: w, span: t });
  }
  return out.sort((a, b) => a.span.x - b.span.x);
}
const qualifies = (hits: Array<{ label: string }>, required: string[], minHits: number) => {
  const seen = new Set(hits.map((h) => h.label));
  // an empty `required` is "no surface demanded of THIS row" (the descent
  // below, where the row above already proved the surfaces are here) — it is
  // not "no row can qualify", which is what `[].some()` used to say (#374)
  return seen.size >= minHits && (!required.length || required.some((r) => seen.has(r)));
};

function findHeaderRow(rows: GraphSpan[][], vocab: string[], required: string[], minHits: number): { anchors: Anchor[]; rowIndex: number } | null {
  for (let i = 0; i < rows.length; i++) {
    let hits = headerHits(rows[i], vocab);
    if (!qualifies(hits, required, minHits)) continue;
    // A three-tier header puts PARENTS on top (ROOM | FLOOR | WALLS | CEILING)
    // and the real columns underneath (MARK | LOCATION | FINISH | BASE |
    // NORTH | …). The parent row carries enough vocabulary to look like the
    // header, and taking it read every sub-header as data — BASE landed in
    // WALLS and the whole row shifted. Where consecutive rows BOTH qualify,
    // the LOWER one defines the columns; the rows above only name them.
    let idx = i;
    for (;;) {
      // Look a couple of rows down, not just one: a column that spans both
      // tiers (REMARKS, centred across them) lands on its own row between
      // them and would otherwise stop the descent dead.
      let next = -1;
      for (let j = idx + 1; j < Math.min(idx + 4, rows.length); j++) {
        const h = headerHits(rows[j], vocab);
        // A header row is almost ENTIRELY header words. A data row carries a
        // few by accident — a material schedule's "VINYL WALL BASE" hits WALL
        // and BASE — and descending into one shifts every column by a row.
        const ratio = h.length / Math.max(1, rows[j].length);
        // The row ABOVE already proved the required surfaces are here. A
        // two-tier Revit schedule (#374) puts FLOOR / BASE / WAINSCOT on the
        // parent tier and ROOM # | ROOM NAME | FINISH | MAT | HT on the tier
        // that actually defines the columns — which carries none of the
        // required words itself. Demanding them again refused the descent,
        // the key column never anchored, and 21 rows read as 2.
        if (qualifies(h, [], minHits) && h.length > hits.length && ratio >= 0.6) { next = j; break; }
      }
      if (next < 0) break;
      idx = next;
      hits = headerHits(rows[idx], vocab);
    }
    // A label repeated in the row (two FINISH columns) is ambiguous on its
    // own and takes its parent's name: FLOOR FINISH, CEILING FINISH. The
    // parent is the label above whose centre falls inside THIS column's own
    // interval — a parent's text is narrow and centred over a wide column, so
    // testing against the sub-header's own span finds nothing.
    const dup = new Set<string>();
    const once = new Set<string>();
    for (const h of hits) (once.has(h.label) ? dup : once).add(h.label);
    const anchors: Anchor[] = [];
    const used = new Set<string>();
    const parents: (string | null)[] = [];   // the parent each hit resolved, by index (#374)
    for (let j = 0; j < hits.length; j++) {
      const h = hits[j];
      parents[j] = null;
      let label = h.label;
      // An ambiguous label takes its parent's name first (two FINISH columns
      // become FLOOR FINISH and CEILING FINISH) …
      if (dup.has(h.label) && !SURFACE_WORDS.has(h.label)) {
        const hi = j + 1 < hits.length ? hits[j + 1].span.x : Infinity;
        // the parent is centred over its sub-columns TOGETHER, so the sub-column
        // on the right (HT under BASE | HT) has the parent's centre to its LEFT
        // — outside [this.x, next.x). Fall back to the column's own extent,
        // midpoint-to-midpoint between its neighbours (#374).
        const lo2 = j > 0 ? (hits[j - 1].span.x + (hits[j - 1].span.w || 0) + h.span.x) / 2 : h.span.x;
        const hi2 = j + 1 < hits.length ? (h.span.x + (h.span.w || 0) + hits[j + 1].span.x) / 2 : hi;
        let parent = parentLabelOver(rows, idx, i, h.span.x, hi, vocab) ?? parentLabelOver(rows, idx, i, lo2, hi2, vocab);
        // A merged parent is centred over its sub-columns TOGETHER (BASE over
        // MAT | HT), which can leave the right-hand sub-column with no parent
        // text over its own extent at all. The sub-column immediately to its
        // left already resolved that parent; an adjacent, unresolved sub-label
        // is its sibling and inherits it (#374).
        if (!parent && j > 0 && parents[j - 1] && h.span.x - (hits[j - 1].span.x + (hits[j - 1].span.w || 0)) < bandLimits(hits.map((x) => ({ label: x.label, x: x.span.x }))).medGap * 1.5) parent = parents[j - 1];
        // a generic sub-word under a surface parent IS that surface's column
        // (FLOOR over FINISH → FLOOR), so resolve_tag and assign_from_schedule
        // find it under the surface name; a splitting sub-word keeps both
        if (parent && parent !== h.label) { label = `${parent} ${h.label}`; parents[j] = parent; }
      }
      // … and failing that, a cell naming more than one vocabulary word falls
      // through to its next one: "ROOM #" and "ROOM NAME" both lead with ROOM,
      // and the second must become NAME rather than lose its column.
      if (used.has(label)) {
        const alt = headerLabels(h.span.str, vocab).find((w) => !used.has(w));
        if (alt) label = alt;
      }
      if (used.has(label)) continue;
      used.add(label);
      anchors.push({ label, x: h.span.x + (h.span.w || 0) / 2 });
    }
    if (anchors.length < minHits) continue;
    // A column that exists ONLY at a parent tier (REMARKS spanning the whole
    // header block) is a real column: keep it when it sits outside every
    // descended anchor's reach, drop it when it is merely a parent naming
    // columns that are already anchored below it.
    if (idx > i) {
      const lo = Math.min(...anchors.map((a) => a.x)), hi = Math.max(...anchors.map((a) => a.x));
      // …but a parent-tier word FAR outside the band is some other block that
      // shares the header's y — the finish-abbreviation list beside a Revit
      // schedule reads "RUBBER BASE" and "CERAMIC FLOOR TILE" on the parent
      // row (#374). Two column pitches beyond the band is as far as a real
      // spanning column (REMARKS) sits.
      const reach = bandLimits(anchors).medGap * 2;
      for (let j = i; j < idx; j++) {
        for (const h of headerHits(rows[j], vocab)) {
          const cx = h.span.x + (h.span.w || 0) / 2;
          if (cx >= lo && cx <= hi) continue;
          if (cx < lo - reach || cx > hi + reach) continue;
          if (used.has(h.label)) continue;
          used.add(h.label);
          anchors.push({ label: h.label, x: cx });
        }
      }
    }
    return { anchors: subTierAnchors(rows, idx, anchors.sort((a, b) => a.x - b.x), vocab), rowIndex: idx };
  }
  return null;
}

// ── two-tier headers (#87 phase 3b) ─────────────────────────────────────────
// A merged parent cell over sub-columns — WALLS (PLAN DIRECTION) spanning
// N | E | S | W — is standard on room-finish schedules. The sub-labels are
// not vocabulary words, so the anchor hunt above went blind to them and every
// wall column banded to whichever neighbour was nearest: N and E landed in
// BASE, S and W in CEILING. Field-found on a real gym set, where BASE read
// "VWB-1 - FRP-1, FRP-1A, PT" instead of "VWB-1" — a polluted base column is
// a wrong number in the bid, not a cosmetic smear.
// A run of ≥2 adjacent non-vocabulary tokens INSIDE the header's own span is
// a sub-tier. The parent is the nearest span above whose box actually covers
// the run, and each sub-anchor is labelled "<PARENT> <SUB>" ("WALLS N") so
// the column keeps both halves of its meaning. No parent above, no sub-tier:
// an unexplained token never mints a column.
const SUB_LABEL_RE = /^[A-Z0-9][A-Z0-9.\/-]{0,5}$/;

function parentLabelOver(rows: GraphSpan[][], hdrIdx: number, topIdx: number, gx0: number, gx1: number, vocab: string[]): string | null {
  const width = Math.max(Math.min(gx1, gx0 + 4000) - gx0, 1);
  // Search UPWARD by distance, not by row count. Dotted leaders and a
  // neighbouring table's rows interleave between the tiers of one header
  // block, so "two rows up" can fall short of the parent that is physically
  // sitting right above the column.
  const hs = rows[hdrIdx].map((t) => t.h || 8).sort((a, b) => a - b);
  const near = Math.max(24, (hs[hs.length >> 1] || 8) * 4);
  const hy = rowY(rows[hdrIdx]);
  const floorIdx = Math.max(0, Math.min(topIdx, hdrIdx - 8));
  for (let j = hdrIdx - 1; j >= floorIdx; j--) {
    if (hy - rowY(rows[j]) > near) break;
    for (const t of rows[j]) {
      const cx = t.x + (t.w || 0) / 2;
      const inInterval = cx >= gx0 && cx < gx1;
      const overlaps = Math.min(t.x + (t.w || 0), gx1) - Math.max(t.x, gx0) > width * 0.3;
      if (!inInterval && !overlaps) continue;
      const lbl = headerLabel(t.str, vocab);
      if (lbl) return lbl;
    }
  }
  return null;
}

function subTierAnchors(rows: GraphSpan[][], hdrIdx: number, anchors: Anchor[], vocab: string[]): Anchor[] {
  const lo = anchors[0].x, hi = anchors[anchors.length - 1].x;
  const loose = rows[hdrIdx]
    .filter((t) => !headerLabel(t.str, vocab) && SUB_LABEL_RE.test(norm(t.str)))
    .filter((t) => t.x + (t.w || 0) / 2 > lo && t.x + (t.w || 0) / 2 < hi)
    .sort((a, b) => a.x - b.x);
  if (loose.length < 2) return anchors;
  const mid = (t: GraphSpan) => t.x + (t.w || 0) / 2;
  const gaps = loose.slice(1).map((t, i) => mid(t) - mid(loose[i])).sort((a, b) => a - b);
  const med = gaps[gaps.length >> 1] || 1;
  const runs: GraphSpan[][] = [];
  let run: GraphSpan[] = [loose[0]];
  for (let i = 1; i < loose.length; i++) {
    if (mid(loose[i]) - mid(loose[i - 1]) > med * 3) { runs.push(run); run = []; }
    run.push(loose[i]);
  }
  runs.push(run);
  const out = anchors.slice();
  const used = new Set(anchors.map((a) => a.label));
  for (const r of runs) {
    if (r.length < 2) continue;
    const last = r[r.length - 1];
    const parent = parentLabelOver(rows, hdrIdx, hdrIdx - 2, r[0].x, last.x + (last.w || 0), vocab);
    if (!parent) continue;
    // sub-columns under a merged parent are equal-width: the pitch between
    // their labels IS the column width, so each one's bounds are its center
    // ± half a pitch. Those bounds are what keep a left-aligned wall code out
    // of the narrow BASE column next door.
    const pitch = r.length > 1
      ? r.slice(1).map((t, i) => mid(t) - mid(r[i])).sort((a, b) => a - b)[(r.length - 1) >> 1]
      : 0;
    for (const t of r) {
      const label = `${parent} ${norm(t.str)}`;
      if (used.has(label)) continue;
      used.add(label);
      const c = mid(t);
      out.push(pitch > 0 ? { label, x: c, x0: c - pitch / 2, x1: c + pitch / 2 } : { label, x: c });
    }
  }
  return out.sort((a, b) => a.x - b.x);
}

// Rotated headers (#87 phase 2): column labels written at 90° stack each word
// in a tall, narrow box, so y-row clustering never assembles them into a
// header row — the anchor hunt above goes blind. Vertical spans get their own
// hunt: vocabulary matches whose y-extents overlap form the header BAND;
// each member's x-center is its column anchor; data rows band below the
// band's bottom edge exactly as they would under a horizontal header.
function findRotatedHeader(vert: GraphSpan[], vocab: string[], required: string[], minHits: number): { anchors: Anchor[]; top: number; bottom: number; spans: GraphSpan[] } | null {
  const cands = vert
    .map((sp) => ({ sp, label: headerLabel(sp.str, vocab) }))
    .filter((c): c is { sp: GraphSpan; label: string } => !!c.label)
    .sort((a, b) => a.sp.x - b.sp.x);
  let band: typeof cands = [];
  let y0 = 0, y1 = 0;
  const flush = (): ReturnType<typeof findRotatedHeader> => {
    const seen = new Set(band.map((c) => c.label));
    if (band.length < minHits || seen.size < minHits || !required.some((r) => seen.has(r))) return null;
    const anchors: Anchor[] = [];
    const used = new Set<string>();
    for (const c of band) if (!used.has(c.label)) { used.add(c.label); anchors.push({ label: c.label, x: c.sp.x + (c.sp.w || 0) / 2 }); }
    return { anchors: anchors.sort((a, b) => a.x - b.x), top: y0, bottom: y1, spans: band.map((c) => c.sp) };
  };
  for (const c of cands) {
    const cy0 = c.sp.y, cy1 = c.sp.y + (c.sp.h || 0);
    if (band.length && (cy0 > y1 || cy1 < y0)) {
      const done = flush();
      if (done) return done;
      band = [];
    }
    if (!band.length) { y0 = cy0; y1 = cy1; }
    else { y0 = Math.min(y0, cy0); y1 = Math.max(y1, cy1); }
    band.push(c);
  }
  return band.length ? flush() : null;
}

// A BOUNDED anchor claims only what falls inside it — that is the whole point
// of knowing a sub-column's edges. Everything else bands to the nearest
// UNBOUNDED header center, so a narrow BASE column keeps its own cell and
// never inherits the wall code drawn just past its rule line.
const nearestAnchor = (x: number, anchors: Anchor[]) => {
  let inside: Anchor | null = null;
  for (const a of anchors) {
    if (a.x0 == null || a.x1 == null || x < a.x0 || x > a.x1) continue;
    if (!inside || Math.abs(a.x - x) < Math.abs(inside.x - x)) inside = a;
  }
  if (inside) return inside.label;
  let best: Anchor | null = null;
  for (const a of anchors) {
    if (a.x0 != null) continue;
    if (!best || Math.abs(a.x - x) < Math.abs(best.x - x)) best = a;
  }
  return (best ?? anchors[0]).label;
};

// The ANCHORS bound the table, not the whole clustered row — on a dense sheet
// a neighbouring table's header can share the y-band, and its x-range must
// not leak in. Left margin is generous (data cells sit left of a centered
// header). The RIGHT edge depends on what the last column IS: a prose column
// (REMARKS / DESCRIPTION / NOTES) earns three median gaps so a wide wrapped
// remark stays in; a code column (CEILING, WALL, COLOR) hugs its anchor —
// field-found on a real gym set: a finish legend sitting 300px right of a
// room schedule bled into every CEILING cell under the generous edge.
const WIDE_LAST = new Set(["REMARKS", "DESCRIPTION", "NOTES", "COMMENTS"]);
function bandLimits(anchors: Anchor[]): { x0: number; x1: number; medGap: number } {
  const gaps = anchors.slice(1).map((a, i) => a.x - anchors[i].x).sort((a, b) => a - b);
  const medGap = gaps.length ? gaps[gaps.length >> 1] : 150;
  const last = anchors[anchors.length - 1];
  const rightMargin = WIDE_LAST.has(last.label) ? Math.max(300, medGap * 3) : Math.max(120, medGap);
  return { x0: anchors[0].x - Math.max(80, medGap / 2), x1: last.x + rightMargin, medGap };
}

// A finish code: scheduleParse's pattern. A schedule ROW key is looser than a
// plan bubble (detectRooms' 2–3 digits): real room-finish schedules carry
// "3", "3A", "139A" — one to three digits plus up to two letters. A
// building-QUALIFIED key ("A-134") is accepted only for a designator the set
// names (opts.buildings) — otherwise a stray finish code ("P-2") banding to
// the key column would mint a phantom building.
const CODE_RE = /^[A-Z]{1,4}(-?[A-Z0-9]{1,4})?$/;
const ROW_KEY_RE = /^\d{1,3}[A-Z]{0,2}$/;
const QUALIFIED_KEY_RE = /^([A-Z]{1,2})-(\d{1,3}[A-Z]{0,2})$/;
const CORRIDOR_KEY_RE = /^[A-Z]{1,3}(?:\d{1,3}-\d{1,3}|\d{3})[A-Z]?$/;   // CR11-9, C101 — never a two-character tag like "T1"

export interface ExtractOpts { buildings?: Set<string>; deltas?: DeltaIndex }

// Schedule families that are NOT finish/material schedules but share the
// MARK/DESCRIPTION column shape. A title naming one of these is refused as a
// finish table — unless it ALSO says FINISH or MATERIAL, in which case the
// safe reading is to keep it and let the caller look.
const OTHER_FAMILY_RE = /\b(DOOR|WINDOW|PARTITION|EQUIPMENT|HARDWARE|LOUVER|SIGNAGE|LIGHTING|LUMINAIRE|PLUMBING|MECHANICAL|ELECTRICAL|STOREFRONT|GLAZING|CASEWORK|MILLWORK|APPLIANCE)S?\b/;
export const isNonFinishSchedule = (title: string): boolean => {
  const u = norm(title);
  return OTHER_FAMILY_RE.test(u) && !/\b(FINISH|MATERIAL)S?\b/.test(u);
};

function rowKeyOf(raw: string, kind: "room-finish" | "finish", buildings?: Set<string>): { key: string; building?: string } | null {
  const kept = norm(raw).replace(/[^A-Z0-9/-]/g, "");
  const key = kept.replace(/\//g, "");
  if (kind === "finish") {
    // a compound cell keys one row for several marks — "R1 / E1" is the same
    // device scheduled for two services; keep the slash so the row can answer
    // for each mark on its own (checked first: slash-stripped "R1E1" would
    // otherwise pass CODE_RE and bury the compound)
    const parts = kept.split("/").filter(Boolean);
    if (parts.length > 1 && parts.every((p) => CODE_RE.test(p))) return { key: parts.join("/") };
    return CODE_RE.test(key) ? { key } : null;
  }
  if (ROW_KEY_RE.test(key)) return { key };
  // "CR11-9", "C101": letters-then-digits keys a Revit schedule gives
  // corridors and lettered wings (#374). Letters-dash-digits ("PT-2") is a
  // finish code and stays out; letters-dash-digits with a named building is
  // the qualified form below.
  if (CORRIDOR_KEY_RE.test(key)) return { key };
  const q = key.match(QUALIFIED_KEY_RE);
  if (q && buildings?.has(q[1])) return { key, building: q[1] };
  return null;
}

/** Does a schedule-row key answer for a mark? Exact, or one of a compound
 * key's slash-separated parts ("R1/E1" answers for "R1" and for "E1"). */
export const rowKeyAnswersFor = (key: string, want: string): boolean => {
  const c = norm(key).replace(/\s+/g, "");
  const w = norm(want).replace(/\s+/g, "");
  return c === w || c.split("/").filter(Boolean).includes(w);
};

/** The number part of a row key — "A-134" and "134" both answer for 134. */
const numOf = (key: string): string => key.match(QUALIFIED_KEY_RE)?.[2] ?? key;

const centerX = (t: GraphSpan) => t.x + (t.w || 0) / 2;

/** Column starts read off the DATA, plus WHICH edge of a token to band by.
 * Some schedules left-align their cells and some centre them; the alignment
 * is a property of the sheet, not something to assume. Both are tried and the
 * one that actually explains the data — the tighter clustering — wins. A map
 * is returned only when every anchor ends up owning a column, in the anchors'
 * own order; otherwise banding falls back to nearest-anchor, so a table this
 * does not fit is never mangled by a half-built column map. */
type ColumnMap = { coord: "left" | "center"; cols: Array<{ start: number; label: string }>; score: number };
const PLACEHOLDER_RE = /^[-–—]{1,3}$/;

function columnMapFor(
  rows: GraphSpan[][],
  anchors: Anchor[],
  cfg: { fromIdx: number; belowY: number },
  x0: number,
  x1: number,
  coord: "left" | "center",
): ColumnMap | null {
  const at = (t: GraphSpan) => (coord === "left" ? t.x : t.x + (t.w || 0) / 2);
  const xs: number[] = [];
  const hs: number[] = [];
  const dashes: number[] = [];
  for (let i = Math.max(cfg.fromIdx, 0); i < rows.length; i++) {
    if (rowY(rows[i]) <= cfg.belowY) continue;
    for (const t of rows[i]) {
      if (t.x < x0 || t.x > x1 || revisionOf(t.str) != null) continue;
      // A placeholder dash is CENTRED in its column while the codes beside it
      // are left-aligned, and on a column that is mostly dashes ("--" in 16
      // of 20 WAINSCOT rows) the dash edge became the column start and the
      // four real codes, starting a few px left of it, banded into the
      // column before (Dublin A-601: "BASE HT" read "4\" CWT-1", #374). A
      // dash says nothing about where cells start, so it does not vote.
      if (PLACEHOLDER_RE.test(t.str.trim())) { dashes.push(at(t)); continue; }
      xs.push(at(t));
      hs.push(t.h || 8);
    }
  }
  if (xs.length < anchors.length * 2) return null;
  hs.sort((a, b) => a - b);
  const tol = Math.max(4, hs[hs.length >> 1] * 0.5);
  xs.sort((a, b) => a - b);
  const clusters: Array<{ start: number; n: number }> = [];
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.start <= tol) { last.n++; continue; }
    clusters.push({ start: x, n: 1 });
  }
  const maxN = Math.max(...clusters.map((c) => c.n));
  const kept = clusters.filter((c) => c.n >= Math.max(2, maxN * 0.25));
  if (kept.length < anchors.length) return null;
  const byLabel = new Map<string, number>();
  for (const c of kept) {
    const own = anchors.find((a) => a.x >= c.start);
    if (!own) continue;
    const cur = byLabel.get(own.label);
    if (cur == null || c.start < cur) byLabel.set(own.label, c.start);
  }
  // A column that is dashes in most rows and a real code in a few (the
  // WAINSCOT column: "--" in 16 rows, CWT-1 in 4) can lose its real cluster
  // to the keep floor above. It is still a column: the dashes place it, and
  // the real cells — when there are any — say where it starts.
  if (byLabel.size < anchors.length && dashes.length) {
    dashes.sort((a, b) => a - b);
    const dc: Array<{ start: number; n: number }> = [];
    for (const x of dashes) { const last = dc[dc.length - 1]; if (last && x - last.start <= tol) { last.n++; continue; } dc.push({ start: x, n: 1 }); }
    for (const c of dc.filter((d) => d.n >= 2)) {
      const own = anchors.find((a) => a.x >= c.start);
      if (!own || byLabel.has(own.label)) continue;
      const real = clusters.filter((k) => k.n >= 1 && anchors.find((a) => a.x >= k.start)?.label === own.label).sort((a, b) => a.start - b.start)[0];
      byLabel.set(own.label, real ? real.start : c.start);
    }
  }
  if (byLabel.size !== anchors.length) return null;
  const cols = [...byLabel.entries()].map(([label, start]) => ({ label, start })).sort((a, b) => a.start - b.start);
  if (cols.map((c) => c.label).join("|") !== anchors.map((a) => a.label).join("|")) return null;
  // how well this alignment explains the data: the share of tokens sitting on
  // a column start rather than scattered between them
  const starts = kept.map((c) => c.start);
  let on = 0;
  for (const x of xs) if (starts.some((st) => Math.abs(x - st) <= tol)) on++;
  return { coord, cols, score: on / xs.length };
}

function columnStarts(
  rows: GraphSpan[][],
  anchors: Anchor[],
  cfg: { fromIdx: number; belowY: number },
  x0: number,
  x1: number,
): ColumnMap | null {
  // A map has to FIT before it is trusted. A mediocre fit is worse than none:
  // it looks authoritative and quietly merges a column into its neighbour,
  // where falling back to nearest-anchor reads the table correctly. Measured
  // on real sets, a true alignment scores ~0.82–0.90 and a wrong one ~0.54.
  const FIT_FLOOR = 0.7;
  const fits = (m: ColumnMap | null) => (m && m.score >= FIT_FLOOR ? m : null);
  const left = fits(columnMapFor(rows, anchors, cfg, x0, x1, "left"));
  const center = fits(columnMapFor(rows, anchors, cfg, x0, x1, "center"));
  if (!left) return center;
  if (!center) return left;
  // Left alignment is the common case; centring has to EARN the switch. On a
  // near tie both modes score well and picking the wrong one merges a column
  // into its neighbour, so only a clearly better centred fit wins.
  return center.score > left.score + 0.05 ? center : left;
}

function bandDataRows(
  rows: GraphSpan[][],
  anchors: Anchor[],
  kind: "room-finish" | "finish",
  sheetKey: string,
  buildings: Set<string> | undefined,
  cfg: { fromIdx: number; belowY: number; keyAlign?: { x: number; tol: number }; deltas?: DeltaIndex },
): { out: TableRow[]; region: Bbox | null } {
  const { x0, x1, medGap } = bandLimits(anchors);
  // Columns are defined by where the DATA starts, not by where the header
  // sits. Headers are centered over their column; cells are left-aligned in
  // it — so a short cell and a long cell in the same column share a left edge
  // but have wildly different centers. Measured on a real gym schedule:
  // "PT-1" and "SEE INT. ELEVATIONS" both start at x=2342, and center-banding
  // put the short one in BASE and the long one in WALL. Clustering the left
  // edges recovers the true column starts; the headers only NAME them.
  const cols = columnStarts(rows, anchors, cfg, x0, x1);
  // A key belongs to the key column when it sits nearer that column's start
  // than the next column's — sized from the table's own pitch, not from text
  // height, so a wider key ("139A") or a hair of indent still counts.
  const keyTol = cols && cols.cols.length > 1 ? Math.max(8, (cols.cols[1].start - cols.cols[0].start) * 0.5) : 40;
  const out: TableRow[] = [];
  const outY: number[] = [];
  let region: Bbox | null = null;
  /** Which column a token belongs to: its LEFT edge against the data-derived
   * column starts when those were recoverable, else the old nearest-anchor
   * reading of its center. */
  const columnOf = (t: GraphSpan): string => {
    if (!cols) return nearestAnchor(centerX(t), anchors);
    const at = cols.coord === "left" ? t.x : centerX(t);
    let label = cols.cols[0].label;
    for (const c of cols.cols) { if (at + 1 >= c.start) label = c.label; else break; }
    // Left-aligned map, but a Revit schedule CENTRES its codes while it
    // left-aligns its names, so a wide code ("LVT-1 / LVT-2" in a column of
    // "CPT-1"s) starts left of the column's start and its left edge alone
    // reads as the column before. The cell's whole extent decides: the column
    // whose interval it overlaps most owns it (#374). A short cell sitting on
    // its start is unchanged — its extent lies inside one interval.
    if (cols.coord === "left" && (t.w || 0) > 0) {
      const x1 = t.x + (t.w || 0);
      let best = label, bestOv = -1;
      for (let ci = 0; ci < cols.cols.length; ci++) {
        const lo = cols.cols[ci].start, hi = ci + 1 < cols.cols.length ? cols.cols[ci + 1].start : Infinity;
        const ov = Math.min(hi, x1) - Math.max(lo, t.x);
        if (ov > bestOv) { bestOv = ov; best = cols.cols[ci].label; }
      }
      if (bestOv > 0) label = best;
    }
    return label;
  };
  const add = (row: TableRow, toks: GraphSpan[]) => {
    for (const t of toks) {
      const label = columnOf(t);
      const text = t.str.trim();
      if (!row.cells[label]) row.cells[label] = { text, bbox: bboxOf(t) };
      else row.cells[label] = { text: `${row.cells[label].text} ${text}`, bbox: merge(row.cells[label].bbox, bboxOf(t)) };
      region = region ? merge(region, bboxOf(t)) : bboxOf(t);
    }
  };
  const orphans: Array<{ toks: GraphSpan[]; y: number }> = [];
  const markers: Array<{ rev: string; span: GraphSpan; drawn?: boolean; tri?: Bbox }> = [];
  for (let i = Math.max(cfg.fromIdx, 0); i < rows.length; i++) {
    if (rowY(rows[i]) <= cfg.belowY) continue;
    const banded: GraphSpan[] = [];
    for (const t of rows[i]) {
      const tri = cfg.deltas?.get(t);
      const rev = tri ? norm(t.str) : revisionOf(t.str);
      // a delta usually sits in the MARGIN beside its row — outside the data
      // band — so the marker gate is wider than the cell gate
      if (rev != null) {
        if (centerX(t) >= x0 - 2.5 * medGap && centerX(t) <= x1 + medGap) markers.push({ rev, span: t, ...(tri ? { drawn: true, tri } : {}) });
        continue;
      }
      if (t.x >= x0 && t.x <= x1) banded.push(t);
    }
    if (!banded.length) continue;
    const keyed = rowKeyOf(banded[0].str, kind, buildings);
    if (!keyed) { orphans.push({ toks: banded, y: rowY(rows[i]) }); continue; }
    // Every row of THIS table starts its key at the key column. Rows are
    // clustered across the whole sheet, so a keyed-looking row belonging to
    // something else — a legend, a room tag drawn beside the schedule —
    // otherwise joins the table and shows up as a duplicate key.
    if (cols && Math.abs((cols.coord === "left" ? banded[0].x : centerX(banded[0])) - cols.cols[0].start) > keyTol) continue;
    // continuation adoption: a keyed row whose key column does not line up
    // with the base's belongs to some OTHER structure — skipped, never merged
    if (cfg.keyAlign && Math.abs(centerX(banded[0]) - cfg.keyAlign.x) > cfg.keyAlign.tol) continue;
    const row: TableRow = { key: keyed.key, sheet: sheetKey, cells: {} };
    if (keyed.building) row.building = keyed.building;
    add(row, banded);
    out.push(row);
    outY.push(rowY(rows[i]));
  }
  // A table ends where its rows stop. Rows are clustered across the WHOLE
  // sheet, so a keyed-looking row far below — a legend, a note block, a room
  // tag on the plan drawn beside the schedule — otherwise joins the table and
  // shows up as a duplicate key ("ambiguous: 3 schedule rows match 100").
  // Keep the run that starts at the first row and break at the first gap
  // wider than eight times the table's own row pitch — a real schedule
  // can carry section breaks and blank bands, so the bar has to be high.
  // Key-column alignment above bounds the table sideways; a gap eight row
  // pitches deep bounds it downwards, for the case where something keyed the
  // same way sits far below.
  if (out.length > 2) {
    const d = outY.slice(1).map((y, i) => y - outY[i]).filter((g) => g > 0).sort((a, b) => a - b);
    const pitch0 = d.length ? d[d.length >> 1] : 0;
    if (pitch0 > 0) {
      let end = out.length;
      for (let i = 1; i < outY.length; i++) if (outY[i] - outY[i - 1] > pitch0 * 8) { end = i; break; }
      if (end < out.length) { out.length = end; outY.length = end; }
    }
  }
  // the repair radius: median gap between consecutive keyed rows; a lone-row
  // table falls back to a couple of text heights
  const gaps = outY.slice(1).map((y, i) => y - outY[i]).filter((d) => d > 0).sort((a, b) => a - b);
  const pitch = gaps.length ? gaps[gaps.length >> 1] : 0;
  const nearest = (y: number): { i: number; d: number } => {
    let bi = -1, bd = Infinity;
    outY.forEach((ry, i) => { const d = Math.abs(y - ry); if (d < bd) { bd = d; bi = i; } });
    return { i: bi, d: bd };
  };
  const radius = (h: number) => (pitch ? pitch * 0.6 : Math.max(h, 8) * 1.6);
  for (const o of orphans) {
    const { i, d } = nearest(o.y);
    if (i < 0 || d > radius(Math.max(...o.toks.map((t) => t.h || 8)))) continue;
    add(out[i], o.toks);
  }
  for (const m of markers) {
    const { i, d } = nearest(m.span.y);
    if (i < 0 || d > radius(m.span.h || 8) || out[i].revision) continue;
    // a drawn delta's evidence bbox spans digit AND triangle — view_sheet
    // shows the symbol, not just the bare digit
    const ebox = m.tri ? merge(bboxOf(m.span), m.tri) : bboxOf(m.span);
    out[i].revision = { rev: m.rev, source: { sheet: sheetKey, text: m.span.str.trim(), bbox: ebox }, ...(m.drawn ? { drawn: true } : {}) };
  }
  // row-level building off the BLDG/BUILDING column, where the key itself
  // did not carry one
  for (const row of out) {
    if (row.building) continue;
    const cellB = norm(row.cells.BLDG?.text || row.cells.BUILDING?.text || "");
    if (DESIGNATOR_RE.test(cellB)) row.building = cellB;
  }
  return { out, region };
}

/** Extract one kind of table from a sheet's spans. Returns null when the
 * header structure isn't there — never invented rows. Horizontal header rows
 * are tried first; a sheet without one is re-tried against a rotated
 * (quarter-turn) header band. */
export function extractTable(sheet: SheetSpans, kind: "room-finish" | "finish", opts: ExtractOpts = {}): ScheduleTable | null {
  const horiz = sheet.spans.filter((s) => !isVertical(s));
  const vert = sheet.spans.filter(isVertical);
  const rows = clusterRows(horiz);
  const vocab = kind === "room-finish" ? ROOM_HEADERS : FINISH_HEADERS;
  const required = kind === "room-finish" ? ["FLOOR", "BASE"] : ["CODE", "MARK", "SYMBOL", "TAG"];
  const minHits = kind === "room-finish" ? 4 : 3;

  let anchors: Anchor[];
  let headerSpans: GraphSpan[];
  let dataFrom: number;           // first row index eligible as data
  let dataBelowY = -Infinity;     // rotated: data rows must sit below the band
  let titleFrom: number;          // title hunt walks upward from here
  let rotated = false;

  const flat = findHeaderRow(rows, vocab, required, minHits);
  if (flat) {
    anchors = flat.anchors;
    headerSpans = rows[flat.rowIndex];
    dataFrom = flat.rowIndex + 1;
    titleFrom = flat.rowIndex - 1;
  } else {
    const rot = findRotatedHeader(vert, vocab, required, minHits);
    if (!rot) return null;
    rotated = true;
    anchors = rot.anchors;
    headerSpans = rot.spans;
    dataBelowY = rot.bottom - 2;
    dataFrom = 0;
    titleFrom = rows.findIndex((r) => rowY(r) >= rot.top) - 1;
    if (titleFrom < -1) titleFrom = rows.length - 1;
  }

  // The region is what an agent is told to LOOK at, so it must bound THIS
  // table and no other. A clustered header row on a dense sheet sweeps in the
  // neighbouring table's tokens, and merging all of them advertised a region
  // five times the table's width — two tables in one crop. Only header spans
  // inside the anchors' own band count.
  const hdrBand = bandLimits(anchors);
  let region: Bbox | null = null;
  for (const t of headerSpans) {
    if (centerX(t) < hdrBand.x0 || centerX(t) > hdrBand.x1) continue;
    region = region ? merge(region, bboxOf(t)) : bboxOf(t);
  }
  const banded = bandDataRows(rows, anchors, kind, sheet.key, opts.buildings, { fromIdx: dataFrom, belowY: dataBelowY, deltas: opts.deltas });
  const out = banded.out;
  if (banded.region) region = region ? merge(region, banded.region) : banded.region;
  if (!out.length) return null;
  const { x0, x1 } = bandLimits(anchors);
  // the table's title: the nearest "… SCHEDULE" span above the header WITHIN
  // the table's own x-band — on a dense sheet the neighbouring table's title
  // shares the y-band and must not label this one
  let title: Evidence | null = null;
  for (let i = titleFrom; i >= 0 && i >= titleFrom - 5 && !title; i--) {
    const hit = rows[i].find((t) => /SCHEDULE/.test(norm(t.str)) && t.x >= x0 && t.x <= x1);
    if (hit) title = { sheet: sheet.key, text: hit.str.trim(), bbox: bboxOf(hit) };
  }
  const table: ScheduleTable = { kind, sheet: sheet.key, title, headers: anchors.map((a) => a.label), rows: out, region: region!, anchors };
  if (rotated) table.rotated_headers = true;
  return table;
}

// ── continuation sheets (#87 phase 2) ───────────────────────────────────────
// "ROOM FINISH SCHEDULE — CONT'D" is not a second schedule: it is the SAME
// table whose rows ran off the sheet. Fragments merge into one logical table
// — rows keep the sheet that carries them, so every citation still points at
// real ink — and resolution, ambiguity checks, and find_schedule all see ONE
// table. Two shapes ship: a continuation that repeats its header row (the
// common convention) merges by title; one that repeats only the TITLE adopts
// the base fragment's column anchors, gated on the key column actually
// aligning — misaligned columns refuse and the gap is NAMED in graph.notes,
// never silently dropped.
const CONT_TAIL_RE = /[\s\-–—:.,(]*(?:CONTINUATION|CONTINUED|CONT['’]?D?)[\s.)]*$/;
const isContinuationTitle = (text: string): boolean => {
  const u = norm(text);
  return /SCHEDULE/.test(u) && CONT_TAIL_RE.test(u);
};
const baseTitleOf = (text: string): string =>
  norm(text).replace(CONT_TAIL_RE, "").replace(/[\s\-–—:.,()]+$/, "").trim();

function findContinuationBase(logical: ScheduleTable[], frag: ScheduleTable): ScheduleTable | null {
  const sameKind = logical.filter((t) => t.kind === frag.kind
    && (frag.building == null || t.building == null || t.building === frag.building));
  if (!sameKind.length) return null;
  const fragBase = baseTitleOf(frag.title!.text);
  const titled = sameKind.filter((t) => t.title && baseTitleOf(t.title.text) === fragBase);
  const pool = titled.length ? titled : sameKind;
  return pool[pool.length - 1]; // the most recent fragment in sheet order
}

function mergeContinuation(base: ScheduleTable, frag: ScheduleTable): void {
  if (!base.parts) {
    base.parts = [{ sheet: base.sheet, title: base.title?.text || "", rows: base.rows.length, region: base.region, ...(base.rotated_headers ? { rotated_headers: true } : {}) }];
  }
  for (const r of frag.rows) if (r.building == null && frag.building != null) r.building = frag.building;
  base.parts.push({ sheet: frag.sheet, title: frag.title?.text || "", rows: frag.rows.length, region: frag.region, ...(frag.rotated_headers ? { rotated_headers: true } : {}) });
  base.rows.push(...frag.rows);
}

/** A header-less continuation: the sheet repeats the TITLE but not the header
 * row, so extraction found nothing there. Adopt the base table's anchors and
 * band the rows below the title — but only where the key column actually
 * lines up; adopting misaligned columns would caption cells with the wrong
 * headers, which is worse than refusing. */
function adoptContinuationRows(sheet: SheetSpans, titleSpan: GraphSpan, base: ScheduleTable, buildings: Set<string>, deltas?: DeltaIndex): ScheduleTable | null {
  if (!base.anchors?.length || base.kind === "unknown") return null;
  const rows = clusterRows(sheet.spans.filter((s) => !isVertical(s)));
  const { medGap } = bandLimits(base.anchors);
  const keyTol = Math.max(40, medGap / 2);
  const banded = bandDataRows(rows, base.anchors, base.kind, sheet.key, buildings, {
    fromIdx: 0, belowY: titleSpan.y, keyAlign: { x: base.anchors[0].x, tol: keyTol }, deltas,
  });
  if (!banded.out.length) return null;
  const region = banded.region ? merge(bboxOf(titleSpan), banded.region) : bboxOf(titleSpan);
  return {
    kind: base.kind, sheet: sheet.key,
    title: { sheet: sheet.key, text: titleSpan.str.trim(), bbox: bboxOf(titleSpan) },
    headers: base.headers, rows: banded.out, region,
  };
}

// ── room tags on plans ──────────────────────────────────────────────────────
export interface RoomTag { tag: string; name: string; sheet: string; bbox: Bbox; building?: string; revision?: RowRevision;
  /** WHY this number is believed to be a room: a name drawn with it, a
   * room-finish row answering for it, or both. Uncorroborated numbers are not
   * rooms — they are listed in SheetGraph.unmatched_tags with a reason. */
  corroboration?: "name" | "schedule" | "name+schedule" }
/** A numbered tag on a plan sheet that is NOT counted as a room, and why.
 * Listed rather than dropped: a room the schedule genuinely forgot shows up
 * here, and so does every keynote hexagon — the reason separates them. */
export interface UnmatchedTag { tag: string; sheet: string; bbox: Bbox; building?: string; name?: string; reason: string }
const QUALIFIED_TAG_RE = /^([A-Z]{1,2})-(\d{2,3}[A-Z]?)$/;
/** Words that sit next to a number in a TABLE, never over a room bubble. */
const NON_ROOM_NAME = new Set(["NUMBER", "NO", "NAME", "MARK", "SYMBOL", "CODE", "TYPE", "QTY", "SIZE", "TOTAL", "SHEET", "DATE", "SCALE", "REV", "REVISION", "DESCRIPTION", "REMARKS", "COMMENTS", "DETAIL", "ROOM"]);

export interface RoomTagOpts {
  /** Building designators the set names — a qualified plan tag ("A-134") is
   * only a room where its prefix is one of these. */
  buildings?: Set<string>;
  /** Normalized tags that are actually sheet numbers in the set ("A-601",
   * "A601") — a title block's own number must never mint a room. */
  exclude?: Set<string>;
  /** Drawn delta triangles on this sheet — a bare digit inside one is a
   * revision marker, never a room, and attaches to the bubble it sits by. */
  deltas?: DeltaIndex;
}

/** Room-number tags on a sheet, with the name span sitting just above the
 * number (the "WORKROOM ⏎ 109" bubble stack) when one exists. */
export function roomTags(sheet: SheetSpans, opts: RoomTagOpts = {}): RoomTag[] {
  const out: RoomTag[] = [];
  const spans = sheet.spans;
  const accept = (t: string): { ok: boolean; building?: string } => {
    if (ROOM_LABEL_RE.test(t)) return { ok: true };
    const q = norm(t).match(QUALIFIED_TAG_RE);
    if (q && opts.buildings?.has(q[1]) && !opts.exclude?.has(norm(t).replace(/[^A-Z0-9]/g, ""))) return { ok: true, building: q[1] };
    return { ok: false };
  };
  for (const sp of spans) {
    if (opts.deltas?.has(sp)) continue; // a digit inside a drawn delta is a marker, never a room
    const t = sp.str.trim();
    const a = accept(t);
    if (!a.ok) continue;
    const b = bboxOf(sp);
    const hgt = Math.max(sp.h || 8, 6);
    // the label above: horizontally overlapping, within ~2 text heights up,
    // and NOT itself a number (two stacked room numbers are two rooms)
    let name = "";
    let best = Infinity;
    for (const cand of spans) {
      if (cand === sp || accept(cand.str.trim()).ok) continue;
      const cb = bboxOf(cand);
      const dy = b[1] - cb[3];
      if (dy < -hgt * 0.2 || dy > hgt * 2.2) continue;
      if (cb[2] < b[0] - hgt || cb[0] > b[2] + hgt) continue;
      const raw = cand.str.trim();
      // A room name is drafted in CAPS ("MEN'S SAUNA", "IT"). Mixed-case
      // prose is title-block or note text — "Fax", "Story" — and pairing it
      // with a nearby number invents a room out of a fax number.
      if (/[a-z]/.test(raw)) continue;
      if (!/^[A-Z][A-Z .'’\/&-]{1,}$/.test(norm(raw))) continue;
      if (NON_ROOM_NAME.has(norm(raw))) continue;
      if (dy < best) { best = dy; name = cand.str.trim(); }
    }
    const tag: RoomTag = { tag: t, name, sheet: sheet.key, bbox: b };
    if (a.building) tag.building = a.building;
    out.push(tag);
  }
  // a delta beside the bubble flags the ROOM as revised — the finish stated
  // for it changed under that revision; nearest marker within ~2.5 tag
  // heights of the bubble's edge attaches, farther ones are someone else's
  const markers: Array<{ rev: string; span: GraphSpan; box: Bbox; drawn?: boolean }> = [];
  for (const c of spans) {
    const tri = opts.deltas?.get(c);
    if (tri) markers.push({ rev: norm(c.str), span: c, box: merge(bboxOf(c), tri), drawn: true });
    else {
      const rev = revisionOf(c.str);
      if (rev != null) markers.push({ rev, span: c, box: bboxOf(c) });
    }
  }
  for (const tag of out) {
    const hgt = Math.max(tag.bbox[3] - tag.bbox[1], 6);
    let bestM: (typeof markers)[number] | null = null;
    let bd = Infinity;
    for (const m of markers) {
      const dx = Math.max(tag.bbox[0] - m.box[2], m.box[0] - tag.bbox[2], 0);
      const dy = Math.max(tag.bbox[1] - m.box[3], m.box[1] - tag.bbox[3], 0);
      const d = Math.hypot(dx, dy);
      if (d <= hgt * 2.5 && d < bd) { bd = d; bestM = m; }
    }
    if (bestM) tag.revision = { rev: bestM.rev, source: { sheet: sheet.key, text: bestM.span.str.trim(), bbox: bestM.box }, ...(bestM.drawn ? { drawn: true } : {}) };
  }
  return out;
}

// ── detail callouts ─────────────────────────────────────────────────────────
export interface DetailCallout { detail: string; target_sheet: string; sheet: string; bbox: Bbox }
const CALLOUT_RE = /^(\d{1,2})\s*\/\s*([A-Z]{1,2}-?\d{1,3}(?:\.\d+)?)$/;

export function detailCallouts(sheet: SheetSpans): DetailCallout[] {
  const out: DetailCallout[] = [];
  for (const sp of sheet.spans) {
    const m = sp.str.trim().match(CALLOUT_RE);
    if (m) out.push({ detail: m[1], target_sheet: m[2], sheet: sheet.key, bbox: bboxOf(sp) });
  }
  return out;
}

// ── the graph ───────────────────────────────────────────────────────────────
export interface SheetGraphSchedule { kind: TableKind; title: string; rows: number; region: Bbox; continues?: string; rotated_headers?: boolean }
export interface SheetGraphSheet { key: string; role: SheetRole; confidence: number; evidence: Evidence | null; building?: string; schedules: SheetGraphSchedule[] }
export interface SheetGraph {
  available: boolean;                 // false = no text layer anywhere (a scanned set) — nothing half-populates
  sheets: SheetGraphSheet[];
  rooms: RoomTag[];                   // numbers CORROBORATED as rooms
  unmatched_tags: UnmatchedTag[];     // numbers that are not, each with its reason — listed, never dropped
  tables: ScheduleTable[];            // LOGICAL tables — a continued schedule is one entry
  callouts: DetailCallout[];
  buildings: string[];                // every building designator the set names, sorted
  revisions: RevisionMarker[];        // every delta/REV marker the set carries — the sheet is under revision where these sit
  notes: string[];                    // named gaps found while building — never silent drops
}

export function buildSheetGraph(sheets: SheetSpans[]): SheetGraph {
  const withText = sheets.filter((s) => s.spans.length > 0);
  if (!withText.length) return { available: false, sheets: [], rooms: [], unmatched_tags: [], tables: [], callouts: [], buildings: [], revisions: [], notes: [] };
  const notes: string[] = [];

  // revision markers, set-wide — where these sit, the current answer is the
  // POST-revision answer and the consumer should know the ink changed. Two
  // detectors: text markers ("Δ2", "REV 2"), and DRAWN deltas — a bare digit
  // inside a digit-scale triangle of linework — on sheets that supplied segs.
  const deltasBySheet = new Map<string, DeltaIndex>();
  const revisions: RevisionMarker[] = [];
  for (const s of withText) {
    const deltas: DeltaIndex = new Map();
    if (s.segs?.length) for (const d of drawnDeltaMarkers(s.spans, s.segs)) deltas.set(d.span, d.tri);
    if (deltas.size) deltasBySheet.set(s.key, deltas);
    for (const sp of s.spans) {
      const tri = deltas.get(sp);
      if (tri) revisions.push({ rev: norm(sp.str), sheet: s.key, bbox: merge(bboxOf(sp), tri), drawn: true });
      else {
        const rev = revisionOf(sp.str);
        if (rev != null) revisions.push({ rev, sheet: s.key, bbox: bboxOf(sp) });
      }
    }
  }

  // pass 0 — building vocabulary from TEXT (sheet titles, table titles): the
  // gate for qualified row keys, known before any extraction
  const ctxBySheet = new Map<string, string>();
  const buildings = new Set<string>();
  for (const s of withText) {
    for (const sp of s.spans) for (const b of buildingMentions(sp.str)) buildings.add(b);
    const ctx = sheetBuilding(s);
    if (ctx) ctxBySheet.set(s.key, ctx.building);
  }

  // pass 1 — roles + per-sheet table fragments
  const roles = new Map<string, ReturnType<typeof classifySheetRole>>();
  const fragments: ScheduleTable[] = [];
  const fragmentKinds = new Map<string, Set<TableKind>>(); // sheet key → kinds extracted there
  for (const s of withText) {
    roles.set(s.key, classifySheetRole(s));
    for (const kind of ["room-finish", "finish"] as const) {
      const t = extractTable(s, kind, { buildings, deltas: deltasBySheet.get(s.key) });
      if (!t) continue;
      // A DOOR / WINDOW / PARTITION schedule carries a MARK column, so the
      // finish-table hunt happily reads one as a finish/material schedule —
      // and then a finish code that collides with a door mark chains to a
      // door, which is a confidently wrong product in the bid. Field-found on
      // a real grocery set whose DOOR SCHEDULE extracted as 54 "finish" rows.
      // Refuse by TITLE, and only when the title does not also say finish or
      // material: when in doubt the table is kept, and the drop is NAMED.
      if (kind === "finish" && t.title && isNonFinishSchedule(t.title.text)) {
        notes.push(`${s.key}: "${t.title.text}" names another schedule family, not a finish/material schedule — its ${t.rows.length} rows are NOT indexed as finish definitions`);
        continue;
      }
      // table-level building: its own title first, the sheet's context second
      const titleB = t.title ? buildingMentions(t.title.text) : [];
      const b = titleB.length === 1 ? titleB[0] : ctxBySheet.get(s.key);
      if (b) t.building = b;
      for (const r of t.rows) if (r.building) buildings.add(r.building);
      fragments.push(t);
      if (!fragmentKinds.has(s.key)) fragmentKinds.set(s.key, new Set());
      fragmentKinds.get(s.key)!.add(kind);
    }
  }

  // pass 2 — merge continuations (header repeated), in sheet order
  const tables: ScheduleTable[] = [];
  for (const f of fragments) {
    const base = f.title && isContinuationTitle(f.title.text) ? findContinuationBase(tables, f) : null;
    if (base) mergeContinuation(base, f);
    else {
      if (f.title && isContinuationTitle(f.title.text)) {
        notes.push(`${f.sheet}: "${f.title.text}" reads as a continuation but no earlier ${f.kind} table matches — kept as a standalone table`);
      }
      tables.push(f);
    }
  }

  // pass 2b — header-less continuations: a "… SCHEDULE … CONT'D" TITLE on a
  // sheet that yielded no table of that kind adopts the base's anchors
  for (const s of withText) {
    for (const sp of s.spans) {
      const text = sp.str.trim();
      if (!isContinuationTitle(text)) continue;
      const fragBase = baseTitleOf(text);
      const base = [...tables].reverse().find((t) => t.kind !== "unknown" && t.title && baseTitleOf(t.title.text) === fragBase
        && t.sheet !== s.key && !t.parts?.some((p) => p.sheet === s.key));
      if (!base || fragmentKinds.get(s.key)?.has(base.kind)) continue;
      const adopted = adoptContinuationRows(s, sp, base, buildings, deltasBySheet.get(s.key));
      if (adopted) {
        if (adopted.building == null && ctxBySheet.get(s.key)) adopted.building = ctxBySheet.get(s.key);
        mergeContinuation(base, adopted);
        for (const r of adopted.rows) if (r.building) buildings.add(r.building);
      } else {
        notes.push(`${s.key}: "${text}" reads as a continuation of ${base.sheet} but no rows aligned to that table's columns — rows there are NOT indexed`);
      }
    }
  }

  // pass 3 — room tags (full building vocabulary known) + callouts. Room tags
  // read off PLAN-role sheets AND unknowns — a schedule sheet's room-number
  // column must not mint phantom rooms, so schedule/legend sheets contribute
  // rows, not tags.
  const sheetNumbers = new Set<string>();
  for (const s of sheets) {
    const n = norm(s.sheet_number || "").replace(/[^A-Z0-9]/g, "");
    if (n) sheetNumbers.add(n);
  }
  const found: RoomTag[] = [];
  const callouts: DetailCallout[] = [];
  for (const s of withText) {
    const role = roles.get(s.key)!;
    // Read tags unless the sheet is CONFIDENTLY something that carries room
    // numbers as table content rather than as drawing tags. A weak guess must
    // not suppress the reading: a real finish plan whose title block the role
    // hunt could not parse came back "detail" at 0.3 confidence, and that
    // single soft signal silently hid every room on the sheet.
    const suppresses = (role.role === "schedule" || role.role === "legend" || role.role === "elevation" || role.role === "detail") && role.confidence >= 0.6;
    if (!suppresses) {
      const ctxB = ctxBySheet.get(s.key);
      for (const r of roomTags(s, { buildings, exclude: sheetNumbers, deltas: deltasBySheet.get(s.key) })) {
        if (r.building == null && ctxB) r.building = ctxB;
        found.push(r);
      }
    }
    callouts.push(...detailCallouts(s));
  }

  // ── pass 3b: is that number actually a ROOM? (#87 phase 4) ────────────────
  // A finish plan is covered in 2–3 digit numbers that are not rooms: keynote
  // hexagons, detail markers, dimension fragments. Measured across five real
  // sets, they were a third of everything the tag reader returned — and every
  // one came back "no schedule row", which reads like a room missing from the
  // schedule (the lost-bid case) when it is nothing of the kind. Two honest
  // signals CORROBORATE a number as a room:
  //   name     — a room name sits stacked with it, the drafting convention;
  //   schedule — a room-finish row answers for that number.
  // A number with neither is not called a room and is not dropped either: it
  // goes to unmatched_tags WITH its reason, so a real room the schedule
  // forgot is still visible — just not counted as an answered room.
  const roomRows = tables.filter((t) => t.kind === "room-finish");
  const scheduleNums = new Set<string>();
  for (const t of roomRows) for (const r of t.rows) scheduleNums.add(numOf(norm(r.key)));
  const rooms: RoomTag[] = [];
  const unmatched: UnmatchedTag[] = [];
  for (const r of found) {
    const num = numOf(norm(r.tag).replace(/\s+/g, ""));
    const byName = !!r.name.trim();
    const bySchedule = scheduleNums.has(num);
    // Where the set HAS a room-finish schedule, that schedule is the
    // authority on which numbers are rooms. A drawn name is not enough on its
    // own: a keynote legend ("10  LOCKER ROOM ACCESSORY", "13  MIRROR") pairs
    // a number with a description exactly the way a room bubble pairs one
    // with a name, and measured across real sets the name-only signal fired
    // on legend rows and never on a genuine room the schedule had missed.
    // So a named number the schedule does not list is still surfaced — under
    // its OWN reason, which is the one an estimator needs to read.
    if (bySchedule || (byName && !roomRows.length)) {
      r.corroboration = bySchedule ? (byName ? "name+schedule" : "schedule") : "name";
      rooms.push(r);
    } else {
      unmatched.push({
        tag: r.tag, sheet: r.sheet, bbox: r.bbox, ...(r.building ? { building: r.building } : {}),
        ...(byName ? { name: r.name } : {}),
        reason: !roomRows.length
          ? "no room name drawn with it, and the set carries no room-finish schedule to check it against"
          : byName
            ? `"${r.name}" is drawn with it but no room-finish row answers for it — either a room the schedule omits, or a keynote/legend row; LOOK before pricing it`
            : "no room name drawn with it and no room-finish row answers for it — reads as a keynote, detail marker or dimension fragment rather than a room",
      });
    }
  }
  if (unmatched.length) {
    notes.push(`${unmatched.length} numbered tag(s) on plan sheets are NOT counted as rooms — no name drawn with them and no schedule row answers for them; see unmatched_tags (they are listed, never dropped)`);
  }

  // compose the per-sheet view from the LOGICAL tables' parts
  const outSheets: SheetGraphSheet[] = withText.map((s) => {
    const role = roles.get(s.key)!;
    const schedules: SheetGraphSchedule[] = [];
    for (const t of tables) {
      const parts: TablePart[] = t.parts ?? [{ sheet: t.sheet, title: t.title?.text || "", rows: t.rows.length, region: t.region, ...(t.rotated_headers ? { rotated_headers: true } : {}) }];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.sheet !== s.key) continue;
        schedules.push({
          kind: t.kind, title: p.title || t.title?.text || "", rows: p.rows, region: p.region,
          ...(i > 0 ? { continues: t.sheet } : {}),
          ...(p.rotated_headers ? { rotated_headers: true } : {}),
        });
      }
    }
    const entry: SheetGraphSheet = { key: s.key, role: role.role, confidence: role.confidence, evidence: role.evidence, schedules };
    const b = ctxBySheet.get(s.key);
    if (b) entry.building = b;
    return entry;
  });

  return { available: true, sheets: outSheets, rooms, unmatched_tags: unmatched, tables, callouts, buildings: [...buildings].sort(), revisions, notes };
}

// ── resolution ──────────────────────────────────────────────────────────────
// resolve a room tag: plan tag → room-finish row → finish definitions.
// Finish cells are the room-finish row's FLOOR/BASE/WALL-ish columns; each
// resolved code chains to the finish table's definition when one exists.
// Phase 2: the tag may be building-qualified ("A-134"); an UNQUALIFIED tag
// that matches rows in more than one building refuses and LISTS the
// candidates — the first match is exactly the wrong answer in a multi-
// building set.
export interface ResolvedFinish { surface: string; code: string; source: Evidence; definition?: { cells: Record<string, string>; source: Evidence } }
export interface ResolveCandidate { key: string; building?: string; sheet: string; table: string }
export type ResolveResult =
  | { status: "resolved"; tag: string; room: RoomTag | null; building?: string; finishes: ResolvedFinish[]; sources: Evidence[]; revisions?: RowRevision[] }
  | { status: "unresolved"; tag: string; room: RoomTag | null; reason: string; candidates?: ResolveCandidate[] };

const SURFACE_HEADERS = ["FLOOR", "BASE", "WALL", "WALLS", "NORTH", "SOUTH", "EAST", "WEST", "CEILING", "WAINSCOT"];
/** A surface column, including a two-tier sub-column ("WALLS N"): the LEADING
 * word names the surface, the rest qualifies it. Ranked so a row's finishes
 * always come back FLOOR-first regardless of the sheet's column order. */
const surfaceRank = (label: string): number => SURFACE_HEADERS.indexOf(label.split(" ")[0]);

export function resolveTag(graph: SheetGraph, tag: string): ResolveResult {
  const t = norm(tag).replace(/\s+/g, "");
  const q = t.match(QUALIFIED_KEY_RE);
  const wantB = q ? q[1] : null;
  const num = q ? q[2] : t;

  // Citation draws on the UNCORROBORATED tags too. A number the schedule
  // never lists is not counted as a room, but when someone asks about it the
  // refusal must still point at the ink on the plan — that plan bubble is the
  // whole evidence that a room may have been left out of the schedule, and
  // dropping it is how the bid loses the room.
  const asRoom = (u: UnmatchedTag): RoomTag => ({ tag: u.tag, name: u.name ?? "", sheet: u.sheet, bbox: u.bbox, ...(u.building ? { building: u.building } : {}) });
  const candidates: RoomTag[] = [...graph.rooms, ...graph.unmatched_tags.map(asRoom)];
  const rooms = candidates.filter((r) => {
    const rt = norm(r.tag).replace(/\s+/g, "");
    return rt === t || numOf(rt) === num;
  });
  const pickRoom = (b: string | null): RoomTag | null => {
    if (b) return rooms.find((r) => r.building === b) ?? rooms.find((r) => !r.building) ?? null;
    const distinct = new Set(rooms.map((r) => r.building || ""));
    return distinct.size > 1 ? null : rooms[0] ?? null; // citing ONE of two buildings' tags would be quietly wrong
  };

  const roomTables = graph.tables.filter((x) => x.kind === "room-finish");
  if (!roomTables.length) return { status: "unresolved", tag: t, room: pickRoom(wantB), reason: "no room-finish schedule found in the set" };

  interface Cand { tab: ScheduleTable; r: TableRow; building?: string }
  const cands: Cand[] = [];
  for (const tab of roomTables) {
    for (const r of tab.rows) {
      if (numOf(norm(r.key)) !== num) continue;
      const b = r.building ?? tab.building;
      cands.push({ tab, r, ...(b ? { building: b } : {}) });
    }
  }
  const describe = (c: Cand) => `${c.building ? `building ${c.building}` : "no building"} (${c.r.sheet})`;
  const wire = (c: Cand): ResolveCandidate => ({ key: c.r.key, ...(c.building ? { building: c.building } : {}), sheet: c.r.sheet, table: c.tab.title?.text || `${c.tab.kind} schedule` });

  let chosen: Cand;
  if (wantB) {
    const filtered = cands.filter((c) => c.building === wantB);
    if (!filtered.length) {
      if (!graph.buildings.length) {
        return { status: "unresolved", tag: t, room: pickRoom(wantB), reason: `the set names no buildings — no BUILDING/BLDG text or qualified schedule keys anywhere; try resolve_tag "${num}"`, ...(cands.length ? { candidates: cands.map(wire) } : {}) };
      }
      if (!graph.buildings.includes(wantB)) {
        return { status: "unresolved", tag: t, room: pickRoom(wantB), reason: `the set names no building "${wantB}" (buildings found: ${graph.buildings.join(", ")})`, ...(cands.length ? { candidates: cands.map(wire) } : {}) };
      }
      if (cands.length) {
        return { status: "unresolved", tag: t, room: pickRoom(wantB), reason: `no building-${wantB} schedule row for ${num} — ${num} is listed under ${cands.map(describe).join(", ")}`, candidates: cands.map(wire) };
      }
      return { status: "unresolved", tag: t, room: pickRoom(wantB), reason: `no schedule row for ${t} — the plan shows the room but no room-finish table lists it` };
    }
    if (filtered.length > 1) {
      return { status: "unresolved", tag: t, room: pickRoom(wantB), reason: `ambiguous: ${filtered.length} schedule rows match ${t} (${filtered.map((c) => c.r.sheet).join(", ")})`, candidates: filtered.map(wire) };
    }
    chosen = filtered[0];
  } else {
    if (!cands.length) return { status: "unresolved", tag: t, room: pickRoom(null), reason: `no schedule row for ${t} — the plan shows the room but no room-finish table lists it` };
    if (cands.length > 1) {
      const distinctB = [...new Set(cands.filter((c) => c.building).map((c) => c.building!))];
      if (distinctB.length > 1) {
        return {
          status: "unresolved", tag: t, room: null,
          reason: `ambiguous: room ${num} appears in ${distinctB.length} buildings — ${cands.map(describe).join(", ")} — qualify the tag, e.g. "${distinctB[0]}-${num}"`,
          candidates: cands.map(wire),
        };
      }
      return { status: "unresolved", tag: t, room: pickRoom(null), reason: `ambiguous: ${cands.length} schedule rows match ${t} (room numbers reused across the set?)`, candidates: cands.map(wire) };
    }
    chosen = cands[0];
  }

  const { tab, r } = chosen;
  const room = pickRoom(chosen.building ?? null);
  const finTables = graph.tables.filter((x) => x.kind === "finish");
  const finishes: ResolvedFinish[] = [];
  const sources: Evidence[] = [{ sheet: r.sheet, text: `${tab.title?.text || "room-finish schedule"} row ${r.key}`, bbox: r.cells[Object.keys(r.cells)[0]]?.bbox || tab.region }];
  if (room) sources.unshift({ sheet: room.sheet, text: `${room.name ? room.name + " " : ""}${room.tag}`.trim(), bbox: room.bbox });
  const surfaces = Object.keys(r.cells)
    .filter((k) => surfaceRank(k) >= 0)
    .sort((a, b) => surfaceRank(a) - surfaceRank(b) || a.localeCompare(b));
  for (const surface of surfaces) {
    const cell = r.cells[surface];
    if (!cell || !cell.text.trim()) continue;
    const code = norm(cell.text).replace(/[^A-Z0-9-]/g, "");
    const fin: ResolvedFinish = { surface, code: cell.text.trim(), source: { sheet: r.sheet, text: cell.text.trim(), bbox: cell.bbox } };
    for (const ft of finTables) {
      const def = ft.rows.find((fr) => rowKeyAnswersFor(fr.key, code));
      if (def) {
        const cells: Record<string, string> = {};
        for (const [k, v] of Object.entries(def.cells)) cells[k] = v.text;
        fin.definition = { cells, source: { sheet: def.sheet, text: `${ft.title?.text || "finish schedule"} row ${def.key}`, bbox: def.cells[Object.keys(def.cells)[0]]?.bbox || ft.region } };
        break;
      }
    }
    finishes.push(fin);
  }
  if (!finishes.length) return { status: "unresolved", tag: t, room, reason: `schedule row ${t} exists but carries no finish cells the extractor could band` };
  // revision markers on the answering row or the plan bubble ride the result:
  // the codes above are the POST-revision answer, but the consumer must know
  // the ink changed — a delta read silently is a superseded number priced
  // confidently
  const revs: RowRevision[] = [];
  if (r.revision) revs.push(r.revision);
  if (room?.revision && !revs.some((v) => v.rev === room.revision!.rev)) revs.push(room.revision);
  return { status: "resolved", tag: t, room, ...(chosen.building ? { building: chosen.building } : {}), finishes, sources, ...(revs.length ? { revisions: revs } : {}) };
}
