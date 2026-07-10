// Vendor-neutral coverage helpers. Values are generic industry-typical spread
// rates for estimating — always verify against the product data sheet.
export function materialKind(m) {
  if (m?.kind) return m.kind;
  const n = m?.name || "";
  if (/mortar|thin-?set/i.test(n)) return "mortar";
  if (/grout/i.test(n)) return "grout";
  if (/adhes|glue|bond|mastic/i.test(n)) return "adhesive";
  return "";
}
export const MATERIAL_PRESETS = {
  adhesive: [                              // SF per gallon
    { label: '1/16″×1/32″×1/32″ U (PSA)', per: 200 },
    { label: '1/4″ nap roller (PSA)',      per: 300 },
    { label: '1/16″×1/16″×1/16″ sq',       per: 150 },
    { label: '1/8″×1/8″×1/8″ sq',          per: 100 },
    { label: '3/16″ V (wood)',             per: 60 },
    { label: '1/4″×1/4″ V (wood)',         per: 50 },
    { label: '1/2″×1/2″ V (wood, coarse)', per: 40 },
  ],
  mortar: [                                // SF per 50-lb bag
    { label: '1/4″×1/4″×1/4″ sq', per: 90 },
    { label: '1/4″×3/8″×1/4″ sq', per: 65 },
    { label: '1/2″×1/2″×1/2″ sq', per: 42 },
    { label: '3/4″ U (large tile)', per: 30 },
  ],
};
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
export const groutNote = (g) => `${g.tileL}×${g.tileW}×${inFrac(g.tileT)}″ @ ${inFrac(g.joint)}″ · ${g.bagLbs} lb`;

// The { per, note } patch a grout-geometry edit derives, or null when the
// geometry is incomplete/invalid (a cleared input mid-edit, a zero, NaN) —
// callers must KEEP the last good per + note rather than commit a rate of 0
// that silently zeroes the line's quantity in the buy list and every export.
// Small rates keep two decimals so mosaic-scale coverages (e.g. 2.49 SF/bag)
// don't round away up to ~20% of the order — and never floor to 0.
export function groutDerivedFields(grout) {
  const rate = groutCoverageSfPerBag(grout);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const per = rate >= 10 ? Math.round(rate) : Math.round(rate * 100) / 100;
  if (!(per > 0)) return null;
  return { per, note: groutNote(grout) };
}
