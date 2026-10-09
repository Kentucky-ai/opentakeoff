// A sheet's number, read from its title block's number label (SHEET NUMBER,
// SHEET NO, DWG NO, …): the label is found, the cell under (or beside) it is
// read in the label's own frame, and the number is a cell line that is wholly
// one sheet-number-shaped token at ≥ 1.5 × the label's height. Pure: no
// pdf.js. Answers match the probe reader it was tuned as (test oracle,
// web/test/sheetNameOracle.ts) while staying near-linear in the page's
// text items: one prefilter, one sort per angle, windowed lookups per label.

/** One text item in viewport px at scale 2: x, y and w as fractions of the
 *  page, h the glyph height in px, a the baseline angle in whole degrees. */
export type SheetItem = { s: string; x: number; y: number; h: number; a: number; w: number };
export type SheetPage = { W: number; H: number; items: SheetItem[] };

/** Bump on any change that can change an answer: saved names carry it. */
export const READER_VERSION = 1;
/** Past this many items a page is not read (recorded as having no number). */
export const MAX_ITEMS = 60000;
/** At most this many number labels are tried on one page. */
const MAX_LABELS = 32;

type TextItemLike = { str?: string; transform?: number[]; width?: number };
type ViewportLike = { width: number; height: number; transform: number[] };

const SCALE = 2; // the reader's thresholds are in px at the canvas's RENDER_SCALE

/** A page's non-empty text items in the reader's frame, from pdf.js text
 *  content and any viewport of the page (rescaled to scale 2). */
export function sheetItems(tc: { items: unknown[] }, vp: ViewportLike): SheetPage {
  const m = vp.transform;
  const vscale = Math.hypot(m[0], m[1]) || 1;
  const k = SCALE / vscale;
  const W = vp.width * k, H = vp.height * k;
  const items: SheetItem[] = [];
  for (const raw of tc.items as TextItemLike[]) {
    const s = raw.str;
    if (!s || !s.trim() || !raw.transform) continue;
    const n = raw.transform;
    // pdf.js Util.transform(vp.transform, item.transform)
    const t0 = m[0] * n[0] + m[2] * n[1], t1 = m[1] * n[0] + m[3] * n[1];
    const t2 = m[0] * n[2] + m[2] * n[3], t3 = m[1] * n[2] + m[3] * n[3];
    const t4 = m[0] * n[4] + m[2] * n[5] + m[4], t5 = m[1] * n[4] + m[3] * n[5] + m[5];
    items.push({
      s,
      x: +(t4 / vp.width).toFixed(4),
      y: +(t5 / vp.height).toFixed(4),
      h: +(Math.hypot(t2, t3) * k).toFixed(1),
      a: Math.round((Math.atan2(t1, t0) * 180) / Math.PI),
      w: +(((raw.width || 0) * vscale) / vp.width).toFixed(4),
    });
  }
  return { W, H, items };
}

const NUMBER_LABELS = ["SHEET NUMBER", "DRAWING NUMBER", "SHEET NO", "DWG NO", "SHEET"];
const TITLE_LABELS = ["DRAWING TITLE", "SHEET TITLE", "SHEET NAME"];
const INLINE = NUMBER_LABELS.map((lab) => new RegExp(`^${lab}${lab === "SHEET NO" ? "\\.?" : ""}:\\s*(.+)$`));
const STOP_VOCAB = /^(ISSUE DATE|DATE|CHECKED|DRAWN|APPROVED|SCALE|LOCATION|PHASE|PROJECT|SHEET NUMBER|DRAWING NUMBER|SHEET NO|DWG NO|SHEET|JOB NO|REV|DWG)\b/;
const SHAPE = /^(?=.*\d)[A-Z]{1,3}\d{0,3}(?:[-. ]?[A-Z0-9]{1,4}){0,3}$/;
// every label starts with one of these words (spelled out: an /i alternation
// is ~50x slower on a dense page)
const CANDIDATE = /[Ss][Hh][Ee][Ee][Tt]|[Dd][Ww][Gg]|[Dd][Rr][Aa][Ww][Ii][Nn][Gg]/;
const norm = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();
const labelNorm = (s: string) => { const n = norm(s).replace(/:$/, "").trim(); return n === "SHEET NO." ? "SHEET NO" : n; };
const isVocab = (s: string) => { const n = labelNorm(s); return STOP_VOCAB.test(n) || TITLE_LABELS.includes(n) || NUMBER_LABELS.includes(n); };
const shaped = (s: string) => { const n = norm(s); return SHAPE.test(n.replace(/\s+/g, "")) && n.length <= 10; };

