// Symbol Sweep — deterministic repeated-symbol matching (pure, no DOM;
// node-testable, the sheets.ts/oneclick.ts precedent).
//
// Plan symbols — drains, thresholds, fixtures, transition markers — are
// repeated vector blocks: the same little cluster of segments stamped across
// the sheet. Given ONE example instance (a marquee around it), find every
// other placement of that same cluster from the linework alone. No ML, no
// vision, no guessing: a placement either reproduces the seed's segments
// within a pixel tolerance or it doesn't, and the score says exactly how much
// of the seed it reproduced.
//
// The pipeline:
//   1. FINGERPRINT — the segments fully inside the seed rect, expressed
//      relative to their length-weighted centroid. Fully-inside, not
//      intersecting: a marquee around a drain must not drag in the wall run
//      passing behind it.
//   2. CANDIDATES — constellation anchoring. Sheets run 100k+ segments, so a
//      naive O(n·m) scan of every position is out. Instead, up to
//      ANCHOR_COUNT seed segments of DISTINCT quantized length (rarest
//      sheet-wide first — a rare length prunes hardest) each vote: every
//      sheet segment of matching length proposes the centroid the symbol
//      would have if that segment were this anchor, per symmetry transform.
//      Several anchors, deliberately: a placement stays discoverable even
//      when one of its segments is drawn perturbed (the near-miss case whose
//      whole point is to be REPORTED).
//   3. SCORE — for each candidate placement, each transformed seed segment
//      looks up a sheet segment whose endpoints both sit within tolPx (either
//      orientation) via an endpoint grid. Score = length-weighted fraction of
//      seed segments matched — a long wall-side matching counts more than a
//      tick mark.
//   4. CLASSIFY — score ≥ scoreHigh is a match; [scoreLow, scoreHigh) is a
//      WITHHELD near-match with a reason (a question the caller can answer
//      with a look, never a silent commit or a silent drop); below is not the
//      symbol. The seed's own location is reported separately and never
//      returned as a match.
//
// Symmetry: symbols rotate and flip on plans, so placements are searched
// under the square's symmetry group — 0/90/180/270 rotation × optional
// mirror — with both options ON by default and independently switchable.
//
// Work is CAPPED and the cap is REPORTED: candidates.dropped > 0 means some
// placements were never scored, and the caller is told rather than handed a
// silently truncated count (the sheet_context decimation doctrine).

export type Point = [number, number];

export interface SweepOptions {
  /** Also try 90/180/270 rotated placements (default true — symbols rotate on plans). */
  rotations?: boolean;
  /** Also try mirrored placements (default true). */
  mirror?: boolean;
  /** Endpoint match tolerance, image px (default 2 — CAD jitter, not drift). */
  tolPx?: number;
  /** Commit bar: score ≥ this is a match (default 0.92). */
  scoreHigh?: number;
  /** Withhold floor: [scoreLow, scoreHigh) is a reported near-match (default 0.75). */
  scoreLow?: number;
  /** Cap on scored placements (default 20000). Overflow is counted, never silent. */
  maxCandidates?: number;
}

export interface SweepMatch {
  /** The placed symbol's centroid, image px. */
  at: Point;
  /** Length-weighted fraction of seed segments matched, 0..1. */
  score: number;
  /** Detected rotation, degrees CW in image space (y down): 0 | 90 | 180 | 270. */
  rotation: number;
  mirrored: boolean;
}

export interface SweepWithheld extends SweepMatch {
  reason: string;
}

export interface SweepResult {
  seed: {
    /** Segments the fingerprint was built from (fully inside the rect). */
    segments: number;
    /** The seed instance's own centroid, image px — reported, never a match. */
    center: Point;
    /** Total seed linework length, image px. */
    length_px: number;
  };
  matches: SweepMatch[];
  withheld: SweepWithheld[];
  /** Work accounting: dropped > 0 means the candidate cap bit and some
   * placements were never scored — the caller must be told. */
  candidates: { considered: number; dropped: number };
}

export const SWEEP_TOL_PX = 2;
export const SWEEP_SCORE_HIGH = 0.92;
export const SWEEP_SCORE_LOW = 0.75;
export const SWEEP_MAX_CANDIDATES = 20000;
/** Distinct-length anchors used for candidate generation. Three means a
 * placement survives discovery even with one perturbed segment — the
 * near-miss band exists to be populated, and a single anchor would hide
 * exactly the placements it is supposed to report. */
export const ANCHOR_COUNT = 3;
/** Seed segments shorter than this (px) are dropped from the fingerprint —
 * sub-pixel specks can't be matched at any honest tolerance. */
const MIN_SEG_LEN = 0.5;
/** A marquee holding more segments than this is not one symbol instance. */
const MAX_SEED_SEGS = 2000;

