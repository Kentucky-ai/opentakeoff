// Match-line stitching (#161, phase 1) — the pure math and hydrate gates.
//
// A STITCH is a persisted composite working surface: 2..MAX_GROUP member
// sheets placed at offsets (image px in the baseline RENDER_SCALE frame,
// the same frame shapes and scales live in) and opened on the canvas as ONE
// panel. Shapes bind to the stitch key (`sheet_id: "stitch:<uid>"`) exactly
// like any sheet's — the sheet_id-per-shape model is preserved (the issue's
// "composite wins" design call), so totals, report, undo, and persistence
// all work unchanged. The members are a render-time concern only: the input
// model (panelAt / stage space) never sees them.
//
// Everything here is pdfjs-free and node-tested (sheetKey.ts precedent).

import { parseSheetKey } from "./sheetKey";
import type { SubPath } from "./oneclick";

export const STITCH_PREFIX = "stitch:";
export function isStitchKey(k: unknown): k is string {
  return typeof k === "string" && k.startsWith(STITCH_PREFIX);
}
// ids are minted client-side; a colon never appears in a real dropped-file
// sheet key's file name on any platform we ingest from, so the prefix can't
// collide with a sheet.
export function mintStitchId(): string {
  const uid = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  return STITCH_PREFIX + uid;
}

export interface StitchMember { key: string; dx: number; dy: number }
export interface Stitch { id: string; name: string; members: StitchMember[]; aligned?: boolean; seam_check?: SeamCheckResult; created_at?: string }
export interface Dim { w: number; h: number }
export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Hydrate gate for the additive `stitches` payload field (the approvals /
 * roll_setup precedent): old projects lack the field and load as [] — one
 * corrupt entry is dropped, never wedges the canvas. Rules: well-formed id,
 * 2..maxMembers members, member keys are non-stitch (no nesting) and unique
 * within the stitch, finite offsets, unique stitch ids. Offsets normalize so
 * the min corner is (0,0) — extent math and verts_norm depend on that. */
export function sanitizeStitches(raw: unknown, maxMembers: number): Stitch[] {
  if (!Array.isArray(raw)) return [];
  const out: Stitch[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const s = e as Record<string, unknown>;
    if (!isStitchKey(s.id) || seen.has(s.id)) continue;
    if (!Array.isArray(s.members) || s.members.length < 2 || s.members.length > maxMembers) continue;
    const members: StitchMember[] = [];
    const memberKeys = new Set<string>();
    let ok = true;
    for (const m of s.members) {
      const mm = m as Record<string, unknown> | null;
      const key = mm && typeof mm.key === "string" && mm.key && !isStitchKey(mm.key) ? mm.key : null;
      if (!key || memberKeys.has(key) || !Number.isFinite(mm!.dx) || !Number.isFinite(mm!.dy)) { ok = false; break; }
      memberKeys.add(key);
      members.push({ key, dx: mm!.dx as number, dy: mm!.dy as number });
    }
    if (!ok) continue;
    seen.add(s.id);
    out.push({
      id: s.id,
      name: typeof s.name === "string" && s.name.trim() ? s.name : "Stitched sheets",
      members: normalizeMembers(members),
      ...(typeof s.aligned === "boolean" ? { aligned: s.aligned } : {}),
      ...(s.seam_check && typeof s.seam_check === "object" ? { seam_check: s.seam_check as SeamCheckResult } : {}),
      ...(typeof s.created_at === "string" ? { created_at: s.created_at } : {}),
    });
  }
  return out;
}

/** Shift offsets so the minimum corner sits at (0,0) — the stitch's own
 * origin. Keeps verts_norm/extent stable regardless of how an alignment
 * moved members around. */
export function normalizeMembers(members: StitchMember[]): StitchMember[] {
  if (!members.length) return members;
  const mx = Math.min(...members.map((m) => m.dx));
  const my = Math.min(...members.map((m) => m.dy));
  if (mx === 0 && my === 0) return members;
  return members.map((m) => ({ ...m, dx: m.dx - mx, dy: m.dy - my }));
}

/** True when two stitch definitions describe the exact same member placement
 * (within 1e-3 px after normalization). Used to reject conflicting imports. */
export function stitchPlacementsMatch(a: Pick<Stitch, "members">, b: Pick<Stitch, "members">): boolean {
  const ma = normalizeMembers(a.members);
  const mb = normalizeMembers(b.members);
  if (ma.length !== mb.length) return false;
  const byKey = new Map(ma.map((m) => [m.key, m]));
  if (byKey.size !== mb.length) return false;
  for (const m of mb) {
    const other = byKey.get(m.key);
    if (!other) return false;
    if (Math.abs(other.dx - m.dx) > 1e-3 || Math.abs(other.dy - m.dy) > 1e-3) return false;
  }
  return true;
}

/** Initial layout for a fresh stitch: members flush left-to-right (no gap —
 * this is one surface, not a side-by-side group), tops aligned. */
export function autoButt(keys: string[], dims: Record<string, Dim>): StitchMember[] {
  let x = 0;
  return keys.map((key) => {
    const m = { key, dx: x, dy: 0 };
    x += dims[key]?.w || 0;
    return m;
  });
}

/** Overall extent of the stitch — the composite panel's logical image dims. */
export function stitchExtent(members: StitchMember[], dims: Record<string, Dim>): Dim {
  let w = 0, h = 0;
  for (const m of members) {
    const d = dims[m.key];
    if (!d?.w) continue;
    w = Math.max(w, m.dx + d.w);
    h = Math.max(h, m.dy + d.h);
  }
  return { w: Math.ceil(w), h: Math.ceil(h) };
}

