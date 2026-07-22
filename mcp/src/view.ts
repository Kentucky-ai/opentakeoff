// view_sheet's drawing half: the calibrated measuring grid and the committed-
// shapes overlay, drawn onto the rendered page in canvas space. Pure functions
// over a minimal 2D-context surface — no @napi-rs/canvas import here, so this
// module loads (and tests) on platforms without the optional native binary.
import { RENDER_SCALE } from "../../web/src/lib/sheets.ts";
import { UserError } from "./format.ts";
import type { Shape } from "./session.ts";

/** The slice of CanvasRenderingContext2D the drawing uses — structural, so
 * @napi-rs/canvas's context satisfies it without a type dependency. */
export interface Ctx2D {
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  font: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
  fillText(text: string, x: number, y: number): void;
}

/** image px → canvas px, closed over the crop and zoom by the renderer. */
export type ToCanvas = (x: number, y: number) => [number, number];

export interface Region { x0: number; y0: number; x1: number; y1: number }

// Overlay colors match the canvas's reading of the same states: accepted /
// human ink solid red, unreviewed machine shapes dashed pencil blue.
const INK = "#d91a1a";
const PENCIL = "#2659e6";
// The grid draws over the rasterized page (there is no pre-raster page space
// here), so both weights carry alpha — plan ink stays legible beneath.
const GRID_MINOR = "rgba(184, 191, 217, 0.55)";
const GRID_MAJOR = "rgba(51, 107, 242, 0.6)";
const GRID_LABEL = "#336bf2";

/** Grid spec → image px per real foot, or null when no grid was asked for.
 *
 * "auto" uses the sheet's set scale (upp = real feet per image px); anything
 * else is the DRAWING scale as inches-per-foot — "1/4" for a 1/4" = 1'-0"
 * plan, "3/16", or a bare number like "0.25". One drawing foot is
 * ipf paper inches = ipf × 72 pt = ipf × 72 × RENDER_SCALE image px. */
export function gridPxPerFoot(spec: string | undefined, upp: number | null): number | null {
  const s = (spec || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "auto") {
    if (upp == null) {
      throw new UserError('grid "auto" needs this sheet\'s scale set — call set_scale first, or pass the drawing scale read off the title block instead (e.g. grid: "1/4").');
    }
    return 1 / upp;
  }
  let inPerFt: number;
  if (s.includes("/")) {
    const [num, den] = s.split("/", 2);
    inPerFt = Number(num) / Number(den);
  } else {
    inPerFt = Number(s);
  }
  if (!Number.isFinite(inPerFt)) {
    throw new UserError(`Bad grid scale ${JSON.stringify(spec)} — use inches-per-foot like "1/4", "3/16", or "0.25" (or "auto" once the scale is set).`);
  }
  if (inPerFt < 0.01 || inPerFt > 12) {
    throw new UserError(`Grid scale out of range: ${JSON.stringify(spec)} — inches-per-foot must be between 0.01 and 12.`);
  }
  return inPerFt * 72 * RENDER_SCALE;
}

/** Calibrated measuring grid over the crop: thin lines every foot, heavy every
 * 5 ft, foot labels along the crop edges — feet counted from the crop's
 * top-left corner. Drawn under the shapes overlay. */
export function drawGrid(ctx: Ctx2D, toCanvas: ToCanvas, region: Region, ppf: number): void {
  const [ox, oy] = toCanvas(region.x0, region.y0);
  const step = toCanvas(region.x0 + ppf, region.y0)[0] - ox;
  const [ex, ey] = toCanvas(region.x1, region.y1);
  const nx = Math.ceil((region.x1 - region.x0) / ppf);
  const ny = Math.ceil((region.y1 - region.y0) / ppf);
  ctx.setLineDash([]);
  for (const major of [false, true]) {
    ctx.strokeStyle = major ? GRID_MAJOR : GRID_MINOR;
    ctx.lineWidth = major ? 1.5 : 0.75;
    // sub-3-px minor cells read as mush — draw only the 5-ft majors there
    if (!major && step < 3) continue;
    ctx.beginPath();
    for (let i = 0; i <= nx; i++) {
      if ((i % 5 === 0) !== major) continue;
      const x = ox + i * step;
      ctx.moveTo(x, oy);
      ctx.lineTo(x, ey);
    }
    for (let j = 0; j <= ny; j++) {
      if ((j % 5 === 0) !== major) continue;
      const y = oy + j * step;
      ctx.moveTo(ox, y);
      ctx.lineTo(ex, y);
    }
    ctx.stroke();
  }
  const size = Math.max(9, Math.min(36, step * 0.38));
  ctx.font = `${size}px sans-serif`;
  ctx.fillStyle = GRID_LABEL;
  for (let i = 0; i <= nx; i += 5) ctx.fillText(String(i), ox + i * step + 3, oy + size + 2);
  for (let j = 5; j <= ny; j += 5) ctx.fillText(String(j), ox + 3, oy + j * step - 3);
}

/** Burn the session's shapes for one sheet into the render: closed rings for
 * area/deduct roles, open polylines for linear — solid ink when a human
 * affirmed the shape, dashed pencil while origin.reviewed === false. */
export function drawShapes(ctx: Ctx2D, toCanvas: ToCanvas, shapes: Shape[], sheetW: number, sheetH: number, longEdge: number): void {
  const w = Math.max(1.4, longEdge / 700);
  for (const s of shapes) {
    const pts = s.verts_norm.map(([nx, ny]) => toCanvas(nx * sheetW, ny * sheetH));
    if (pts.length < 2) continue;
    const pending = s.origin?.reviewed === false;
    ctx.strokeStyle = pending ? PENCIL : INK;
    ctx.lineWidth = w;
    ctx.setLineDash(pending ? [w * 4, w * 3] : []);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (s.measure_role !== "linear") ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
