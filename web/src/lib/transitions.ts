// Where two finishes meet — the shared-boundary geometry behind derive_transitions.
//
// The most mechanical derivation left on a Division 9 takeoff is the transition:
// carpet meets tile, and somebody draws a line there by hand, every time, on
// every job. It is derivable — but not the way it first looks.
//
// THE CATCH, stated up front: flood-traced rooms DO NOT SHARE EDGES. A trace
// fills to the wall linework, so two rooms on opposite sides of a partition are
// separated by the wall's thickness — four to eight inches of nothing. Testing
// for a shared edge finds exactly zero transitions on a real planset. What is
// actually there is PROXIMITY, and proximity comes in two flavours that mean
// completely different things to an estimator:
//
//   butt joint      the two rings run together inside ONE open space — a lobby
//                   that changes from carpet to tile with no wall between them.
//                   The transition IS that run. Derivable, and committed.
//
//   wall-separated  the two rings run parallel across a partition. The rooms
//                   are adjacent; the transition is NOT the whole shared wall.
//                   It is a threshold, in the doorway, and NOTHING in the trace
//                   record says where the doorway is — the flood engine seals
//                   openings and reports only how MUCH boundary it synthesised
//                   (sealedPx), never where. Committing 34 LF of threshold
//                   because two rooms share 34 LF of wall would be a wrong bid
//                   with a machine's confidence behind it.
//
// So this module measures both and refuses to conflate them. The wall-separated
// runs come back as questions — with their length, their gap, and a point to
// look at — for the estimator to answer with the drawing in front of them. The
// same doctrine symbol_sweep's 0.75–0.92 band follows: a near-match is a
// question you answer by LOOKING, never a silent commit and never a silent drop.
//
// Pure geometry, no engine imports beyond distToSeg — so it tests directly, and
// both callers mount the same computation: the MCP verb derive_transitions
// (#202, agent-side) and the canvas's ⟂ Transitions button (estimator-side).
// (geometry.js's distToSeg returns distance only; a run needs the closest POINT
// too — see the perpendicularity rule below — so the projection is done here.)

export type Pt = [number, number];

export type RunKind = "butt" | "wall";

export interface SharedRun {
  kind: RunKind;
  /** The run traced along ring A's boundary, image px. */
  path: Pt[];
  /** Run length along A, image px. */
  length_px: number;
  /** Median A→B distance across the run, image px — what decides the kind. */
  gap_px: number;
  /** Midpoint of the run (image px) — where to point view_sheet. */
  at: Pt;
}

export interface SharedRunOpts {
  /** Sampling step along A's boundary, image px. */
  step_px: number;
  /** At or under this A→B distance the rings are touching: a butt joint. */
  touch_px: number;
  /** Beyond this they are not adjacent at all. */
  max_gap_px: number;
  /** Runs shorter than this are corner artifacts, not transitions. */
  min_len_px: number;
}

// Below this the two boundaries are the same line, not two lines close together
// (image px — no drafted geometry lands here without being coincident).
const COINCIDENT_PX = 1e-9;

/** Closed ring → its segments, wrapping the last vertex back to the first. */
function segments(ring: Pt[]): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (let i = 0; i < ring.length; i++) out.push([ring[i], ring[(i + 1) % ring.length]]);
  return out;
}

/** Closest point on one segment to p, and the distance to it. */
function nearestOnSeg(p: Pt, a: Pt, b: Pt): { d: number; at: Pt } {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2)) : 0;
  const at: Pt = [a[0] + vx * t, a[1] + vy * t];
  return { d: Math.hypot(p[0] - at[0], p[1] - at[1]), at };
}

/** Closest point on a ring's BOUNDARY (not its interior), and the distance. */
export function nearestOnRing(p: Pt, ring: Pt[]): { d: number; at: Pt } {
  let best = { d: Infinity, at: p };
  for (const [a, b] of segments(ring)) {
    const hit = nearestOnSeg(p, a, b);
    if (hit.d < best.d) best = hit;
  }
  return best;
}

/** Shortest distance from a point to a ring's boundary (not its interior). */
export function distToRing(p: Pt, ring: Pt[]): number {
  return nearestOnRing(p, ring).d;
}