/** Member bounding boxes in stitch-local px, parallel to `members`. */
export function memberBoxes(members: StitchMember[], dims: Record<string, Dim>): Box[] {
  return members.map((m) => {
    const d = dims[m.key] || { w: 0, h: 0 };
    return { x0: m.dx, y0: m.dy, x1: m.dx + d.w, y1: m.dy + d.h };
  });
}

/** Index of the member under a stitch-local point — TOPMOST (last drawn)
 * when boxes overlap, NEAREST when the point is outside every box (the
 * panelAt convention: a click never routes nowhere). -1 only when empty. */
export function memberAtPoint(boxes: Box[], x: number, y: number): number {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) return i;
  }
  let best = -1, bd = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const ddx = x < b.x0 ? b.x0 - x : x > b.x1 ? x - b.x1 : 0;
    const ddy = y < b.y0 ? b.y0 - y : y > b.y1 ? y - b.y1 : 0;
    const d = ddx * ddx + ddy * ddy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** The two-click match-line aligner (the Calibrate idiom): `anchor` is the
 * first-clicked point, `moving` the second — both stitch-local px. The member
 * under `moving` translates so the two points coincide. Same member under
 * both clicks is an error (nothing to join). Returns re-normalized members. */
export function alignMembers(
  members: StitchMember[], dims: Record<string, Dim>,
  anchor: [number, number], moving: [number, number],
): { members: StitchMember[]; movedKey: string } | { error: string } {
  const boxes = memberBoxes(members, dims);
  const ai = memberAtPoint(boxes, anchor[0], anchor[1]);
  const bi = memberAtPoint(boxes, moving[0], moving[1]);
  if (ai < 0 || bi < 0) return { error: "No sheets to align." };
  if (ai === bi) return { error: "Both clicks landed on the same sheet — click the matching point on the other sheet." };
  const dx = anchor[0] - moving[0], dy = anchor[1] - moving[1];
  const next = members.map((m, i) => (i === bi ? { ...m, dx: m.dx + dx, dy: m.dy + dy } : m));
  return { members: normalizeMembers(next), movedKey: members[bi].key };
}

/** Per-member VISIBLE boxes (stitch-local): where members overlap along the
 * dominant chain axis, the overlap splits at its midline — each member shows
 * its own half, so the neighbor's margin/border strip near the match line is
 * covered instead of overpainting the plan. Purely visual (canvas clipping);
 * quantities never read pixels. Parallel to `members`. */
export function seamClips(members: StitchMember[], dims: Record<string, Dim>): Box[] {
  const boxes = memberBoxes(members, dims);
  const clips = boxes.map((b) => ({ ...b }));
  if (boxes.length < 2) return clips;
  // dominant axis: the one with more center spread
  const cxs = boxes.map((b) => (b.x0 + b.x1) / 2), cys = boxes.map((b) => (b.y0 + b.y1) / 2);
  const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
  const horizontal = spread(cxs) >= spread(cys);
  const order = boxes.map((_, i) => i).sort((a, b) => (horizontal ? boxes[a].x0 - boxes[b].x0 : boxes[a].y0 - boxes[b].y0));
  for (let k = 0; k + 1 < order.length; k++) {
    const i = order[k], j = order[k + 1];
    if (horizontal && boxes[j].x0 < boxes[i].x1) {
      const seam = (boxes[j].x0 + boxes[i].x1) / 2;
      clips[i].x1 = Math.min(clips[i].x1, seam);
      clips[j].x0 = Math.max(clips[j].x0, seam);
    } else if (!horizontal && boxes[j].y0 < boxes[i].y1) {
      const seam = (boxes[j].y0 + boxes[i].y1) / 2;
      clips[i].y1 = Math.min(clips[i].y1, seam);
      clips[j].y0 = Math.max(clips[j].y0, seam);
    }
  }
  return clips;
}

// ── vector-geometry merge (snap grid / one-click mask inputs) ──────────────
// The stitch key gets ONE merged geometry set: each member's extracted
// endpoints and segments, offset into stitch space and CLIPPED to that
// member's visible (seam) box — hidden ink must not offer snap targets or
// wall off the flood mask. Inputs to buildMask/buildSnapGrid only; the
// one-click engine itself is untouched.

export function mergePoints(
  perMember: Array<{ points: Array<[number, number]>; dx: number; dy: number; clip: Box }>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of perMember) {
    for (const [x, y] of m.points) {
      const sx = x + m.dx, sy = y + m.dy;
      if (sx >= m.clip.x0 && sx <= m.clip.x1 && sy >= m.clip.y0 && sy <= m.clip.y1) out.push([sx, sy]);
    }
  }
  return out;
}

/** Merge member segment sets (flat [x0,y0,x1,y1,…] quads + per-seg meta byte)
 * into stitch space. Ownership is by MIDPOINT: a segment rides the merge iff
 * its midpoint falls in the member's seam box — kept WHOLE, never cut.
 * Geometric cutting at the seam was tried first and is a trap: One-Click's
 * hatch classifier keys on row-span statistics, and halving every hatch row
 * that crosses the seam flips soft tile-hatch into hard "walls" (phantom
 * 1–20 SF pockets, dense-linework refusals — reproduced on the split-sheet
 * fixture). Midpoint ownership keeps every row at its true length, assigns
 * seam-crossing ink to exactly one member (the two copies of a shared wall
 * have the same midpoint, so exactly one member's box claims it), and still
 * excludes content hidden past the seam. imageArea sums so the raster-
 * fallback trigger signal stays honest. */
export interface MergeSegMember {
  segs: ArrayLike<number>;
  meta?: ArrayLike<number>;
  lum?: ArrayLike<number>;
  layerOf?: ArrayLike<number>;
  layerIds?: string[];
  subpaths?: SubPath[];
  imageArea?: number;
  dx: number;
  dy: number;
  clip: Box;
}

