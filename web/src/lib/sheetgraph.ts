// The sheet graph (#87, phase 1) — a pure, client-side plan-set index built
// from positioned text spans: sheet roles, schedule tables, room tags, detail
// callouts, and the resolution room tag → schedule row → finish definition.
// No pdf.js, no DOM — the MCP server and the canvas both feed it spans.
//
// Doctrine (the RFC's): every edge carries an EVIDENCE pointer (sheet, text,
// bbox) — an edge without provenance is a hallucination with extra steps and
// is never created. A room on the plan with no schedule row comes back
// UNRESOLVED WITH A REASON, never silently omitted — the omission is how a
// bid gets lost. A set with no text layer degrades to "unavailable", cleanly.
//
// Composes the machinery the repo already trusts: scheduleParse's header-
// anchor table idiom (generalized here to arbitrary header vocabularies),
// detectRooms' room-tag pattern, and the span shape the MCP server already
// serves (sheet_context.text.spans).

import { ROOM_LABEL_RE } from "./detectRooms";

export interface GraphSpan { str: string; x: number; y: number; w: number; h: number }
export interface SheetSpans { key: string; sheet_number?: string | null; spans: GraphSpan[] }

export type SheetRole = "plan" | "schedule" | "legend" | "detail" | "elevation" | "demolition" | "unknown";
export type Bbox = [number, number, number, number];
export interface Evidence { sheet: string; text: string; bbox: Bbox }

const bboxOf = (s: GraphSpan): Bbox => [s.x, s.y, s.x + (s.w || 0), s.y + (s.h || 0)];
const merge = (a: Bbox, b: Bbox): Bbox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const norm = (s: string) => (s || "").trim().toUpperCase();

// ── sheet role ──────────────────────────────────────────────────────────────
// Title text first (what the sheet SAYS it is), sheet-number convention as a
// weak fallback. Wrong-here poisons everything downstream, so mixed signals
// lower confidence instead of picking a winner silently — and a sheet can
// legitimately be a plan that CARRIES schedules (the common case); schedules
// are found per-region below regardless of the sheet's role.
// A standalone schedule TITLE ("ROOM FINISH SCHEDULE - FIRST FLOOR") is a far
// stronger signal than the word SCHEDULE appearing in running text.
const SCHEDULE_TITLE_RE = /^[A-Z][A-Z ()/&.-]* SCHEDULE( *[-–] *[A-Z0-9 ()/&.-]+)?$/;
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

// ── schedule tables ─────────────────────────────────────────────────────────
// Generalized header-anchor extraction: a header row is a row where ≥ minHits
// tokens match the vocabulary; data cells band to the nearest anchor. Every
// cell keeps its evidence bbox. Two vocabularies ship: the room-finish
// schedule (rooms → finishes — THE resolution target) and the finish/material
// schedule (codes → products, scheduleParse's own gate re-stated).
export type TableKind = "room-finish" | "finish" | "unknown";
export interface TableCell { text: string; bbox: Bbox }
export interface TableRow { key: string; cells: Record<string, TableCell> }
export interface ScheduleTable { kind: TableKind; sheet: string; title: Evidence | null; headers: string[]; rows: TableRow[]; region: Bbox }

const ROOM_HEADERS = ["ROOM", "NO", "NUMBER", "NAME", "FLOOR", "BASE", "WALL", "WALLS", "NORTH", "SOUTH", "EAST", "WEST", "CEILING", "WAINSCOT", "REMARKS", "CLG", "HT"];
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

const nearestAnchor = (x: number, anchors: Array<{ label: string; x: number }>) => {
  let best = anchors[0];
  for (const a of anchors) if (Math.abs(a.x - x) < Math.abs(best.x - x)) best = a;
  return best.label;
};

// A finish code: scheduleParse's pattern. A schedule ROW key is looser than a
// plan bubble (detectRooms' 2–3 digits): real room-finish schedules carry
// "3", "3A", "139A" — one to three digits plus up to two letters.
const CODE_RE = /^[A-Z]{1,4}(-?[A-Z0-9]{1,4})?$/;
const ROW_KEY_RE = /^\d{1,3}[A-Z]{0,2}$/;

/** Extract one kind of table from a sheet's spans. Returns null when the
 * header structure isn't there — never invented rows. */
