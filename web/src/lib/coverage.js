// Vendor-neutral coverage helpers. Values are generic industry-typical spread
import { M_PER_FT, M2_PER_SF, MM_PER_IN } from "./units";
import i18n from '../i18n/index.js';
const _t = (key) => i18n.t(key, { ns: 'lib' });
// rates for estimating — always verify against the product data sheet.
export function materialKind(m) {
  if (m?.kind) return m.kind;
  const n = m?.name || "";
  if (/mortar|thin-?set/i.test(n)) return "mortar";
  if (/grout/i.test(n)) return "grout";
  if (/adhes|glue|bond|mastic/i.test(n)) return "adhesive";
  return "";
}
export const getMaterialPresets = () => ({
  adhesive: [                              // SF per gallon
    { preset_id: "adhesive_1_16_1_32", label: _t("preset.adhesive_1_16_1_32"), per: 200 },
    { preset_id: "adhesive_nap", label: _t("preset.adhesive_nap"), per: 300 },
    { preset_id: "adhesive_1_16_sq", label: _t("preset.adhesive_1_16_sq"), per: 150 },
    { preset_id: "adhesive_1_8_sq", label: _t("preset.adhesive_1_8_sq"), per: 100 },
    { preset_id: "adhesive_3_16_v", label: _t("preset.adhesive_3_16_v"), per: 60 },
    { preset_id: "adhesive_1_4_v", label: _t("preset.adhesive_1_4_v"), per: 50 },
    { preset_id: "adhesive_1_2_v", label: _t("preset.adhesive_1_2_v"), per: 40 },
  ],
  mortar: [                                // SF per 50-lb bag
    { preset_id: "mortar_1_4_sq", label: _t("preset.mortar_1_4_sq"), per: 90 },
    { preset_id: "mortar_3_8_sq", label: _t("preset.mortar_3_8_sq"), per: 65 },
    { preset_id: "mortar_1_2_sq", label: _t("preset.mortar_1_2_sq"), per: 42 },
    { preset_id: "mortar_3_4_u", label: _t("preset.mortar_3_4_u"), per: 30 },
  ],
});
export const MATERIAL_PRESETS = getMaterialPresets();

// Look up a preset by its stable id across locales.  Returns the preset
// object or undefined.  Calling code should fall back to a label-based
// match for legacy materials that only carry `note` (no `preset_id`).
export const findPresetById = (presetId) => {
  if (!presetId) return undefined;
  for (const list of Object.values(MATERIAL_PRESETS)) {
    const hit = list.find((p) => p.preset_id === presetId);
    if (hit) return hit;
  }
  return undefined;
};

// Find a preset whose label matches `note` in ANY supported locale.
// Legacy materials that predate the `preset_id` field only carry a `note`
// whose value is the label as it was when the user selected the preset.
// If the user later switches locales, `p.label` (the current locale's
// translation) no longer matches — so we check every locale's translation.
// Uses a static labels map for reliability (i18n may not be initialized in
// test environments); the runtime i18n.t fallback covers any future locale
// additions without a code change.
const PRESET_ALL_LABELS = {
  adhesive_1_16_1_32: ["1/16″×1/32″×1/32″ U (PSA)", "1/16″×1/32″×1/32″ U (PSA)"],
  adhesive_nap:       ["1/4″ nap roller (PSA)", "Rolo 1/4″ nap (PSA)"],
  adhesive_1_16_sq:   ["1/16″×1/16″×1/16″ sq", "1/16″×1/16″×1/16″ quad"],
  adhesive_1_8_sq:    ["1/8″×1/8″×1/8″ sq", "1/8″×1/8″×1/8″ quad"],
  adhesive_3_16_v:    ["3/16″ V (wood)", "3/16″ V (madeira)"],
  adhesive_1_4_v:     ["1/4″×1/4″ V (wood)", "1/4″×1/4″ V (madeira)"],
  adhesive_1_2_v:     ["1/2″×1/2″ V (wood, coarse)", "1/2″×1/2″ V (madeira, grossa)"],
  mortar_1_4_sq:      ["1/4″×1/4″×1/4″ sq", "1/4″×1/4″×1/4″ quad"],
  mortar_3_8_sq:      ["1/4″×3/8″×1/4″ sq", "1/4″×3/8″×1/4″ quad"],
  mortar_1_2_sq:      ["1/2″×1/2″×1/2″ sq", "1/2″×1/2″×1/2″ quad"],
  mortar_3_4_u:       ["3/4″ U (large tile)", "3/4″ U (telha grande)"],
};
export const findPresetByNote = (note) => {
  if (!note) return undefined;
  const normalized = note.trim().toLowerCase();
  for (const list of Object.values(MATERIAL_PRESETS)) {
    for (const p of list) {
      // Static map: check every locale's label
      const labels = PRESET_ALL_LABELS[p.preset_id];
      if (labels && labels.some((l) => l.toLowerCase() === normalized)) return p;
      // Runtime fallback: i18n.t covers any locale added after this file was edited
      const locales = i18n.options?.supportedLngs || [];
      for (const lng of locales) {
        const localeLabel = i18n.t(`preset.${p.preset_id}`, { lng, ns: "lib" });
        if (localeLabel && localeLabel.toLowerCase() === normalized) return p;
      }
    }
  }
  return undefined;
};

// Material coverage rates are persisted in canonical SF/LF per unit. These
// helpers are the display/input edge for the UI and human-readable exports;
// totals and JSON/API payloads continue to consume the canonical value.
export function coverageRateForDisplay(per, basis = "area", units = "imperial") {
  const n = Number(per) || 0;
  if (units !== "metric") return n;
  return basis === "linear" || basis === "seam_lf" ? n * M_PER_FT : basis === "count" ? n : n * M2_PER_SF;
}