export interface MergeSegResult {
  segs: number[];
  meta: Uint8Array;
  imageArea: number;
  lum?: Uint8Array;
  layerOf?: Int32Array;
  layerIds?: string[];
  subpaths?: SubPath[];
}

export function mergeSegs(
  perMember: MergeSegMember[],
): MergeSegResult {
  const segs: number[] = [];
  const meta: number[] = [];
  const hasLum = perMember.some((m) => m.lum != null);
  const hasLayers = perMember.some((m) => m.layerOf != null || (m.layerIds && m.layerIds.length > 0));
  const hasSubpaths = perMember.some((m) => m.subpaths != null);
  const lumArr: number[] = [];
  const layerOfArr: number[] = [];
  const layerIds: string[] = [];
  const layerMap = new Map<string, number>();
  const subpaths: SubPath[] = [];
  let imageArea = 0;

  for (const m of perMember) {
    imageArea += m.imageArea || 0;
    let localToGlobal: number[] | null = null;
    if (hasLayers && m.layerIds) {
      localToGlobal = m.layerIds.map((id) => {
        let gi = layerMap.get(id);
        if (gi === undefined) {
          gi = layerIds.length;
          layerIds.push(id);
          layerMap.set(id, gi);
        }
        return gi;
      });
    }
    const n = m.segs.length >> 2;
    const outIdxBySeg = m.subpaths ? new Int32Array(n).fill(-1) : null;
    for (let i = 0; i < n; i++) {
      const x0 = m.segs[i * 4] + m.dx, y0 = m.segs[i * 4 + 1] + m.dy;
      const x1 = m.segs[i * 4 + 2] + m.dx, y1 = m.segs[i * 4 + 3] + m.dy;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      if (mx < m.clip.x0 || mx > m.clip.x1 || my < m.clip.y0 || my > m.clip.y1) continue;
      const outIdx = segs.length >> 2;
      if (outIdxBySeg) outIdxBySeg[i] = outIdx;
      segs.push(x0, y0, x1, y1);
      meta.push(m.meta ? m.meta[i] : 0);
      if (hasLum) lumArr.push(m.lum ? m.lum[i] : 0);
      if (hasLayers) {
        const li = m.layerOf ? m.layerOf[i] : -1;
        layerOfArr.push(li >= 0 && localToGlobal && li < localToGlobal.length ? localToGlobal[li] : -1);
      }
    }
    if (hasSubpaths && m.subpaths && outIdxBySeg) {
      for (const sp of m.subpaths) {
        const end = Math.min(sp.i1, n);
        let keptCount = 0;
        let runI0 = -1, runI1 = -1;
        let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
        const flush = (closedRun: boolean) => {
          if (runI0 >= 0 && runI1 > runI0) {
            subpaths.push({ i0: runI0, i1: runI1, x0: rx0, y0: ry0, x1: rx1, y1: ry1, closed: closedRun, flags: sp.flags, fillLum: sp.fillLum });
          }
          runI0 = -1; runI1 = -1;
          rx0 = Infinity; ry0 = Infinity; rx1 = -Infinity; ry1 = -Infinity;
        };
        for (let i = sp.i0; i < end; i++) {
          const oi = outIdxBySeg[i];
          if (oi < 0) {
            flush(false);
            continue;
          }
          keptCount++;
          const ax = segs[oi * 4], ay = segs[oi * 4 + 1], bx = segs[oi * 4 + 2], by = segs[oi * 4 + 3];
          if (runI0 < 0 || oi !== runI1) {
            flush(false);
            runI0 = oi;
          }
          runI1 = oi + 1;
          rx0 = Math.min(rx0, ax, bx); ry0 = Math.min(ry0, ay, by);
          rx1 = Math.max(rx1, ax, bx); ry1 = Math.max(ry1, ay, by);
        }
        const total = sp.i1 - sp.i0;
        flush(sp.closed && total > 0 && keptCount === total && runI1 - runI0 === total);
      }
    }
  }
  return {
    segs,
    meta: Uint8Array.from(meta),
    imageArea,
    ...(hasLum ? { lum: Uint8Array.from(lumArr) } : {}),
    ...(hasLayers ? { layerOf: Int32Array.from(layerOfArr), layerIds } : {}),
    ...(hasSubpaths ? { subpaths } : {}),
  };
}

// ── marked-set composite page (#200) ────────────────────────────────────────
// The Marked Set burns a stitch as ONE page at its composite dimensions — the
// honest rendering of what was measured: shapes were traced on the composite,
// their verts_norm are normalized to its extent, and a room crossing the
// match line is one ring with one quantity. Projecting back onto the members'
// source pages was considered and rejected for the deliverable: it splits a
// measured-once room into clipped fragments whose chip must land on an
// arbitrary half, and a reviewer reading either member page sees a partial
// ring that LOOKS like a wrong trace. One page that matches the canvas the
// work was reviewed on beats two pages that each show half the truth.

export interface StitchPagePlan {
  extent: Dim;
  members: Array<{ key: string; dx: number; dy: number; clip: Box }>;
}

/** Everything the PDF builder needs to lay out a stitch page: the composite
 * extent plus each member's offset and VISIBLE (seam-clipped) box, all in
 * stitch-local image px. Same seam rule as the canvas — overlapping members
 * split at the midline, so ink never double-draws at the match line. */
export function stitchPagePlan(members: StitchMember[], dims: Record<string, Dim>): StitchPagePlan {
  const clips = seamClips(members, dims);
  return {
    extent: stitchExtent(members, dims),
    members: members.map((m, i) => ({ key: m.key, dx: m.dx, dy: m.dy, clip: clips[i] })),
  };
}

