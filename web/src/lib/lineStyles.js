// Shared line-style primitive — the single source of truth for dash patterns so
import i18n from '../i18n/index.js';
const t = (key) => i18n.t(key, { ns: 'lib' });
// the canvas (SVG strokeDasharray) and the marked-set PDF (pdf-lib dashArray)
// never drift, plus a dark-mode lighten used for arbitrary user colors on the
// dark canvas / dark marked sheets. Pure, no DOM — the CI-testable surface.

// Raw dash patterns in base units: page points for the PDF, and divided by the
// stage scale for the screen-relative SVG convention (`${n/z}` everywhere).
// `solid` carries no pattern.
export const getLineStyles = () => ({
  solid: { label: t("line_style.solid"), dash: null },
  dashed: { label: t("line_style.dashed"), dash: [6, 4] },
  dotted: { label: t("line_style.dotted"), dash: [1, 3] },
  dashdot: { label: t("line_style.dashdot"), dash: [8, 3, 1, 3] },
});
export const LINE_STYLES = getLineStyles();

export const LINE_STYLE_IDS = Object.keys(LINE_STYLES);

// SVG strokeDasharray string for a style, screen-relative (divided by the stage
// scale, matching the `${n/z}` sizing used across the canvas). Returns undefined
// for solid/unknown — NEVER "" or []: React drops an undefined attribute, so a
// solid outline gets no strokeDasharray at all.
export function dashArrayFor(style, scale = 1) {
  const pat = getLineStyles()[style]?.dash;
  if (!pat || !pat.length) return undefined;
  const s = scale || 1;
  return pat.map((n) => n / s).join(" ");
}

// pdf-lib dashArray (page-point units, no scale). Returns undefined for
// solid/unknown — pdf-lib's line() guards `dash ? { dashArray: dash } : {}`,
// and an empty array is TRUTHY, so returning [] would pass `dashArray: []` and
// draw nothing / warn. A fixed pattern reads slightly denser on larger sheets
// (page-point units), acceptable and consistent with the raw cloud dash.
export function pdfDashFor(style) {
  const pat = getLineStyles()[style]?.dash;
  if (!pat || !pat.length) return undefined;
  return pat.slice();
}

// ── markup line-weight multiplier ────────────────────────────────────────────
// `weight` is a MULTIPLIER over each element's existing base stroke width (so
// box proportions survive — a scalar absolute would flatten them). Default 1,
// clamped to [WEIGHT_MIN, WEIGHT_MAX]; absent/garbage → 1 (legacy markups render
// exactly as before). Applied on canvas AND in the marked-set PDF, and to the
// selection-halo widths so a heavy stroke never overruns the halo rings.
export const WEIGHT_MIN = 0.5;
export const WEIGHT_MAX = 3;
export const WEIGHT_STEPS = [0.5, 1, 1.5, 2, 2.5, 3];
export function clampWeight(w) {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, n));
}
// snap a (clamped) weight to the nearest UI step — so a select bound to it always
// matches an <option> even for an off-step value imported from external JSON.
export function snapWeight(w) {
  const c = clampWeight(w);
  return WEIGHT_STEPS.reduce((a, b) => (Math.abs(b - c) < Math.abs(a - c) ? b : a));
}

// ── dark-mode color boost ────────────────────────────────────────────────────
// A user color from PALETTE can be an arbitrary dark navy/ink; drawn as a flat
// literal it vanishes on the dark canvas (#0b0e14) and dark marked sheets. This
// lightens it in HSL preserving hue — and ONLY when it's actually dark, so light
// colors pass through untouched and distinct dark colors don't all wash to the
// same pale tone (PALETTE is user data). Opacity can't rescue a dark stroke, so
// this is a genuine lighten, not an alpha bump.

function parseHex(hex) {
  const s = String(hex || "").replace("#", "").trim();
  const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.padEnd(6, "0").slice(0, 6);
  const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return [0.5, 0.5, 0.5];
  return [r / 255, g / 255, b / 255];
}
const toHex2 = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");

// h in [0,360), s/l in [0,1]
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}
// perceptual relative luminance
export function luminance(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const DARK_LUM_THRESHOLD = 0.5; // only lighten colors dimmer than this
const DARK_MIN_L = 0.62;        // floor HSL lightness so a dark stroke reads on #0b0e14

// Return a hex string lightened for the dark canvas, or the input unchanged when
// it's already light enough. Hue + saturation are preserved.
const isHexColor = (h) => typeof h === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(h.trim());
export function boostForDark(hex) {
  // per-markup color is user data (can arrive via imported/hand-edited JSON), so a
  // malformed value must never leak out as an invalid CSS/SVG color — coerce to grey.
  if (luminance(hex) >= DARK_LUM_THRESHOLD) return isHexColor(hex) ? hex.trim() : "#888888";
  const [r, g, b] = parseHex(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h, s, Math.max(l, DARK_MIN_L));
  return "#" + toHex2(nr) + toHex2(ng) + toHex2(nb);
}