export function coverageRateToCanonical(value, basis = "area", units = "imperial") {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (units !== "metric") return n;
  return basis === "linear" || basis === "seam_lf" ? n / M_PER_FT : basis === "count" ? n : n / M2_PER_SF;
}
export const GROUT_DENSITY = 8.33;         // industry-standard grout density factor
export const GROUT_DEFAULTS = { tileL: 12, tileW: 24, tileT: 0.375, joint: 0.125, bagLbs: 25 };
export const GROUT_PARAM_KEYS = ["tileL", "tileW", "tileT", "joint", "bagLbs"];
// lbs/SF = ((L+W)/(L×W)) × thickness_in × joint_in × density; coverage = bag ÷ lbs/SF
export function groutCoverageSfPerBag({ tileL, tileW, tileT, joint, bagLbs, density = GROUT_DENSITY }) {
  if (!(tileL > 0) || !(tileW > 0) || !(tileT > 0) || !(joint > 0) || !(bagLbs > 0)) return 0;
  return bagLbs / (((tileL + tileW) / (tileL * tileW)) * tileT * joint * density);
}

// Structural equality over the five geometry params — the invariant is
// "equal iff the editor RENDERS them identically". PRESENCE comes first
// (round-3 finding 4): the render gate below shows a CALCULATOR for a line
// WITH geometry and a derive BUTTON for one without, so absent-vs-present can
// never be equal — deriving defaults on a linked line whose entry has no
// geometry must amber the geometry row (and the row's ↺ trio-revert heals
// it). Both absent → equal. Both present → both sides go through the
// editor's own merge ({ ...GROUT_DEFAULTS, ...grout }): an absent key
// renders (and compares) as its default, while a present-but-junk value
// (null, 0, NaN — a poisoned library entry) renders blank and compares as 0,
// NOT as the default it visibly isn't. Never compares by reference.
export const groutParamsEqual = (a, b) => {
  if (!!a !== !!b) return false; // exactly one side absent — rendered as button vs calculator, never equal
  if (!a && !b) return true;
  const A = { ...GROUT_DEFAULTS, ...a }, B = { ...GROUT_DEFAULTS, ...b };
  return GROUT_PARAM_KEYS.every((k) => (Number(A[k]) || 0) === (Number(B[k]) || 0));
};

// The grout calculator's render gate: the tile-geometry row appears ONLY when
// the line actually HAS geometry (m.grout truthy) — a kind:"grout" line
// without it (e.g. a library entry whose geometry was detached by a hand
// per-edit, then pushed/attached) must show its pushed rate untouched, with an
// explicit "derive from tile geometry" affordance instead of a calculator
// silently backfilled with defaults, where one keystroke would commit the
// whole default object over the pushed rate.
export const showsGroutCalc = (m) =>
  materialKind(m) === "grout" && (m.basis || "area") === "area" && !!m.grout;
export const showsGroutDeriveAffordance = (m) =>
  materialKind(m) === "grout" && (m.basis || "area") === "area" && !m.grout;

// Inches → drawing-style fraction (0.375 → "3/8", 1.25 → "1 1/4"); falls back
// to the decimal when the value isn't on the 1/32″ grid.
export function inFrac(v) {
  const n32 = Math.round(v * 32);
  if (!(n32 > 0) || Math.abs(v * 32 - n32) > 1e-6) return String(v);
  let n = n32, d = 32;
  while (n % 2 === 0 && d % 2 === 0) { n /= 2; d /= 2; }
  const whole = Math.floor(n / d), rem = n - whole * d;
  if (!rem) return String(whole);
  return whole ? `${whole} ${rem}/${d}` : `${rem}/${d}`;
}
export const groutNote = (g, units = "imperial") => {
  if (units === "metric") {
    const tl = Math.round((g.tileL || 0) * MM_PER_IN);
    const tw = Math.round((g.tileW || 0) * MM_PER_IN);
    const tt = Math.round((g.tileT || 0) * MM_PER_IN);
    const jw = Math.round((g.joint || 0) * MM_PER_IN * 10) / 10;
    return `${tl}×${tw}×${tt} mm @ ${jw} mm · ${g.bagLbs} lb`;
  }
  return `${g.tileL}×${g.tileW}×${inFrac(g.tileT)}″ @ ${inFrac(g.joint)}″ · ${g.bagLbs} lb`;
};

// The { per } patch a grout-geometry edit derives, or null when the
// geometry is incomplete/invalid (a cleared input mid-edit, a zero, NaN) —
// callers must KEEP the last good per rather than commit a rate of 0
// that silently zeroes the line's quantity in the buy list and every export.
// Small rates keep two decimals so mosaic-scale coverages (e.g. 2.49 SF/bag)
// don't round away up to ~20% of the order — and never floor to 0.
//
// NOTE: grout notes are NOT persisted — they are format-specific and derived
// at render time via groutDisplayNote(). This prevents stale unit-formatted
// text when the user switches between Imperial and SI.
export function groutDerivedFields(grout) {
  const rate = groutCoverageSfPerBag(grout);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const per = rate >= 10 ? Math.round(rate) : Math.round(rate * 100) / 100;
  if (!(per > 0)) return null;
  return { per };
}

// Display-only grout note: format the canonical (inch-stored) grout geometry
// into a human-readable string in the current unit system. The note is derived
// from m.grout at render time, never persisted — so switching units instantly
// updates every grout note in the UI and exports without a data migration.
export function groutDisplayNote(m, units = "imperial") {
  if (m?.grout) return groutNote(m.grout, units);
  return m?.note || "";
}