export function extractTable(sheet: SheetSpans, kind: "room-finish" | "finish"): ScheduleTable | null {
  const rows = clusterRows(sheet.spans);
  const found = kind === "room-finish"
    ? findHeaderRow(rows, ROOM_HEADERS, ["FLOOR", "BASE"], 4)
    : findHeaderRow(rows, FINISH_HEADERS, ["CODE", "MARK"], 3);
  if (!found) return null;
  const { anchors, rowIndex } = found;
  const keyRe = kind === "room-finish" ? ROW_KEY_RE : CODE_RE;
  const out: TableRow[] = [];
  let region: Bbox | null = null;
  const headerRow = rows[rowIndex];
  for (const t of headerRow) region = region ? merge(region, bboxOf(t)) : bboxOf(t);
  // The ANCHORS bound the table, not the whole clustered row — on a dense
  // sheet a neighbouring table's header can share the y-band, and its x-range
  // must not leak in. Left margin is generous (data cells sit left of a
  // centered header); the right edge extends past the last anchor by three
  // median column gaps so a wide REMARKS cell stays in while the next table
  // over stays out.
  const gaps = anchors.slice(1).map((a, i) => a.x - anchors[i].x).sort((a, b) => a - b);
  const medGap = gaps.length ? gaps[gaps.length >> 1] : 150;
  const x0 = anchors[0].x - Math.max(80, medGap / 2);
  const x1 = anchors[anchors.length - 1].x + Math.max(300, medGap * 3);
  for (let i = rowIndex + 1; i < rows.length; i++) {
    const inBand = rows[i].filter((t) => t.x >= x0 && t.x <= x1);
    if (!inBand.length) continue;
    const keyTok = inBand[0];
    const key = norm(keyTok.str).replace(/[^A-Z0-9-]/g, "");
    if (!keyRe.test(key)) continue;
    const cells: Record<string, TableCell> = {};
    for (const t of inBand) {
      const label = nearestAnchor(t.x, anchors);
      const text = t.str.trim();
      if (!cells[label]) cells[label] = { text, bbox: bboxOf(t) };
      else { cells[label] = { text: `${cells[label].text} ${text}`, bbox: merge(cells[label].bbox, bboxOf(t)) }; }
      region = region ? merge(region, bboxOf(t)) : bboxOf(t);
    }
    out.push({ key, cells });
  }
  if (!out.length) return null;
  // the table's title: the nearest "… SCHEDULE" span above the header row
  // WITHIN the table's own x-band — on a dense sheet the neighbouring table's
  // title shares the y-band and must not label this one
  let title: Evidence | null = null;
  for (let i = rowIndex - 1; i >= 0 && i >= rowIndex - 6 && !title; i--) {
    const hit = rows[i].find((t) => /SCHEDULE/.test(norm(t.str)) && t.x >= x0 && t.x <= x1);
    if (hit) title = { sheet: sheet.key, text: hit.str.trim(), bbox: bboxOf(hit) };
  }
  return { kind, sheet: sheet.key, title, headers: anchors.map((a) => a.label), rows: out, region: region! };
}

// ── room tags on plans ──────────────────────────────────────────────────────
export interface RoomTag { tag: string; name: string; sheet: string; bbox: Bbox }

/** Room-number tags on a sheet, with the name span sitting just above the
 * number (the "WORKROOM ⏎ 109" bubble stack) when one exists. */
