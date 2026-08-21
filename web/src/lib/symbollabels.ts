// Label corroboration for symbol placements (#308): the plan already NAMES
// its labeled families — fixtures, tagged equipment, keyed devices — and a
// sweep that ignores those names leaves identity on the table in both
// directions. Measured before building, on two real sets from two offices:
//
//   A gym set (leader-line convention, color-plotted): following the black
//   leader from each P-7/P-6/P-6A label named 10 of 11 drain spots — every
//   committed match confirmed as the seed's own tag, five of six withheld
//   resolved as a DIFFERENT fixture by name, one true question left.
//
//   A mixed-use renovation (labels beside symbols, ONE pen): nearest-token
//   adjacency named all 5 real drains — and flagged two 0.97+ matches with
//   NO label anywhere near them: circles inside a backflow-preventer
//   assembly. Geometry alone was confident and wrong; the absent label
//   caught what the shape could not.
//
// This module is PURE — spans, segments, and placements in; names out — so
// the canvas Symbol tool (#264) can reuse it verbatim. It never promotes or
// demotes a placement: a label is disclosure, and the judgement stays with
// the estimator.
import type { Point } from "./oneclick.ts";

export interface LabelSpan { str: string; x0: number; y0: number; x1: number; y1: number }

export interface PlacementLabel {
  /** The tag the drawing itself puts on this placement, e.g. "P-7", "FD1". */
  label: string;
  /** How the tag reached the placement: written beside it, or connected by a
   * drawn leader line. */
  via: "adjacent" | "leader";
  /** Center-to-center (adjacent) or chase-endpoint (leader) distance, px. */
  distance_px: number;
}

/** The token shape fixture tags take on real sheets: 1–4 letters, optional
 * dash, optional digits, optional variant letter — P-7, P-6A, FD, FD1, CO,
 * VTR, WC1, WH-1, T1. At least one letter, so bare keynote numbers and
 * dimension strings never read as tags. The token must be its OWN text run:
 * a "CO" inside "CONNECT…" is prose, not a tag. */
export const LABEL_TOKEN_RE = /^[A-Z]{1,4}-?\d{0,3}[A-Z]?$/;

export function labelTokens(spans: LabelSpan[]): LabelSpan[] {
  return spans.filter((s) => {
    const t = s.str.trim();
    return t.length <= 6 && LABEL_TOKEN_RE.test(t) && /[A-Z]/.test(t);
  });
}

/** Adjacency radius, scaled off the token's own text height: this office's
 * lettering sets the spacing between a tag and the symbol it names. Measured:
 * true beside-the-symbol pairs sat at 1.2–1.9× the text height; the nearest
 * impostor (a same-shaped valve circle one fixture over) at 2.6×. */
export const LABEL_ADJACENT_K = 2.2;

/** Leader chasing arms only when the sheet draws in more than one pen: on a
 * color-plotted set the annotation pen (dark) is separable from the work
 * (#260's luminance channel), so a chase follows leaders and nothing else.
 * On a one-pen sheet the same walk would flood through walls and piping, so
 * adjacency carries the sheet alone. The share is length-weighted. */
export const LEADER_MAX_DARK_SHARE = 0.9;
export const LEADER_DARK_LUM = 60;
const LEADER_HOP_PX = 14;
const LEADER_HOPS = 4;
const LEADER_HIT_PX = 30;

interface DarkIndex { segs: number[][]; cells: Map<number, number[]>; cell: number }

function buildDarkIndex(segs: number[], lum: Uint8Array): DarkIndex {
  const dark: number[][] = [];
  const n = segs.length >> 2;
  for (let i = 0; i < n; i++) {
    if (lum[i] < LEADER_DARK_LUM) dark.push([segs[i * 4], segs[i * 4 + 1], segs[i * 4 + 2], segs[i * 4 + 3]]);
  }
  const cell = LEADER_HOP_PX * 2;
  const key = (x: number, y: number): number => Math.floor(x / cell) * 73856093 ^ Math.floor(y / cell) * 19349663;
  const cells = new Map<number, number[]>();
  dark.forEach((s, i) => {
    for (const [x, y] of [[s[0], s[1]], [s[2], s[3]]] as const) {
      const k = key(x, y);
      const a = cells.get(k);
      if (a) a.push(i); else cells.set(k, [i]);
    }
  });
  return { segs: dark, cells, cell };
}

