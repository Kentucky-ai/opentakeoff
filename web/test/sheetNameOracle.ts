// Test-only oracle: the round-3 probe reader's sheet-NUMBER path
// (scratch-r3/reader3.ts readSheet with the V3 preset), switches folded in and
// the title path dropped. It is quadratic on dense pages and is kept only to
// check web/src/lib/sheetName.ts answer-for-answer.
export type Item = { s: string; x: number; y: number; h: number; a: number; w: number };
export type Page = { W: number; H: number; items: Item[] };

const NUMBER_LABELS = ["SHEET NUMBER", "DRAWING NUMBER", "SHEET NO", "DWG NO", "SHEET"];
const TITLE_LABELS = ["DRAWING TITLE", "SHEET TITLE", "SHEET NAME"];
const STOP_VOCAB = /^(ISSUE DATE|DATE|CHECKED|DRAWN|APPROVED|SCALE|LOCATION|PHASE|PROJECT|SHEET NUMBER|DRAWING NUMBER|SHEET NO|DWG NO|SHEET|JOB NO|REV|DWG)\b/;
const SHAPE2 = /^(?=.*\d)[A-Z]{1,3}\d{0,3}(?:[-. ]?[A-Z0-9]{1,4}){0,3}$/;
const norm = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();
const labelNorm = (s: string) => { let n = norm(s).replace(/:$/, "").trim(); if (n === "SHEET NO.") n = "SHEET NO"; return n; };
const isVocab = (s: string) => { const n = labelNorm(s); return STOP_VOCAB.test(n) || TITLE_LABELS.includes(n) || NUMBER_LABELS.includes(n); };

type P = Item & { X: number; Y: number; L: number; idx: number };
type F = P & { u: number; v: number };
const frame = (i: P, a: number): F => { const th = (a * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th); return { ...i, u: i.X * c + i.Y * s, v: -i.X * s + i.Y * c }; };
const sameAng = (a: number, b: number) => Math.abs(a - b) <= 1;
type Run = { items: F[]; text: string; a: number };
type Lab = { run: Run; inline?: string };

function runs(px: P[]): Run[] {
  const byA = new Map<number, P[]>();
  for (const i of px) { const k = Math.round(i.a); byA.set(k, [...(byA.get(k) ?? []), i]); }
  const out: Run[] = [];
  for (const [a, its] of byA) {
    const fs = its.map((i) => frame(i, a)).sort((p, q) => p.v - q.v || p.u - q.u);
    const rows: F[][] = [];
    for (const f of fs) { const r = rows.find((r) => Math.abs(r[0].v - f.v) <= Math.max(2, 0.35 * r[0].h)); if (r) r.push(f); else rows.push([f]); }
    for (const r of rows) {
      r.sort((p, q) => p.u - q.u);
      let cur: F[] = [];
      const flush = () => { for (const it of cur) out.push({ items: [it], text: it.s, a }); if (cur.length > 1) out.push({ items: cur, text: cur.map((x) => x.s).join(" "), a }); };
      for (const f of r) { const last = cur[cur.length - 1]; if (last && f.u - (last.u + last.L) > 1.0 * Math.max(last.h, f.h)) { flush(); cur = []; } cur.push(f); }
      if (cur.length) flush();
    }
  }
  return out;
}