export function roomTags(sheet: SheetSpans): RoomTag[] {
  const out: RoomTag[] = [];
  const spans = sheet.spans;
  for (const sp of spans) {
    const t = sp.str.trim();
    if (!ROOM_LABEL_RE.test(t)) continue;
    const b = bboxOf(sp);
    const hgt = Math.max(sp.h || 8, 6);
    // the label above: horizontally overlapping, within ~2 text heights up,
    // and NOT itself a number (two stacked room numbers are two rooms)
    let name = "";
    let best = Infinity;
    for (const cand of spans) {
      if (cand === sp || ROOM_LABEL_RE.test(cand.str.trim())) continue;
      const cb = bboxOf(cand);
      const dy = b[1] - cb[3];
      if (dy < -hgt * 0.2 || dy > hgt * 2.2) continue;
      if (cb[2] < b[0] - hgt || cb[0] > b[2] + hgt) continue;
      if (!/^[A-Z][A-Z .\/&-]{2,}$/.test(norm(cand.str))) continue;
      if (dy < best) { best = dy; name = cand.str.trim(); }
    }
    out.push({ tag: t, name, sheet: sheet.key, bbox: b });
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
export interface SheetGraphSheet { key: string; role: SheetRole; confidence: number; evidence: Evidence | null; schedules: Array<{ kind: TableKind; title: string; rows: number; region: Bbox }> }
export interface SheetGraph {
  available: boolean;                 // false = no text layer anywhere (a scanned set) — nothing half-populates
  sheets: SheetGraphSheet[];
  rooms: RoomTag[];
  tables: ScheduleTable[];
  callouts: DetailCallout[];
}

export function buildSheetGraph(sheets: SheetSpans[]): SheetGraph {
  const withText = sheets.filter((s) => s.spans.length > 0);
  if (!withText.length) return { available: false, sheets: [], rooms: [], tables: [], callouts: [] };
  const tables: ScheduleTable[] = [];
  const rooms: RoomTag[] = [];
  const callouts: DetailCallout[] = [];
  const outSheets: SheetGraphSheet[] = [];
  for (const s of withText) {
    const role = classifySheetRole(s);
    const found: ScheduleTable[] = [];
    for (const kind of ["room-finish", "finish"] as const) {
      const t = extractTable(s, kind);
      if (t) { found.push(t); tables.push(t); }
    }
    // room tags read off PLAN-role sheets AND unknowns — a schedule sheet's
    // room-number column must not mint phantom rooms, so schedule/legend
    // sheets contribute rows, not tags
    if (role.role === "plan" || role.role === "unknown" || role.role === "demolition") rooms.push(...roomTags(s));
    callouts.push(...detailCallouts(s));
    outSheets.push({
      key: s.key, role: role.role, confidence: role.confidence, evidence: role.evidence,
      schedules: found.map((t) => ({ kind: t.kind, title: t.title?.text || "", rows: t.rows.length, region: t.region })),
    });
  }
  return { available: true, sheets: outSheets, rooms, tables, callouts };
}

// ── resolution ──────────────────────────────────────────────────────────────
// resolve a room tag: plan tag → room-finish row → finish definitions.
// Finish cells are the room-finish row's FLOOR/BASE/WALL-ish columns; each
// resolved code chains to the finish table's definition when one exists.
export interface ResolvedFinish { surface: string; code: string; source: Evidence; definition?: { cells: Record<string, string>; source: Evidence } }
export type ResolveResult =
  | { status: "resolved"; tag: string; room: RoomTag | null; finishes: ResolvedFinish[]; sources: Evidence[] }
  | { status: "unresolved"; tag: string; room: RoomTag | null; reason: string };

const SURFACE_HEADERS = ["FLOOR", "BASE", "WALL", "WALLS", "NORTH", "SOUTH", "EAST", "WEST", "CEILING", "WAINSCOT"];

export function resolveTag(graph: SheetGraph, tag: string): ResolveResult {
  const t = norm(tag);
  const room = graph.rooms.find((r) => norm(r.tag) === t) || null;
  const roomTables = graph.tables.filter((x) => x.kind === "room-finish");
  if (!roomTables.length) return { status: "unresolved", tag: t, room, reason: "no room-finish schedule found in the set" };
  const matches = roomTables.flatMap((tab) => tab.rows.filter((r) => norm(r.key) === t).map((r) => ({ tab, r })));
  if (!matches.length) return { status: "unresolved", tag: t, room, reason: `no schedule row for ${t} — the plan shows the room but no room-finish table lists it` };
  if (matches.length > 1) return { status: "unresolved", tag: t, room, reason: `ambiguous: ${matches.length} schedule rows match ${t} (room numbers reused across the set?)` };
  const { tab, r } = matches[0];
  const finTables = graph.tables.filter((x) => x.kind === "finish");
  const finishes: ResolvedFinish[] = [];
  const sources: Evidence[] = [{ sheet: tab.sheet, text: `${tab.title?.text || "room-finish schedule"} row ${r.key}`, bbox: r.cells[Object.keys(r.cells)[0]]?.bbox || tab.region }];
  if (room) sources.unshift({ sheet: room.sheet, text: `${room.name ? room.name + " " : ""}${room.tag}`.trim(), bbox: room.bbox });
  for (const surface of SURFACE_HEADERS) {
    const cell = r.cells[surface];
    if (!cell || !cell.text.trim()) continue;
    const code = norm(cell.text).replace(/[^A-Z0-9-]/g, "");
    const fin: ResolvedFinish = { surface, code: cell.text.trim(), source: { sheet: tab.sheet, text: cell.text.trim(), bbox: cell.bbox } };
    for (const ft of finTables) {
      const def = ft.rows.find((fr) => norm(fr.key) === code);
      if (def) {
        const cells: Record<string, string> = {};
        for (const [k, v] of Object.entries(def.cells)) cells[k] = v.text;
        fin.definition = { cells, source: { sheet: ft.sheet, text: `${ft.title?.text || "finish schedule"} row ${def.key}`, bbox: def.cells[Object.keys(def.cells)[0]]?.bbox || ft.region } };
        break;
      }
    }
    finishes.push(fin);
  }
  if (!finishes.length) return { status: "unresolved", tag: t, room, reason: `schedule row ${t} exists but carries no finish cells the extractor could band` };
  return { status: "resolved", tag: t, room, finishes, sources };
}
