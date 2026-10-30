// Pure page and coordinate transformations for PDF page tools (#578).
// No DOM, no canvas, no store dependencies — pure mathematical transforms
// on normalized [0..1] coordinates and sheet-relative geometry.
//
// The Takeoff frame:
//   - Shapes store `verts_norm`: array of [x, y] in normalized [0..1] sheet coordinates.
//   - Optional `verts_norm_holes`: array of rings, each in normalized [0..1].
//   - Optional `origin`: { seed_norm: [x,y], proposed_verts_norm: [[x,y],...] }.
//   - Markups store normalized points `at`, `target`, `from`, `to`, `pts`, `quads`, `rect`.
//   - Image markups store `at` (center), `w` (fraction of sheet width), and `aspect` (h / w).
//
// Rotation angles are 90°, 180°, 270° clockwise.
//
// Coordinate transformation for 90° clockwise rotation:
//   In sheet image pixels (origin top-left, X right, Y down):
//     W' = H, H' = W
//     x' = H - y
//     y' = x
//   In normalized coordinates (u = x / W, v = y / H):
//     u' = x' / W' = (H - y) / H = 1 - v
//     v' = y' / H' = x / W = u
//
// Repeated rotations:
//   90°:  (u, v) -> (1 - v, u)
//   180°: (u, v) -> (1 - u, 1 - v)
//   270°: (u, v) -> (v, 1 - u)
//   360°: (u, v) -> (u, v)

import { parseSheetKey } from "./sheetKey.ts";

export type RotationAngle = 90 | 180 | 270;

export interface SheetDims {
  w: number;
  h: number;
}

/** Normalize rotation angle to one of 0, 90, 180, 270 */
export function normalizeAngle(angle: number): 0 | 90 | 180 | 270 {
  const a = Math.round(angle) % 360;
  const pos = a < 0 ? a + 360 : a;
  if (pos === 90 || pos === 180 || pos === 270) return pos;
  return 0;
}

/**
 * Rotate a single normalized [0..1] point by 90°, 180°, or 270° clockwise.
 */
export function rotateNormalizedPoint(pt: [number, number], angle: number): [number, number] {
  if (!Array.isArray(pt) || pt.length < 2) return pt;
  const a = normalizeAngle(angle);
  const u = pt[0];
  const v = pt[1];
  switch (a) {
    case 90: return [1 - v, u];
    case 180: return [1 - u, 1 - v];
    case 270: return [v, 1 - u];
    default: return [u, v];
  }
}

/**
 * Rotate a ring (array of normalized [x,y] points) by clockwise angle.
 */
export function rotateNormalizedRing(ring: [number, number][], angle: number): [number, number][] {
  if (!Array.isArray(ring)) return [];
  return ring.map((pt) => rotateNormalizedPoint(pt, angle));
}

/**
 * Rotate a normalized bounding rectangle [[x0, y0], [x1, y1]].
 * Normalizes the output so rect[0] is top-left and rect[1] is bottom-right.
 */
export function rotateNormalizedRect(
  rect: [[number, number], [number, number]],
  angle: number
): [[number, number], [number, number]] {
  if (!Array.isArray(rect) || rect.length < 2) return rect;
  const p0 = rotateNormalizedPoint(rect[0], angle);
  const p1 = rotateNormalizedPoint(rect[1], angle);
  return [
    [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1])],
    [Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])],
  ];
}

/**
 * Dimensions of a sheet after clockwise rotation.
 */
export function rotatedSheetDims(dims: SheetDims, angle: number): SheetDims {
  const a = normalizeAngle(angle);
  if (a === 90 || a === 270) {
    return { w: dims.h, h: dims.w };
  }
  return { w: dims.w, h: dims.h };
}

/**
 * Rotate a shape's geometry on a sheet by clockwise angle.
 * Preserves human review states, IDs, condition links, labels, and heights.
 */
export function rotateShape<T extends Record<string, any>>(shape: T, angle: number): T {
  const a = normalizeAngle(angle);
  if (a === 0 || !shape) return shape;

  const next: Record<string, any> = { ...shape };

  if (Array.isArray(shape.verts_norm)) {
    next.verts_norm = rotateNormalizedRing(shape.verts_norm, a);
  }

  if (Array.isArray(shape.verts_norm_holes)) {
    next.verts_norm_holes = shape.verts_norm_holes.map((h: [number, number][]) =>
      rotateNormalizedRing(h, a)
    );
  }

  if (shape.origin && typeof shape.origin === "object") {
    const nextOrigin = { ...shape.origin };
    if (Array.isArray(shape.origin.seed_norm)) {
      nextOrigin.seed_norm = rotateNormalizedPoint(shape.origin.seed_norm as [number, number], a);
    }
    if (Array.isArray(shape.origin.proposed_verts_norm)) {
      nextOrigin.proposed_verts_norm = rotateNormalizedRing(shape.origin.proposed_verts_norm, a);
    }
    next.origin = nextOrigin;
  }

  return next as T;
}

