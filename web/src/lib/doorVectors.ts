// The door reader's input: every painted path on a page, as flat arrays.
//
// The door reader (engine/door-reader, WebAssembly) needs more than the
// canvas extractor keeps: a Bezier curve must stay a curve (an arc is fitted
// to its exact points), each piece must remain in the path it was drawn in
// (a swing drawn as loose strokes is told from a polyline by that), and each
// path keeps whether it is stroked dashed and whether it is filled dark.
// Clip-only paths are left out: they draw nothing.
//
// Coordinates are page points in the UNROTATED frame, y down, origin at the
// top-left of the page's view box: pass the transform of
// page.getViewport({ scale: 1, rotation: 0 }). Readers that work in another
// frame map the doors' coordinates back afterwards (doorReader.ts).
import { decodeConstructPath, strokeLuminance } from "./oneclick.ts";
import type { OpList, OpsTable } from "./oneclick.ts";

/** Floats per item / per path record; the layout the WebAssembly reader reads. */
export const ITEM_F64 = 10;
export const PATH_F64 = 2;
export const KIND_LINE = 0, KIND_CURVE = 1, KIND_EDGE = 2;
/** Read a run of legacy constructPath ops with no paint between them as one path. */
const SPLIT_PATHS = true;

export interface DoorVectors {
  /** n × [path, kind, x0, y0, x1, y1, x2, y2, x3, y3] */
  items: Float64Array;
  /** m × [dashed, darkFill] */
  paths: Float64Array;
  nItems: number;
  nPaths: number;
}

/** Mean of the RGB components, 0–255, from a pdf.js color op's args (null: unreadable). */
function meanRgb(args: unknown[]): number | null {
  const first = args?.[0];
  if (typeof first === "string") {
    const hex = /^#([0-9a-f]{6})$/i.exec(first);
    if (!hex) return null;
    const v = parseInt(hex[1], 16);
    return (((v >> 16) & 255) + ((v >> 8) & 255) + (v & 255)) / 3;
  }
  const a = Array.isArray(first) || (ArrayBuffer.isView(first) && !(first instanceof DataView)) ? (first as ArrayLike<number>) : (args as ArrayLike<number>);
  if (!a || a.length < 3) return strokeLuminance(args as unknown[]);
  const [r, g, b] = [Number(a[0]), Number(a[1]), Number(a[2])];
  if (![r, g, b].every(Number.isFinite)) return null;
  const k = r <= 1 && g <= 1 && b <= 1 ? 255 : 1;
  return ((r + g + b) / 3) * k;
}

function dashedPattern(arr: unknown): boolean {
  if (!arr) return false;
  const a = arr as ArrayLike<number>;
  if (typeof a.length !== "number" || a.length === 0) return false;
  for (let i = 0; i < a.length; i++) if (Number(a[i]) > 0) return true;
  return false;
}