interface Xform { rotation: number; mirrored: boolean; m: [number, number, number, number]; }

/** The symmetry transforms to search, deterministic order: unmirrored
 * rotations first, 0° first — ties in dedupe resolve toward the plainest
 * reading. Matrices act on centroid-relative coords in image space (y down);
 * rotation is CW degrees in that frame. */
function transformsFor(rotations: boolean, mirror: boolean): Xform[] {
  const rots: [number, [number, number, number, number]][] = [
    [0, [1, 0, 0, 1]], [90, [0, -1, 1, 0]], [180, [-1, 0, 0, -1]], [270, [0, 1, -1, 0]],
  ];
  const use = rotations ? rots : rots.slice(0, 1);
  const out: Xform[] = use.map(([rotation, m]) => ({ rotation, mirrored: false, m }));
  if (mirror) {
    // reflect x, then rotate: m' = R · diag(-1, 1)
    for (const [rotation, m] of use) out.push({ rotation, mirrored: true, m: [-m[0], m[1], -m[2], m[3]] });
  }
  return out;
}

const apply = (m: [number, number, number, number], x: number, y: number): Point =>
  [m[0] * x + m[1] * y, m[2] * x + m[3] * y];

/** Endpoint spatial hash over the sheet's segments: cell → segment indices
 * with an endpoint in that cell. Cell size ≥ 2×tol so a tolerance ball around
 * any query point is covered by the 3×3 cell neighborhood. */
class EndpointGrid {
  private cells = new Map<number, number[]>();
  private cell: number;
  constructor(private segs: number[], tol: number) {
    this.cell = Math.max(2 * tol, 4);
    const n = segs.length >> 2;
    for (let i = 0; i < n; i++) {
      this.add(segs[i * 4], segs[i * 4 + 1], i);
      this.add(segs[i * 4 + 2], segs[i * 4 + 3], i);
    }
  }
  private key(cx: number, cy: number): number { return cx * 73856093 ^ cy * 19349663; }
  private add(x: number, y: number, i: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const a = this.cells.get(k);
    if (a) { if (a[a.length - 1] !== i) a.push(i); } else this.cells.set(k, [i]);
  }
  /** Indices of segments with an endpoint within one cell of (x, y). */
  near(x: number, y: number, out: number[]): number[] {
    out.length = 0;
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = this.cells.get(this.key(cx + dx, cy + dy));
      if (a) for (const i of a) out.push(i);
    }
    return out;
  }
}

const segLen = (segs: number[], i: number): number =>
  Math.hypot(segs[i * 4 + 2] - segs[i * 4], segs[i * 4 + 3] - segs[i * 4 + 1]);

