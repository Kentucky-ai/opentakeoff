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

export function reshapeBox(spans: readonly GraphSpan[]): GraphSpan[] | null {
  const lines = linesOf(spans);
  const h = headerLine(lines);
  return h >= 0 ? reshapeHeader(spans, lines, h) : legendHeader(spans, lines);
}

/** Rename alias headers; move the key column's band to the front. */
function reshapeHeader(spans: readonly GraphSpan[], lines: GraphSpan[][], h: number): GraphSpan[] | null {
  const header = lines[h];
  const present = new Set(header.map((t) => words(t.str).find((w) => HEADER_WORDS.has(w))).filter(Boolean));
  const renamed = new Map<GraphSpan, string>();
  for (const t of header) {
    if (words(t.str).some((w) => HEADER_WORDS.has(w))) continue;
    const to = words(t.str).map((w) => ALIASES[w]).find(Boolean);
    if (to && !present.has(to)) { renamed.set(t, to); present.add(to); }
  }
  const named = header.filter((t) => headerWordOf(t.str));
  const k = named.findIndex((t) => { const w = renamed.get(t) ?? headerWordOf(t.str); return !!w && KEY_WORDS.has(w); });
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
  return spans.map((t) => {
    if (!below.has(t)) return t;
    const dx = shift.get(bandOf(t)) ?? 0;
    const str = renamed.get(t) ?? t.str;
    return dx || str !== t.str ? { ...t, x: t.x + dx, str } : t;
  });
}

/** A legend with no header row: two or more lines, most of them, led by a
 *  finish code with letters and a digit and followed by one run of text. Write
 *  CODE | DESCRIPTION above the first, and an empty REMARKS column clear of
 *  the text (the reader wants three header words). */
function legendHeader(spans: readonly GraphSpan[], lines: GraphSpan[][]): GraphSpan[] | null {
  // a legend line is a code and ONE run of text: no gap wider than three
  // text heights between its words. A table's cells have such gaps, and a
  // table whose header the reader can't see (rotated, or a device schedule)
  // stays unread rather than folding its columns into one description.
  const legendLine = (l: GraphSpan[]) => l.slice(2).every((t, i) => t.x - right(l[i + 1]) <= 3 * (t.h || 10));
  const keyed = lines.filter((l) => {
    const first = (l[0]?.str ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    return l.length >= 2 && finishCodeOk(first) && /\d/.test(first) && /[A-Z]/.test(first) && legendLine(l);
  });
  if (keyed.length < 2) return null;
  const firstKeyed = lines.indexOf(keyed[0]);
  // a legend titled as another family (EQUIPMENT LEGEND, DOOR TYPES) isn't a finish legend
  if (lines.slice(0, firstKeyed).some((l) => isNonFinishSchedule(l.map((t) => t.str).join(" ")))) return null;
  const body = lines.slice(firstKeyed);
  if (keyed.length < 0.6 * body.length) return null;
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const keyX = med(keyed.map((l) => l[0].x));
  const textX = med(keyed.map((l) => l[1].x));
  const maxRight = Math.max(...body.flat().map(right));
  const top = keyed[0][0], hh = top.h || 10;
  const y = top.y - 1.6 * hh;
  const at = (str: string, x: number): GraphSpan => ({ str, x, y, w: str.length * hh * 0.6, h: hh });
  return [...spans, at("CODE", keyX), at("DESCRIPTION", textX), at("REMARKS", 2 * maxRight - textX + 4 * hh)];
}