/** Walk a closed ring at a fixed step, returning the sample points in order. */
export function sampleRing(ring: Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (const [a, b] of segments(ring)) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(len > 0)) continue;
    // every segment contributes its own start, so a corner is always sampled
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return Infinity;
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Every run of ring A's boundary that runs alongside ring B.
 *
 * Sampling walks A once and measures each sample's distance to B's boundary;
 * contiguous samples inside max_gap_px become a run, and the run's MEDIAN gap
 * decides its kind. Median rather than mean on purpose: one sample dipping to
 * zero where two walls corner into each other should not turn a wall-separated
 * run into a butt joint, and a mean lets it.
 *
 * A's boundary is closed, so a run crossing the ring's start vertex would
 * otherwise be reported as two — they are stitched back together at the end,
 * which is the difference between "one 12 LF run" and "a 3 LF and a 9 LF run"
 * on the same piece of floor.
 */
export function sharedRuns(ringA: Pt[], ringB: Pt[], opts: SharedRunOpts): SharedRun[] {
  if (ringA.length < 3 || ringB.length < 3) return [];
  const { step_px, touch_px, max_gap_px, min_len_px } = opts;
  const samples = sampleRing(ringA, step_px);
  if (samples.length < 2) return [];
  const near = samples.map((p) => nearestOnRing(p, ringB));
  const dists = near.map((h) => h.d);

  // ── the perpendicularity rule ──────────────────────────────────────────────
  // Distance alone says "close to B", which is not the same as "running
  // ALONGSIDE B", and the difference is every corner on the plan. Walk A's top
  // wall toward the corner where B begins and the last foot of it is within a
  // wall's thickness of B's corner VERTEX — near, but pointing straight AT it.
  // Left in, that tail lengthens every run by the gap tolerance at both ends
  // (a 4 ft joint measured as 6 ft) and invents 2 ft runs where two rooms
  // merely clip corners diagonally.
  //
  // Two boundaries run together when the direction from A to B is PERPENDICULAR
  // to the way A is heading. Pointing along A's own direction means the nearest
  // thing on B is ahead, not beside — a corner, not a joint. Half a right angle
  // is the cut: |cos| <= 0.5.
  const alongside = samples.map((p, i) => {
    if (dists[i] > max_gap_px) return false;
    const prev = samples[(i - 1 + samples.length) % samples.length];
    const next = samples[(i + 1) % samples.length];
    const tx = next[0] - prev[0], ty = next[1] - prev[1];
    const tl = Math.hypot(tx, ty);
    const dx = near[i].at[0] - p[0], dy = near[i].at[1] - p[1];
    const dl = Math.hypot(dx, dy);
    if (tl === 0) return false;
    // COINCIDENT, not "exactly zero". Two rings that share an edge project onto
    // each other at a distance of ~1e-16 rather than 0, and at that magnitude
    // the direction vector is pure rounding noise — its angle to the tangent is
    // effectively random, so an exact `=== 0` test rejects a scattering of
    // samples along a perfectly good joint and shatters one long run into
    // fragments. (Found by driving a real sheet: a 13.2 LF butt joint came back
    // as 1.25 + 1.99 + 7.47. The unit fixtures missed it because their
    // coordinates happened to project exactly.) There is nothing to reject when
    // the boundaries touch — this rule exists to catch a nearest point AHEAD of
    // the walk, and a coincident point is not ahead of anything.
    if (dl < COINCIDENT_PX) return true;
    return Math.abs((tx * dx + ty * dy) / (tl * dl)) <= 0.5;
  });

  type Raw = { from: number; to: number };   // inclusive sample indices
  const raw: Raw[] = [];
  let start = -1;
  for (let i = 0; i < samples.length; i++) {
    if (alongside[i] && start < 0) start = i;
    if (!alongside[i] && start >= 0) { raw.push({ from: start, to: i - 1 }); start = -1; }
  }
  if (start >= 0) raw.push({ from: start, to: samples.length - 1 });

  // stitch a run that wraps the ring's start vertex back into one
  if (raw.length > 1) {
    const first = raw[0], last = raw[raw.length - 1];
    if (first.from === 0 && last.to === samples.length - 1) {
      raw.pop();
      raw[0] = { from: last.from, to: first.to + samples.length };   // indices modulo samples.length
    }
  }

  const runs: SharedRun[] = [];
  for (const r of raw) {
    const idx: number[] = [];
    for (let i = r.from; i <= r.to; i++) idx.push(i % samples.length);
    const path = idx.map((i) => samples[i]);
    let length_px = 0;
    for (let i = 1; i < path.length; i++) {
      length_px += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    }
    if (length_px < min_len_px) continue;
    const gap_px = median(idx.map((i) => dists[i]));
    const mid = path[path.length >> 1];
    runs.push({
      kind: gap_px <= touch_px ? "butt" : "wall",
      path, length_px, gap_px, at: [mid[0], mid[1]],
    });
  }
  return runs;
}

