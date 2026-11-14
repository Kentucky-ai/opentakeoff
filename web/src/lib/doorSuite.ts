// The Doors suite's reading of a plan set: the door schedule, the hardware
// sets in specification section 08 71 00, which plan door carries which mark,
// and the questions the documents leave to the estimator.
//
// Pure: no React, no DOM, no pdf.js. The canvas hands in text runs (already
// placed in a page frame) and the door reader's doors; everything here is
// deterministic and tested (test/doorSuite.test.ts).
//
// Counting follows how doors are bought. An OPENING is one mark in one frame;
// a pair is one opening with two door leaves. Frames and hardware sets count
// per opening, door slabs per leaf.
import type { ReadDoor } from "./doorReader.ts";

/** A text run in a page frame: x/y = top-left of its box, y down, page points. */
export interface TextRun { str: string; x: number; y: number; w: number; h: number }

export interface ScheduleRow {
  mark: string;
  fromRoom: string;
  toRoom: string;
  width: string;
  height: string;
  doorType: string;
  material: string;
  finish: string;
  glass: string;
  frameType: string;
  frameMaterial: string;
  frameFinish: string;
  rating: string;
  hwSet: string;
  remarks: string;
  /** the row's box in the schedule sheet's frame */
  box: [number, number, number, number];
}

export interface DoorSchedule { rows: ScheduleRow[]; box: [number, number, number, number] }

const MARK_RE = /^[A-Z]?\d{1,4}[A-Z]{0,2}(-\d+)?$/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const up = (s: string) => norm(s).toUpperCase();
const cx = (r: TextRun) => r.x + r.w / 2;
const cy = (r: TextRun) => r.y + r.h / 2;

/** Rows of text: runs whose vertical centres sit within half a line of each other. */
function lines(runs: TextRun[]): TextRun[][] {
  const sorted = [...runs].sort((a, b) => cy(a) - cy(b) || a.x - b.x);
  const out: TextRun[][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const h = Math.max(1, r.h);
    if (last && Math.abs(cy(last[0]) - cy(r)) <= h * 0.5) last.push(r);
    else out.push([r]);
  }
  for (const l of out) l.sort((a, b) => a.x - b.x);
  return out;
}

type Col = { key: keyof ScheduleRow; x: number; x0: number; x1: number };

