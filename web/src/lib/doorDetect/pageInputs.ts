// What the door-detector pipeline reads off a page besides the model's boxes:
// its text (as lines and words) and its straight linework with stroke widths,
// both from pdf.js, in the door reader's frame (unrotated page points, y
// down: pass the transform of page.getViewport({ scale: 1, rotation: 0 })).
// Pure: pdf.js hands in plain arrays.
import { decodeConstructPath } from "../oneclick.ts";
import type { OpList, OpsTable } from "../oneclick.ts";
import type { Pt } from "./geom.ts";
import type { TextLine } from "./tags.ts";
import type { Word } from "./filters2.ts";
import { SEG_F32, type WallSegs } from "./filters.ts";

/** A pdf.js getTextContent() item, the fields used here. */
export interface PdfTextItem { str: string; transform: number[]; width: number; height: number }

/**
 * pdf.js text items → text lines (one per item) and words. A line's box is
 * the run's axis-aligned extent, from a fifth of the font size below the
 * baseline to four fifths above it (the usual descender and ascender), so
 * rotated text still has a true centre. A word's centre is placed along the run by its share of the
 * run's characters.
 */
export function pageText(items: PdfTextItem[], vt: number[]): { lines: TextLine[]; words: Word[] } {
  const lines: TextLine[] = [], words: Word[] = [];
  for (const it of items) {
    const raw = it.str || "", str = raw.trim();
    if (!str || !Array.isArray(it.transform)) continue;
    const t = it.transform;
    const m = [vt[0] * t[0] + vt[2] * t[1], vt[1] * t[0] + vt[3] * t[1], vt[0] * t[2] + vt[2] * t[3], vt[1] * t[2] + vt[3] * t[3], vt[0] * t[4] + vt[2] * t[5] + vt[4], vt[1] * t[4] + vt[3] * t[5] + vt[5]];
    const fs = Math.hypot(m[2], m[3]) || 1, dl = Math.hypot(m[0], m[1]) || 1, sc = Math.hypot(vt[0], vt[1]) || 1;
    const w = (it.width || 0) * sc;
    const ux = m[0] / dl, uy = m[1] / dl;           // reading direction
    const vx = m[2] / fs, vy = m[3] / fs;           // baseline → top of the letters
    const o: Pt = [m[4], m[5]];
    const corners: Pt[] = [];
    for (const a of [0, w]) for (const b of [-0.2 * fs, 0.8 * fs]) corners.push([o[0] + ux * a + vx * b, o[1] + uy * a + vy * b]);
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const box: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    lines.push({ str, box, c: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], size: fs });
    const n = Math.max(raw.length, 1), re = /\S+/g;
    for (let mm = re.exec(raw); mm; mm = re.exec(raw)) {
      const at = ((mm.index + mm[0].length / 2) / n) * w;
      words.push({ str: mm[0], c: [o[0] + ux * at + vx * 0.35 * fs, o[1] + uy * at + vy * 0.35 * fs] });
    }
  }
  return { lines, words };
}

/**
 * Every straight painted segment on the page with its stroke width (page
 * points, scaled by the drawing's transform) and whether it comes from a
 * filled-not-stroked path. Rectangles give their four sides; curves and
 * clip-only paths are left out.
 */
export function extractWallSegs(opList: OpList, transform: number[], OPS: OpsTable): WallSegs {
  const out: number[] = [];
  let m = transform.slice(), lw = 1;
  const stack: Array<[number[], number]> = [];
  const mul = (a: number[], b: number[]): number[] => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const fns = opList.fnArray, A = opList.argsArray;
  const followingPaint = (i: number): number | null => {
    for (let j = i + 1; j < fns.length && j <= i + 3; j++) {
      const f = fns[j];
      if (f === OPS.clip || f === OPS.eoClip) continue;
      return f;
    }
    return null;
  };
  const isFill = (p: number | null) => p === OPS.fill || p === OPS.eoFill || p === OPS.fillStroke || p === OPS.eoFillStroke || p === OPS.closeFillStroke || p === OPS.closeEOFillStroke;
  const isStroke = (p: number | null) => p === OPS.stroke || p === OPS.closeStroke || p === OPS.fillStroke || p === OPS.eoFillStroke || p === OPS.closeFillStroke || p === OPS.closeEOFillStroke;
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i], args = A[i];
    if (fn === OPS.save) stack.push([m.slice(), lw]);
    else if (fn === OPS.restore) { const p = stack.pop(); if (p) { m = p[0]; lw = p[1]; } }
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([m.slice(), lw]); if (args && args[0]) m = mul(m, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { const p = stack.pop(); if (p) { m = p[0]; lw = p[1]; } }
    else if (fn === OPS.setLineWidth) { const v = Number(args?.[0]); if (Number.isFinite(v)) lw = v; }
    else if (fn === OPS.setGState) { for (const pr of args?.[0] || []) if (pr && pr[0] === "LW") { const v = Number(pr[1]); if (Number.isFinite(v)) lw = v; } }
    else if (fn === OPS.constructPath) {
      const decoded = decodeConstructPath(args, OPS);
      if (!decoded) continue;
      const paint = decoded.paintFn === null ? followingPaint(i) : decoded.paintFn;
      const fill = isFill(paint), stroke = isStroke(paint);
      if (!fill && !stroke) continue;
      const width = stroke ? lw * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) : 0, flag = fill && !stroke ? 1 : 0;
      const tx = (x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
      const seg = (a: Pt, b: Pt) => { out.push(a[0], a[1], b[0], b[1], width, flag); };
      const ops = decoded.ops, co = decoded.co;
      let c = 0, cur: Pt | null = null, start: Pt | null = null;
      for (let oi = 0; oi < ops.length; oi++) {
        const op = ops[oi];
        if (op === OPS.moveTo) { cur = tx(co[c], co[c + 1]); start = cur; c += 2; }
        else if (op === OPS.lineTo) { const p = tx(co[c], co[c + 1]); c += 2; if (cur) seg(cur, p); cur = p; if (!start) start = p; }
        else if (op === OPS.curveTo) { cur = tx(co[c + 4], co[c + 5]); c += 6; if (!start) start = cur; }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { cur = tx(co[c + 2], co[c + 3]); c += 4; if (!start) start = cur; }
        else if (op === OPS.closePath) { if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) seg(cur, start); cur = start; }
        else if (op === OPS.rectangle) {
          const x = co[c], y = co[c + 1], w = co[c + 2], h = co[c + 3]; c += 4;
          const q = [tx(x, y), tx(x + w, y), tx(x + w, y + h), tx(x, y + h)];
          for (let k = 0; k < 4; k++) seg(q[k], q[(k + 1) % 4]);
          cur = q[0]; start = q[0];
        }
      }
    }
  }
  return { data: Float32Array.from(out), n: out.length / SEG_F32 };
}

/** A gray render → its ink: pixels darker than `thr`. */
export function inkMask(gray: Uint8Array, w: number, h: number, z: number, thr: number): { w: number; h: number; z: number; data: Uint8Array } {
  const data = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) data[i] = gray[i] < thr ? 1 : 0;
  return { w, h, z, data };
}
