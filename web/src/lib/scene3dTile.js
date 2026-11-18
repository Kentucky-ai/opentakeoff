// SPDX-License-Identifier: AGPL-3.0-only
// TILE IN 3D — a tile condition's GROUT GRID, drawn as a repeating texture on its floors at the
// size and joint the condition states (condition.tile_spec, or a size in a finish build-up row).
// No size stated → no grid, just the finish colour. Nothing here lays or counts tile.
// From Michael Edlin's Spline 3D viewer (2026), ported to OpenTakeoff.

export const DEFAULT_JOINT_IN = 1 / 8;       // GROUT_DEFAULTS' 1/8" — the same assumption the doc parser carries

const GROUT_WORDS = [
  [/BRIGHT\s*WHITE|\bWHITE\b|SNOW|ARCTIC/i, "#f1f0ec"],
  [/CHARCOAL|DARK\s*GR[AE]Y|GRAPHITE|SLATE|IRON/i, "#4d5157"],
  [/\bBLACK\b|ONYX|EBONY/i, "#26272a"],
  [/LIGHT\s*GR[AE]Y|PEARL|SILVER|MIST|FROST/i, "#cbcdcf"],
  [/GR[AE]Y|PEWTER|STONE|DOVE/i, "#9fa3a7"],
  [/BONE|BEIGE|ALMOND|SAND|BISCUIT|IVORY|LINEN|CREAM|TAN|KHAKI/i, "#d9cdb4"],
  [/BROWN|MOCHA|COCOA|WALNUT|ESPRESSO|CHOCOLATE/i, "#7a5c45"],
];
export const DEFAULT_GROUT_COLOR = "#b8b4ab";   // a warm mid grey, labelled assumed

// The grout colour a document names, in words, as a swatch — else the default, flagged.
export function groutColorOf(text) {
  const t = String(text || "");
  for (const [re, hex] of GROUT_WORDS) if (re.test(t)) return { color: hex, stated: true, text: t };
  return { color: DEFAULT_GROUT_COLOR, stated: false, text: t };
}

const val = (f) => (f && typeof f === "object" && "value" in f ? f.value : f);

/**
 * A condition's grout grid from its tile_spec, or null when no size is stated.
 *   { wFt, hFt, jointFt, pattern: "stacked"|"running", patternText, grout:{color, stated},
 *     jointStated, sizeText, cite }
 * Wall faces lay w along the wall and h up it; floors lay w along x (east) and h along y.
 * Only stacked and running bond draw as a grid; any other stated pattern (herringbone, basket…)
 * draws stacked and says so — the laid pieces come from the tile engine, never from here.
 */
const SIZE_RE = /(\d+(?:\.\d+)?)\s*["”]?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*["”]?/;
// no size in the documents: the estimator's own finish row may name one ("… 12x24 vertical
// offset") — used, and labelled as the build-up's, never as the documents'
function buildupSize(cond) {
  const fin = (cond?.buildup || []).find((r) => r && r.role === "finish" && SIZE_RE.test(String(r.item || "")));
  if (!fin) return null;
  const m = String(fin.item).match(SIZE_RE);
  const grout = (cond.buildup || []).find((r) => r?.grout && Number(r.grout.joint_in) > 0);
  return { w: Number(m[1]), h: Number(m[2]), joint: grout ? Number(grout.grout.joint_in) : null, pattern: String(fin.item).replace(SIZE_RE, " ").match(/OFFSET|RUNNING|BRICK|STACK|HERRINGBONE|BASKET/i)?.[0] || "", item: fin.item };
}
// OpenTakeoff conditions carry no tile_spec: a tile-type condition whose name states a size
// ("PT-1 Porcelain 12x24") draws that size, labelled as the condition name's
const TILE_TYPES = /ceramic|porcelain|tile|stone|quarry|mosaic/i;
function nameSize(cond) {
  const text = `${cond?.name || ""} ${cond?.finish_tag || ""}`;
  if (!TILE_TYPES.test(`${cond?.flooring_type || ""} ${text}`)) return null;
  const m = text.match(SIZE_RE);
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]), joint: null, pattern: text.replace(SIZE_RE, " ").match(/OFFSET|RUNNING|BRICK|STACK/i)?.[0] || "", item: text.trim(), fromName: true };
}
export function tileGridOf(cond) {
  const ts = cond?.tile_spec;
  const nom = val(ts?.nominal);
  let w = Number(nom?.w_in), h = Number(nom?.h_in), from = "documents";
  let jIn = Number(val(ts?.joint_in)), ptext = String(val(ts?.pattern) || "");
  if (!(w > 0) || !(h > 0)) {
    const b = buildupSize(cond) || nameSize(cond);
    if (!b) return null;
    w = b.w; h = b.h; from = `${b.fromName ? "the condition" : "build-up"} ("${b.item}")`;
    if (!(jIn > 0) && b.joint > 0) jIn = b.joint;
    if (!ptext) ptext = b.pattern;
  }
  // "horizontal stack" / "vertical offset": the long side runs that way, whatever order the size was written in
  if (/HORIZ/i.test(ptext) && h > w) [w, h] = [h, w];
  else if (/VERT/i.test(ptext) && w > h) [w, h] = [h, w];
  const joint = jIn > 0 ? jIn : DEFAULT_JOINT_IN;
  const running = /RUNNING|OFFSET|BRICK|1\s*\/\s*[23]|THIRD|HALF/i.test(ptext);
  const grout = groutColorOf(val(ts?.grout_color));
  return {
    wFt: w / 12, hFt: h / 12, jointFt: joint / 12, jointIn: joint,
    pattern: running ? "running" : "stacked", patternText: ptext || "stacked (none stated)",
    patternApprox: !!ptext && !running && !/STACK|GRID|STRAIGHT/i.test(ptext),
    grout, jointStated: jIn > 0 && ts?.joint_in?.status !== "assumed", from,
    sizeText: `${fmtIn(w)}×${fmtIn(h)}`, cite: ts?.nominal?.cite || null,
  };
}
function fmtIn(v) { return `${Math.round(v * 100) / 100}"`; }