/** What a bottom-row header label means, given the group words printed above it. */
function columnKey(label: string, group: string): keyof ScheduleRow | null {
  const L = up(label), G = up(group);
  if (/^(DOOR\s*)?(NO\.?|NUMBER|MARK|#)$/.test(L) || L === "DOOR NO." || L === "DOOR") return "mark";
  if (/FROM/.test(L)) return "fromRoom";
  if (/^TO\b/.test(L)) return "toRoom";
  if (/^(W|WD|WIDTH)$/.test(L)) return "width";
  if (/^(H|HT|HGT|HEIGHT)$/.test(L)) return "height";
  if (/RATIN|RATING|LABEL/.test(L) || /FIRE/.test(G) && /^G$|RAT/.test(L)) return "rating";
  if (/SET|HDW|HARDWARE|HW/.test(L) || /HARDWARE/.test(G)) return "hwSet";
  if (/REMARK|NOTE|COMMENT/.test(L)) return "remarks";
  if (/GLASS|GLAZ/.test(L) || /GLASS|GLAZ/.test(G)) return "glass";
  const frame = /FRAME/.test(G);
  if (/TYPE/.test(L)) return frame ? "frameType" : "doorType";
  if (/MAT/.test(L)) return frame ? "frameMaterial" : "material";
  if (/FIN/.test(L)) return frame ? "frameFinish" : "finish";
  return null;
}

const GROUP_WORDS = /^(DOOR|FRAME|GLASS|GLAZING|FIRE|HARDWARE)$/;

/** The door schedule on a sheet, or null when the sheet has none. */
export function readDoorSchedule(runs: TextRun[]): DoorSchedule | null {
  const title = runs.find((r) => /\bDOOR\s+SCHEDULE\b/.test(up(r.str)) && !/HARDWARE/.test(up(r.str)));
  if (!title) return null;
  const below = runs.filter((r) => r.y >= title.y - 2);
  const ls = lines(below);
  // the header's bottom row: the first line under the title holding a door-number label
  const hi = ls.findIndex((l) => l.some((r) => /^(DOOR\s*)?(NO\.?|NUMBER|MARK)$/.test(up(r.str))) && cy(l[0]) > cy(title));
  if (hi < 0) return null;
  const header = ls[hi];
  const markRun = header.find((r) => /^(DOOR\s*)?(NO\.?|NUMBER|MARK)$/.test(up(r.str)))!;
  const left = markRun.x - markRun.h * 2;
  const headerTop = ls.slice(0, hi).filter((l) => cy(l[0]) > cy(title)).flat();
  // the table's right edge: the last header label on the line
  const right = header[header.length - 1].x + header[header.length - 1].w + markRun.h * 3;
  // Multi-line labels ("GLASS" over "TYPE", "FIRE" over "RATIN" over "G"):
  // a word sitting right above a column label (or above another part of one)
  // belongs to that label. The words left over above the header are group
  // headings ("DOOR", "FRAME"), and a column falls under the nearest one.
  const inX = (r: TextRun) => r.x >= left && r.x <= right;
  const partOf = new Map<TextRun, TextRun>();
  const chain = new Map<TextRun, TextRun[]>(header.filter(inX).map((r) => [r, [r]]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of headerTop) {
      if (partOf.has(a) || !inX(a)) continue;
      for (const [col, parts] of chain) {
        const s = parts[0];
        if (cy(s) - cy(a) > 0 && cy(s) - cy(a) <= s.h * 1.6 && Math.abs(cx(a) - cx(s)) < Math.max(a.w, s.w) / 2 + s.h * 0.5) {
          partOf.set(a, col); parts.unshift(a); grew = true; break;
        }
      }
    }
  }
  // Door columns come before frame columns in every door schedule: the second
  // TYPE / MATL / FINISH is the frame's (a FRAME heading over it says so too).
  const FRAME_OF: Partial<Record<keyof ScheduleRow, keyof ScheduleRow>> = { doorType: "frameType", material: "frameMaterial", finish: "frameFinish" };
  const cols: Col[] = [];
  for (const [r, parts] of [...chain].sort((a, b) => cx(a[0]) - cx(b[0]))) {
    const label = parts.map((p) => p.str).join(" ");
    let key = columnKey(label, "") || columnKey(r.str, "");
    if (key && FRAME_OF[key] && (cols.some((c) => c.key === key) || /FRAME/i.test(label))) key = FRAME_OF[key]!;
    if (!key || cols.some((c) => c.key === key)) continue;
    cols.push({ key, x: cx(r), x0: r.x, x1: r.x + r.w });
  }
  if (!cols.some((c) => c.key === "mark")) return null;
  cols.sort((a, b) => a.x - b.x);
  const rows: ScheduleRow[] = [];
  let misses = 0;
  for (const l of ls.slice(hi + 1)) {
    const inTable = l.filter((r) => r.x >= left && r.x <= right);
    if (!inTable.length) continue;
    const first = inTable[0];
    const markCol = cols.find((c) => c.key === "mark")!;
    const mark = up(first.str).split(" ")[0];
    if (Math.abs(cx(first) - markCol.x) > markCol.x1 - markCol.x0 + first.h * 3 || !MARK_RE.test(mark)) {
      if (rows.length && ++misses > 2) break;
      continue;
    }
    misses = 0;
    const row: ScheduleRow = { mark, fromRoom: "", toRoom: "", width: "", height: "", doorType: "", material: "", finish: "", glass: "", frameType: "", frameMaterial: "", frameFinish: "", rating: "", hwSet: "", remarks: "", box: [first.x, Math.min(...inTable.map((r) => r.y)), 0, 0] };
    for (const r of inTable) {
      if (r === first) {
        // "109 IDF": a mark run that carries the room name with it
        const rest = norm(first.str).split(" ").slice(1).join(" ");
        if (rest) row.fromRoom = rest;
        continue;
      }
      // nearest column by centre; a long left-aligned room name goes by its left edge
      let col = cols.reduce((b, c) => (Math.abs(c.x - cx(r)) < Math.abs(b.x - cx(r)) ? c : b), cols[0]);
      const wordy = /[A-Z]{3,}/i.test(r.str) && r.str.length > 6;
      if (wordy && r.w > (col.x1 - col.x0) * 2.5) col = cols.filter((c) => c.x0 - r.h <= r.x).pop() || col;
      if (col.key === "mark") col = cols.find((c) => c.key === "fromRoom") || col;
      if (col.key === "mark") continue;
      const v = norm(r.str);
      (row as unknown as Record<string, string>)[col.key] = row[col.key] ? `${row[col.key]} ${v}` : v;
    }
    const xs = inTable.map((r) => r.x + r.w), ys = inTable.map((r) => r.y + r.h);
    row.box[2] = Math.max(...xs); row.box[3] = Math.max(...ys);
    rows.push(row);
  }
  if (!rows.length) return null;
  return { rows, box: [Math.min(...rows.map((r) => r.box[0])), cy(title) - title.h, Math.max(...rows.map((r) => r.box[2])), Math.max(...rows.map((r) => r.box[3]))] };
}

// ── hardware sets, specification section 08 71 00 ─────────────────────────────

export interface HardwareSet { set: string; label: string; marks: string[]; items: string; page?: number }

/** Hardware sets in a 08 71 00 section's text ("Set 3 (glazed corridor doors, 100C, 101): 3 hinges, …"). */
export function readHardwareSets(text: string): HardwareSet[] {
  const t = text.replace(/\r/g, "");
  const at = t.search(/08\s?71\s?00/);
  if (at < 0) return [];
  const body = t.slice(at);
  const out: HardwareSet[] = [];
  const re = /(?:^|\n)\s*(?:[A-Z]\.\s*)?(?:HARDWARE\s+)?SET\s*(?:NO\.?|#)?\s*([0-9]{1,3}[A-Z]?)\s*(?:\(([^)]*)\))?\s*[:.\-–]\s*([\s\S]*?)(?=\n\s*(?:[A-Z]\.\s*)?(?:HARDWARE\s+)?SET\s*(?:NO\.?|#)?\s*[0-9]{1,3}[A-Z]?\b|\n\s*\d\.\d\s|\nEND OF SECTION|$)/gi;
  for (let m; (m = re.exec(body)); ) {
    // "(main operations and 911 call center, 106A, 111B)": the words are the
    // label, the comma-separated codes after them are the doors
    const parts = (m[2] || "").split(",").map((x) => norm(x)).filter(Boolean);
    const isMark = (x: string) => /^[A-Z]?\d{2,4}[A-Z]{0,2}$/i.test(x);
    const marks = parts.filter(isMark).map((x) => x.toUpperCase());
    const label = parts.filter((x) => !isMark(x)).join(", ");
    out.push({ set: m[1].toUpperCase(), label, marks, items: norm(m[3]).replace(/\.$/, "") });
  }
  return out;
}

// ── plan door ↔ door tag ──────────────────────────────────────────────────────

/** The door's centre and swing radius in its page frame. */
export function doorCenter(d: ReadDoor): { x: number; y: number; r: number } {
  const r = Math.max(...d.leaves.map((l) => l.radiusPt), 1);
  return { x: (d.box[0] + d.box[2]) / 2, y: (d.box[1] + d.box[3]) / 2, r };
}

export type TagKind = "symbol" | "room" | "plain";

/**
 * What a run that reads as a door mark is, from the drawing around it:
 * - "room": a room-number label (a room name sits right above it), never a door tag;
 * - "symbol": enclosed by drawn ink on all sides (the hexagon, circle or box of a door tag);
 * - "plain": loose text.
 * `segs` is the sheet's linework as flat [x0, y0, x1, y1, …] in the runs' frame.
 */
export function classifyTagRun(t: TextRun, runs: TextRun[], segs: ArrayLike<number> | null): TagKind {
  const h = Math.max(1, Math.min(t.w, t.h) > 0 ? Math.min(t.w, t.h) : t.h);
  const tc = [cx(t), cy(t)];
  // a room label: a wordy run stacked just above (or the name and number in one box)
  for (const r of runs) {
    if (r === t || !/[A-Z]{3,}/i.test(r.str) || MARK_RE.test(up(r.str))) continue;
    const dy = tc[1] - cy(r);
    const overlap = Math.min(r.x + r.w, t.x + t.w) - Math.max(r.x, t.x);
    if (dy > h * 0.4 && dy < h * 3.2 && overlap > -h * 0.5) return "room";
  }
  if (!segs || segs.length < 4) return "plain";
  // enclosure: rays from the run's centre in 8 directions each meet ink
  // between the text's own edge and a symbol's reach
  const half = Math.max(t.w, t.h) / 2;
  const reach = half + h * 2.2;
  const x0 = tc[0] - reach, x1 = tc[0] + reach, y0 = tc[1] - reach, y1 = tc[1] + reach;
  const near: number[] = [];
  for (let i = 0; i + 3 < segs.length; i += 4) {
    const ax = segs[i], ay = segs[i + 1], bx = segs[i + 2], by = segs[i + 3];
    if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) continue;
    near.push(ax, ay, bx, by);
  }
  let hits = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4, dx = Math.cos(a), dy = Math.sin(a);
    // the text box's own extent along this ray: ink inside it is the glyphs' neighbourhood, not a border
    const inner = Math.min(Math.abs(dx) > 1e-9 ? t.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? t.h / 2 / Math.abs(dy) : Infinity) * 0.95;
    let hit = false;
    for (let i = 0; i + 3 < near.length && !hit; i += 4) {
      const ex = near[i + 2] - near[i], ey = near[i + 3] - near[i + 1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const qx = near[i] - tc[0], qy = near[i + 1] - tc[1];
      const tt = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
      if (u >= 0 && u <= 1 && tt >= inner && tt <= reach) hit = true;
    }
    if (hit) hits++;
  }
  return hits >= 7 ? "symbol" : "plain";
}

export interface TagMatch {
  /** one mark (or null) per door */
  marks: (string | null)[];
  /** doors whose nearest tags read as two different marks: asked, not guessed */
  ambiguous: Record<number, [string, string]>;
}

/**
 * Which schedule mark each plan door carries. A tag inside a door-tag symbol
 * beats loose text; a room-number label is never a door tag. The nearest
 * candidate within a few swing radii wins, each mark used once (the closest
 * door takes it). When a door's two best candidates are different marks of
 * the same kind at nearly the same distance, the door is left unmatched and
 * reported as ambiguous.
 */
export function matchDoorTags(doors: ReadDoor[], runs: TextRun[], marks: Set<string>, opts: { segs?: ArrayLike<number> | null; reach?: number } = {}): TagMatch {
  const reach = opts.reach ?? 2.6;
  const tagRuns = runs.filter((r) => marks.has(up(r.str)));
  const kind = new Map(tagRuns.map((t) => [t, classifyTagRun(t, runs, opts.segs ?? null)]));
  const usable = tagRuns.filter((t) => kind.get(t) !== "room");
  const cand: Array<{ d: number; i: number; mark: string; strong: boolean }> = [];
  const ambiguous: Record<number, [string, string]> = {};
  doors.forEach((door, i) => {
    const c = doorCenter(door);
    const mine: Array<{ d: number; mark: string; strong: boolean }> = [];
    for (const t of usable) {
      const dist = Math.hypot(cx(t) - c.x, cy(t) - c.y);
      if (dist <= c.r * reach) mine.push({ d: dist, mark: up(t.str), strong: kind.get(t) === "symbol" });
    }
    // symbol tags first, then distance
    mine.sort((a, b) => Number(b.strong) - Number(a.strong) || a.d - b.d);
    const [p, q] = mine;
    if (p && q && p.mark !== q.mark && p.strong === q.strong && q.d < p.d * 1.15) { ambiguous[i] = [p.mark, q.mark]; return; }
    for (const m of mine) cand.push({ ...m, i });
  });
  cand.sort((a, b) => Number(b.strong) - Number(a.strong) || a.d - b.d);
  const out: (string | null)[] = doors.map(() => null);
  const used = new Set<string>();
  for (const c of cand) {
    if (out[c.i] || used.has(c.mark)) continue;
    out[c.i] = c.mark;
    used.add(c.mark);
  }
  return { marks: out, ambiguous };
}

/**
 * The opening a door hangs in, as a line across the wall from jamb to jamb
 * (page points): the reader's own jamb line. A read without one (a zero-length
 * or non-finite line) falls back to hinge to hinge for a pair, and hinge to
 * the swing's closed end for one leaf.
 */
export function openingLine(d: ReadDoor): [[number, number], [number, number]] {
  const j = d.jambLine;
  if (j && j.flat().every(Number.isFinite) && Math.hypot(j[1][0] - j[0][0], j[1][1] - j[0][1]) > 1e-6) return [[j[0][0], j[0][1]], [j[1][0], j[1][1]]];
  const sp = swingPoints(d);
  if (sp.length > 1) return [sp[0].hinge, sp[1].hinge];
  if (sp.length === 1) return [sp[0].hinge, sp[0].closed];
  return [[d.box[0], d.box[1]], [d.box[2], d.box[3]]];
}

/** The opening's drawn width in feet (jamb to jamb), or null when the sheet's scale is unknown. `fpp`: feet per page point. */
export function openingWidthFt(d: ReadDoor, fpp: number | null | undefined): number | null {
  if (!fpp || !(fpp > 0)) return null;
  const [a, b] = openingLine(d);
  const ft = Math.hypot(b[0] - a[0], b[1] - a[1]) * fpp;
  return Number.isFinite(ft) && ft > 0 ? ft : null;
}

/** Feet as the drawings write them, to the nearest inch: 3 -> 3'-0", 2.67 -> 2'-8". */
export function feetInches(ft: number): string {
  const inches = Math.round(ft * 12);
  return `${Math.floor(inches / 12)}'-${inches % 12}"`;
}

/**
 * Doors kept out of the count until the person answers: a swing the reader is
 * not sure of (confidence under the cutoff), and a toilet-partition stall door,
 * which comes with the partitions (Division 10) and is never on the door schedule.
 */
export function heldBack(doors: ReadDoor[], cutoff = 0): boolean[] {
  return doors.map((d) => d.stall || d.confidence < cutoff - 1e-9);
}

/** Where a door's swing actually sweeps: per leaf, its hinge, the open leaf's tip and the closed end. */
export function swingPoints(d: ReadDoor): Array<{ hinge: [number, number]; tip: [number, number]; closed: [number, number]; r: number }> {
  return d.leaves.map((l) => {
    const h = l.hinge, t = l.tip, r = l.radiusPt, sw = ((l.sweepDeg || 90) * Math.PI) / 180;
    const a0 = Math.atan2(t[1] - h[1], t[0] - h[0]);
    const ends = [1, -1].map((sg) => [h[0] + r * Math.cos(a0 + sg * sw), h[1] + r * Math.sin(a0 + sg * sw)] as [number, number]);
    const inBox = (q: [number, number]) => q[0] >= d.box[0] - r * 0.15 && q[0] <= d.box[2] + r * 0.15 && q[1] >= d.box[1] - r * 0.15 && q[1] <= d.box[3] + r * 0.15;
    const closed = inBox(ends[0]) || !inBox(ends[1]) ? ends[0] : ends[1];
    return { hinge: h, tip: t, closed, r };
  });
}

/**
 * Where a door's count marks go: inside its swing (the open side), never on
 * the tag. `frame` sits a little past the middle of the sweep, `hardware`
 * nearer the hinge, and one `leaves` mark per leaf at the leaf's midpoint;
 * any mark that would land on a tag run slides out along the swing.
 */
export function countMarkPoints(d: ReadDoor, avoid: TextRun[] = []): { frame: [number, number]; hardware: [number, number]; leaves: Array<[number, number]> } {
  const sp = swingPoints(d);
  const s0 = sp[0];
  const onTag = (p: [number, number]) => avoid.some((t) => p[0] >= t.x - 2 && p[0] <= t.x + t.w + 2 && p[1] >= t.y - 2 && p[1] <= t.y + t.h + 2);
  const inSwing = (frac: number, s = s0): [number, number] => {
    const mx = (s.tip[0] + s.closed[0]) / 2 - s.hinge[0], my = (s.tip[1] + s.closed[1]) / 2 - s.hinge[1];
    const L = Math.hypot(mx, my) || 1;
    return [s.hinge[0] + (mx / L) * s.r * frac, s.hinge[1] + (my / L) * s.r * frac];
  };
  const place = (fracs: number[], s = s0) => { for (const f of fracs) { const p = inSwing(f, s); if (!onTag(p)) return p; } return inSwing(fracs[0], s); };
  return {
    frame: place([0.62, 0.8, 0.45]),
    hardware: place([0.34, 0.5, 0.22]),
    leaves: sp.map((s) => { const m: [number, number] = [(s.hinge[0] + s.tip[0]) / 2, (s.hinge[1] + s.tip[1]) / 2]; return onTag(m) ? place([0.5, 0.7], s) : m; }),
  };
}

// ── openings and questions ────────────────────────────────────────────────────

/** Feet from a schedule dimension ("3'-0\"", "6'-0", "36\""); null when unreadable. */
export function feetOf(s: string): number | null {
  const m = /(\d+)\s*'\s*-?\s*(\d+(?:\.\d+)?)?/.exec(s || "");
  if (m) return Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0);
  const i = /^(\d+(?:\.\d+)?)\s*"$/.exec(norm(s || ""));
  return i ? Number(i[1]) / 12 : null;
}

/** A schedule row that describes a pair: typed so ("F2", "FG 2", "PAIR", "DBL") or 5'-0" wide and over. */
export function scheduledPair(row: ScheduleRow | undefined | null): boolean {
  if (!row) return false;
  if (/\b(PAIR|PR|DBL|DOUBLE)\b/i.test(`${row.doorType} ${row.remarks}`) || /\b[A-Z]{1,3}\s?2$/i.test(norm(row.doorType))) return true;
  const w = feetOf(row.width);
  return w != null && w >= 5 - 1e-6;
}

export type QuestionKind = "withheld" | "untagged" | "unplaced" | "hardware" | "pair" | "ambiguous";

export interface DoorQuestion {
  id: string;
  kind: QuestionKind;
  text: string;
  why: string;
  /** recommended answer first */
  answers: [string, string];
  /** what to fly to: a plan door index, or a schedule row mark */
  door?: number;
  mark?: string;
}

export interface Opening {
  /** index into the sheet's doors (committed + withheld, in reader order) */
  door: number;
  mark: string | null;
  row: ScheduleRow | null;
  pair: boolean;
  leaves: number;
  /** the opening's width as drawn, jamb to jamb, in feet; null without a scale */
  drawnFt: number | null;
  withheld: boolean;
  /** an answer has taken it out of the count */
  leftOut: boolean;
}

export interface DoorSuiteView {
  openings: Opening[];
  questions: DoorQuestion[];
  counts: { openings: number; frames: number; leaves: number; matched: number; open: number };
  /** schedule marks with no door found on this sheet */
  unplaced: ScheduleRow[];
}

export const ANSWERS = {
  withheld: ["It's a door, count it", "Not a door, leave it out"] as [string, string],
  untagged: (gray: boolean): [string, string] => (gray ? ["Existing, leave it out", "Count it as a new door"] : ["Count it as a new door", "Existing, leave it out"]),
  unplaced: ["Not on this sheet, check another", "Not in this scope, leave it out"] as [string, string],
  hardware: (set: string): [string, string] => [`Keep set ${set}, as scheduled`, "Ask the architect"],
  pair: (plan: boolean): [string, string] => (plan ? ["Count it as a pair, as drawn", "Count it as a single, as scheduled"] : ["Count it as a single, as drawn", "Count it as a pair, as scheduled"]),
};

const leafWord = (n: number) => `${n} door lea${n === 1 ? "f" : "ves"}`;

/**
 * The suite's view of one sheet: openings (each plan door, matched to its
 * schedule row by tag), the questions the documents leave open, and counts
 * that respect the answers given so far.
 */
export function buildDoorSuite(input: {
  doors: ReadDoor[];
  withheld: boolean[];
  marks: (string | null)[];
  schedule: DoorSchedule | null;
  sets: HardwareSet[];
  answers: Record<string, string>;
  sheetLabel: string;
  /** schedule marks found on OTHER sheets of the set (never asked about here) */
  placedElsewhere?: Set<string>;
  /** per door: its swing drawn gray (lighter than the plan's other doors), dark, or unknown */
  tone?: Array<"gray" | "dark" | null>;
  /** doors whose tag reads two ways (matchDoorTags) */
  ambiguous?: Record<number, [string, string]>;
  /** feet per page point the doors were read at (for each opening's drawn width) */
  fpp?: number | null;
}): DoorSuiteView {
  const { doors, withheld, schedule, sets, answers, sheetLabel } = input;
  // an ambiguous tag, once answered, is the mark the person picked
  const marks = input.marks.map((m, i) => {
    const amb = input.ambiguous?.[i];
    if (!amb) return m;
    const a = answers[`tag:${i}`];
    return a ? (/^It's (.+)$/.exec(a)?.[1] ?? null) : null;
  });
  const byMark = new Map((schedule?.rows || []).map((r) => [r.mark, r]));
  const questions: DoorQuestion[] = [];
  const openings: Opening[] = doors.map((d, i) => {
    const mark = marks[i];
    const row = mark ? byMark.get(mark) || null : null;
    const planPair = d.pair || d.leaves.length > 1;
    let pair = planPair;
    let leftOut = false;
    const isWithheld = withheld[i];
    if (isWithheld) {
      const id = `withheld:${i}`;
      if (answers[id] === ANSWERS.withheld[1]) leftOut = true;
      else if (!answers[id]) leftOut = true;   // not counted until answered
      questions.push({
        id, kind: "withheld", door: i,
        text: d.stall ? "This swing looks like a toilet-partition stall door, which comes with the partitions and not the door schedule. It's left out of the count until you answer."
          : mark ? `Door ${mark}: not sure this swing is a door. It's left out of the count until you answer.` : "Not sure this swing is a door. It's left out of the count until you answer.",
        why: d.stall ? "Why: it hangs on a thin partition panel, or closes in line with a row of stall doors" : d.doubts.length ? `Why: ${d.doubts.slice(0, 3).join(", ")}` : "The drawing doesn't settle it",
        answers: ANSWERS.withheld,
      });
    } else if (input.ambiguous?.[i] && !answers[`tag:${i}`]) {
      const [a, b] = input.ambiguous[i];
      questions.push({
        id: `tag:${i}`, kind: "ambiguous", door: i,
        text: `This door's tag could read ${a} or ${b}: the two tags sit about the same distance from it.`,
        why: `Pick the one the drawing means; the door is left out of the count until you do.`,
        answers: [`It's ${a}`, `It's ${b}`],
      });
      leftOut = true;
    } else if (!mark && schedule) {
      const id = `untagged:${i}`;
      const gray = input.tone?.[i] === "gray";
      // not counted until answered
      if (answers[id] !== "Count it as a new door") leftOut = true;
      questions.push({
        id, kind: "untagged", door: i,
        text: `A door on ${sheetLabel} has no door number and no schedule row. It's left out of the count until you answer.`,
        why: gray ? "Drawn gray, likely existing" : "No door number or schedule row",
        answers: ANSWERS.untagged(gray),
      });
    }
    if (row && !isWithheld) {
      const schedPair = scheduledPair(row);
      if (schedPair !== planPair) {
        const id = `pair:${row.mark}`;
        const a = ANSWERS.pair(planPair);
        if (answers[id]) pair = /pair/i.test(answers[id]);
        questions.push({
          id, kind: "pair", door: i, mark: row.mark,
          text: planPair ? `Door ${row.mark} is drawn as a pair, but the schedule lists a single ${row.width} door.` : `Door ${row.mark} is drawn as a single door, but the schedule lists it ${row.width} wide${row.doorType ? `, type ${row.doorType}` : ""}, a pair.`,
          why: `Plan ${sheetLabel} · schedule row ${row.mark}`,
          answers: a,
        });
      }
      if (row.hwSet && sets.length) {
        const set = sets.find((s) => s.set === up(row.hwSet));
        const known = set ? set.marks.filter((m) => byMark.has(m)) : [];
        const listed = known.length ? known : set ? set.marks : [];
        if (set && listed.length && !listed.includes(row.mark)) {
          questions.push({
            id: `hardware:${row.mark}`, kind: "hardware", door: i, mark: row.mark,
            text: `Door ${row.mark} is on hardware set ${set.set} in the schedule, but the spec lists set ${set.set} for door${listed.length > 1 ? "s" : ""} ${listed.join(", ")} only.`,
            why: `Schedule row ${row.mark} · spec 08 71 00, hardware set ${set.set}`,
            answers: ANSWERS.hardware(set.set),
          });
        }
      }
    }
    return { door: i, mark, row, pair, leaves: pair ? 2 : 1, drawnFt: openingWidthFt(d, input.fpp), withheld: isWithheld, leftOut };
  });
  const placed = new Set(openings.filter((o) => o.mark).map((o) => o.mark as string));
  const unplaced = (schedule?.rows || []).filter((r) => !placed.has(r.mark) && !input.placedElsewhere?.has(r.mark));
  for (const r of unplaced) {
    questions.push({
      id: `unplaced:${r.mark}`, kind: "unplaced", mark: r.mark,
      text: `Schedule row ${r.mark}${r.fromRoom ? ` (${r.fromRoom}${r.toRoom ? ` to ${r.toRoom}` : ""})` : ""} has no door found on ${sheetLabel}.`,
      why: "The door's tag isn't next to a swing on this sheet. It may be on another sheet, or drawn without a swing.",
      answers: ANSWERS.unplaced,
    });
  }
  const counted = openings.filter((o) => !o.leftOut);
  const open = questions.filter((q) => !answers[q.id]).length;
  return {
    openings, questions, unplaced,
    counts: { openings: counted.length, frames: counted.length, leaves: counted.reduce((s, o) => s + o.leaves, 0), matched: counted.filter((o) => o.row).length, open },
  };
}

/** "9 openings · 10 door leaves" */
export function countLine(c: { openings: number; leaves: number }): string {
  return `${c.openings} opening${c.openings === 1 ? "" : "s"} · ${leafWord(c.leaves)}`;
}

/** Opening/leaf groups for the estimate: one row per door type and size. */
export function estimateGroups(openings: Opening[]): Array<{ key: string; type: string; size: string; openings: Opening[]; leaves: number }> {
  const g = new Map<string, { key: string; type: string; size: string; openings: Opening[]; leaves: number }>();
  for (const o of openings) {
    if (o.leftOut) continue;
    const type = o.row?.doorType || (o.pair ? "Pair" : "Single");
    const size = o.row ? `${o.row.width} × ${o.row.height}`.trim() : "size not scheduled";
    const key = `${type}|${size}|${o.pair ? 2 : 1}`;
    const e = g.get(key) || { key, type, size, openings: [], leaves: 0 };
    e.openings.push(o);
    e.leaves += o.leaves;
    g.set(key, e);
  }
  return [...g.values()];
}

// ── text runs from a pdf.js text layer ────────────────────────────────────────

/** A pdf.js getTextContent() item, the fields used here. */
export interface PdfTextItem { str: string; transform: number[]; width: number; height: number }

/**
 * Place pdf.js text items in a viewport's frame (pass viewport.transform): each
 * run's axis-aligned box, so rotated text still has a true centre. Runs of
 * whitespace are dropped.
 */
export function textRuns(items: PdfTextItem[], vt: number[]): TextRun[] {
  const out: TextRun[] = [];
  for (const it of items) {
    const str = (it.str || "").trim();
    if (!str || !Array.isArray(it.transform)) continue;
    const t = it.transform;
    const m = [vt[0] * t[0] + vt[2] * t[1], vt[1] * t[0] + vt[3] * t[1], vt[0] * t[2] + vt[2] * t[3], vt[1] * t[2] + vt[3] * t[3], vt[0] * t[4] + vt[2] * t[5] + vt[4], vt[1] * t[4] + vt[3] * t[5] + vt[5]];
    const fs = Math.hypot(m[2], m[3]) || 1;
    const dl = Math.hypot(m[0], m[1]) || 1;
    const sc = Math.hypot(vt[0], vt[1]) || 1;
    const w = (it.width || 0) * sc;
    const ax = (m[0] / dl) * w, ay = (m[1] / dl) * w;
    const ux = (m[2] / fs) * fs, uy = (m[3] / fs) * fs;
    const xs = [m[4], m[4] + ax, m[4] + ux, m[4] + ax + ux], ys = [m[5], m[5] + ay, m[5] + uy, m[5] + ay + uy];
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    out.push({ str, x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 });
  }
  return out;
}

/** Hardware-set colours: distinct in lightness as well as hue, readable on paper and dark. */
export const DOOR_SET_COLORS = ["#0f9d8a", "#d97706", "#db2777", "#7c3aed", "#0284c7", "#ea580c", "#65a30d", "#be123c", "#4f46e5", "#0d9488", "#a16207", "#9333ea"];
export const DOOR_NEUTRAL = "#7b8389";
/** A hardware set's colour, by its place in the set order (neutral when unknown). */
export function doorSetColor(set: string | null | undefined, order: string[]): string {
  if (!set) return DOOR_NEUTRAL;
  const i = order.indexOf(String(set).toUpperCase());
  return DOOR_SET_COLORS[(i < 0 ? 0 : i) % DOOR_SET_COLORS.length];
}