function findLabels(px: P[]): Lab[] {
  const out: Lab[] = [];
  for (const r of runs(px)) {
    const f = r.items[0];
    if (f.x < 0.5 && f.y < 0.5) continue;
    const n = labelNorm(r.text), raw = norm(r.text);
    for (const lab of NUMBER_LABELS) {
      if (n === lab) out.push({ run: r });
      else if (r.items.length === 1) {
        const m = new RegExp(`^${lab}${lab === "SHEET NO" ? "\\.?" : ""}:\\s*(.+)$`).exec(raw);
        if (m) { const orig = r.text.replace(/\s+/g, " ").trim(); out.push({ run: r, inline: orig.slice(orig.length - m[1].length) }); }
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((l) => { const k = `${l.run.items[0].idx}|${l.run.items.length}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

type Line = { t: string; h: number };
function readCell(p: Page, px: P[], lab: Lab): Line[] {
  const a = lab.run.a, first = lab.run.items[0], last = lab.run.items[lab.run.items.length - 1];
  const h = first.h, Lu = first.u, Lend = last.u + last.L, Lv = first.v;
  const same = px.filter((i) => sameAng(i.a, a)).map((i) => frame(i, a));
  const inLab = new Set(lab.run.items.map((i) => i.idx));
  const rowTol = 0.8 * h;
  const onRow = same.filter((i) => !inLab.has(i.idx) && Math.abs(i.v - Lv) <= rowTol);
  const rowRight = onRow.filter((i) => i.u > Lend - 0.1 * h).sort((x, y) => x.u - y.u)[0];
  const rowLeft = onRow.filter((i) => i.u + i.L < Lu + 0.1 * h).sort((x, y) => y.u + y.L - (x.u + x.L))[0];
  const axis = Math.abs(Math.cos((a * Math.PI) / 180)) > 0.5 ? p.W : p.H;
  const right = rowRight ? rowRight.u - 0.3 * h : Lu + 0.15 * axis;
  const left = Lu - 0.5 * h;
  void rowLeft;
  let lim = Lv + 16 * h;
  const firstV = same.filter((i) => !inLab.has(i.idx) && i.v > Lv + rowTol && i.v < Lv + 16 * h && i.u < right && i.u + i.L > left).sort((x, y) => x.v - y.v)[0];
  if (firstV) lim = Math.max(lim, firstV.v + 4.5 * 1.6 * firstV.h);
  const band = same.filter((i) => !inLab.has(i.idx) && i.v > Lv + rowTol && i.v < lim);
  const endMax = rowRight ? rowRight.u + 0.5 * h : Infinity;
  const ls: { v: number; h: number; it: F[] }[] = [];
  for (const b of [...band].sort((x, y) => x.v - y.v || x.u - y.u)) { const l = ls.find((l) => Math.abs(b.v - l.v) <= Math.max(2, l.h * 0.35) && Math.abs(b.h - l.h) <= 0.3 * l.h); if (l) l.it.push(b); else ls.push({ v: b.v, h: b.h, it: [b] }); }
  let below: F[] = [];
  for (const l of ls) {
    const it = l.it.sort((x, y) => x.u - y.u); const segs: F[][] = [];
    for (const f of it) { const sg = segs[segs.length - 1]; const lst = sg?.[sg.length - 1]; if (lst && f.u - (lst.u + lst.L) <= 1.0 * Math.max(f.h, lst.h)) sg.push(f); else segs.push([f]); }
    for (const sg of segs) { const st = sg[0].u, en = sg[sg.length - 1].u + sg[sg.length - 1].L;
      const inside = st >= left && st < right;
      if ((inside || (st < Lend && en > Lu)) && en <= endMax) below.push(...sg); }
  }
  below = below.sort((x, y) => x.v - y.v || x.u - y.u);
  const lines: { v: number; h: number; it: F[] }[] = [];
  for (const b of below) { const ln = lines.find((l) => Math.abs(b.v - l.v) <= Math.max(2, l.h * 0.35)); if (ln) ln.it.push(b); else lines.push({ v: b.v, h: b.h, it: [b] }); }
  lines.sort((x, y) => x.v - y.v);
  const out: Line[] = [];
  for (const ln of lines) {
    const t = ln.it.sort((x, y) => x.u - y.u).map((x) => x.s).join(" ").replace(/\s+/g, " ").trim();
    if ((isVocab(ln.it[0].s) || isVocab(t)) && ln.h <= 1.1 * h) break;
    if (out.length >= 4) break;
    out.push({ t, h: ln.h });
  }
  const colonBeside = /:\s*$/.test(lab.run.text) && rowRight && rowRight.u - Lend <= 3 * h && !isVocab(rowRight.s) && !/:\s*$/.test(rowRight.s);
  if (out.length && !colonBeside) return out;
  if (rowRight && !isVocab(rowRight.s)) {
    const row = same.filter((i) => !inLab.has(i.idx) && Math.abs(i.v - rowRight.v) <= Math.max(2, 0.35 * rowRight.h) && i.u >= rowRight.u).sort((x, y) => x.u - y.u);
    const r: F[] = [];
    for (const f of row) { const l = r[r.length - 1]; if (l && f.u - (l.u + l.L) > 1.0 * f.h) break; r.push(f); }
    return [{ t: r.map((x) => x.s).join(" ").replace(/\s+/g, " ").trim(), h: rowRight.h }];
  }
  return [];
}

function shapedToken(lines: Line[], labH: number): string | null {
  const c: Line[] = [];
  for (const l of lines) { const sq = norm(l.t).replace(/\s+/g, ""); if (l.h < 1.5 * labH) continue; if (SHAPE2.test(sq) && sq.length <= 10) c.push({ t: sq, h: l.h }); }
  return c.length ? c.sort((x, y) => y.h - x.h)[0].t : null;
}

function isTableHeader(p: Page, px: P[], lab: Lab): boolean {
  const a = lab.run.a, f = lab.run.items[0];
  const same = px.filter((i) => sameAng(i.a, a)).map((i) => frame(i, a));
  const col = same.filter((i) => i.v > f.v + 0.5 * f.h && i.v < f.v + 0.35 * p.H && Math.abs(i.u - f.u) < 0.06 * p.W);
  const rows = new Set<number>();
  for (const i of col) if (SHAPE2.test(norm(i.s).replace(/\s+/g, "")) && norm(i.s).length <= 10) rows.add(Math.round(i.v / Math.max(2, 0.5 * i.h)));
  return rows.size >= 3;
}

export function oracleSheetNumber(p: Page): string | null {
  const px: P[] = p.items.map((i, idx) => ({ ...i, X: i.x * p.W, Y: i.y * p.H, L: i.w * p.W, idx }));
  const labs = findLabels(px).filter((l) => !isTableHeader(p, px, l));
  const d = (l: Lab) => Math.hypot(l.run.items[0].X - p.W, l.run.items[0].Y - p.H);
  for (const l of [...labs].sort((a, b) => d(a) - d(b))) {
    const lines = l.inline ? [{ t: l.inline, h: l.run.items[0].h * 2 }] : readCell(p, px, l);
    const tok = shapedToken(lines, l.run.items[0].h);
    if (tok) return tok;
  }
  return null;
}
