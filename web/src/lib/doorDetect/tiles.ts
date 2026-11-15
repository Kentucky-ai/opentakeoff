// The door detector's input and output, around the model call: how a page is
// cut into tiles, how a tile becomes the model's input, how the model's raw
// output becomes boxes, and how boxes from overlapping tiles are merged.
// It matches the published Python runner (detect_onnx.py in the model's
// Hugging Face repo) step for step, so a browser run and a Python run of the
// same render give the same boxes. Pure: no DOM, no onnxruntime.
import type { DetBox } from "./geom.ts";

export interface DetectParams {
  /** render scale the model was trained at, pixels per foot */
  px_per_ft: number;
  tile: number;
  stride: number;
  /** the model's input side; a tile is resized to it */
  input: number;
  /** a tile whose darkest pixel is lighter than this is blank and skipped */
  blank_min: number;
  /** lowest score kept */
  floor: number;
  top_k: number;
  /** two boxes overlapping by more than this share of the smaller are one door */
  merge_overlap: number;
  /** class ids that only compete with their own kind when merging (a doorway strip overlaps its own swing box) */
  strip_separate: number[];
}

/** Top-left corners of the tiles covering a w × h render: a stride apart, the last one flush with the far edge. */
export function tileOrigins(w: number, h: number, tile: number, stride: number): Array<[number, number]> {
  const axis = (n: number) => {
    const last = Math.max(n - tile, 0);
    const out: number[] = [];
    for (let v = 0; v <= last; v += stride) out.push(v);
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  };
  const xs = axis(w), ys = axis(h), out: Array<[number, number]> = [];
  for (const y of ys) for (const x of xs) out.push([x, y]);
  return out;
}

/** One tile of a grayscale page (white where it runs off the page), and whether it has any ink. */
export function cutTile(gray: Uint8Array, w: number, h: number, x: number, y: number, tile: number, blankMin: number): { px: Uint8Array; blank: boolean } {
  const px = new Uint8Array(tile * tile).fill(255);
  let min = 255;
  const cw = Math.min(tile, w - x), ch = Math.min(tile, h - y);
  for (let r = 0; r < ch; r++) {
    const row = gray.subarray((y + r) * w + x, (y + r) * w + x + cw);
    px.set(row, r * tile);
    for (let c = 0; c < cw; c++) if (row[c] < min) min = row[c];
  }
  return { px, blank: min > blankMin };
}

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

/**
 * A gray tile → the model's input: resized to `size` (bilinear, pixel centres
 * aligned, as OpenCV's INTER_LINEAR), copied to three channels, scaled 0–1
 * and ImageNet-normalized, channel-first.
 */
export function tileTensor(px: Uint8Array, tile: number, size: number): Float32Array {
  const out = new Float32Array(3 * size * size);
  const scale = tile / size;
  const x0 = new Int32Array(size), x1 = new Int32Array(size), fx = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    let s = (i + 0.5) * scale - 0.5;
    if (s < 0) s = 0;
    const lo = Math.min(Math.floor(s), tile - 1);
    x0[i] = lo; x1[i] = Math.min(lo + 1, tile - 1); fx[i] = s - lo;
  }
  const n = size * size;
  for (let j = 0; j < size; j++) {
    const ra = x0[j] * tile, rb = x1[j] * tile, fy = fx[j];
    for (let i = 0; i < size; i++) {
      const a = px[ra + x0[i]], b = px[ra + x1[i]], c = px[rb + x0[i]], d = px[rb + x1[i]];
      const top = a + (b - a) * fx[i], bot = c + (d - c) * fx[i];
      const v = Math.round(top + (bot - top) * fy) / 255;
      const o = j * size + i;
      out[o] = (v - MEAN[0]) / STD[0];
      out[n + o] = (v - MEAN[1]) / STD[1];
      out[2 * n + o] = (v - MEAN[2]) / STD[2];
    }
  }
  return out;
}

/**
 * The model's raw output for one tile → boxes in tile pixels.
 * `dets` is queries × 4 (cx, cy, w, h, each 0–1 of the tile); `logits` is
 * queries × columns. The top_k scores over every (query, class) pair are
 * kept down to the floor; columns past the known classes are ignored.
 */
export function decodeTile(dets: ArrayLike<number>, logits: ArrayLike<number>, cols: number, nClasses: number, tile: number, floor: number, topK: number): DetBox[] {
  const n = logits.length;
  const cut = Math.log(floor / (1 - floor));   // a logit at the floor
  const cand: Array<[number, number]> = [];    // [logit, flat index]
  for (let i = 0; i < n; i++) if (logits[i] >= cut - 1e-6) cand.push([logits[i], i]);
  // the top_k highest of ALL pairs, as the runner takes them, before the class filter
  let kth = -Infinity;
  if (n > topK) {
    const all = Float32Array.from(logits as ArrayLike<number>).sort();
    kth = all[n - topK];
  }
  cand.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const out: DetBox[] = [];
  for (const [lg, i] of cand) {
    if (lg < kth) break;
    const s = 1 / (1 + Math.exp(-lg));
    if (s < floor) break;
    const q = Math.floor(i / cols), c = i % cols;
    if (c >= nClasses) continue;
    const cx = dets[q * 4] * tile, cy = dets[q * 4 + 1] * tile, w = dets[q * 4 + 2] * tile, h = dets[q * 4 + 3] * tile;
    out.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, s, c]);
  }
  return out;
}

/**
 * One door, one box: boxes from every tile, highest score first; a box is
 * dropped when it overlaps a kept one by more than merge_overlap of the
 * smaller. Classes in strip_separate compete only among themselves, because a
 * doorway strip lies across its own swing box.
 */
export function mergeBoxes(boxes: DetBox[], mergeOverlap: number, stripSeparate: number[] = []): DetBox[] {
  const sorted = boxes.map((b, i) => [b, i] as const).sort((a, b) => b[0][4] - a[0][4] || a[1] - b[1]).map((x) => x[0]);
  const sep = new Set(stripSeparate);
  const keep: DetBox[] = [];
  for (const b of sorted) {
    const ar = (b[2] - b[0]) * (b[3] - b[1]);
    let ok = true;
    for (const k of keep) {
      if (sep.has(b[5]) !== sep.has(k[5])) continue;
      const ov = Math.max(0, Math.min(b[2], k[2]) - Math.max(b[0], k[0])) * Math.max(0, Math.min(b[3], k[3]) - Math.max(b[1], k[1]));
      if (!(ov < mergeOverlap * Math.min(ar, (k[2] - k[0]) * (k[3] - k[1])))) { ok = false; break; }
    }
    if (ok) keep.push(b);
  }
  return keep;
}

/** Tile-merged boxes in render pixels → page points, rounded as the runner rounds them. */
export function toPagePoints(boxes: DetBox[], z: number): DetBox[] {
  return boxes.map((b) => [Math.round((b[0] / z) * 100) / 100, Math.round((b[1] / z) * 100) / 100, Math.round((b[2] / z) * 100) / 100, Math.round((b[3] / z) * 100) / 100, Math.round(b[4] * 1e4) / 1e4, b[5]]);
}
