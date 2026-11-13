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

/**
 * Which schedule mark each plan door carries: the nearest run that reads as
 * a scheduled mark, within a few swing radii, each mark used once (the
 * closest door wins). Returns one mark (or null) per door.
 */
export function matchDoorTags(doors: ReadDoor[], runs: TextRun[], marks: Set<string>, reach = 2.6): (string | null)[] {
  const cand: Array<{ d: number; i: number; mark: string }> = [];
  const tagRuns = runs.filter((r) => marks.has(up(r.str)));
  doors.forEach((door, i) => {
    const c = doorCenter(door);
    for (const t of tagRuns) {
      const dx = cx(t) - c.x, dy = cy(t) - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= c.r * reach) cand.push({ d: dist, i, mark: up(t.str) });
    }
  });
  cand.sort((a, b) => a.d - b.d);
  const out: (string | null)[] = doors.map(() => null);
  const used = new Set<string>();
  for (const c of cand) {
    if (out[c.i] || used.has(c.mark)) continue;
    out[c.i] = c.mark;
    used.add(c.mark);
  }
  return out;
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

export type QuestionKind = "withheld" | "untagged" | "unplaced" | "hardware" | "pair";

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
  untagged: ["Existing, leave it out", "Count it as a new door"] as [string, string],
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
}): DoorSuiteView {
  const { doors, withheld, marks, schedule, sets, answers, sheetLabel } = input;
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
        text: mark ? `Door ${mark}: not sure this swing is a door. It's left out of the count until you answer.` : "Not sure this swing is a door. It's left out of the count until you answer.",
        why: d.doubts.length ? `Why: ${d.doubts.slice(0, 3).join(", ")}` : "The drawing doesn't settle it",
        answers: ANSWERS.withheld,
      });
    } else if (!mark && schedule) {
      const id = `untagged:${i}`;
      // not counted until answered: the recommended answer leaves it out
      if (answers[id] !== ANSWERS.untagged[1]) leftOut = true;
      questions.push({
        id, kind: "untagged", door: i,
        text: `A door on ${sheetLabel} has no door number and no schedule row. It's left out of the count until you answer.`,
        why: `${planPair ? "Pair" : "Single"} swing, ${d.dashed ? "drawn dashed (existing or to be removed)" : "drawn as new work"}`,
        answers: ANSWERS.untagged,
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
    return { door: i, mark, row, pair, leaves: pair ? 2 : 1, withheld: isWithheld, leftOut };
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