function nearDark(idx: DarkIndex, x: number, y: number): number[] {
  const out: number[] = [];
  const cx = Math.floor(x / idx.cell), cy = Math.floor(y / idx.cell);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const a = idx.cells.get((cx + dx) * 73856093 ^ (cy + dy) * 19349663);
    if (a) for (const i of a) if (!out.includes(i)) out.push(i);
  }
  return out;
}

/** Walk touching dark segments outward from a start point, a few hops — the
 * shape of a leader: tail, maybe one bend, arrowhead. Returns every endpoint
 * reached. */
function chase(idx: DarkIndex, start: Point): Point[] {
  let frontier: Point[] = [start];
  const seen = new Set<string>();
  const reached: Point[] = [start];
  for (let hop = 0; hop < LEADER_HOPS; hop++) {
    const next: Point[] = [];
    for (const p of frontier) {
      for (const i of nearDark(idx, p[0], p[1])) {
        const s = idx.segs[i];
        const ends: Point[] = [[s[0], s[1]], [s[2], s[3]]];
        for (let e = 0; e < 2; e++) {
          if (Math.hypot(ends[e][0] - p[0], ends[e][1] - p[1]) > LEADER_HOP_PX) continue;
          const other = ends[1 - e];
          const k = `${i}:${1 - e}`;
          if (seen.has(k)) continue;
          seen.add(k);
          next.push(other); reached.push(other);
        }
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return reached;
}

/**
 * Resolve the drawing's own name for each placement. Adjacency first — the
 * office that writes the tag beside the symbol — then, where the sheet's pens
 * allow it, leader-following from each token's left and right edges. Every
 * result names its route and distance so a label is auditable, never oracular.
 */
export function labelPlacements(
  placements: Point[],
  spans: LabelSpan[],
  segs: number[],
  lum?: Uint8Array,
): (PlacementLabel | null)[] {
  const tokens = labelTokens(spans);
  if (!tokens.length || !placements.length) return placements.map(() => null);

  const out: (PlacementLabel | null)[] = placements.map(() => null);

  // ── adjacent: nearest token within its own text-height radius ─────────────
  for (let p = 0; p < placements.length; p++) {
    const [px, py] = placements[p];
    let best: { tag: string; d: number } | null = null;
    for (const t of tokens) {
      const h = Math.max(t.y1 - t.y0, 8);
      const d = Math.hypot((t.x0 + t.x1) / 2 - px, (t.y0 + t.y1) / 2 - py);
      if (d <= LABEL_ADJACENT_K * h && (!best || d < best.d)) best = { tag: t.str.trim(), d };
    }
    if (best) out[p] = { label: best.tag, via: "adjacent", distance_px: Math.round(best.d) };
  }

  // ── leader: only on multi-pen sheets, only for still-unnamed placements ───
  if (lum && lum.length) {
    let darkLen = 0, totalLen = 0;
    const n = segs.length >> 2;
    for (let i = 0; i < n; i++) {
      const L = Math.hypot(segs[i * 4 + 2] - segs[i * 4], segs[i * 4 + 3] - segs[i * 4 + 1]);
      totalLen += L;
      if (lum[i] < LEADER_DARK_LUM) darkLen += L;
    }
    if (totalLen > 0 && darkLen / totalLen <= LEADER_MAX_DARK_SHARE) {
      const idx = buildDarkIndex(segs, lum);
      for (const t of tokens) {
        const cy = (t.y0 + t.y1) / 2;
        for (const start of [[t.x0 - 4, cy], [t.x1 + 4, cy]] as Point[]) {
          const reach = chase(idx, start);
          for (let p = 0; p < placements.length; p++) {
            if (out[p]) continue;
            const hit = reach.reduce((m, q) => Math.min(m, Math.hypot(q[0] - placements[p][0], q[1] - placements[p][1])), Infinity);
            if (hit <= LEADER_HIT_PX) out[p] = { label: t.str.trim(), via: "leader", distance_px: Math.round(hit) };
          }
        }
      }
    }
  }
  return out;
}