/**
 * Rotate a markup's coordinates on a sheet.
 * Handles points, vectors, paths, rects, quads, and aspect-ratio scaling for images.
 */
export function rotateMarkup<T extends Record<string, any>>(
  markup: T,
  angle: number,
  sheetDims?: SheetDims
): T {
  const a = normalizeAngle(angle);
  if (a === 0 || !markup) return markup;

  const next: Record<string, any> = { ...markup };

  if (Array.isArray(markup.at) && markup.at.length >= 2) {
    next.at = rotateNormalizedPoint(markup.at as [number, number], a);
  }

  if (Array.isArray(markup.target) && markup.target.length >= 2) {
    next.target = rotateNormalizedPoint(markup.target as [number, number], a);
  }

  if (Array.isArray(markup.from) && markup.from.length >= 2) {
    next.from = rotateNormalizedPoint(markup.from as [number, number], a);
  }

  if (Array.isArray(markup.to) && markup.to.length >= 2) {
    next.to = rotateNormalizedPoint(markup.to as [number, number], a);
  }

  if (Array.isArray(markup.pts)) {
    next.pts = markup.pts.map((p: [number, number]) => rotateNormalizedPoint(p, a));
  }

  if (Array.isArray(markup.quads)) {
    next.quads = markup.quads.map((quad: [number, number][]) =>
      Array.isArray(quad) ? quad.map((p) => rotateNormalizedPoint(p, a)) : quad
    );
  }

  if (Array.isArray(markup.rect) && markup.rect.length >= 2) {
    next.rect = rotateNormalizedRect(markup.rect as [[number, number], [number, number]], a);
  }

  // Image markup width and aspect ratio transform:
  // Placed pixel box on original sheet: bw = w * sheetW, bh = bw * aspect
  // When rotated 90 or 270:
  // New placed pixel box: bw' = bh, bh' = bw
  // New width fraction: w' = bw' / newSheetW = (w * sheetW * aspect) / sheetH
  // New aspect: aspect' = bh' / bw' = 1 / aspect
  if (markup.type === "image" && (a === 90 || a === 270)) {
    const w = Number(markup.w);
    const aspect = Number(markup.aspect);
    if (w > 0 && aspect > 0) {
      next.aspect = 1 / aspect;
      if (sheetDims && sheetDims.w > 0 && sheetDims.h > 0) {
        next.w = (w * sheetDims.w * aspect) / sheetDims.h;
      }
    }
  }

  return next as T;
}

/**
 * Rotate an approval seal coordinate on a sheet.
 */
export function rotateApproval<T extends Record<string, any>>(approval: T, angle: number): T {
  const a = normalizeAngle(angle);
  if (a === 0 || !approval) return approval;
  const next: Record<string, any> = { ...approval };
  if (Array.isArray(approval.at) && approval.at.length >= 2) {
    next.at = rotateNormalizedPoint(approval.at as [number, number], a);
  }
  return next as T;
}

/**
 * Rotate all takeoff elements (shapes, markups, approvals) on a specific sheet.
 */
export function rotateTakeoffOnSheet(
  takeoff: {
    shapes?: any[];
    markups?: any[];
    approvals?: any[];
    [key: string]: any;
  },
  sheetId: string,
  angle: number,
  sheetDims?: SheetDims
) {
  const a = normalizeAngle(angle);
  if (a === 0) return takeoff;

  const shapes = (takeoff.shapes || []).map((s) =>
    s?.sheet_id === sheetId ? rotateShape(s, a) : s
  );

  const markups = (takeoff.markups || []).map((m) =>
    m?.sheet_id === sheetId ? rotateMarkup(m, a, sheetDims) : m
  );

  const approvals = (takeoff.approvals || []).map((ap) =>
    ap?.sheet_id === sheetId ? rotateApproval(ap, a) : ap
  );

  return {
    ...takeoff,
    shapes,
    markups,
    approvals,
  };
}

