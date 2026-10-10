// Import from schedule's second look at a box that read no rows (#483 rows 1
// and 4). The finish reader keys a table on its LEFTMOST column and knows
// its headers by a fixed vocabulary, so three common layouts read as no
// table at all:
//   - headers it has no word for: MFG, SPECIFICATION, NOTES;
//   - the key column printed second: MATERIAL | CODE | MANUFACTURER …;
//   - a legend with no header row: codes down the left, text beside them.
// reshapeBox rewrites the box's spans so the reader sees the layout it
// knows: alias headers renamed, the key column's band moved to the front
// (each band keeps its own spacing), or a CODE | DESCRIPTION header written
// above a legend. It returns null when none applies. readScheduleSpans
// calls it only after the box read no rows, so a box that reads today
// reads exactly as before, and the rows it returns carry no coordinates,
// so moving a band never reaches a citation.
import { finishCodeOk } from "./finishCode.ts";
import { finishSectionOf } from "./finishSections.ts";
import { isNonFinishSchedule, type GraphSpan } from "./sheetgraph.ts";

const KEY_WORDS = new Set(["CODE", "MARK", "SYMBOL", "TAG"]);
// the reader's finish vocabulary (sheetgraph.ts FINISH_HEADERS) plus the aliases below
const HEADER_WORDS = new Set([...KEY_WORDS, "MATERIAL", "MANUFACTURER", "PRODUCT", "STYLE", "COLOR", "SIZE", "REMARKS", "DESCRIPTION", "PATTERN", "COMMENTS"]);
// a header word the reader has no column for → the column it means
const ALIASES: Record<string, string> = {
  MFG: "MANUFACTURER", MFR: "MANUFACTURER", MANUFACTURERS: "MANUFACTURER",
  SPEC: "PRODUCT", SPECS: "PRODUCT", SPECIFICATION: "PRODUCT", SPECIFICATIONS: "PRODUCT",
  NOTES: "REMARKS", NOTE: "REMARKS",
};

const words = (s: string) => s.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
const headerWordOf = (s: string): string | null => {
  for (const w of words(s)) {
    if (HEADER_WORDS.has(w)) return w;
    if (ALIASES[w]) return ALIASES[w];
  }
  return null;
};
const midY = (t: GraphSpan) => t.y + (t.h || 0) / 2;
const right = (t: GraphSpan) => t.x + (t.w || 0);

/** Spans grouped into printed lines, top to bottom, each left to right. */
function linesOf(spans: readonly GraphSpan[]): GraphSpan[][] {
  const hs = spans.map((t) => t.h || 0).filter((h) => h > 0).sort((a, b) => a - b);
  const tol = 0.5 * (hs.length ? hs[hs.length >> 1] : 10);
  const lines: GraphSpan[][] = [];
  for (const t of [...spans].sort((a, b) => midY(a) - midY(b))) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(midY(t) - midY(line[0])) <= tol) line.push(t);
    else lines.push([t]);
  }
  for (const l of lines) l.sort((a, b) => a.x - b.x);
  return lines;
}

/** A header line: three or more cells naming finish columns, one of them a key. */
function headerLine(lines: GraphSpan[][]): number {
  return lines.findIndex((l) => {
    const named = l.map((t) => headerWordOf(t.str)).filter(Boolean) as string[];
    return named.length >= 3 && named.some((w) => KEY_WORDS.has(w));
  });
}

/** The reshaped box, and how many codes it shows: the second read must
 * read at least that many rows, or it isn't used (a code glued to the
 * next cell's words by OCR can drop its row, and a read that silently
 * loses rows is worse than none). */
export interface Reshaped { spans: GraphSpan[]; codes: number }

export function reshapeBox(input: readonly GraphSpan[]): Reshaped | null {
  const split = splitGluedHeader(input, linesOf(input));
  const spans = split ?? input;
  const lines = linesOf(spans);
  const h = headerLine(lines);
  const out = h >= 0 ? reshapeHeader(spans, lines, h) ?? split : legendHeader(spans, lines);
  if (!out) return null;
  const data = lines.slice(h >= 0 ? h + 1 : 0);
  return { spans: out, codes: data.filter((l) => l.some(isCodeCell)).length };
}

const isCodeCell = (t: GraphSpan) => { const w = (t.str.trim().split(/\s+/)[0] ?? "").toUpperCase(); return /\d/.test(w) && /[A-Z]/.test(w) && finishCodeOk(w); };

/** A header cell OCR read as one box over two columns (MATERIAL CODE): split
 * it in two when every cell under it lies inside its left and right edges, in
 * two groups side by side, and the key word's group holds codes. The second
 * word starts where its group does. When more than a fifth of the cells
 * under it run past its edges (vendors under a CODE MFG box, glued into the
 * next column) the box stays whole, and the read stands down as before. */
