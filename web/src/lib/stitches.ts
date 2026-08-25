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
export interface Stitch { id: string; name: string; members: StitchMember[]; created_at?: string }
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
      name: typeof s.name === "string" && s.name.trim() ? s.name : "",
      members: normalizeMembers(members),
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
  if (ai < 0 || bi < 0) return { error: "stitch_no_sheets" };
  if (ai === bi) return { error: "stitch_same_sheet" };
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
export function mergeSegs(
  perMember: Array<{ segs: ArrayLike<number>; meta?: ArrayLike<number>; imageArea?: number; dx: number; dy: number; clip: Box }>,
): { segs: number[]; meta: Uint8Array; imageArea: number } {
  const segs: number[] = [];
  const meta: number[] = [];
  let imageArea = 0;
  for (const m of perMember) {
    imageArea += m.imageArea || 0;
    const n = m.segs.length >> 2;
    for (let i = 0; i < n; i++) {
      const x0 = m.segs[i * 4] + m.dx, y0 = m.segs[i * 4 + 1] + m.dy;
      const x1 = m.segs[i * 4 + 2] + m.dx, y1 = m.segs[i * 4 + 3] + m.dy;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      if (mx < m.clip.x0 || mx > m.clip.x1 || my < m.clip.y0 || my > m.clip.y1) continue;
      segs.push(x0, y0, x1, y1);
      meta.push(m.meta ? m.meta[i] : 0);
    }
  }
  return { segs, meta: Uint8Array.from(meta), imageArea };
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