// ── the shape-level derivation ───────────────────────────────────────────────
// sharedRuns above is pure geometry on two rings in image px. Everything below
// is the layer between it and a takeoff: which committed rooms to compare,
// against which sheet's scale, and what the answer becomes — a linear shape you
// can accept, or a question you cannot.
//
// It is deliberately a SEPARATE, pure entry point rather than a canvas method:
// this is the ONE copy of the sequencing — the canvas drives it for the
// Transitions button, and mcp/src/session.ts deriveTransitions drives it around
// its own store (refusals, journal commit, wire rows stay session-side).

/** A committed floor shape, as little of one as the derivation needs. */
export interface TransitionSourceShape {
  id: string;
  sheet_id: string;
  verts_norm: [number, number][];
}

/** A sheet's logical image frame — the same baseline verts_norm normalizes
 *  against — plus its scale. `upp` is FEET per image px; a sheet without one
 *  cannot take part (a transition is a real length, so an unscaled sheet is a
 *  refusal, never a guess). */
export interface SheetFrame {
  widthPx: number;
  heightPx: number;
  upp: number;
}

/** One derived run: a linear shape's worth of geometry plus the provenance the
 *  origin.derived record carries (both parents, both tags, the measured gap). */
export interface DerivedTransition {
  sheet_id: string;
  between_shape_ids: [string, string];
  between: [string, string];
  length_lf: number;
  gap_in: number;
  /** Run midpoint in image px — where to point the view. */
  at: [number, number];
  /** The run, normalized to its sheet frame: ready to become verts_norm. */
  verts_norm: [number, number][];
}

/** The same measurement, refused: two rooms across a partition. Adjacency is
 *  real, the number is not — the transition there is a threshold in a doorway
 *  and nothing in the trace record says where the doorway is. Reported with its
 *  length, its gap and a point to look at; never committed. */
export interface WithheldTransition extends DerivedTransition {
  reason: "wall_separated";
}

export interface DeriveTransitionsOpts {
  /** Beyond this the two rooms are not adjacent at all (inches). */
  max_gap_in?: number;
  /** Runs shorter than this are corner artifacts, not transitions (inches). */
  min_run_in?: number;
}

/** Defaults shared with the MCP verb — a wall is under a foot thick, and a
 *  transition under a foot long is a corner clip. */
export const TRANSITION_DEFAULTS = { max_gap_in: 12, min_run_in: 12 };

const round2 = (n: number): number => +n.toFixed(2);
const round1 = (n: number): number => +n.toFixed(1);

/**
 * Drop the interpolated points sharing a straight line with their neighbours.
 *
 * sharedRuns walks A's boundary every quarter-foot, so a straight thirty-foot
 * butt joint comes back as a hundred and twenty vertices — correct, and a
 * miserable shape to own: every one of them is a drag handle on a line with two
 * real ends. The samples along one segment are exact linear interpolations, so
 * their cross product against the chord is float noise (~1e-10 px on a sheet
 * measured in thousands); a 1e-6 px cut removes them and cannot reach a corner
 * that any drafted geometry actually turns. Length is preserved — which matters,
 * because the committed LF is measured on the FULL path before this runs.
 */
export function dropCollinear(path: Pt[], tol = 1e-6): Pt[] {
  if (path.length < 3) return path.map((p) => [p[0], p[1]] as Pt);
  const out: Pt[] = [[path[0][0], path[0][1]]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1], b = path[i], c = path[i + 1];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const acx = c[0] - a[0], acy = c[1] - a[1];
    const len = Math.hypot(acx, acy);
    // distance from b to the a→c chord; degenerate chord keeps the vertex
    const off = len > 0 ? Math.abs(abx * acy - aby * acx) / len : Infinity;
    if (off > tol) out.push([b[0], b[1]]);
  }
  out.push([path[path.length - 1][0], path[path.length - 1][1]]);
  return out;
}

/**
 * Every transition between two finishes' committed rooms, split into the runs
 * that commit and the ones that are questions.
 *
 * Rooms are paired only WITHIN a sheet (a room on A-101 does not butt a room on
 * A-102), and a sheet takes part only if `sheets` carries its frame and scale —
 * scoping is the caller's, so the canvas can derive across exactly the sheets
 * the estimator has open and can review.
 *
 * The kind decision is sharedRuns': median gap under an inch is one open space
 * (butt) and becomes a shape; anything wider is a partition (wall) and becomes
 * a reported question. Nothing here decides that twice.
 */