function splitGluedHeader(spans: readonly GraphSpan[], lines: GraphSpan[][]): GraphSpan[] | null {
  for (let h = 0; h < lines.length; h++) {
    for (const t of lines[h]) {
      const ws = words(t.str);
      if (ws.length !== 2 || !ws.every((w) => HEADER_WORDS.has(w) || ALIASES[w])) continue;
      const keyAt = ws.findIndex((w) => KEY_WORDS.has(w));
      if (keyAt < 0 || KEY_WORDS.has(ws[1 - keyAt])) continue;
      // with the box as two cells, the line names three or more columns
      if (lines[h].filter((o) => o !== t && headerWordOf(o.str)).length + 2 < 3) continue;
      const lo = t.x, hi = right(t), tol = 0.5 * (t.h || 10);
      const below = lines.slice(h + 1).flat();
      const touching = below.filter((s) => s.x < hi && right(s) > lo);
      const under = touching.filter((s) => s.x >= lo - tol && right(s) <= hi + tol);
      // a stray long word (a note line below the table) may run past it; a
      // column of them is a column the box doesn't hold
      if (touching.length - under.length > 0.2 * touching.length) continue;
      const codes = under.filter(isCodeCell);
      if (codes.length < 2) continue;
      // the second column starts where the codes do (key second) or past
      // their right edge (key first); the first column's cells end before it
      const at = keyAt === 1 ? Math.min(...codes.map((s) => s.x)) : Math.min(...under.filter((s) => s.x > Math.max(...codes.map(right))).map((s) => s.x));
      if (!Number.isFinite(at)) continue;
      const left = under.filter((s) => s.x < at - tol), rightGroup = under.filter((s) => s.x >= at - tol);
      if (left.some((s) => right(s) >= at)) continue;
      const keyGroup = keyAt === 1 ? rightGroup : left;
      if (keyGroup.filter(isCodeCell).length < 0.6 * keyGroup.length) continue;
      const a: GraphSpan = { ...t, str: ws[0], w: Math.max(1, Math.min(at - lo - 1, (t.w || 0) * ws[0].length / t.str.length)) };
      const b: GraphSpan = { ...t, str: ws[1], x: at, w: Math.max(1, hi - at) };
      return spans.flatMap((s) => (s === t ? [a, b] : [s]));
    }
  }
  return null;
}

/** Rename alias headers; move the key column's band to the front. */
function reshapeHeader(spans: readonly GraphSpan[], lines: GraphSpan[][], h: number): GraphSpan[] | null {
  const header = lines[h];
  // a header cell naming two columns ("CODE MFG", one OCR box) can't be
  // split into bands here: moving it would carry the wrong column along
  if (header.some((t) => words(t.str).filter((w) => HEADER_WORDS.has(w) || ALIASES[w]).length >= 2)) return null;
  const present = new Set(header.map((t) => words(t.str).find((w) => HEADER_WORDS.has(w))).filter(Boolean));
  const renamed = new Map<GraphSpan, string>();
  for (const t of header) {
    if (words(t.str).some((w) => HEADER_WORDS.has(w))) continue;
    const to = words(t.str).map((w) => ALIASES[w]).find(Boolean);
    if (to && !present.has(to)) { renamed.set(t, to); present.add(to); }
  }
  const named = header.filter((t) => headerWordOf(t.str));
  // the key: CODE when the header names it, else the first of TAG / MARK /
  // SYMBOL (a MARK beside a CODE is a plan symbol, not the finish code)
  const labelOf = (t: GraphSpan) => renamed.get(t) ?? headerWordOf(t.str);
  const code = named.findIndex((t) => labelOf(t) === "CODE");
  const k = code >= 0 ? code : named.findIndex((t) => KEY_WORDS.has(labelOf(t) ?? ""));
  if (!renamed.size && k <= 0) return null;

  // column bands: each header cell to halfway to the next one's left edge
  const below = new Set(lines.slice(h).flat());
  const bounds = named.map((t, i) => (i === 0 ? -Infinity : (right(named[i - 1]) + t.x) / 2));
  const bandOf = (t: GraphSpan) => {
    const cx = t.x + (t.w || 0) / 2;
    let b = 0;
    for (let i = 1; i < bounds.length; i++) if (cx >= bounds[i]) b = i;
    return b;
  };
  const shift = new Map<number, number>();
  if (k > 0) {
    // band extents from what is printed in them, header included
    const ext = named.map(() => ({ lo: Infinity, hi: -Infinity }));
    for (const t of below) { const e = ext[bandOf(t)]; e.lo = Math.min(e.lo, t.x); e.hi = Math.max(e.hi, right(t)); }
    const gaps = named.slice(1).map((t, i) => Math.max(0, ext[i + 1].lo - ext[i].hi));
    const gap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 20;
    const order = [k, ...named.map((_, i) => i).filter((i) => i !== k)];
    let cursor = ext[0].lo;
    for (const b of order) {
      shift.set(b, cursor - ext[b].lo);
      cursor += ext[b].hi - ext[b].lo + gap;
    }
  }
  // a section heading printed alone on its line (FLOORING, BASE) stays at the
  // left edge, where the key column now starts, as it would sit in a table
  // printed CODE first
  const heading = new Set(lines.slice(h + 1).filter((l) => l.length === 1 && finishSectionOf(l[0].str)).flat());
  return spans.map((t) => {
    if (!below.has(t)) return t;
    const dx = heading.has(t) ? 0 : shift.get(bandOf(t)) ?? 0;
    const str = renamed.get(t) ?? t.str;
    return dx || str !== t.str ? { ...t, x: t.x + dx, str } : t;
  });
}

