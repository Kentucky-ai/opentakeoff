// The sheet graph (#87, phases 1–2) — a pure, client-side plan-set index built
// from positioned text spans: sheet roles, schedule tables (including tables
// that CONTINUE across sheets and tables with rotated column headers), room
// tags qualified by building, detail callouts, and the resolution
// room tag → schedule row → finish definition.
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
export interface SheetSpans { key: string; sheet_number?: string | null; spans: GraphSpan[] }

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
  { re: /FINISH\s+PLAN|FLOOR\s+PLAN|FURNITURE\s+PLAN|CEILING\s+PLAN/, role: "plan", conf: 0.85 },
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
    // sheet-number fallback: A-1xx is conventionally a plan — weak, stated as weak
    const n = norm(sheet.sheet_number || "");
    if (/^A-?1\d\d/.test(n)) return { role: "plan", confidence: 0.4, evidence: null };
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
export interface TableRow { key: string; sheet: string; building?: string; cells: Record<string, TableCell> }
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
  anchors?: Array<{ label: string; x: number }>;
}

const ROOM_HEADERS = ["ROOM", "NO", "NUMBER", "NAME", "FLOOR", "BASE", "WALL", "WALLS", "NORTH", "SOUTH", "EAST", "WEST", "CEILING", "WAINSCOT", "REMARKS", "CLG", "HT", "BLDG", "BUILDING"];
const FINISH_HEADERS = ["CODE", "MARK", "MATERIAL", "MANUFACTURER", "PRODUCT", "STYLE", "COLOR", "SIZE", "REMARKS", "DESCRIPTION", "PATTERN"];
// A header CELL is often a multi-word span ("FLOOR FINISH", "CEILING FINISH")
// — the vocabulary word inside it names the column.
const headerLabel = (s: string, vocab: string[]): string | null => {
  for (const w of norm(s).split(/[^A-Z]+/)) if (w && vocab.includes(w)) return w;
  return null;
};

function findHeaderRow(rows: GraphSpan[][], vocab: string[], required: string[], minHits: number): { anchors: Array<{ label: string; x: number }>; rowIndex: number } | null {
  for (let i = 0; i < rows.length; i++) {
    const anchors: Array<{ label: string; x: number }> = [];
    const seen = new Set<string>();
    for (const t of rows[i]) {
      const w = headerLabel(t.str, vocab);
      if (w && !seen.has(w)) { seen.add(w); anchors.push({ label: w, x: t.x }); }
    }
    if (anchors.length < minHits || !required.some((r) => seen.has(r))) continue;
    return { anchors: anchors.sort((a, b) => a.x - b.x), rowIndex: i };
  }
  return null;
}

