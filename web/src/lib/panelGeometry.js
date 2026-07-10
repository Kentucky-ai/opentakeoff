// Panel-row geometry for the Takeoff Canvas — the pure math behind the ONE
// rendering model (single-sheet mode is a group of one). Every coordinate on
// screen lives in "stage space": panel i's image px plus its xOffset; with one
// panel xOffset is 0, so stage space IS image space. These are the extracted
// computational cores of the canvas's panel helpers: each takes the live
// `panels` array / scale maps explicitly, and the component keeps thin
// same-named wrappers so call sites read unchanged.
//
// A panel is { key, file, page, img: {w,h}, xOffset } (built in the canvas).

import { RENDER_SCALE } from "./sheets";

// Overall stage extent of the panel row (row width including gaps baked into
// xOffset, height of the tallest panel).
export const stageExtent = (panels) =>
  panels.reduce((a, p) => ({ w: Math.max(a.w, p.xOffset + p.img.w), h: Math.max(a.h, p.img.h) }), { w: 0, h: 0 });

export const panelByKey = (panels, k) => panels.find((p) => p.key === k) || panels[0];

// never null: a click in a gap (or off the row) routes to the NEAREST panel,
// matching the old behavior of happily returning out-of-bounds image coords
export const panelAt = (panels, sx) => {
  let best = panels[0], bd = Infinity;
  for (const p of panels) {
    if (sx >= p.xOffset && sx < p.xOffset + p.img.w) return p;
    const d = sx < p.xOffset ? p.xOffset - sx : sx - (p.xOffset + p.img.w);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
};

// Stored scales are ALWAYS feet-per-pixel at the baseline RENDER_SCALE. A hi-res
// sheet is rastered at autoRenderScale, so its bitmap has factorFor× the baseline
// pixels — geometry must divide by that factor (uppFor) and calibration must multiply
// back to baseline, or a quantity would drift with the render resolution. Shape verts
// are normalized to the panel, so positions are scale-free; only the px→feet factor
// moves. factorFor reads the scale ACTUALLY rastered (the canvas's renderScalesRef
// map), so it always matches the bitmap currently on screen.
// `renderScales` is a Map of sheetKey → base raster pdf scale; `scales` is the
// sheetKey → units-per-px record.
export const factorFor = (renderScales, key) => (renderScales.get(key) || RENDER_SCALE) / RENDER_SCALE;
export const uppFor = (scales, renderScales, key) => {
  const u = scales[key];
  return u == null ? null : u / factorFor(renderScales, key);
};