/** A legend with no header row: two or more lines, most of them, led by a
 *  finish code with letters and a digit and followed by one run of text (and
 *  at most one note after it). Write CODE | DESCRIPTION above the first, and
 *  REMARKS over the notes or clear of the text (the reader wants three header
 *  words). */
function legendHeader(spans: readonly GraphSpan[], lines: GraphSpan[][]): GraphSpan[] | null {
  // a legend line is a code and ONE run of text: no gap wider than three
  // text heights between its words. A table's cells have such gaps, and a
  // table whose header the reader can't see (rotated, or a device schedule)
  // stays unread rather than folding its columns into one description.
  // A line may carry one more run after a gap: a note beside the
  // description, read as remarks. Most lines must be the one run.
  // A box with a CODE / TAG / MARK / SYMBOL cell has a header the reader
  // didn't take (too few known words), so it isn't a legend.
  if (lines.some((l) => l.some((t) => KEY_WORDS.has(t.str.trim().toUpperCase())))) return null;
  const runs = (l: GraphSpan[]) => 1 + l.slice(2).filter((t, i) => t.x - right(l[i + 1]) > 3 * (t.h || 10)).length;
  const keyed = lines.filter((l) => {
    const first = (l[0]?.str ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    return l.length >= 2 && finishCodeOk(first) && /\d/.test(first) && /[A-Z]/.test(first) && runs(l) <= 2;
  });
  if (keyed.length < 2 || keyed.filter((l) => runs(l) === 1).length < 0.6 * keyed.length) return null;
  const firstKeyed = lines.indexOf(keyed[0]);
  // a legend titled as another family (EQUIPMENT LEGEND, DOOR TYPES) isn't a finish legend
  if (lines.slice(0, firstKeyed).some((l) => isNonFinishSchedule(l.map((t) => t.str).join(" ")))) return null;
  const body = lines.slice(firstKeyed);
  if (keyed.length < 0.6 * body.length) return null;
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const keyX = med(keyed.map((l) => l[0].x));
  const textX = med(keyed.map((l) => l[1].x));
  // a four- or five-letter code with no number (CONC) leading the legend is
  // a legend line too: the header goes above it, so the reader sees it and
  // reports it (skipped) instead of losing it above the table
  let topLine = firstKeyed;
  while (topLine > 0) {
    const l = lines[topLine - 1];
    if (l.length < 2 || runs(l) > 1 || Math.abs(l[0].x - keyX) > 0.5 * (l[0].h || 10) || !/^[A-Z]{4,5}$/.test(l[0].str.trim())) break;
    topLine--;
  }
  const top = lines[topLine][0], hh = keyed[0][0].h || 10;
  // REMARKS sits over the notes when there are any, else clear of the text
  const noteStart = (l: GraphSpan[]) => l.slice(2).find((t, i) => t.x - right(l[i + 1]) > 3 * (t.h || 10));
  const notes = keyed.map(noteStart).filter((t): t is GraphSpan => !!t);
  const maxRight = Math.max(...body.flat().map(right));
  const remarksX = notes.length ? med(notes.map((t) => t.x)) : 2 * maxRight - textX + 4 * hh;
  const y = top.y - 1.6 * hh;
  const at = (str: string, x: number): GraphSpan => ({ str, x, y, w: str.length * hh * 0.6, h: hh });
  return [...spans, at("CODE", keyX), at("DESCRIPTION", textX), at("REMARKS", remarksX)];
}
