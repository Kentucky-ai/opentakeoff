// Vendor-neutral coverage helpers. Values are generic industry-typical spread
// rates for estimating — always verify against the product data sheet.
export function materialKind(m) {
  if (m?.kind) return m.kind;
  const n = m?.name || "";
  if (/mortar|thin-?set/i.test(n)) return "mortar";
  if (/grout/i.test(n)) return "grout";
  if (/adhes|glue|bond|mastic/i.test(n)) return "adhesive";
  // Edge/cap profiles, LAST so it can't eat an adhesive whose name mentions a trim.
  // These are stick goods: they are bought by the LENGTH OF STICK, not by a spread
  // rate, which is why they get their own preset family below.
  if (/\btrim\b|\bprofile\b|top cap|edge cap|nosing|\bschiene\b|reducer/i.test(n)) return "trim";
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
  // LF per stick. Edge and cap profiles are stick goods, so the "coverage" that
  // divides a linear measure is simply the stock length — an odd-looking rate to
  // type from memory (8.2, not 8), and the reason tile base capped with an edge
  // profile kept getting ordered a stick short. Metric stock lengths dominate:
  // 2.5 m = 8.202 LF, 3 m = 9.843, 1.5 m = 4.921.
  trim: [                                  // LF per stick
    { label: "2.5 m stick (8′ 2-1/2″)", per: 8.202 },
    { label: "3 m stick (9′ 10″)",      per: 9.843 },
    { label: "1.5 m stick (4′ 11″)",    per: 4.921 },
    { label: "8 ft stick",              per: 8 },
    { label: "10 ft stick",             per: 10 },
    { label: "12 ft stick",             per: 12 },
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

// ── tile base: the same formula on a line measured in LINEAR feet ────────────
// Tile base (a cove or bullnose course, or field tile ripped to height and
// capped with a trim profile) is measured in LF, but grout is consumed per SF
// of the face being set. Two facts turn one into the other:
//
//  • A single course grouted at the floor line has joint density 1/W + 1/H per
//    inch of face — which IS (H+W)/(H·W), the field-tile term for a tile of
//    dimensions H × W. So the "tile" fed to the formula is the BASE PIECE: its
//    long dimension is the piece height, its short one the piece width. No new
//    formula, no joint-density parameter — the field one, fed the right piece.
//  • Face SF per LF of run is the base height IN FEET (a 6″ base is 0.5 SF of
//    face per LF). So sf/bag ÷ height_ft = lf/bag.
//
// The base HEIGHT belongs to the condition (height_ft) and is read-only in the
// geometry block — two owners of one number drift, and a 6″ base whose block
// still says 4″ prices a joint that isn't there. The piece height defaults to it
// (see baseGroutParams) and is only worth typing for multi-course base.
//
// The WIDTH is always the estimator's, and it is the input that bites: for
// field-cut base it is the parent tile dimension that was NOT ripped. A 6″ base
// off a 12×24 is 6H × 24W (615 lf/bag); read as 6H × 12W it is 512, a 20%
// over-order, and read as a 6×6 catalog piece it is 384 — 60% over.
const GROUT_BASES = new Set(["area", "linear"]);
export const isLinearGrout = (m) => (m?.basis || "area") === "linear";

// The grout calculator's render gate: the tile-geometry row appears ONLY when
// the line actually HAS geometry (m.grout truthy) — a kind:"grout" line
// without it (e.g. a library entry whose geometry was detached by a hand
// per-edit, then pushed/attached) must show its pushed rate untouched, with an
// explicit "derive from tile geometry" affordance instead of a calculator
// silently backfilled with defaults, where one keystroke would commit the
// whole default object over the pushed rate.
export const showsGroutCalc = (m) =>
  materialKind(m) === "grout" && GROUT_BASES.has(m.basis || "area") && !!m.grout;
export const showsGroutDeriveAffordance = (m) =>
  materialKind(m) === "grout" && GROUT_BASES.has(m.basis || "area") && !m.grout;

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
// A base line's note names the two dimensions for what they ARE — height and piece
// width — because "6×24" alone reads as a tile and hides the derivation the estimator
// is being asked to confirm.
export const baseGroutNote = (g) =>
  `${inFrac(g.tileL)}″H × ${inFrac(g.tileW)}″W pc × ${inFrac(g.tileT)}″ @ ${inFrac(g.joint)}″ · ${g.bagLbs} lb`;

// Height (ft) → the tile-geometry object the formula takes for a base line. tileL is the
// PIECE height and defaults to the base height (one course spanning it — the catalog-cove
// and field-cut case), deriving rather than storing so it can't drift from the condition.
//
// It stays honoured when the estimator states something SHORTER, because multi-course base
// breaks the single-course identity: a 6″ band of 2×2 mosaic is three courses with two
// interior horizontal joints, and read as one 6″×2″ piece it understates the grout by a
// third. At or above the base height (or unset) the base height wins.
export const baseGroutParams = (grout, heightFt) => {
  const hIn = Number(heightFt) > 0 ? Number(heightFt) * 12 : 0;
  if (!hIn) return grout;
  const pieceH = Number(grout?.tileL);
  return pieceH > 0 && pieceH < hIn ? grout : { ...grout, tileL: hIn };
};
// Courses in the base — 1 unless a shorter piece is stated. Display only: a fractional
// last course is a CUT (waste), never more grout.
export const baseCourses = (grout, heightFt) => {
  const hIn = Number(heightFt) > 0 ? Number(heightFt) * 12 : 0;
  const pieceH = Number(grout?.tileL);
  return hIn && pieceH > 0 && pieceH < hIn ? hIn / pieceH : 1;
};

// A base grout line's rate depends on FOUR inputs, and only three of them live on the
// row: the geometry (row), the bag (row), the joint (row) — and the base HEIGHT, which
// lives on the condition. So unlike a field-tile line, this one can go stale without
// anything on it changing. The case: a library entry derived at a 6″ base attached to a
// 4″ base condition — per/note/grout all match the entry, nothing ambers, and a rate
// figured for a taller base rides a shorter one. This is the same "a row must never
// contradict its own calculator" invariant materials.js states for the per/note/grout
// trio, extended to the input that isn't on the row. Area lines can't go stale this way
// and always report false. `true` = show it and let the estimator re-derive; never
// auto-correct, because silently rewriting a rate he typed is the other failure.
export function groutRateStale(m, heightFt) {
  if (!isLinearGrout(m) || materialKind(m) !== "grout" || !m?.grout) return false;
  const d = groutDerivedFields(m.grout, "linear", heightFt);
  if (!d) return Number(m.per) > 0;   // not figurable at all, yet the line carries a rate
  return (Number(m.per) || 0) !== d.per;
}

// The { per, note } patch a grout-geometry edit derives, or null when the
// geometry is incomplete/invalid (a cleared input mid-edit, a zero, NaN) —
// callers must KEEP the last good per + note rather than commit a rate of 0
// that silently zeroes the line's quantity in the buy list and every export.
// Small rates keep two decimals so mosaic-scale coverages (e.g. 2.49 SF/bag)
// don't round away up to ~20% of the order — and never floor to 0.
// On a LINEAR (tile base) line the rate is lf/bag and needs the condition's height —
// omit it, or pass 0, and this returns null, which is the same "keep the last good
// per + note" contract as any other incomplete geometry. That is deliberate: a base
// line whose condition has no height is NOT figurable, and writing the raw sf/bag onto
// an LF-measured line is the exact bug this conversion exists to prevent.
export function groutDerivedFields(grout, basis = "area", heightFt = 0) {
  const linear = (basis || "area") === "linear";
  const h = Number(heightFt) || 0;
  if (linear && !(h > 0)) return null;
  const g = linear ? baseGroutParams(grout, h) : grout;
  const sf = groutCoverageSfPerBag(g);
  if (!Number.isFinite(sf) || sf <= 0) return null;
  const rate = linear ? sf / h : sf;
  const per = rate >= 10 ? Math.round(rate) : Math.round(rate * 100) / 100;
  if (!(per > 0)) return null;
  return { per, note: linear ? baseGroutNote(g) : groutNote(g) };
}