export function deriveTransitionRuns(
  a: { tag: string; shapes: TransitionSourceShape[] },
  b: { tag: string; shapes: TransitionSourceShape[] },
  sheets: Map<string, SheetFrame>,
  opts: DeriveTransitionsOpts = {},
): { runs: DerivedTransition[]; withheld: WithheldTransition[] } {
  const maxGapIn = opts.max_gap_in ?? TRANSITION_DEFAULTS.max_gap_in;
  const minRunIn = opts.min_run_in ?? TRANSITION_DEFAULTS.min_run_in;
  const runs: DerivedTransition[] = [], withheld: WithheldTransition[] = [];
  if (!(maxGapIn > 0) || !(minRunIn > 0)) return { runs, withheld };

  for (const [key, frame] of sheets) {
    if (!(frame.upp > 0) || !(frame.widthPx > 0) || !(frame.heightPx > 0)) continue;
    const onA = a.shapes.filter((s) => s.sheet_id === key);
    const onB = b.shapes.filter((s) => s.sheet_id === key);
    if (!onA.length || !onB.length) continue;
    const pxPerFt = 1 / frame.upp;
    const toPx = (s: TransitionSourceShape): Pt[] =>
      s.verts_norm.map(([x, y]) => [x * frame.widthPx, y * frame.heightPx] as Pt);
    const runOpts: SharedRunOpts = {
      step_px: Math.max(1, pxPerFt * 0.25),   // a quarter-foot walk — finer than any transition matters
      touch_px: pxPerFt * (1 / 12),           // within an inch: one open space, not two rooms
      max_gap_px: pxPerFt * (maxGapIn / 12),
      min_len_px: pxPerFt * (minRunIn / 12),
    };
    for (const ra of onA) {
      for (const rb of onB) {
        if (ra.id === rb.id) continue;        // the same shape on both sides is not a transition
        for (const r of sharedRuns(toPx(ra), toPx(rb), runOpts)) {
          const row: DerivedTransition = {
            sheet_id: key,
            between_shape_ids: [ra.id, rb.id],
            between: [a.tag, b.tag],
            length_lf: round2(r.length_px * frame.upp),
            gap_in: round1(r.gap_px * frame.upp * 12),
            at: [Math.round(r.at[0]), Math.round(r.at[1])],
            verts_norm: dropCollinear(r.path).map(([x, y]) => [x / frame.widthPx, y / frame.heightPx] as [number, number]),
          };
          if (r.kind === "wall") withheld.push({ ...row, reason: "wall_separated" });
          else runs.push(row);
        }
      }
    }
  }
  return { runs, withheld };
}

/**
 * The all-or-nothing gate, ahead of any commit — the MCP verb's refusals, said
 * to an estimator instead of an agent. Returns the reason to refuse, or null.
 *
 * The one that is not obvious: a transition must land on its OWN tag. Committing
 * carpet-meets-tile onto the carpet condition adds linear feet to the finish it
 * separates, and that error is invisible in the totals — it just makes carpet
 * read long.
 */
export function transitionRefusal(gate: {
  activeTag: string;
  a: { tag: string; shapes: TransitionSourceShape[] };
  b: { tag: string; shapes: TransitionSourceShape[] };
  sheets: Map<string, SheetFrame>;
  unscaled?: string[];
}): string | null {
  const { activeTag, a, b, sheets, unscaled = [] } = gate;
  if (!a.tag || !b.tag) return "Pick the two finishes that meet.";
  if (a.tag === b.tag) return "Pick two DIFFERENT finishes — a tag does not transition to itself.";
  if (activeTag === a.tag || activeTag === b.tag) {
    return `The transition has to land on its own condition (e.g. T-1) — committing onto ${activeTag} would add its LF to one of the finishes it separates.`;
  }
  for (const side of [a, b]) {
    if (!side.shapes.length) return `${side.tag} has no rooms on the open sheets — measure them first (One-Click or Area).`;
  }
  if (unscaled.length) {
    return `${unscaled.join(", ")} ${unscaled.length === 1 ? "has" : "have"} no scale — a transition is a real length, so calibrate before deriving.`;
  }
  const shared = [...sheets.keys()].filter((k) => a.shapes.some((s) => s.sheet_id === k) && b.shapes.some((s) => s.sheet_id === k));
  if (!shared.length) return `${a.tag} and ${b.tag} have no rooms on the same open sheet — nothing can meet.`;
  return null;
}