export function extractDoorVectors(opList: OpList, transform: number[], OPS: OpsTable): DoorVectors {
  const items: number[] = [];
  const paths: number[] = [];
  let m = transform.slice();
  let dashed = false;
  let fillMean = 0;      // PDF's initial fill colour is black
  const stack: Array<[number[], boolean, number]> = [];
  const mul = (a: number[], b: number[]): number[] => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const fns = opList.fnArray, A = opList.argsArray;
  // legacy shape: the paint op follows its path (clip ops may sit between)
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
    if (fn === OPS.save) stack.push([m.slice(), dashed, fillMean]);
    else if (fn === OPS.restore) { const p = stack.pop(); if (p) { m = p[0]; dashed = p[1]; fillMean = p[2]; } }
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([m.slice(), dashed, fillMean]); if (args && args[0]) m = mul(m, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { const p = stack.pop(); if (p) { m = p[0]; dashed = p[1]; fillMean = p[2]; } }
    else if (fn === OPS.setDash) dashed = dashedPattern(args?.[0]);
    else if (fn === OPS.setGState) { for (const pr of args?.[0] || []) if (pr && pr[0] === "D") dashed = dashedPattern(pr[1]?.[0]); }
    else if (fn === OPS.setFillRGBColor || fn === OPS.setFillGray || fn === OPS.setFillCMYKColor) {
      if (fn === OPS.setFillRGBColor) { const v = meanRgb(args); if (v !== null) fillMean = v; }
      else if (fn === OPS.setFillGray) { const g = Number(args?.[0]); if (Number.isFinite(g)) fillMean = g <= 1 ? g * 255 : g; }
      else { const v = meanRgb(args); if (v !== null) fillMean = v; }
    }
    else if (fn === OPS.constructPath) {
      let decoded = decodeConstructPath(args, OPS);
      if (!decoded) continue;
      // legacy shape: one path can arrive as several constructPath ops in a row (a lone moveTo, then its curve), painted
      // once after the last; read them as one, or a curve loses its start point (the current point the moveTo set)
      if (decoded.paintFn === null && SPLIT_PATHS) {
        let ops = Array.from(decoded.ops), co = Array.from(decoded.co);
        while (i + 1 < fns.length && fns[i + 1] === OPS.constructPath) {
          const next = decodeConstructPath(A[i + 1], OPS);
          if (!next || next.paintFn !== null) break;
          ops = ops.concat(Array.from(next.ops)); co = co.concat(Array.from(next.co));
          i++;
        }
        decoded = { ops, co, paintFn: null };
      }
      const paint = decoded.paintFn === null ? followingPaint(i) : decoded.paintFn;
      if (paint === OPS.endPath || (!isFill(paint) && !isStroke(paint))) continue;   // clip-only: draws nothing
      const pathIdx = paths.length / PATH_F64;
      const filledDark = isFill(paint) && fillMean < 127.5;
      const stroked = isStroke(paint);
      const tx = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
      const ops = decoded.ops, co = decoded.co;
      // one subpath at a time, so a closed axis-aligned four-sided figure is named a rectangle (its edges are never strokes of an arc)
      let sub: number[] = [];        // pending items of the current subpath (flat records)
      let subPts: Array<[number, number]> = [];
      let subLinesOnly = true;
      let subClosed = false;
      const flushSub = () => {
        if (!sub.length) return;
        let rect = false;
        if (subLinesOnly && subClosed && sub.length === 4 * ITEM_F64) {
          rect = true;
          for (let k = 0; k < 4; k++) {
            const o = k * ITEM_F64;
            if (Math.abs(sub[o + 2] - sub[o + 4]) > 1e-6 && Math.abs(sub[o + 3] - sub[o + 5]) > 1e-6) { rect = false; break; }
          }
        }
        if (rect) for (let k = 0; k < 4; k++) sub[k * ITEM_F64 + 1] = KIND_EDGE;
        for (const v of sub) items.push(v);
        sub = []; subPts = []; subLinesOnly = true; subClosed = false;
      };
      const push = (kind: number, pts: Array<[number, number]>) => {
        sub.push(pathIdx, kind);
        for (let k = 0; k < 4; k++) { const p = pts[k] || [0, 0]; sub.push(p[0], p[1]); }
        if (kind !== KIND_LINE) subLinesOnly = false;
      };
      let c = 0;
      let cur: [number, number] | null = null, start: [number, number] | null = null;
      for (let oi = 0; oi < ops.length; oi++) {
        const op = ops[oi];
        if (op === OPS.moveTo) { flushSub(); cur = tx(co[c], co[c + 1]); start = cur; subPts.push(cur); c += 2; }
        else if (op === OPS.lineTo) { const p = tx(co[c], co[c + 1]); c += 2; if (cur) push(KIND_LINE, [cur, p]); cur = p; if (!start) start = p; }
        else if (op === OPS.curveTo || op === OPS.curveTo2 || op === OPS.curveTo3) {
          let p1: [number, number], p2: [number, number], p3: [number, number];
          if (op === OPS.curveTo) { p1 = tx(co[c], co[c + 1]); p2 = tx(co[c + 2], co[c + 3]); p3 = tx(co[c + 4], co[c + 5]); c += 6; }
          else if (op === OPS.curveTo2) { p1 = cur || tx(co[c], co[c + 1]); p2 = tx(co[c], co[c + 1]); p3 = tx(co[c + 2], co[c + 3]); c += 4; }
          else { p1 = tx(co[c], co[c + 1]); p2 = p3 = tx(co[c + 2], co[c + 3]); c += 4; }
          const p0: [number, number] = cur || p1;
          push(KIND_CURVE, [p0, p1, p2, p3]);
          cur = p3; if (!start) start = p0;
        }
        else if (op === OPS.closePath) {
          if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) push(KIND_LINE, [cur, start]);
          subClosed = true;
          cur = start;
        }
        else if (op === OPS.rectangle) {
          flushSub();
          const x = co[c], y = co[c + 1], w = co[c + 2], h = co[c + 3]; c += 4;
          const q = [tx(x, y), tx(x + w, y), tx(x + w, y + h), tx(x, y + h)];
          for (let k = 0; k < 4; k++) push(KIND_EDGE, [q[k], q[(k + 1) % 4]]);
          flushSub();
          cur = q[0]; start = q[0];
        }
      }
      flushSub();
      paths.push(stroked && dashed ? 1 : 0, filledDark ? 1 : 0);
    }
  }
  return { items: Float64Array.from(items), paths: Float64Array.from(paths), nItems: items.length / ITEM_F64, nPaths: paths.length / PATH_F64 };
}