/** The light-mode embed math for one member, kept pure so it's testable: map
 * the member's source-page user space onto the composite page and clip it to
 * its seam box.
 *
 * `vpTransform` is the pdf.js viewport transform at the baseline render scale
 * (user space → member visual px, y down, rotation + viewBox offsets
 * included). The returned `matrix` is the PDF form matrix (x' = a·x + c·y + e,
 * y' = b·x + d·y + f) taking user space to composite-page points (y up), with
 * the member placed at its stitch offset; `bbox` is the seam-clip box mapped
 * back into user space (axis-aligned — page rotation is always a multiple of
 * 90°), which is the space a form XObject's BBox clips in. */
export function memberEmbed(
  vpTransform: ArrayLike<number>, member: { dx: number; dy: number; clip: Box },
  pageH: number, renderScale: number,
): { bbox: { left: number; bottom: number; right: number; top: number }; matrix: [number, number, number, number, number, number] } {
  const [a, b, c, d, e, f] = Array.from(vpTransform);
  const det = a * d - b * c;
  // seam box (stitch-local px) → member-local visual px → source user space
  const inv = (x: number, y: number): [number, number] =>
    [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
  const { clip, dx, dy } = member;
  const corners = [
    inv(clip.x0 - dx, clip.y0 - dy), inv(clip.x1 - dx, clip.y0 - dy),
    inv(clip.x0 - dx, clip.y1 - dy), inv(clip.x1 - dx, clip.y1 - dy),
  ];
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const z = (n: number) => n + 0 || 0;   // −0 → 0 (a rotated inverse mints −0 at the origin)
  return {
    bbox: { left: z(Math.min(...xs)), bottom: z(Math.min(...ys)), right: z(Math.max(...xs)), top: z(Math.max(...ys)) },
    // user → visual px (vpTransform), + stitch offset, ÷ renderScale into
    // points, y flipped into PDF's y-up — composed into one affine
    matrix: [
      a / renderScale, -b / renderScale, c / renderScale, -d / renderScale,
      (e + dx) / renderScale, pageH - (f + dy) / renderScale,
    ],
  };
}

// ── liveness + labels ───────────────────────────────────────────────────────

/** A stitch is openable while every member's file is still in the working
 * set (mirrors the group-prune rule for plain sheets). */
export function stitchAlive(stitch: Stitch, fileNames: Set<string>): boolean {
  return stitch.members.every((m) => fileNames.has(parseSheetKey(m.key).file));
}

/** Signature of the open stitches' layouts — joins groupSig so the render
 * effect re-keys when an alignment moves a member (same keys, new offsets). */
export function stitchLayoutSig(groupKeys: string[], stitches: Stitch[]): string {
  const parts: string[] = [];
  for (const k of groupKeys) {
    if (!isStitchKey(k)) continue;
    const st = stitches.find((s) => s.id === k);
    if (st) parts.push(st.id + "=" + st.members.map((m) => `${m.key}@${m.dx.toFixed(2)},${m.dy.toFixed(2)}`).join(";"));
  }
  return parts.join("|");
}

/** The files the open sheets come from (stitches through their members):
 * the document cache keeps these loaded. A stitch no longer in `stitchById`
 * adds nothing; an empty key (no sheet) neither. */
export function pinnedFiles(o: { keys: Iterable<string>; stitchById: Record<string, Stitch | undefined> }): Set<string> {
  const files = new Set<string>();
  const add = (k: string) => { if (k) files.add(parseSheetKey(k).file); };
  for (const k of o.keys) {
    if (isStitchKey(k)) o.stitchById[k]?.members.forEach((m) => add(m.key));
    else add(k);
  }
  return files;
}

// ── match-line seam check ──────────────────────────────────────────────────
export interface SeamCheckDiscrepancy {
  at: [number, number];
  miss_px: number;
  miss_in: number;
  sheet_a_pt: [number, number];
  sheet_b_pt: [number, number];
}

export interface SeamCheckResult {
  passed: boolean;
  withheld: boolean;
  tolerance_in: number;
  rot_tolerance_deg: number;
  max_px: number;
  p95_px: number;
  median_px: number;
  max_in: number;
  p95_in: number;
  median_in: number;
  leftover_rotation_deg: number;
  sample_count: number;
  withheld_reasons: string[];
  discrepancies: SeamCheckDiscrepancy[];
  note: string;
}

export function checkSeamLinework(
  members: StitchMember[],
  dims: Record<string, Dim>,
  memberSegs: Record<string, { segs: ArrayLike<number>; meta?: Uint8Array } | ArrayLike<number>>,
  upp: number,
  opts?: { tolerance_in?: number; rot_tolerance_deg?: number },
): SeamCheckResult {
  // Empirical tolerance defaults calibrated from 6 real split-sheet UCCS CAD pairs
  // (AF2.2/AF2.1, A2.1.3/A2.1.2, A3.1.3/A3.1.2, E2.1.3/E2.1.2, MD2.1, EMP2.1):
  // clean pairs show median 0.00"-0.04", p95 0.00"-0.19", true max 0.24"-0.40", and
  // long-segment max rotation 0.04°-0.14°, so 0.50" and 0.25° sit above real CAD noise.
  const toleranceIn = opts?.tolerance_in ?? 0.50;
  const rotToleranceDeg = opts?.rot_tolerance_deg ?? 0.25;
  const clips = seamClips(members, dims);
  const boxes = memberBoxes(members, dims);

  if (members.length < 2) {
    return {
      passed: true,
      withheld: false,
      tolerance_in: toleranceIn,
      rot_tolerance_deg: rotToleranceDeg,
      max_px: 0,
      p95_px: 0,
      median_px: 0,
      max_in: 0,
      p95_in: 0,
      median_in: 0,
      leftover_rotation_deg: 0,
      sample_count: 0,
      withheld_reasons: [],
      discrepancies: [],
      note: "Single member — no seam to check.",
    };
  }

  const cxs = boxes.map((b) => (b.x0 + b.x1) / 2);
  const cys = boxes.map((b) => (b.y0 + b.y1) / 2);
  const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
  const horizontal = spread(cxs) >= spread(cys);
  const order = boxes.map((_, i) => i).sort((a, b) => (horizontal ? boxes[a].x0 - boxes[b].x0 : boxes[a].y0 - boxes[b].y0));

  const allMatched: Array<{ miss_px: number; miss_in: number; angle_err: number; at: [number, number]; pA: [number, number]; pB: [number, number] }> = [];
  const discrepancies: SeamCheckDiscrepancy[] = [];
  const seamStats: Array<{ k: number; aKey: string; bKey: string; count: number; maxIn: number; rotDeg: number }> = [];

  for (let k = 0; k + 1 < order.length; k++) {
    const ai = order[k], bi = order[k + 1];
    const mA = members[ai], mB = members[bi];
    const segsA = memberSegs[mA.key];
    const segsB = memberSegs[mB.key];
    const seamMatched: typeof allMatched = [];
    if (!segsA || !segsB) {
      seamStats.push({ k, aKey: mA.key, bKey: mB.key, count: 0, maxIn: 0, rotDeg: 0 });
      continue;
    }

    let seamCoord: number;
    let seamMin: number;
    let seamMax: number;
    if (horizontal) {
      seamCoord = (clips[ai].x1 + clips[bi].x0) / 2;
      seamMin = Math.max(clips[ai].y0, clips[bi].y0);
      seamMax = Math.min(clips[ai].y1, clips[bi].y1);
    } else {
      seamCoord = (clips[ai].y1 + clips[bi].y0) / 2;
      seamMin = Math.max(clips[ai].x0, clips[bi].x0);
      seamMax = Math.min(clips[ai].x1, clips[bi].x1);
    }

    const envelopePx = Math.max(80, upp > 0 ? (24 / (upp * 12)) : 150);

    type Seg = { x0: number; y0: number; x1: number; y1: number; mx: number; my: number; len: number; ang: number; nx: number; ny: number };
    const extract = (m: StitchMember, data: { segs: ArrayLike<number>; meta?: Uint8Array } | ArrayLike<number>, pad = 0): Seg[] => {
      const dataSegs = (data as any)?.segs ?? data;
      const dataMeta = (data as any)?.meta;
      const res: Seg[] = [];
      if (!dataSegs || !dataSegs.length) return res;
      const n = dataSegs.length >> 2;
      const cMin = seamCoord - envelopePx - pad;
      const cMax = seamCoord + envelopePx + pad;
      const oMin = seamMin - 50;
      const oMax = seamMax + 50;
      for (let s = 0; s < n; s++) {
        if (dataMeta && (dataMeta[s] & 1)) continue; // skip curve chords
        let x0 = dataSegs[s * 4] + m.dx, y0 = dataSegs[s * 4 + 1] + m.dy;
        let x1 = dataSegs[s * 4 + 2] + m.dx, y1 = dataSegs[s * 4 + 3] + m.dy;
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 6) continue;
        const sMinX = Math.min(x0, x1), sMaxX = Math.max(x0, x1);
        const sMinY = Math.min(y0, y1), sMaxY = Math.max(y0, y1);

        // Keep any segment intersecting the seam corridor so continuous lines crossing the seam are preserved
        if (horizontal) {
          if (sMaxX < cMin || sMinX > cMax) continue;
          if (sMaxY < oMin || sMinY > oMax) continue;
        } else {
          if (sMaxY < cMin || sMinY > cMax) continue;
          if (sMaxX < oMin || sMinX > oMax) continue;
        }
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;

        if (x0 > x1 || (x0 === x1 && y0 > y1)) {
          [x0, x1] = [x1, x0];
          [y0, y1] = [y1, y0];
        }
        let ang = Math.atan2(y1 - y0, x1 - x0);
        while (ang > Math.PI / 2) ang -= Math.PI;
        while (ang < -Math.PI / 2) ang += Math.PI;
        const nx = -Math.sin(ang);
        const ny = Math.cos(ang);
        res.push({ x0, y0, x1, y1, mx, my, len, ang, nx, ny });
      }
      return res;
    };

    const extractedA = extract(mA, segsA, 0);
    const extractedB = extract(mB, segsB, 50);

    // Identify outer viewport crop boundaries inside the seam envelope (where >=10 strokes end flush
    // at one outer coordinate) and periodic dashed gridlines (>=3 collinear dashes) so viewport
    // cropping or dash-phase shifts do not synthesize false longitudinal displacement.
    const findCropEdge = (segs: Seg[], findHigh: boolean): number | null => {
      if (segs.length < 10) return null;
      const minBand = seamCoord - envelopePx - 60;
      const maxBand = seamCoord + envelopePx + 60;
      const counts = new Map<number, number>();
      const flushCoords = new Set<number>();
      for (const s of segs) {
        const p0 = horizontal ? s.x0 : s.y0;
        const p1 = horizontal ? s.x1 : s.y1;
        const q0 = Math.round(p0 * 2) / 2;
        const q1 = Math.round(p1 * 2) / 2;
        if (Math.abs(p0 - p1) <= 1.0 && p0 >= minBand && p0 <= maxBand && s.len >= 20) {
          flushCoords.add(q0);
        }
        for (const v of (p0 === p1 ? [p0] : [p0, p1])) {
          if (v < minBand || v > maxBand) continue;
          const q = Math.round(v * 2) / 2;
          counts.set(q, (counts.get(q) ?? 0) + 1);
        }
      }
      const candidatesEdge = [...counts.entries()]
        .filter(([coord, cnt]) => cnt >= 10 && flushCoords.has(coord) && (findHigh ? coord > seamCoord + 10 : coord < seamCoord - 10))
        .sort((a, b) => (findHigh ? b[0] - a[0] : a[0] - b[0]));
      return candidatesEdge[0]?.[0] ?? null;
    };
    const cropA = findCropEdge(extractedA, true);
    const cropB = findCropEdge(extractedB, false);
    const liesOnCrop = (s: Seg, crop: number | null) => {
      if (crop === null) return false;
      const p0 = horizontal ? s.x0 : s.y0;
      const p1 = horizontal ? s.x1 : s.y1;
      return Math.abs(p0 - crop) <= 1.0 && Math.abs(p1 - crop) <= 1.0;
    };
    const clippedByCrop = (s: Seg, crop: number | null) => {
      if (crop === null) return false;
      const p0 = horizontal ? s.x0 : s.y0;
      const p1 = horizontal ? s.x1 : s.y1;
      return Math.abs(p0 - crop) <= 1.0 || Math.abs(p1 - crop) <= 1.0;
    };

    const dashKey = (s: Seg) =>
      `${Math.round(s.ang * 20)}:${Math.round((s.mx * s.nx + s.my * s.ny) * 2) / 2}:${Math.round(s.len / 2) * 2}`;
    const dashCounts = (segs: Seg[]) => {
      const counts = new Map<string, number>();
      for (const s of segs) {
        const k = dashKey(s);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return counts;
    };
    const dcA = dashCounts(extractedA);
    const dcB = dashCounts(extractedB);
    const isPeriodicDash = (s: Seg, dc: Map<string, number>) => (dc.get(dashKey(s)) ?? 0) >= 3;

    const maxSearchPx = Math.max(30, upp > 0 ? (12 / (upp * 12)) : 60);

    // Spatial bucketing for extractedB by full coordinate span along the seam axis so long crossing walls aren't missed
    const bucketSize = Math.max(50, maxSearchPx);
    const buckets = new Map<number, number[]>();
    for (let bi = 0; bi < extractedB.length; bi++) {
      const sb = extractedB[bi];
      const s0 = horizontal ? Math.min(sb.y0, sb.y1) : Math.min(sb.x0, sb.x1);
      const s1 = horizontal ? Math.max(sb.y0, sb.y1) : Math.max(sb.x0, sb.x1);
      const b0 = Math.floor(s0 / bucketSize);
      const b1 = Math.floor(s1 / bucketSize);
      for (let b = b0; b <= b1; b++) {
        let list = buckets.get(b);
        if (!list) { list = []; buckets.set(b, list); }
        list.push(bi);
      }
    }

    const seenB = new Int32Array(extractedB.length);
    const getNearB = (sa: Seg, stamp: number): Seg[] => {
      const s0 = horizontal ? Math.min(sa.y0, sa.y1) : Math.min(sa.x0, sa.x1);
      const s1 = horizontal ? Math.max(sa.y0, sa.y1) : Math.max(sa.x0, sa.x1);
      const b0 = Math.floor((s0 - maxSearchPx) / bucketSize);
      const b1 = Math.floor((s1 + maxSearchPx) / bucketSize);
      const res: Seg[] = [];
      for (let b = b0; b <= b1; b++) {
        const l = buckets.get(b);
        if (l) {
          for (let i = 0; i < l.length; i++) {
            const idx = l[i];
            if (seenB[idx] !== stamp) {
              seenB[idx] = stamp;
              res.push(extractedB[idx]);
            }
          }
        }
      }
      return res;
    };

    const candidates: Array<{
      sa: Seg;
      sb: Seg;
      dx: number;
      dy: number;
      angDiff: number;
      at: [number, number];
      pB: [number, number];
      sameLen: boolean;
      clipped: boolean;
      periodicDash: boolean;
    }> = [];

    for (let ai2 = 0; ai2 < extractedA.length; ai2++) {
      const sa = extractedA[ai2];
      if (liesOnCrop(sa, cropA)) continue;
      const nearB = getNearB(sa, ai2 + 1);
      for (const sb of nearB) {
        if (liesOnCrop(sb, cropB)) continue;
        let dang = Math.abs(sa.ang - sb.ang);
        if (dang > Math.PI / 2) dang = Math.PI - dang;
        if (dang > 0.08) continue; // angle within ~4.6 deg

        const cos = Math.cos(sa.ang), sin = Math.sin(sa.ang);
        const ta0 = sa.x0 * cos + sa.y0 * sin;
        const ta1 = sa.x1 * cos + sa.y1 * sin;
        const tb0 = sb.x0 * cos + sb.y0 * sin;
        const tb1 = sb.x1 * cos + sb.y1 * sin;
        const minA = Math.min(ta0, ta1);
        const maxA = Math.max(ta0, ta1);
        const minB = Math.min(tb0, tb1);
        const maxB = Math.max(tb0, tb1);
        const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);

        // 1. Direct counterpart matching in overlap corridor
        const minLen = Math.min(sa.len, sb.len);
        if (overlap >= minLen * 0.50 && Math.abs(sa.len - sb.len) <= Math.max(5, sa.len * 0.35)) {
          const sameLen = Math.abs(sa.len - sb.len) <= Math.max(1.5, minLen * 0.03);
          const clipped = !sameLen || clippedByCrop(sa, cropA) || clippedByCrop(sb, cropB);
          const periodicDash = sameLen && (isPeriodicDash(sa, dcA) || isPeriodicDash(sb, dcB));
          const ref = sb.len >= sa.len ? sb : sa;
          const perp = (sb.mx - sa.mx) * ref.nx + (sb.my - sa.my) * ref.ny;
          const dx = (!clipped && !periodicDash) ? (sb.mx - sa.mx) : (perp * ref.nx);
          const dy = (!clipped && !periodicDash) ? (sb.my - sa.my) : (perp * ref.ny);
          if (Math.hypot(dx, dy) <= maxSearchPx) {
            candidates.push({
              sa,
              sb,
              dx,
              dy,
              angDiff: dang,
              at: [+((sa.mx + sb.mx) / 2).toFixed(1), +((sa.my + sb.my) / 2).toFixed(1)],
              pB: [sb.x0, sb.y0],
              sameLen,
              clipped,
              periodicDash,
            });
          }
        } else if (overlap <= Math.max(15, envelopePx * 0.25)) {
          // 2. Collinear continuation across a butt seam (sa on Sheet A side ending near seam, sb on Sheet B side starting near seam)
          const crossesSeamAngle = horizontal ? Math.abs(sa.ang) < Math.PI / 4 : Math.abs(sa.ang) >= Math.PI / 4;
          if (crossesSeamAngle) {
            const cA0 = horizontal ? Math.min(sa.x0, sa.x1) : Math.min(sa.y0, sa.y1);
            const cA1 = horizontal ? Math.max(sa.x0, sa.x1) : Math.max(sa.y0, sa.y1);
            const cB0 = horizontal ? Math.min(sb.x0, sb.x1) : Math.min(sb.y0, sb.y1);
            const cB1 = horizontal ? Math.max(sb.x0, sb.x1) : Math.max(sb.y0, sb.y1);
            const cAMid = horizontal ? sa.mx : sa.my;
            const cBMid = horizontal ? sb.mx : sb.my;
            if (cA0 <= seamCoord + maxSearchPx && cB1 >= seamCoord - maxSearchPx && cA1 <= seamCoord + maxSearchPx && cB0 >= seamCoord - maxSearchPx && cA1 >= cB0 - maxSearchPx && cAMid <= cBMid && Math.min(cA0, cB0) <= seamCoord && Math.max(cA1, cB1) >= seamCoord) {
              const perp = (sb.mx - sa.mx) * sa.nx + (sb.my - sa.my) * sa.ny;
              let gap = 0;
              if (cB0 > cA1) gap = cB0 - cA1;
              const dx = horizontal ? gap : perp;
              const dy = horizontal ? perp : gap;
              if (Math.hypot(dx, dy) <= maxSearchPx) {
                candidates.push({
                  sa,
                  sb,
                  dx,
                  dy,
                  angDiff: dang,
                  at: horizontal ? [seamCoord, +(sa.my).toFixed(1)] : [+(sa.mx).toFixed(1), seamCoord],
                  pB: [sb.x0, sb.y0],
                  sameLen: false,
                  clipped: true,
                  periodicDash: false,
                });
              }
            }
          }
        }
      }
    }

    if (candidates.length > 0) {
      // Consensus voting using spatial grid binning to find the dominant displacement mode.
      // Full-2D unclipped non-dash candidates vote first so clipped walls cannot pull the mode.
      const binSize = Math.max(0.5, upp > 0 ? (0.25 / (upp * 12)) : 1.0);
      const fullVoters = candidates.filter((c) => !c.clipped && !c.periodicDash);
      const votePool = fullVoters.length >= 5 ? fullVoters : candidates;
      const bins = new Map<string, { count: number; sumDx: number; sumDy: number }>();

      for (const c of votePool) {
        const bx = Math.round(c.dx / binSize);
        const by = Math.round(c.dy / binSize);
        const key = `${bx},${by}`;
        let entry = bins.get(key);
        if (!entry) {
          entry = { count: 0, sumDx: 0, sumDy: 0 };
          bins.set(key, entry);
        }
        entry.count++;
        entry.sumDx += c.dx;
        entry.sumDy += c.dy;
      }

      const sortedBins = [...bins.values()].sort((a, b) => b.count - a.count);
      const bestBin = sortedBins[0] ?? null;

      let modeDx = bestBin && bestBin.count > 0 ? bestBin.sumDx / bestBin.count : 0;
      let modeDy = bestBin && bestBin.count > 0 ? bestBin.sumDy / bestBin.count : 0;
      const tight = votePool.filter((c) => Math.hypot(c.dx - modeDx, c.dy - modeDy) <= binSize * 0.6);
      if (tight.length >= 3) {
        modeDx = tight.reduce((s, c) => s + c.dx, 0) / tight.length;
        modeDy = tight.reduce((s, c) => s + c.dy, 0) / tight.length;
      }

      const clusterTol = Math.max(2.5, upp > 0 ? (0.75 / (upp * 12)) : 5.0);
      const ranked = candidates
        .map((c) => ({ c, distFromMode: Math.hypot(c.dx - modeDx, c.dy - modeDy) }))
        .sort((a, b) => a.distFromMode - b.distFromMode);

      const usedA = new Set<Seg>();
      const usedB = new Set<Seg>();
      const recordMatch = (c: typeof candidates[number]) => {
        usedA.add(c.sa);
        usedB.add(c.sb);
        const missPx = Math.hypot(c.dx, c.dy);
        const missIn = upp > 0 ? missPx * upp * 12 : 0;
        const entry = {
          miss_px: missPx,
          miss_in: missIn,
          angle_err: c.angDiff,
          at: c.at,
          pA: [c.sa.x0, c.sa.y0] as [number, number],
          pB: c.pB,
        };
        allMatched.push(entry);
        seamMatched.push(entry);
        discrepancies.push({
          at: c.at,
          miss_px: +missPx.toFixed(2),
          miss_in: +missIn.toFixed(2),
          sheet_a_pt: [+c.sa.x0.toFixed(1), +c.sa.y0.toFixed(1)],
          sheet_b_pt: [+c.pB[0].toFixed(1), +c.pB[1].toFixed(1)],
        });
      };

      // Pass 1: 1-to-1 consensus-mode pairs closest to the sheet-wide offset
      for (const { c, distFromMode } of ranked) {
        if (distFromMode > clusterTol) break;
        if (usedA.has(c.sa) || usedB.has(c.sb)) continue;
        recordMatch(c);
      }

      // Pass 2: Genuine displaced walls among remaining unmatched equal-length segments inside the
      // shared interior overlap (never drop an isolated shifted wall just because 20+ other walls aligned).
      for (const { c, distFromMode } of ranked) {
        if (distFromMode <= clusterTol) continue;
        if (usedA.has(c.sa) || usedB.has(c.sb)) continue;
        if (!c.sameLen || c.sa.len < 20) continue;
        if (c.periodicDash) {
          const perp = (c.sb.mx - c.sa.mx) * c.sa.nx + (c.sb.my - c.sa.my) * c.sa.ny;
          if (Math.abs(perp) <= clusterTol) continue;
        }
        if (cropA !== null && (horizontal ? Math.max(c.sb.x0, c.sb.x1) > cropA + 1 : Math.max(c.sb.y0, c.sb.y1) > cropA + 1)) continue;
        if (cropB !== null && (horizontal ? Math.min(c.sa.x0, c.sa.x1) < cropB - 1 : Math.min(c.sa.y0, c.sa.y1) < cropB - 1)) continue;
        recordMatch(c);
      }
    }

    const seamMaxIn = seamMatched.reduce((m, x) => Math.max(m, x.miss_in), 0);
    const seamAngs = seamMatched.map((m) => m.angle_err).sort((a, b) => a - b);
    const seamRotDeg = seamAngs.length ? +(seamAngs[Math.floor(seamAngs.length / 2)] * 180 / Math.PI).toFixed(2) : 0;
    seamStats.push({ k, aKey: mA.key, bKey: mB.key, count: seamMatched.length, maxIn: +seamMaxIn.toFixed(2), rotDeg: seamRotDeg });
  }

  const sampleCount = allMatched.length;
  let maxPx = 0, p95Px = 0, medianPx = 0, maxIn = 0, p95In = 0, medianIn = 0, leftoverRotationDeg = 0;

  if (sampleCount > 0) {
    allMatched.sort((a, b) => a.miss_px - b.miss_px);
    const medIdx = Math.floor(sampleCount * 0.50);
    const p95Idx = Math.min(sampleCount - 1, Math.floor(sampleCount * 0.95));
    const maxIdx = sampleCount - 1; // True maximum

    medianPx = +allMatched[medIdx].miss_px.toFixed(2);
    medianIn = +allMatched[medIdx].miss_in.toFixed(2);
    p95Px = +allMatched[p95Idx].miss_px.toFixed(2);
    p95In = +allMatched[p95Idx].miss_in.toFixed(2);
    maxPx = +allMatched[maxIdx].miss_px.toFixed(2);
    maxIn = +allMatched[maxIdx].miss_in.toFixed(2);

    const sortedAng = allMatched.map(m => m.angle_err).sort((a, b) => a - b);
    leftoverRotationDeg = +(sortedAng[Math.floor(sortedAng.length / 2)] * 180 / Math.PI).toFixed(2);
  }

  const withheldReasons: string[] = [];
  if (sampleCount === 0) {
    withheldReasons.push("No linework crossed the seam. Measure the sheets separately.");
  } else {
    for (const st of seamStats) {
      if (st.count === 0) {
        withheldReasons.push(`No linework crossed seam ${st.k + 1} (${st.aKey} ↔ ${st.bKey}). Measure those sheets separately.`);
      }
    }
  }
  if (maxIn > toleranceIn) {
    withheldReasons.push(`Wall linework mismatch max ${maxIn.toFixed(2)}" (p95 ${p95In.toFixed(2)}", median ${medianIn.toFixed(2)}") exceeds ${toleranceIn.toFixed(2)}" tolerance.`);
  }
  if (Math.abs(leftoverRotationDeg) > rotToleranceDeg) {
    withheldReasons.push(`Leftover rotation ${Math.abs(leftoverRotationDeg).toFixed(2)}° exceeds ${rotToleranceDeg.toFixed(2)}° tolerance.`);
  } else {
    for (const st of seamStats) {
      if (st.count > 0 && Math.abs(st.rotDeg) > rotToleranceDeg) {
        withheldReasons.push(`Leftover rotation on seam ${st.k + 1} (${st.aKey} ↔ ${st.bKey}) is ${Math.abs(st.rotDeg).toFixed(2)}°, exceeding ${rotToleranceDeg.toFixed(2)}° tolerance.`);
      }
    }
  }

  const passed = sampleCount > 0 && withheldReasons.length === 0;
  const withheld = !passed;
  discrepancies.sort((a, b) => b.miss_px - a.miss_px);

  const note = sampleCount === 0
    ? "Seam check withheld: No linework crossed the seam. Measure the sheets separately."
    : passed
      ? `Seam check passed: ${sampleCount} wall lines verified across match line (max ${maxIn.toFixed(2)}", p95 ${p95In.toFixed(2)}", median ${medianIn.toFixed(2)}", rotation ${leftoverRotationDeg.toFixed(2)}°).`
      : `Seam check withheld: ${withheldReasons.join(" ")} Inspect coordinates with view_sheet.`;

  return {
    passed,
    withheld,
    tolerance_in: toleranceIn,
    rot_tolerance_deg: rotToleranceDeg,
    max_px: maxPx,
    p95_px: p95Px,
    median_px: medianPx,
    max_in: maxIn,
    p95_in: p95In,
    median_in: medianIn,
    leftover_rotation_deg: leftoverRotationDeg,
    sample_count: sampleCount,
    withheld_reasons: withheldReasons,
    discrepancies: discrepancies.slice(0, 20),
    note,
  };
}
