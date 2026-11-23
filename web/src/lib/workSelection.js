import { flattenCurve } from "./curve.js";

// Selection is transient view state. These helpers never alter measurements
// or invent review state for legacy records that have none.
export function canLocateWork(shape) {
  return typeof shape.sheet_id === "string" && !!shape.sheet_id
    && Array.isArray(shape.verts_norm) && shape.verts_norm.length > 0
    && shape.verts_norm.every((v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite));
}

export function workSelection(shapes, ids) {
  const selected = new Set(ids);
  const rows = shapes.filter((shape) => selected.has(shape.id));
  const locatable = rows.filter(canLocateWork);
  return { rows, locatable,
    pendingIds: locatable.filter((shape) => shape.origin?.reviewed === false).map((shape) => shape.id),
    sheetIds: [...new Set(locatable.map((shape) => shape.sheet_id))] };
}

// Shared by the highlight and framing: normalized vertices -> panel pixels.
// Curved lines use the same flattening as the committed-shape renderer.
export function workSelectionPaths(shape, panel) {
  const pixels = (verts) => verts.map(([x, y]) => [x * panel.img.w, y * panel.img.h]);
  const outer = pixels(shape.verts_norm);
  return [shape.measure_role === "linear" && shape.curved ? flattenCurve(outer) : outer,
    ...(shape.verts_norm_holes || []).map(pixels)];
}

export function workSelectionBounds(shapes, panels) {
  let bounds = null;
  for (const shape of shapes.filter(canLocateWork)) {
    const panel = panels.find((p) => p.key === shape.sheet_id);
    if (!panel?.img?.w || !panel.img.h) return null;
    for (const ring of workSelectionPaths(shape, panel)) {
      for (const [px, y] of ring) {
        const x = px + panel.xOffset;
        if (!bounds) bounds = { x0: x, y0: y, x1: x, y1: y };
        else {
          bounds.x0 = Math.min(bounds.x0, x); bounds.y0 = Math.min(bounds.y0, y);
          bounds.x1 = Math.max(bounds.x1, x); bounds.y1 = Math.max(bounds.y1, y);
        }
      }
    }
  }
  return bounds;
}