// Rotated headers (#87 phase 2): column labels written at 90° stack each word
// in a tall, narrow box, so y-row clustering never assembles them into a
// header row — the anchor hunt above goes blind. Vertical spans get their own
// hunt: vocabulary matches whose y-extents overlap form the header BAND;
// each member's x-center is its column anchor; data rows band below the
// band's bottom edge exactly as they would under a horizontal header.
function findRotatedHeader(vert: GraphSpan[], vocab: string[], required: string[], minHits: number): { anchors: Array<{ label: string; x: number }>; top: number; bottom: number; spans: GraphSpan[] } | null {
  const cands = vert
    .map((sp) => ({ sp, label: headerLabel(sp.str, vocab) }))
    .filter((c): c is { sp: GraphSpan; label: string } => !!c.label)
    .sort((a, b) => a.sp.x - b.sp.x);
  let band: typeof cands = [];
  let y0 = 0, y1 = 0;
  const flush = (): ReturnType<typeof findRotatedHeader> => {
    const seen = new Set(band.map((c) => c.label));
    if (band.length < minHits || seen.size < minHits || !required.some((r) => seen.has(r))) return null;
    const anchors: Array<{ label: string; x: number }> = [];
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

const nearestAnchor = (x: number, anchors: Array<{ label: string; x: number }>) => {
  let best = anchors[0];
  for (const a of anchors) if (Math.abs(a.x - x) < Math.abs(best.x - x)) best = a;
  return best.label;
};

// The ANCHORS bound the table, not the whole clustered row — on a dense sheet
// a neighbouring table's header can share the y-band, and its x-range must
// not leak in. Left margin is generous (data cells sit left of a centered
// header); the right edge extends past the last anchor by three median column
// gaps so a wide REMARKS cell stays in while the next table over stays out.
function bandLimits(anchors: Array<{ label: string; x: number }>): { x0: number; x1: number; medGap: number } {
  const gaps = anchors.slice(1).map((a, i) => a.x - anchors[i].x).sort((a, b) => a - b);
  const medGap = gaps.length ? gaps[gaps.length >> 1] : 150;
  return { x0: anchors[0].x - Math.max(80, medGap / 2), x1: anchors[anchors.length - 1].x + Math.max(300, medGap * 3), medGap };
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

export interface ExtractOpts { buildings?: Set<string> }

function rowKeyOf(raw: string, kind: "room-finish" | "finish", buildings?: Set<string>): { key: string; building?: string } | null {
  const key = norm(raw).replace(/[^A-Z0-9-]/g, "");
  if (kind === "finish") return CODE_RE.test(key) ? { key } : null;
  if (ROW_KEY_RE.test(key)) return { key };
  const q = key.match(QUALIFIED_KEY_RE);
  if (q && buildings?.has(q[1])) return { key, building: q[1] };
  return null;
}

/** The number part of a row key — "A-134" and "134" both answer for 134. */
const numOf = (key: string): string => key.match(QUALIFIED_KEY_RE)?.[2] ?? key;

/** Extract one kind of table from a sheet's spans. Returns null when the
 * header structure isn't there — never invented rows. Horizontal header rows
 * are tried first; a sheet without one is re-tried against a rotated
 * (quarter-turn) header band. */
export function extractTable(sheet: SheetSpans, kind: "room-finish" | "finish", opts: ExtractOpts = {}): ScheduleTable | null {
  const horiz = sheet.spans.filter((s) => !isVertical(s));
  const vert = sheet.spans.filter(isVertical);
  const rows = clusterRows(horiz);
  const vocab = kind === "room-finish" ? ROOM_HEADERS : FINISH_HEADERS;
  const required = kind === "room-finish" ? ["FLOOR", "BASE"] : ["CODE", "MARK"];
  const minHits = kind === "room-finish" ? 4 : 3;

  let anchors: Array<{ label: string; x: number }>;
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

  const out: TableRow[] = [];
  let region: Bbox | null = null;
  for (const t of headerSpans) region = region ? merge(region, bboxOf(t)) : bboxOf(t);
  const { x0, x1 } = bandLimits(anchors);
  for (let i = Math.max(dataFrom, 0); i < rows.length; i++) {
    if (rotated && rowY(rows[i]) <= dataBelowY) continue;
    const inBand = rows[i].filter((t) => t.x >= x0 && t.x <= x1);
    if (!inBand.length) continue;
    const keyed = rowKeyOf(inBand[0].str, kind, opts.buildings);
    if (!keyed) continue;
    const cells: Record<string, TableCell> = {};
    for (const t of inBand) {
      const label = nearestAnchor(t.x, anchors);
      const text = t.str.trim();
      if (!cells[label]) cells[label] = { text, bbox: bboxOf(t) };
      else { cells[label] = { text: `${cells[label].text} ${text}`, bbox: merge(cells[label].bbox, bboxOf(t)) }; }
      region = region ? merge(region, bboxOf(t)) : bboxOf(t);
    }
    const row: TableRow = { key: keyed.key, sheet: sheet.key, cells };
    // row-level building: the qualified key's prefix, else the BLDG column
    const cellB = norm(cells.BLDG?.text || cells.BUILDING?.text || "");
    const b = keyed.building ?? (DESIGNATOR_RE.test(cellB) ? cellB : undefined);
    if (b) row.building = b;
    out.push(row);
  }
  if (!out.length) return null;
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
function adoptContinuationRows(sheet: SheetSpans, titleSpan: GraphSpan, base: ScheduleTable, buildings: Set<string>): ScheduleTable | null {
  if (!base.anchors?.length || base.kind === "unknown") return null;
  const rows = clusterRows(sheet.spans.filter((s) => !isVertical(s)));
  const { x0, x1, medGap } = bandLimits(base.anchors);
  const keyTol = Math.max(40, medGap / 2);
  const out: TableRow[] = [];
  let region: Bbox = bboxOf(titleSpan);
  for (const row of rows) {
    if (rowY(row) <= titleSpan.y) continue;
    const inBand = row.filter((t) => t.x >= x0 && t.x <= x1);
    if (!inBand.length) continue;
    const keyed = rowKeyOf(inBand[0].str, base.kind, buildings);
    if (!keyed || Math.abs(inBand[0].x - base.anchors[0].x) > keyTol) continue;
    const cells: Record<string, TableCell> = {};
    for (const t of inBand) {
      const label = nearestAnchor(t.x, base.anchors);
      const text = t.str.trim();
      if (!cells[label]) cells[label] = { text, bbox: bboxOf(t) };
      else { cells[label] = { text: `${cells[label].text} ${text}`, bbox: merge(cells[label].bbox, bboxOf(t)) }; }
      region = merge(region, bboxOf(t));
    }
    const r: TableRow = { key: keyed.key, sheet: sheet.key, cells };
    if (keyed.building) r.building = keyed.building;
    out.push(r);
  }
  if (!out.length) return null;
  return {
    kind: base.kind, sheet: sheet.key,
    title: { sheet: sheet.key, text: titleSpan.str.trim(), bbox: bboxOf(titleSpan) },
    headers: base.headers, rows: out, region,
  };
}

// ── room tags on plans ──────────────────────────────────────────────────────
export interface RoomTag { tag: string; name: string; sheet: string; bbox: Bbox; building?: string }
const QUALIFIED_TAG_RE = /^([A-Z]{1,2})-(\d{2,3}[A-Z]?)$/;

export interface RoomTagOpts {
  /** Building designators the set names — a qualified plan tag ("A-134") is
   * only a room where its prefix is one of these. */
  buildings?: Set<string>;
  /** Normalized tags that are actually sheet numbers in the set ("A-601",
   * "A601") — a title block's own number must never mint a room. */
  exclude?: Set<string>;
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
      if (!/^[A-Z][A-Z .\/&-]{2,}$/.test(norm(cand.str))) continue;
      if (dy < best) { best = dy; name = cand.str.trim(); }
    }
    const tag: RoomTag = { tag: t, name, sheet: sheet.key, bbox: b };
    if (a.building) tag.building = a.building;
    out.push(tag);
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
  rooms: RoomTag[];
  tables: ScheduleTable[];            // LOGICAL tables — a continued schedule is one entry
  callouts: DetailCallout[];
  buildings: string[];                // every building designator the set names, sorted
  notes: string[];                    // named gaps found while building — never silent drops
}

export function buildSheetGraph(sheets: SheetSpans[]): SheetGraph {
  const withText = sheets.filter((s) => s.spans.length > 0);
  if (!withText.length) return { available: false, sheets: [], rooms: [], tables: [], callouts: [], buildings: [], notes: [] };
  const notes: string[] = [];

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
      const t = extractTable(s, kind, { buildings });
      if (!t) continue;
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
      const adopted = adoptContinuationRows(s, sp, base, buildings);
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
  const rooms: RoomTag[] = [];
  const callouts: DetailCallout[] = [];
  for (const s of withText) {
    const role = roles.get(s.key)!;
    if (role.role === "plan" || role.role === "unknown" || role.role === "demolition") {
      const ctxB = ctxBySheet.get(s.key);
      for (const r of roomTags(s, { buildings, exclude: sheetNumbers })) {
        if (r.building == null && ctxB) r.building = ctxB;
        rooms.push(r);
      }
    }
    callouts.push(...detailCallouts(s));
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

  return { available: true, sheets: outSheets, rooms, tables, callouts, buildings: [...buildings].sort(), notes };
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
  | { status: "resolved"; tag: string; room: RoomTag | null; building?: string; finishes: ResolvedFinish[]; sources: Evidence[] }
  | { status: "unresolved"; tag: string; room: RoomTag | null; reason: string; candidates?: ResolveCandidate[] };

const SURFACE_HEADERS = ["FLOOR", "BASE", "WALL", "WALLS", "NORTH", "SOUTH", "EAST", "WEST", "CEILING", "WAINSCOT"];

export function resolveTag(graph: SheetGraph, tag: string): ResolveResult {
  const t = norm(tag).replace(/\s+/g, "");
  const q = t.match(QUALIFIED_KEY_RE);
  const wantB = q ? q[1] : null;
  const num = q ? q[2] : t;

  const rooms = graph.rooms.filter((r) => {
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
  for (const surface of SURFACE_HEADERS) {
    const cell = r.cells[surface];
    if (!cell || !cell.text.trim()) continue;
    const code = norm(cell.text).replace(/[^A-Z0-9-]/g, "");
    const fin: ResolvedFinish = { surface, code: cell.text.trim(), source: { sheet: r.sheet, text: cell.text.trim(), bbox: cell.bbox } };
    for (const ft of finTables) {
      const def = ft.rows.find((fr) => norm(fr.key) === code);
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
  return { status: "resolved", tag: t, room, ...(chosen.building ? { building: chosen.building } : {}), finishes, sources };
}