export function sweepSymbols(segs: number[], seedRect: [Point, Point], opts: SweepOptions = {}): SweepResult {
  const tol = opts.tolPx ?? SWEEP_TOL_PX;
  const scoreHigh = opts.scoreHigh ?? SWEEP_SCORE_HIGH;
  const scoreLow = opts.scoreLow ?? SWEEP_SCORE_LOW;
  const maxCandidates = opts.maxCandidates ?? SWEEP_MAX_CANDIDATES;
  const xforms = transformsFor(opts.rotations ?? true, opts.mirror ?? true);
  const n = segs.length >> 2;

  const rx0 = Math.min(seedRect[0][0], seedRect[1][0]), rx1 = Math.max(seedRect[0][0], seedRect[1][0]);
  const ry0 = Math.min(seedRect[0][1], seedRect[1][1]), ry1 = Math.max(seedRect[0][1], seedRect[1][1]);

  // ── 1. fingerprint ─────────────────────────────────────────────────────────
  const inside = (x: number, y: number): boolean => x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1;
  const seedIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inside(segs[i * 4], segs[i * 4 + 1]) && inside(segs[i * 4 + 2], segs[i * 4 + 3]) && segLen(segs, i) >= MIN_SEG_LEN) {
      seedIdx.push(i);
    }
  }
  if (!seedIdx.length) {
    throw new Error("No vector segments sit fully inside the seed rect — marquee tightly around one whole symbol instance (segments crossing the rect edge don't count as the symbol).");
  }
  if (seedIdx.length > MAX_SEED_SEGS) {
    throw new Error(`The seed rect holds ${seedIdx.length} segments — that is a region, not one symbol instance. Marquee a single symbol.`);
  }

  let totalLen = 0, cxw = 0, cyw = 0;
  for (const i of seedIdx) {
    const L = segLen(segs, i);
    totalLen += L;
    cxw += ((segs[i * 4] + segs[i * 4 + 2]) / 2) * L;
    cyw += ((segs[i * 4 + 1] + segs[i * 4 + 3]) / 2) * L;
  }
  const seedCx = cxw / totalLen, seedCy = cyw / totalLen;
  // centroid-relative seed segments: [ax, ay, bx, by, len] per entry
  const rel = seedIdx.map((i) => [
    segs[i * 4] - seedCx, segs[i * 4 + 1] - seedCy,
    segs[i * 4 + 2] - seedCx, segs[i * 4 + 3] - seedCy,
    segLen(segs, i),
  ]);
  // the symbol's own footprint (tight bbox over the seed segments) — the
  // shadow-suppression radius below is half its diagonal
  let sbx0 = Infinity, sby0 = Infinity, sbx1 = -Infinity, sby1 = -Infinity;
  for (const i of seedIdx) {
    sbx0 = Math.min(sbx0, segs[i * 4], segs[i * 4 + 2]); sby0 = Math.min(sby0, segs[i * 4 + 1], segs[i * 4 + 3]);
    sbx1 = Math.max(sbx1, segs[i * 4], segs[i * 4 + 2]); sby1 = Math.max(sby1, segs[i * 4 + 1], segs[i * 4 + 3]);
  }

  // ── 2. candidates ──────────────────────────────────────────────────────────
  // Sheet-wide length histogram (bucket = round(len)) for anchor rarity and
  // the per-anchor candidate walk. Deterministic: plain arrays, sorted scans.
  const lenBucket = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const b = Math.round(segLen(segs, i));
    const a = lenBucket.get(b);
    if (a) a.push(i); else lenBucket.set(b, [i]);
  }
  const bucketBand = (L: number): number[] => {
    // every sheet segment with |len − L| ≤ 2·tol (both endpoints off by tol
    // can stretch/shrink the drawn length by up to 2·tol)
    const out: number[] = [];
    for (let b = Math.floor(L - 2 * tol); b <= Math.ceil(L + 2 * tol); b++) {
      const a = lenBucket.get(b);
      if (a) for (const i of a) if (Math.abs(segLen(segs, i) - L) <= 2 * tol) out.push(i);
    }
    return out;
  };

  // anchor selection: rarest DISTINCT quantized lengths first (rarity prunes
  // hardest), longest first on ties so structure beats tick marks
  const byLenQ = new Map<number, { relIdx: number; len: number; rarity: number }>();
  for (let k = 0; k < rel.length; k++) {
    const L = rel[k][4];
    const q = Math.round(L);
    if (!byLenQ.has(q)) byLenQ.set(q, { relIdx: k, len: L, rarity: bucketBand(L).length });
  }
  const anchors = [...byLenQ.values()]
    .sort((a, b) => a.rarity - b.rarity || b.len - a.len || a.relIdx - b.relIdx)
    .slice(0, ANCHOR_COUNT);

  // Each (anchor, transform, matching sheet segment, endpoint pairing)
  // proposes ONE candidate centroid. Both endpoint mappings must agree on the
  // centroid within tolerance, or the sheet segment merely shares a length.
  type Cand = { tx: number; ty: number; xf: number };
  const proposals: Cand[] = [];
  const seen = new Set<string>();
  const quant = Math.max(tol, 1);
  for (let xi = 0; xi < xforms.length; xi++) {
    const { m } = xforms[xi];
    for (const anc of anchors) {
      const r = rel[anc.relIdx];
      const A = apply(m, r[0], r[1]);
      const B = apply(m, r[2], r[3]);
      for (const j of bucketBand(anc.len)) {
        const px = segs[j * 4], py = segs[j * 4 + 1], qx = segs[j * 4 + 2], qy = segs[j * 4 + 3];
        // pairing 1: (p, q) = (A, B); pairing 2: reversed
        for (const [ax, ay, bx, by] of [[A[0], A[1], B[0], B[1]], [B[0], B[1], A[0], A[1]]] as const) {
          const c1x = px - ax, c1y = py - ay;
          const c2x = qx - bx, c2y = qy - by;
          if (Math.abs(c1x - c2x) > 2 * tol || Math.abs(c1y - c2y) > 2 * tol) continue;
          const tx = (c1x + c2x) / 2, ty = (c1y + c2y) / 2;
          const key = `${xi}:${Math.round(tx / quant)}:${Math.round(ty / quant)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          proposals.push({ tx, ty, xf: xi });
        }
      }
    }
  }

  // Deterministic scoring order (reading order, then transform preference),
  // so the cap — when it bites — always drops the same placements and the
  // dropped count means the same thing run to run.
  proposals.sort((a, b) => a.ty - b.ty || a.tx - b.tx || a.xf - b.xf);
  const considered = Math.min(proposals.length, maxCandidates);
  const dropped = proposals.length - considered;

  // ── 3. score ───────────────────────────────────────────────────────────────
  const grid = new EndpointGrid(segs, tol);
  const scratch: number[] = [];
  const tol2 = tol * tol;
  const near = (x1: number, y1: number, x2: number, y2: number): boolean =>
    (x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2) <= tol2;
  const scoreAt = (m: [number, number, number, number], tx: number, ty: number): number => {
    let matched = 0;
    for (const r of rel) {
      const a = apply(m, r[0], r[1]);
      const b = apply(m, r[2], r[3]);
      const ax = a[0] + tx, ay = a[1] + ty, bx = b[0] + tx, by = b[1] + ty;
      let hit = false;
      for (const j of grid.near(ax, ay, scratch)) {
        const px = segs[j * 4], py = segs[j * 4 + 1], qx = segs[j * 4 + 2], qy = segs[j * 4 + 3];
        if ((near(px, py, ax, ay) && near(qx, qy, bx, by)) || (near(qx, qy, ax, ay) && near(px, py, bx, by))) { hit = true; break; }
      }
      if (hit) matched += r[4];
    }
    return matched / totalLen;
  };

  // ── 4. classify + dedupe ───────────────────────────────────────────────────
  // One physical placement can be proposed by several anchors and — for a
  // symmetric symbol — several transforms; centers agree within ~tol, so a
  // small merge radius collapses them to the best score (earliest transform
  // on ties: the plainest reading wins deterministically).
  type Scored = SweepMatch & { xf: number };
  const scored: Scored[] = [];
  for (let k = 0; k < considered; k++) {
    const c = proposals[k];
    const score = scoreAt(xforms[c.xf].m, c.tx, c.ty);
    if (score < scoreLow) continue;
    scored.push({ at: [c.tx, c.ty], score, rotation: xforms[c.xf].rotation, mirrored: xforms[c.xf].mirrored, xf: c.xf });
  }
  const mergeR = Math.max(2 * tol, 4);
  const kept: Scored[] = [];
  for (const s of scored) {
    const twin = kept.find((k) => Math.hypot(k.at[0] - s.at[0], k.at[1] - s.at[1]) <= mergeR);
    if (!twin) { kept.push(s); continue; }
    if (s.score > twin.score || (s.score === twin.score && s.xf < twin.xf)) {
      twin.at = s.at; twin.score = s.score; twin.rotation = s.rotation; twin.mirrored = s.mirrored; twin.xf = s.xf;
    }
  }

  // Shadow suppression. A partially-symmetric symbol reads ALMOST as itself
  // under the wrong transform — square + diagonal without the stub — at a
  // center offset by up to the centroid's eccentricity. Those readings are
  // not questions: the instance is already counted (or is the seed itself).
  // Two REAL instances can never sit within half a symbol diagonal of each
  // other without physically overlapping, so anything that close to the seed
  // or to an accepted match is the same ink read sideways, and listing it as
  // withheld would bury the real near-misses in symmetry noise.
  const suppressR = Math.max(mergeR, Math.hypot(sbx1 - sbx0, sby1 - sby0) / 2);
  const away = kept.filter((s) => Math.hypot(s.at[0] - seedCx, s.at[1] - seedCy) > suppressR);

  const matches: SweepMatch[] = [];
  const withheld: SweepWithheld[] = [];
  const pct = (v: number): number => Math.round(v * 1000) / 1000;
  const row = (s: Scored): SweepMatch => ({
    at: [Math.round(s.at[0] * 10) / 10, Math.round(s.at[1] * 10) / 10] as Point,
    score: pct(s.score),
    rotation: s.rotation,
    mirrored: s.mirrored,
  });
  for (const s of away) if (s.score >= scoreHigh) matches.push(row(s));
  for (const s of away) {
    if (s.score >= scoreHigh) continue;
    if (matches.some((m) => Math.hypot(m.at[0] - s.at[0], m.at[1] - s.at[1]) <= suppressR)) continue;
    withheld.push({ ...row(s), reason: `matched ${Math.round(s.score * 100)}% of the seed's linework (commit bar ${Math.round(scoreHigh * 100)}%) — likely a variant or an overlapped instance; look before counting it` });
  }
  const order = (a: SweepMatch, b: SweepMatch): number =>
    a.at[1] - b.at[1] || a.at[0] - b.at[0] || a.rotation - b.rotation || Number(a.mirrored) - Number(b.mirrored);
  matches.sort(order);
  withheld.sort(order);

  return {
    seed: {
      segments: seedIdx.length,
      center: [Math.round(seedCx * 10) / 10, Math.round(seedCy * 10) / 10],
      length_px: Math.round(totalLen * 10) / 10,
    },
    matches,
    withheld,
    candidates: { considered, dropped },
  };
}
