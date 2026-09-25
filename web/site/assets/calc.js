// Pure math behind the public calculator pages (/tools/*). No DOM: the pages'
// calc-ui.js wires inputs to these, and web/test/siteCalc.test.ts pins them.
// Waste follows the canvas report (web/src/lib/totals.js): ordered = net ×
// (1 + waste%), applied once, never to the measured number itself.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const pos = (v) => Math.max(0, num(v));
const round = (v, d = 2) => {
  const f = 10 ** d;
  return Math.round((v + Number.EPSILON) * f) / f;
};

/** Square feet ↔ square yards. 1 SY = 9 SF exactly. */
export function sfToSy(sf) {
  return pos(sf) / 9;
}
export function syToSf(sy) {
  return pos(sy) * 9;
}

/**
 * Tile / plank / sheet order in packages. Net, waste and attic stock are kept
 * as separate lines (both are percentages of NET, never compounded), then the
 * required quantity rounds up to whole packages.
 */
export function packageOrder({ netSf, wastePct = 0, atticPct = 0, packageSf }) {
  const net = pos(netSf);
  const waste = net * (pos(wastePct) / 100);
  const attic = net * (pos(atticPct) / 100);
  const required = net + waste + attic;
  const per = pos(packageSf);
  const packages = per > 0 ? Math.ceil(round(required / per, 6)) : 0;
  const ordered = packages * per;
  return {
    net: round(net),
    waste: round(waste),
    attic: round(attic),
    required: round(required),
    packages,
    ordered: round(ordered),
    rounding: round(Math.max(0, ordered - required)),
    requiredSy: round(required / 9),
  };
}

/**
 * Broadloom cuts for one rectangular room, full-width drops only. Each drop
 * runs the room's length in the chosen direction, plus the trim allowance,
 * rounded UP to the next whole pattern repeat when one is given. No offcut
 * reuse between drops or rooms — the canvas's roll-goods layout nests cuts;
 * this is the single-room check an estimator does by hand.
 */
export function rollCut({ runFt, acrossFt, rollWidthFt, trimIn = 0, repeatIn = 0 }) {
  const run = pos(runFt);
  const across = pos(acrossFt);
  const roll = pos(rollWidthFt);
  if (!run || !across || !roll) return null;
  const drops = Math.ceil(round(across / roll, 6));
  const rawIn = run * 12 + pos(trimIn);
  const rep = pos(repeatIn);
  const dropIn = rep > 0 ? Math.ceil(round(rawIn / rep, 6)) * rep : rawIn;
  const dropFt = dropIn / 12;
  const cutLf = drops * dropFt;
  const cutSf = cutLf * roll;
  const netSf = run * across;
  return {
    drops,
    dropFt: round(dropFt, 4),
    cutLf: round(cutLf),
    cutSf: round(cutSf),
    cutSy: round(cutSf / 9),
    netSf: round(netSf),
    netSy: round(netSf / 9),
    seams: drops - 1,
    seamLf: round((drops - 1) * run),
    // share of the cut that is not floor: trim, repeat and the unused strip
    wastePct: cutSf > 0 ? round(((cutSf - netSf) / cutSf) * 100, 1) : 0,
  };
}

/**
 * Both roll directions for a room, cheaper (fewer SY) first. Ties go to fewer
 * seams, then to running along the room's length.
 */
export function rollCutBoth({ lengthFt, widthFt, rollWidthFt, trimIn = 0, repeatIn = 0 }) {
  const along = rollCut({ runFt: lengthFt, acrossFt: widthFt, rollWidthFt, trimIn, repeatIn });
  const across = rollCut({ runFt: widthFt, acrossFt: lengthFt, rollWidthFt, trimIn, repeatIn });
  if (!along || !across) return null;
  const opts = [
    { direction: "length", ...along },
    { direction: "width", ...across },
  ];
  opts.sort((a, b) => a.cutSy - b.cutSy || a.seams - b.seams);
  return opts;
}

/**
 * Wall base: perimeter less door and cased openings, plus waste, rounded up to
 * whole pieces (a stick length or a coil length).
 */
export function baseOrder({ perimeterLf, openings = 0, openingWidthFt = 3, wastePct = 0, pieceLf }) {
  const perim = pos(perimeterLf);
  const deduct = Math.min(perim, Math.floor(pos(openings)) * pos(openingWidthFt));
  const net = perim - deduct;
  const waste = net * (pos(wastePct) / 100);
  const required = net + waste;
  const per = pos(pieceLf);
  const pieces = per > 0 ? Math.ceil(round(required / per, 6)) : 0;
  return {
    perimeter: round(perim),
    deduct: round(deduct),
    net: round(net),
    waste: round(waste),
    required: round(required),
    pieces,
    ordered: round(pieces * per),
  };
}

/** Feet-and-inches display, e.g. 14.5 → 14′-6″ (inches rounded to 1/4″). */
export function ftIn(feet) {
  const total = Math.round(pos(feet) * 12 * 4) / 4;
  let ft = Math.floor(total / 12);
  let inch = round(total - ft * 12, 2);
  if (inch >= 12) {
    ft += 1;
    inch = 0;
  }
  return `${ft}′-${inch}″`;
}