/** First position in a nondecreasing list with value ≥ x. */
function firstAtLeast(list: number[], x: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** First index in sorted `keys[order[i]]` with key ≥ x (or > x when strict). */
function lowerBound(order: Int32Array, keys: Float64Array, x: number, strict = false): number {
  let lo = 0, hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const k = keys[order[mid]];
    if (strict ? k <= x : k < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** `pick` (ascending item numbers) sorted by (v, u, item number): bucketed
 *  on whole px of v, so only items sharing a px are compared. */
function sortByVU(pick: number[], u: Float64Array, v: Float64Array): Int32Array {
  const m = pick.length;
  const out = new Int32Array(m);
  if (!m) return out;
  let lo = Infinity, hi = -Infinity;
  for (const i of pick) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
  const nb = Math.floor(hi - lo) + 2;
  const start = new Int32Array(nb + 1);
  for (const i of pick) start[Math.floor(v[i] - lo) + 1]++;
  for (let b = 0; b < nb; b++) start[b + 1] += start[b];
  const fill = start.slice(0, nb);
  for (const i of pick) out[fill[Math.floor(v[i] - lo)]++] = i;
  const cmp = (p: number, q: number) => v[p] - v[q] || u[p] - u[q] || p - q;
  for (let b = 0; b < nb; b++) {
    const a = start[b], z = start[b + 1];
    if (z - a < 2) continue;
    const part = Array.from(out.subarray(a, z)).sort(cmp); // a plain array sorts faster than a typed one
    out.set(part, a);
  }
  return out;
}

// Every item framed by one baseline angle, sorted by (v, u, item order).
type Frame = { u: Float64Array; v: Float64Array; order: Int32Array };

export function readSheetNumber(page: SheetPage): string | null {
  const { W, H, items } = page;
  const n = items.length;
  if (n > MAX_ITEMS) return null;
  // label-word items: a page with none has no number label
  const cand = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) if (CANDIDATE.test(items[i].s)) { cand[i] = 1; any = true; }
  if (!any) return null;

  const X = new Float64Array(n), Y = new Float64Array(n), L = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = items[i].x * W; Y[i] = items[i].y * H; L[i] = items[i].w * W; }
  const hOf = (i: number) => items[i].h;

  // frames by angle, built on first use; the run grouping uses each item's
  // own rounded angle, which is the same frame for items at exactly that angle
  const frames = new Map<number, Frame>();
  const frameFor = (A: number): Frame => {
    let f = frames.get(A);
    if (f) return f;
    const th = (A * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    const u = new Float64Array(n).fill(NaN), v = new Float64Array(n).fill(NaN);
    const pick: number[] = [];
    for (let i = 0; i < n; i++) {
      if (Math.abs(items[i].a - A) > 1) continue;
      u[i] = X[i] * c + Y[i] * s; v[i] = -X[i] * s + Y[i] * c;
      pick.push(i);
    }
    f = { u, v, order: sortByVU(pick, u, v) };
    frames.set(A, f);
    return f;
  };

  // ---- runs → number labels, in the probe's order ----
  type Lab = { items: number[]; text: string; a: number; inline?: string };
  const labs: Lab[] = [];
  const seen = new Set<string>();
  const consider = (run: number[], a: number) => {
    const f = run[0];
    if (items[f].x < 0.5 && items[f].y < 0.5) return; // upper-left quadrant
    const text = run.length === 1 ? items[f].s : run.map((i) => items[i].s).join(" ");
    const nn = labelNorm(text), raw = norm(text);
    for (let k = 0; k < NUMBER_LABELS.length; k++) {
      let inline: string | undefined;
      if (nn !== NUMBER_LABELS[k]) {
        if (run.length !== 1) continue;
        const mm = INLINE[k].exec(raw);
        if (!mm) continue;
        const orig = text.replace(/\s+/g, " ").trim();
        inline = orig.slice(orig.length - mm[1].length);
      }
      const key = `${f}|${run.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labs.push({ items: run, text, a, inline });
    }
  };
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const k = Math.round(items[i].a); let g = groups.get(k); if (!g) groups.set(k, (g = [])); g.push(i); }
  for (const [A] of groups) {
    const { u, v, order } = frameFor(A);
    // rows: an item joins the first row (in the order rows start) whose first
    // item is within max(2, 0.35 h) of it. Items come in v order and every
    // row starts at or above the item, so that row is the oldest one whose
    // reach (start + tolerance) is still ≥ the item's v; a row out of reach
    // stays out of reach, so a queue popped from the front finds it
    const rows: number[][] = [], rowEnd: number[] = [];
    let front = 0;
    for (const i of order) {
      if (Math.round(items[i].a) !== A) continue; // a neighbour angle's item: its own group
      while (front < rows.length && rowEnd[front] < v[i]) front++;
      if (front < rows.length) rows[front].push(i);
      else { rows.push([i]); rowEnd.push(v[i] + Math.max(2, 0.35 * hOf(i))); }
    }
    for (const row of rows) {
      if (!row.some((i) => cand[i])) continue; // no label word: no label run
      row.sort((p, q) => u[p] - u[q]); // stable: ties keep (v, u, item) order
      let cur: number[] = [];
      const flush = () => {
        for (const i of cur) if (cand[i]) consider([i], A);
        if (cur.length > 1 && cand[cur[0]]) consider(cur, A);
      };
      for (const i of row) {
        const last = cur[cur.length - 1];
        if (last !== undefined && u[i] - (u[last] + L[last]) > 1.0 * Math.max(hOf(last), hOf(i))) { flush(); cur = []; }
        cur.push(i);
      }
      if (cur.length) flush();
    }
  }
  if (!labs.length) return null;

  // ---- try labels nearest the lower-right corner first ----
  const dist = (l: Lab) => Math.hypot(X[l.items[0]] - W, Y[l.items[0]] - H);
  const ordered = labs.map((l, k) => ({ l, k, d: dist(l) })).sort((p, q) => p.d - q.d || p.k - q.k).map((x) => x.l);
  const shapeMemo = new Int8Array(n); // 0 unknown, 1 shaped, 2 not
  const isShaped = (i: number) => { if (!shapeMemo[i]) shapeMemo[i] = shaped(items[i].s) ? 1 : 2; return shapeMemo[i] === 1; };

  // a label heading a column of ≥ 3 number-shaped rows is an index header
  const isHeader = (l: Lab) => {
    const { u, v, order } = frameFor(l.a);
    const f = l.items[0], fu = u[f], fv = v[f], fh = hOf(f);
    const rowsSeen = new Set<number>();
    for (let k = lowerBound(order, v, fv + 0.5 * fh, true); k < order.length; k++) {
      const i = order[k];
      if (v[i] >= fv + 0.35 * H) break;
      if (Math.abs(u[i] - fu) >= 0.06 * W || !isShaped(i)) continue;
      rowsSeen.add(Math.round(v[i] / Math.max(2, 0.5 * hOf(i))));
      if (rowsSeen.size >= 3) return true;
    }
    return false;
  };

  type Line = { t: string; h: number };
  const readCell = (l: Lab): Line[] => {
    const { u, v, order } = frameFor(l.a);
    const first = l.items[0], last = l.items[l.items.length - 1];
    const h = hOf(first), Lu = u[first], Lend = u[last] + L[last], Lv = v[first];
    const inLab = new Set(l.items);
    const rowTolL = 0.8 * h;
    // the next item to the right on the label's row
    let rowRight = -1;
    for (let k = lowerBound(order, v, Lv - rowTolL); k < order.length; k++) {
      const i = order[k];
      if (v[i] > Lv + rowTolL) break;
      if (inLab.has(i) || !(u[i] > Lend - 0.1 * h)) continue;
      if (rowRight < 0 || u[i] < u[rowRight] || (u[i] === u[rowRight] && i < rowRight)) rowRight = i;
    }
    const axis = Math.abs(Math.cos((l.a * Math.PI) / 180)) > 0.5 ? W : H;
    const right = rowRight >= 0 ? u[rowRight] - 0.3 * h : Lu + 0.15 * axis;
    const left = Lu - 0.5 * h;
    // the window reaches 16 label heights down, or 4.5 of the first value
    // line's line-heights below it if that is deeper
    let lim = Lv + 16 * h;
    let firstV = -1;
    for (let k = lowerBound(order, v, Lv + rowTolL, true); k < order.length; k++) {
      const i = order[k];
      if (!(v[i] < Lv + 16 * h)) break;
      if (inLab.has(i) || !(u[i] < right && u[i] + L[i] > left)) continue;
      if (firstV < 0 || v[i] < v[firstV] || (v[i] === v[firstV] && i < firstV)) firstV = i;
    }
    if (firstV >= 0) lim = Math.max(lim, v[firstV] + 4.5 * 1.6 * hOf(firstV));
    const band: number[] = [];
    for (let k = lowerBound(order, v, Lv + rowTolL, true); k < order.length; k++) {
      const i = order[k];
      if (!(v[i] < lim)) break;
      if (!inLab.has(i)) band.push(i);
    }
    // same-height lines across the band, then segments that belong to the
    // cell: starting inside it or overlapping the label, ending before the
    // next item on the label's row
    const endMax = rowRight >= 0 ? u[rowRight] + 0.5 * h : Infinity;
    const lsV: number[] = [], lsH: number[] = [], ls: number[][] = [];
    let lsMaxTol = 0;
    for (const b of band) {
      let r = firstAtLeast(lsV, v[b] - lsMaxTol);
      for (; r < ls.length; r++) if (Math.abs(v[b] - lsV[r]) <= Math.max(2, lsH[r] * 0.35) && Math.abs(hOf(b) - lsH[r]) <= 0.3 * lsH[r]) break;
      if (r < ls.length) ls[r].push(b);
      else { ls.push([b]); lsV.push(v[b]); lsH.push(hOf(b)); lsMaxTol = Math.max(lsMaxTol, Math.max(2, hOf(b) * 0.35)); }
    }
    const below: number[] = [];
    for (const it of ls) {
      it.sort((p, q) => u[p] - u[q]);
      const segs: number[][] = [];
      for (const f of it) {
        const sg = segs[segs.length - 1];
        const lst = sg?.[sg.length - 1];
        if (lst !== undefined && u[f] - (u[lst] + L[lst]) <= 1.0 * Math.max(hOf(f), hOf(lst))) sg.push(f); else segs.push([f]);
      }
      for (const sg of segs) {
        const st = u[sg[0]], en = u[sg[sg.length - 1]] + L[sg[sg.length - 1]];
        const inside = st >= left && st < right;
        if ((inside || (st < Lend && en > Lu)) && en <= endMax) below.push(...sg);
      }
    }
    below.sort((p, q) => v[p] - v[q] || u[p] - u[q]);
    const lines: { v: number; h: number; it: number[] }[] = [];
    for (const b of below) {
      const ln = lines.find((x) => Math.abs(v[b] - x.v) <= Math.max(2, x.h * 0.35));
      if (ln) ln.it.push(b); else lines.push({ v: v[b], h: hOf(b), it: [b] });
    }
    lines.sort((p, q) => p.v - q.v);
    const out: Line[] = [];
    for (const ln of lines) {
      ln.it.sort((p, q) => u[p] - u[q]);
      const t = ln.it.map((i) => items[i].s).join(" ").replace(/\s+/g, " ").trim();
      if ((isVocab(items[ln.it[0]].s) || isVocab(t)) && ln.h <= 1.1 * h) break;
      if (out.length >= 4) break;
      out.push({ t, h: ln.h });
    }
    const rr = rowRight >= 0 ? items[rowRight].s : "";
    const colonBeside = /:\s*$/.test(l.text) && rowRight >= 0 && u[rowRight] - Lend <= 3 * h && !isVocab(rr) && !/:\s*$/.test(rr);
    if (out.length && !colonBeside) return out;
    if (rowRight >= 0 && !isVocab(rr)) {
      // the run of items beside the label, from the next item on its row
      const tol = Math.max(2, 0.35 * hOf(rowRight)), rv = v[rowRight], ru = u[rowRight];
      const row: number[] = [];
      for (let k = lowerBound(order, v, rv - tol); k < order.length; k++) {
        const i = order[k];
        if (v[i] > rv + tol) break;
        if (!inLab.has(i) && u[i] >= ru) row.push(i);
      }
      row.sort((p, q) => u[p] - u[q] || p - q);
      const r: number[] = [];
      for (const f of row) { const lst = r[r.length - 1]; if (lst !== undefined && u[f] - (u[lst] + L[lst]) > 1.0 * hOf(f)) break; r.push(f); }
      return [{ t: r.map((i) => items[i].s).join(" ").replace(/\s+/g, " ").trim(), h: hOf(rowRight) }];
    }
    return [];
  };

  let tried = 0;
  for (const l of ordered) {
    if (isHeader(l)) continue;
    if (++tried > MAX_LABELS) break;
    const labH = hOf(l.items[0]);
    const lines = l.inline !== undefined ? [{ t: l.inline, h: labH * 2 }] : readCell(l);
    let best: Line | null = null;
    for (const ln of lines) {
      if (ln.h < 1.5 * labH) continue;
      const sq = norm(ln.t).replace(/\s+/g, "");
      if (SHAPE.test(sq) && sq.length <= 10 && (!best || ln.h > best.h)) best = { t: sq, h: ln.h };
    }
    if (best) return best.t;
  }
  return null;
}
