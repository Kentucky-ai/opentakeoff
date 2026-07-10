// Module-scope helpers for the Takeoff Canvas — no component state (moved
// verbatim from pages/TakeoffCanvas.jsx): render budget math, canvas pixel
// inversion, id minting, zoom clamping, the status-message danger test, and
// the condition-template constructor/seeder. Not React-free: the seeder pulls
// PALETTE from components/hatches.jsx, which imports React — don't import
// this module outside the web app (mcp/ keeps its own mirrored copies).

import { RENDER_SCALE } from "./sheets";
import { STALE_TAB_MESSAGE } from "./store.js";
import { instantiateMaterial } from "./materials.js";
import { PALETTE } from "../components/hatches.jsx";
import {
  MIN_SCALE, MAX_SCALE,
  QUALITY_CEILING, MAX_CANVAS_DIM, MAX_PANEL_AREA,
  FLOORING_DEFAULTS,
} from "./canvasConstants.js";

// Largest pdf.js render scale a wPt×hPt-point page can use within the base budget;
// never below the baseline RENDER_SCALE, never above the ceiling.
export const autoRenderScale = (wPt, hPt) => {
  if (!(wPt > 0 && hPt > 0)) return RENDER_SCALE;
  const byDim  = Math.min(MAX_CANVAS_DIM / wPt, MAX_CANVAS_DIM / hPt);
  const byArea = Math.sqrt(MAX_PANEL_AREA / (wPt * hPt));
  return Math.max(RENDER_SCALE, Math.min(QUALITY_CEILING, byDim, byArea));
};

// Invert a canvas's pixels in place: one difference-with-white pass (an
// involution — applying it again flips back). This is how the negative/dark
// view works: pixel inversion costs one pass at draw time, where a CSS
// `filter: invert(1)` would make every sheet canvas a permanently-filtered
// compositor layer re-processed on every frame — with several panels open on
// a hi-Hz display that chain overloads the compositor (layer eviction =
// flicker/void glitches).
export function invertCanvasPixels(cv) {
  if (!cv || !cv.width || !cv.height) return;
  const ctx = cv.getContext("2d");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);   // raw device px — ignore any render transform
  ctx.globalCompositeOperation = "difference";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.restore();
}

let _idn = 0;
export const uid = (p) => `${p}-${Date.now().toString(36)}-${(_idn++).toString(36)}`;
export const clamp = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
// shared by the status-bar tone AND the auto-dismiss skip (in the canvas) — one
// definition of "this message is bad news" for both readers
export const isDangerMsg = (s) => s === STALE_TAB_MESSAGE || s.startsWith("Commit failed") || s.startsWith("Couldn't");

// A template is a condition minus ids (finish_tag, colors, hatch, waste,
// H/T params, materials) — instantiation mints fresh condition/material ids.
export const instantiateTemplate = (t) => ({
  id: uid("cnd"), finish_tag: t.finish_tag || "?",
  color: t.color || PALETTE[0], fill: t.fill ?? t.color ?? PALETTE[0],
  hatch: t.hatch || "solid", multiplier: 1, waste_pct: Number(t.waste_pct) || 0,
  ...(t.height_ft != null ? { height_ft: t.height_ft } : {}),
  ...(t.thickness_in != null ? { thickness_in: t.thickness_in } : {}),
  // instantiateMaterial (lib/materials.js) deep-copies the nested grout
  // geometry — a shallow spread here aliased the CT-1 seed's one grout object
  // into every fresh-workspace condition across every project in the session
  materials: (t.materials || []).map((m) => instantiateMaterial(m, uid("mat"))),
});
// Fresh-workspace seeding reads the user's template library first; the
// built-in flooring defaults are only the empty-library fallback. Both paths
// run instantiateTemplate — ONE condition constructor, no drift.
export const seedConditions = (library) => (library?.length ? library : FLOORING_DEFAULTS).map(instantiateTemplate);