/**
 * Construct sheet key from file name and 1-based page number.
 * Page 1: "filename.pdf", Page 2+: "filename.pdf#2"
 */
export function formatSheetKey(file: string, page: number): string {
  return page > 1 ? `${file}#${page}` : file;
}

/**
 * Build a sheet key remapping dictionary when pages of a file are reordered,
 * inserted, or deleted.
 * @param file The PDF file name
 * @param oldPageToNewPage Map or function: old 1-based page -> new 1-based page (or null/0 if deleted)
 * @param totalOldPages Number of pages in the old document
 */
export function buildKeyRemap(
  file: string,
  oldPageToNewPage: Record<number, number | null> | ((oldPage: number) => number | null),
  totalOldPages: number
): Map<string, string | null> {
  const remap = new Map<string, string | null>();
  const getNewPage = typeof oldPageToNewPage === "function"
    ? oldPageToNewPage
    : (p: number) => oldPageToNewPage[p] ?? null;

  for (let p = 1; p <= totalOldPages; p++) {
    const oldKey = formatSheetKey(file, p);
    const newPage = getNewPage(p);
    const newKey = newPage && newPage > 0 ? formatSheetKey(file, newPage) : null;
    remap.set(oldKey, newKey);
  }

  return remap;
}

/**
 * Remap sheet_id across all takeoff structures (shapes, markups, sheets/calibrations,
 * approvals, tabs, groups, stitches).
 * Items whose sheet_id maps to null are deleted.
 */
export function remapTakeoffSheetKeys(
  takeoff: {
    shapes?: any[];
    markups?: any[];
    sheets?: any[];
    approvals?: any[];
    rfis?: any[];
    sheet_tabs?: string[];
    sheet_group?: string[];
    last_group?: string[];
    stitches?: any[];
    [key: string]: any;
  },
  keyMap: Map<string, string | null> | Record<string, string | null>
) {
  const map = keyMap instanceof Map ? keyMap : new Map(Object.entries(keyMap));

  const remapKey = (k: string): string | null => (map.has(k) ? map.get(k)! : k);

  const shapes = (takeoff.shapes || [])
    .map((s) => {
      const nextKey = remapKey(s.sheet_id);
      return nextKey ? { ...s, sheet_id: nextKey } : null;
    })
    .filter(Boolean);

  const markups = (takeoff.markups || [])
    .map((m) => {
      const nextKey = remapKey(m.sheet_id);
      if (!nextKey) return null;
      let nextM = { ...m, sheet_id: nextKey };
      if (m.src_sheet_id) {
        const nextSrcKey = remapKey(m.src_sheet_id);
        if (nextSrcKey) nextM.src_sheet_id = nextSrcKey;
      }
      return nextM;
    })
    .filter(Boolean);

  const sheets = (takeoff.sheets || [])
    .map((sh) => {
      const nextKey = remapKey(sh.sheet_id);
      return nextKey ? { ...sh, sheet_id: nextKey } : null;
    })
    .filter(Boolean);

  const approvals = (takeoff.approvals || [])
    .map((ap) => {
      const nextKey = remapKey(ap.sheet_id);
      return nextKey ? { ...ap, sheet_id: nextKey } : null;
    })
    .filter(Boolean);

  const rfis = (takeoff.rfis || []).map((r) => {
    if (!r.sheet_id) return r;
    const nextKey = remapKey(r.sheet_id);
    return nextKey ? { ...r, sheet_id: nextKey } : r;
  });

  const sheet_tabs = (takeoff.sheet_tabs || [])
    .map(remapKey)
    .filter((k): k is string => typeof k === "string" && k.length > 0);

  const sheet_group = (takeoff.sheet_group || [])
    .map(remapKey)
    .filter((k): k is string => typeof k === "string" && k.length > 0);

  const last_group = (takeoff.last_group || [])
    .map(remapKey)
    .filter((k): k is string => typeof k === "string" && k.length > 0);

  const stitches = (takeoff.stitches || []).map((st) => {
    const nextMembers = (st.members || []).map((mem: any) => {
      const nextKey = remapKey(mem.key);
      return nextKey ? { ...mem, key: nextKey } : mem;
    });
    return { ...st, members: nextMembers };
  });

  return {
    ...takeoff,
    shapes,
    markups,
    sheets,
    approvals,
    rfis,
    sheet_tabs,
    sheet_group,
    last_group,
    stitches,
  };
}

