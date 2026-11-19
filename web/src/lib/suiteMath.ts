// Trade-suite quantity math — pure, no DOM, no React, no session.
//
// Every function here turns quantities the estimator (or an agent) already
// measured — plan areas, plan lengths, counts, elevation rings — into the
// trade quantities that follow from them: sloped roof area, true hip length,
// lap-siding pieces, soffit area, mullion lengths, wire footage, hangers.
// Nothing here measures a drawing and nothing here invents an input: a value
// the documents must supply (a roof pitch, a soffit depth, a hanger spacing)
// is a required argument, and an allowance is always reported as one.
//
// Units are feet, square feet and inches where named (_in). Points are [x, y]
// with y DOWN (image space), already in feet: multiply image px by the sheet's
// feet-per-px before calling.

export type Pt = [number, number];

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const ceil = (n: number) => Math.ceil(n - 1e-9);

/** Length of an open polyline. */
export function polylineLength(pts: Pt[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return n;
}

/** A closed ring without a repeated closing point (one is dropped if present). */
function openRing(pts: Pt[]): Pt[] {
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) return pts.slice(0, -1);
  }
  return pts;
}

/** Perimeter of a closed ring. */
export function ringPerimeter(pts: Pt[]): number {
  const p = openRing(pts);
  return p.length < 2 ? 0 : polylineLength([...p, p[0]]);
}

/** Area of a closed ring (shoelace, absolute). */
export function ringAreaSf(pts: Pt[]): number {
  const p = openRing(pts);
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function bbox(pts: Pt[]): { x0: number; y0: number; x1: number; y1: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

// ── Roofing ────────────────────────────────────────────────────────────────

/**
 * A roof pitch as rise per 12 of run. Accepts 6, "6", "6/12", "6:12",
 * "6 in 12", low-slope "1/4 per ft" / "1/4\" per foot" (= 0.25/12),
 * percent ("2%" = 0.24/12), degrees ("22.5 deg", "22.5°"), and
 * ratios ("1:48" = 0.25/12, "1/4:12").
 * Returns null for anything it cannot read — never a guess.
 */
export function parsePitch(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 && raw <= 48 ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/["”″]/g, "");

  // Percent: "2%" -> 2 units rise per 100 run -> rise per 12 is 0.24
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:%|pct|percent)$/);
  if (m) return parsePitch(r4(12 * (Number(m[1]) / 100)));

  // Degrees: "22.5 deg", "22.5°" -> rise per 12 is 12 * tan(angle)
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:°|deg(?:ree)?s?\.?)$/);
  if (m) {
    const deg = Number(m[1]);
    if (deg < 0 || deg >= 90) return null;
    return parsePitch(r3(12 * Math.tan((deg * Math.PI) / 180)));
  }

  // Ratio with fraction rise: "1/4:12", "1/4 in 12", "1/4 / 12"
  m = s.match(/^(\d+)\s*\/\s*(\d+)\s*(?::|\/|in)\s*(\d+(?:\.\d+)?)$/);
  if (m && Number(m[2]) > 0 && Number(m[3]) > 0) {
    const rise = Number(m[1]) / Number(m[2]);
    const run = Number(m[3]);
    return parsePitch(r4(12 * (rise / run)));
  }

  // Low-slope per foot: "1/4 per ft" (= 0.25/12), "1/4\" per foot"
  m = s.match(/^(\d+)\s*\/\s*(\d+)\s*(?:in(?:ch)?\s*)?(?:per|\/)\s*(?:ft|foot|')$/);
  if (m && Number(m[2]) > 0) return parsePitch(Number(m[1]) / Number(m[2]));   // inches of rise per foot = rise per 12

  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:in(?:ch)?\s*)?(?:per|\/)\s*(?:ft|foot|')$/);
  if (m) return parsePitch(Number(m[1]));

  // Ratio: "1:48", "6:12", "4:12" or "1 in 48", "6 in 12"
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?::|in)\s*(\d+(?:\.\d+)?)$/);
  if (m && Number(m[2]) > 0) {
    const rise = Number(m[1]);
    const run = Number(m[2]);
    return parsePitch(r4(12 * (rise / run)));
  }

  // Standard rise over 12: "6/12", "0.25/12"
  m = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*12$/);
  if (m) return parsePitch(Number(m[1]));

  // Plain number: "6", "0" (already rise per 12)
  m = s.match(/^\d+(?:\.\d+)?$/);
  if (m) return parsePitch(Number(s));

  return null;
}

/** Sloped length ÷ plan length for a line running straight up the slope (rakes, and the roof area). */
export const slopeFactor = (risePer12: number) => Math.sqrt(1 + (risePer12 / 12) ** 2);

/** True ÷ plan length for a hip or valley between two planes of the SAME pitch (45° in plan). */
export const hipValleyFactor = (risePer12: number) => Math.sqrt(1 + (risePer12 / 12) ** 2 / 2);

export interface RoofInput {
  /** rise per 12 */
  pitch: number;
  /** plan-view square feet of the roof planes at this pitch */
  plan_sf: number;
  /** plan-view lengths of the typed edges */
  edges: { eave: number; rake: number; ridge: number; hip: number; valley: number };
  /** estimating allowance on the field; absent = the suite allowance (10 %, 15 % with hips or valleys) */
  waste_pct?: number;
  /** self-adhered underlayment band widths (ft, measured up the slope); absent = not figured */
  ice_water?: { eave_ft?: number; valley_ft?: number };
}

export function roofQuantities(inp: RoofInput) {
  const sf = slopeFactor(inp.pitch), hf = hipValleyFactor(inp.pitch);
  const e = inp.edges;
  const cutUp = e.hip + e.valley > 0;
  const waste = inp.waste_pct ?? (cutUp ? 15 : 10);
  const sloped = inp.plan_sf * sf;
  const trueEdges = { eave: e.eave, rake: e.rake * sf, ridge: e.ridge, hip: e.hip * hf, valley: e.valley * hf };
  const iw = inp.ice_water ?? {};
  const iceEave = iw.eave_ft ? trueEdges.eave * iw.eave_ft : 0;
  const iceValley = iw.valley_ft ? trueEdges.valley * iw.valley_ft : 0;
  const notFigured: string[] = [];
  if (!iw.eave_ft) notFigured.push("ice & water at eaves (pass ice_water.eave_ft from the spec or code)");
  if (!iw.valley_ft && e.valley > 0) notFigured.push("ice & water in valleys (pass ice_water.valley_ft)");
  return {
    pitch: `${r2(inp.pitch)}/12`,
    slope_factor: r4(sf),
    hip_valley_factor: r4(hf),
    plan_sf: r2(inp.plan_sf),
    sloped_sf: r2(sloped),
    squares: r2(sloped / 100),
    waste_pct: waste,
    waste_source: inp.waste_pct === undefined ? `suite allowance (${cutUp ? "hips or valleys present" : "no hips or valleys"}) — override with your standard` : "stated",
    squares_with_waste: r2((sloped * (1 + waste / 100)) / 100),
    edges_plan_lf: { eave: r2(e.eave), rake: r2(e.rake), ridge: r2(e.ridge), hip: r2(e.hip), valley: r2(e.valley) },
    edges_true_lf: { eave: r2(trueEdges.eave), rake: r2(trueEdges.rake), ridge: r2(trueEdges.ridge), hip: r2(trueEdges.hip), valley: r2(trueEdges.valley) },
    drip_edge_lf: r2(trueEdges.eave + trueEdges.rake),
    starter_lf: r2(trueEdges.eave),
    ridge_cap_lf: r2(trueEdges.ridge + trueEdges.hip),
    underlayment_sf: r2(sloped),
    ...(iceEave + iceValley > 0 ? { ice_water_sf: r2(iceEave + iceValley) } : {}),
    not_figured: notFigured,
  };
}

// ── Siding ─────────────────────────────────────────────────────────────────

/** The bottom edges of an elevation ring: horizontal edges lying on its lowest line (y is down). */
export function bottomEdges(ring: Pt[], tolFt = 0.5): [Pt, Pt][] {
  const p = openRing(ring);
  if (p.length < 3) return [];
  const maxY = Math.max(...p.map((q) => q[1]));
  const out: [Pt, Pt][] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const flat = Math.abs(a[1] - b[1]) <= tolFt * 0.25 || Math.abs(a[1] - b[1]) <= 0.02 * Math.abs(a[0] - b[0]);
    if (flat && maxY - a[1] <= tolFt && maxY - b[1] <= tolFt) out.push([a, b]);
  }
  return out;
}

/**
 * Starter runs along a wall's bottom edges, with the doors that sit on that
 * line cut out (no starter across a door opening). A bottom edge that lies
 * on another wall shape's edge on the same sheet gets no starter (covers a
 * gable above a wall and a wall split at a floor line). Each run is a 2-point
 * segment in the ring's own units; tol is in those units too.
 */
export function starterRuns(wall: Pt[], doors: Pt[][], tol: number, otherWalls: Pt[][] = []): [Pt, Pt][] {
  const cuts: [number, number, number][] = [];   // [xmin, xmax, y] of each cut
  for (const d of doors) {
    for (const [a, b] of bottomEdges(d, tol)) {
      cuts.push([Math.min(a[0], b[0]), Math.max(a[0], b[0]), (a[1] + b[1]) / 2]);
    }
  }
  for (const w of otherWalls) {
    const p = openRing(w);
    if (p.length < 3) continue;
    const maxY = Math.max(...p.map((q) => q[1]));
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const flat = Math.abs(a[1] - b[1]) <= tol * 0.25 || Math.abs(a[1] - b[1]) <= 0.02 * Math.abs(a[0] - b[0]);
      const isBottom = flat && maxY - a[1] <= tol && maxY - b[1] <= tol;
      if (flat && !isBottom && Math.abs(a[0] - b[0]) > 1e-4) {
        cuts.push([Math.min(a[0], b[0]), Math.max(a[0], b[0]), (a[1] + b[1]) / 2]);
      }
    }
  }
  const out: [Pt, Pt][] = [];
  for (const [a, b] of bottomEdges(wall, tol)) {
    const y = (a[1] + b[1]) / 2;
    let spans: [number, number][] = [[Math.min(a[0], b[0]), Math.max(a[0], b[0])]];
    for (const [c0, c1, cy] of cuts) {
      if (Math.abs(cy - y) > tol) continue;
      spans = spans.flatMap(([s0, s1]) => {
        if (c1 <= s0 || c0 >= s1) return [[s0, s1] as [number, number]];
        const keep: [number, number][] = [];
        if (c0 > s0) keep.push([s0, c0]);
        if (c1 < s1) keep.push([c1, s1]);
        return keep;
      });
    }
    // y along the edge, so a slightly sloped bottom keeps its own line
    const yAt = (x: number) => (b[0] === a[0] ? a[1] : a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]));
    for (const [s0, s1] of spans) if (s1 - s0 >= tol - 1e-6) out.push([[s0, yAt(s0)], [s1, yAt(s1)]]);
  }
  return out;
}

export interface SidingInput {
  /** sheet: only openings on the same sheet cut a wall's starter */
  walls: { id: string; ring: Pt[]; sheet?: string }[];
  /** sides 3 = a door (no trim across the bottom), 4 = a window */
  openings: { id: string; ring: Pt[]; sides: 3 | 4; sheet?: string }[];
  outside_corner_lf?: number;
  inside_corner_lf?: number;
  waste_pct?: number;
  /** lap reveal in inches; with piece_length_ft gives a piece count */
  exposure_in?: number;
  piece_length_ft?: number;
}

export function sidingQuantities(inp: SidingInput) {
  const walls = inp.walls.map((w) => {
    const gross = ringAreaSf(w.ring);
    const doorRings = inp.openings.filter((o) => o.sides === 3 && o.sheet === w.sheet).map((o) => o.ring);
    const otherWalls = inp.walls.filter((o) => o.id !== w.id && o.sheet === w.sheet).map((o) => o.ring);
    const starter = starterRuns(w.ring, doorRings, 0.5, otherWalls).reduce((n, [a, b]) => n + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
    return { id: w.id, gross_sf: r2(gross), starter_lf: r2(starter) };
  });
  const openings = inp.openings.map((o) => {
    const perim = ringPerimeter(o.ring);
    const bottom = o.sides === 3 ? bottomEdges(o.ring).reduce((n, [a, b]) => n + Math.hypot(b[0] - a[0], b[1] - a[1]), 0) : 0;
    return { id: o.id, sf: r2(ringAreaSf(o.ring)), sides: o.sides, trim_lf: r2(perim - bottom) };
  });
  const gross = walls.reduce((n, w) => n + w.gross_sf, 0);
  const open = openings.reduce((n, o) => n + o.sf, 0);
  const net = Math.max(0, gross - open);
  const waste = inp.waste_pct ?? 10;
  const order = net * (1 + waste / 100);
  const pieces = inp.exposure_in && inp.exposure_in > 0 && inp.piece_length_ft && inp.piece_length_ft > 0
    ? ceil(order / ((inp.exposure_in / 12) * inp.piece_length_ft)) : undefined;
  return {
    walls, openings,
    gross_sf: r2(gross), openings_sf: r2(open), net_sf: r2(net),
    squares: r2(net / 100),
    waste_pct: waste,
    waste_source: inp.waste_pct === undefined ? "suite allowance — override with your standard" : "stated",
    order_sf: r2(order), order_squares: r2(order / 100),
    starter_lf: r2(walls.reduce((n, w) => n + w.starter_lf, 0)),
    opening_trim_lf: r2(openings.reduce((n, o) => n + o.trim_lf, 0)),
    outside_corner_lf: r2(inp.outside_corner_lf ?? 0),
    inside_corner_lf: r2(inp.inside_corner_lf ?? 0),
    ...(pieces !== undefined ? { pieces, piece: `${inp.exposure_in}" reveal × ${inp.piece_length_ft}' piece, waste included` } : {}),
  };
}

// ── Soffit & fascia ────────────────────────────────────────────────────────

export interface SoffitInput {
  eave_lf: number;
  /** plan length of rakes; made true with pitch when given */
  rake_plan_lf: number;
  /** horizontal soffit depth at the eaves, inches (from the wall section) */
  overhang_in: number;
  /** soffit depth along the rakes, inches; absent = rake soffit not figured */
  rake_overhang_in?: number;
  pitch?: number;
  /** outside corners where two eave soffits meet (adds a depth × depth square each) */
  outside_corners?: number;
  waste_pct?: number;
  /** attic ventilation: net free area required = attic_sf ÷ ratio (150 or 300), intake share of it */
  vent?: { attic_sf: number; ratio: number; intake_share?: number; nfa_in2_per_lf?: number };
}

export function soffitQuantities(inp: SoffitInput) {
  const d = inp.overhang_in / 12;
  const rakeTrue = inp.pitch !== undefined ? inp.rake_plan_lf * slopeFactor(inp.pitch) : inp.rake_plan_lf;
  const eaveSf = inp.eave_lf * d;
  const rakeSf = inp.rake_overhang_in ? rakeTrue * (inp.rake_overhang_in / 12) : 0;
  const cornerSf = (inp.outside_corners ?? 0) * d * d;
  const soffit = eaveSf + rakeSf + cornerSf;
  const waste = inp.waste_pct ?? 10;
  let vent: Record<string, number | string> | undefined;
  if (inp.vent && inp.vent.attic_sf > 0 && inp.vent.ratio > 0) {
    const share = inp.vent.intake_share ?? 0.5;
    const totalIn2 = (inp.vent.attic_sf / inp.vent.ratio) * 144;
    vent = {
      attic_sf: r2(inp.vent.attic_sf), ratio: `1/${inp.vent.ratio}`, required_nfa_in2: r2(totalIn2),
      intake_share: share, intake_nfa_in2: r2(totalIn2 * share),
      ...(inp.vent.nfa_in2_per_lf && inp.vent.nfa_in2_per_lf > 0 ? { vented_soffit_lf: r2((totalIn2 * share) / inp.vent.nfa_in2_per_lf) } : {}),
    };
  }
  const notFigured: string[] = [];
  if (inp.rake_plan_lf > 0 && !inp.rake_overhang_in) notFigured.push("rake soffit (pass rake_overhang_in)");
  if (inp.rake_plan_lf > 0 && inp.pitch === undefined) notFigured.push("true rake length (pass pitch; rake fascia below is plan length)");
  return {
    overhang_in: inp.overhang_in,
    eave_soffit_sf: r2(eaveSf), rake_soffit_sf: r2(rakeSf), corner_sf: r2(cornerSf),
    soffit_sf: r2(soffit),
    waste_pct: waste,
    waste_source: inp.waste_pct === undefined ? "suite allowance — override with your standard" : "stated",
    soffit_order_sf: r2(soffit * (1 + waste / 100)),
    fascia_lf: r2(inp.eave_lf + rakeTrue),
    wall_receiver_lf: r2(inp.eave_lf + (inp.rake_overhang_in ? rakeTrue : 0)),
    ...(vent ? { vent } : {}),
    not_figured: notFigured,
  };
}

// ── Acoustical ceilings ────────────────────────────────────────────────────
//
// An exposed lay-in grid, from the module on the reflected ceiling plan. Main
// runners run at the long side of a 2 × 4 module, or at twice the side of a
// square one (4 ft for both 2 × 2 and 2 × 4; 1200 mm for 600 × 600 and
// 600 × 1200). Long cross tees span between mains at the short side; a square
// module adds a short cross tee at mid-bay between each pair of long ones. Per
// SF of ceiling, with S the main spacing and w the short side:
//   main runner LF = 1/S      long tees = 1/(S·w)      short tees = 1/(S·w)
// For 2 × 2 that is 0.25 + 0.5 + 0.25 = 1 LF of grid per SF, a line every
// 2 ft both ways. These are average-density counts: a layout with many short
// runs cut at the walls orders more mains than area / (S × piece length).

/** A lay-in module, "2x2" / "2'x4'" in feet, or with metric "600x600" in mm; sides in feet, short first. Null if unreadable. */
export function parseCeilingModule(text: string, metric = false): { w_ft: number; l_ft: number } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:'|ft|mm)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:'|ft|mm)?\s*$/i.exec(String(text));
  if (!m) return null;
  const toFt = metric ? 1 / 304.8 : 1;
  const a = Number(m[1]) * toFt, b = Number(m[2]) * toFt;
  if (!(a > 0 && b > 0)) return null;
  return { w_ft: Math.min(a, b), l_ft: Math.max(a, b) };
}

export interface CeilingInput {
  /** ceiling area, SF (the ACT condition's total) */
  area_sf: number;
  /** wall angle run, LF (the rooms' perimeters) */
  perimeter_lf: number;
  /** module sides, feet: w ≤ l, and l = w (square) or l = 2w */
  module_w_ft: number;
  module_l_ft: number;
  /** hanger wire spacing along the mains, feet (spec / code); absent = hangers not figured */
  hanger_spacing_ft?: number;
  /** main runner piece length, feet; absent = 12 ft allowance */
  main_piece_ft?: number;
  /** tile waste; absent = 10 % suite allowance */
  waste_pct?: number;
}

export function ceilingQuantities(inp: CeilingInput) {
  const w = inp.module_w_ft, l = inp.module_l_ft;
  const square = Math.abs(l - w) <= w * 0.01;
  if (!square && Math.abs(l - 2 * w) > w * 0.01) throw new Error(`a lay-in module is square or twice as long as wide; got ${r3(w)} × ${r3(l)} ft`);
  const S = square ? 2 * w : l;                          // main runner spacing
  const area = Math.max(0, inp.area_sf);
  const tileSf = w * l;
  const tiles = ceil(area / tileSf);
  const waste = inp.waste_pct ?? 10;
  const piece = inp.main_piece_ft ?? 12;
  const mainLf = area / S;
  const notFigured: string[] = [];
  if (!inp.hanger_spacing_ft) notFigured.push("hanger wires (pass hanger_spacing_ft from the spec)");
  // counts are by average density over the area until a grid is laid out
  notFigured.push("border tiles: counted by area, but each cut border tile uses a whole tile");
  notFigured.push("perimeter hangers, and seismic splay wires and struts where the spec calls for them");
  return {
    tile_sf: r4(tileSf),
    main_spacing_ft: r4(S),
    tiles,
    waste_pct: waste,
    waste_source: inp.waste_pct === undefined ? "suite allowance — override with your standard" : "stated",
    tiles_order: ceil((area / tileSf) * (1 + waste / 100)),
    main_runner_lf: r2(mainLf),
    main_runners: ceil(mainLf / piece),
    main_piece_ft: piece,
    main_piece_source: inp.main_piece_ft === undefined ? "suite allowance — override with the product's length" : "stated",
    cross_tees_long: ceil(area / (S * w)),
    cross_tee_long_ft: r4(S),
    cross_tees_short: square ? ceil(area / (S * w)) : 0,
    cross_tee_short_ft: square ? r4(w) : 0,
    wall_angle_lf: r2(Math.max(0, inp.perimeter_lf)),
    ...(inp.hanger_spacing_ft ? { hangers: ceil(area / (S * inp.hanger_spacing_ft)), hanger_spacing_ft: inp.hanger_spacing_ft } : {}),
    not_figured: notFigured,
  };
}

// ── Concrete ───────────────────────────────────────────────────────────────
//
// What a concrete estimator orders, from slabs, footings, walls and pads
// already traced: cubic yards, form contact area (SFCA), reinforcing and the
// material under the slab. Every dimension the plan does not show (thickness,
// footing size, bar size and spacing, lap, base depth) is an argument read
// from the structural sheets; none is assumed. The two allowances are the
// waste on concrete (5 %) and the bar stock length that sets how many laps a
// run carries (20 ft), and both are reported as allowances.
//
//   cubic yards = SF × thickness(in) / 12 / 27          (area elements)
//               = LF × width(in) × depth(in) / 144 / 27  (footings)
//   bars each way = 2 × faces × SF / (spacing(in) / 12)  LF per SF of face
//   with a lap L on stock length S: LF × S / (S − L), because every piece
//   but the first in a run gives up one lap of its length

/** Bar weight, lb per ft, by US bar size (ASTM A615 nominal weights). */
export const REBAR_LB_PER_FT: Readonly<Record<string, number>> = Object.freeze({
  "3": 0.376, "4": 0.668, "5": 1.043, "6": 1.502, "7": 2.044, "8": 2.67, "9": 3.4, "10": 4.303, "11": 5.313,
});

/** "#4", "No. 4", "4" or 4 → "4"; null when it is not a US bar size #3–#11. */
export function parseBarSize(v: unknown): string | null {
  const m = /^\s*(?:#|no\.?\s*)?(\d{1,2})\s*$/i.exec(String(v));
  return m && Object.prototype.hasOwnProperty.call(REBAR_LB_PER_FT, m[1]) ? m[1] : null;
}

const CONCRETE_WASTE_PCT = 5;
const BAR_STOCK_FT = 20;

export interface RebarSpec {
  /** US bar size, "#4" */
  size: string;
  /** splice lap, inches (structural notes); absent = laps not figured */
  lap_in?: number;
  /** bar stock length, feet; absent = 20 ft allowance */
  stock_ft?: number;
}

/** Bars from their net run length: laps added, pieces counted and weighed. */
export function rebarQuantities(net_lf: number, spec: RebarSpec) {
  const size = parseBarSize(spec.size);
  if (!size) throw new Error(`bar size ${JSON.stringify(spec.size)} is not a US bar size #3 to #11`);
  const stock = spec.stock_ft ?? BAR_STOCK_FT;
  const lapFt = (spec.lap_in ?? 0) / 12;
  if (lapFt >= stock) throw new Error(`a ${spec.lap_in} in lap is not shorter than the ${stock} ft bar`);
  const net = Math.max(0, net_lf);
  const lf = net * stock / (stock - lapFt);
  return {
    size: `#${size}`,
    bar_weight: `${REBAR_LB_PER_FT[size]} lb/ft (nominal, #${size})`,
    net_lf: r2(net),
    lap_lf: r2(lf - net),
    lap_in: spec.lap_in ?? 0,
    stock_ft: stock,
    stock_source: spec.stock_ft === undefined ? "suite allowance — override with the bar length you buy" : "stated",
    lf: r2(lf),
    pieces: ceil(lf / stock),
    weight_lb: r2(lf * REBAR_LB_PER_FT[size]),
  };
}

/** Net bar LF each way (both directions) on `faces` mats or faces of `area_sf`. */
export function barsEachWayLf(area_sf: number, spacing_in: number, faces = 1): number {
  return 2 * faces * Math.max(0, area_sf) / (spacing_in / 12);
}

/** A concrete order: waste on a net volume. */
function concreteOrder(cf: number, waste_pct?: number) {
  const waste = waste_pct ?? CONCRETE_WASTE_PCT;
  return {
    concrete_cy: r2(cf / 27),
    waste_pct: waste,
    waste_source: waste_pct === undefined ? "suite allowance — override with your standard" : "stated",
    order_cy: r2(cf * (1 + waste / 100) / 27),
  };
}

export interface SlabInput {
  /** net plan area, SF (the condition's total) */
  area_sf: number;
  /** plan perimeter, LF, for the edge forms */
  perimeter_lf: number;
  thickness_in: number;
  /** edge forms on the perimeter: a slab on grade poured against forms (default true) */
  edge_form?: boolean;
  /** reinforcing bars at this spacing each way, one mat */
  bars?: RebarSpec & { spacing_in: number; mats?: number };
  /** welded wire fabric: roll width and side lap */
  mesh?: { roll_width_ft: number; lap_in: number };
  /** compacted base course under the slab, inches */
  base_depth_in?: number;
  /** vapor barrier under the slab (default false) */
  vapor_barrier?: boolean;
  waste_pct?: number;
}

/** A slab on grade, an elevated slab, or a pad traced as an area. */
export function slabQuantities(inp: SlabInput) {
  const area = Math.max(0, inp.area_sf);
  const t = inp.thickness_in;
  if (!(t > 0)) throw new Error("thickness_in must be positive");
  const edge = inp.edge_form ?? true;
  const edgeLf = edge ? Math.max(0, inp.perimeter_lf) : 0;
  const notFigured: string[] = [];
  const out = {
    area_sf: r2(area),
    thickness_in: t,
    ...concreteOrder(area * t / 12, inp.waste_pct),
    edge_form_lf: r2(edgeLf),
    edge_form_sf: r2(edgeLf * t / 12),
  } as Record<string, unknown>;
  if (inp.bars) {
    if (!(inp.bars.spacing_in > 0)) throw new Error("bars.spacing_in must be positive");
    const mats = inp.bars.mats ?? 1;
    out.rebar = rebarQuantities(barsEachWayLf(area, inp.bars.spacing_in, mats), inp.bars);
    out.rebar_spacing_in = inp.bars.spacing_in;
    if (inp.bars.lap_in === undefined) notFigured.push("bar laps (pass bars.lap_in from the structural notes): bar LF is the net run");
  }
  if (inp.mesh) {
    const w = inp.mesh.roll_width_ft, lap = inp.mesh.lap_in / 12;
    if (!(w > 0) || !(lap >= 0) || lap >= w) throw new Error("mesh needs a roll width wider than its lap");
    out.mesh_sf = r2(area * w / (w - lap));
    out.mesh_lap_in = inp.mesh.lap_in;
  }
  if (inp.base_depth_in !== undefined) out.base_cy = r2(area * inp.base_depth_in / 12 / 27);
  if (inp.vapor_barrier) out.vapor_barrier_sf = r2(area);
  if (inp.vapor_barrier) notFigured.push("vapor barrier laps and turn-ups at the edges: SF is the plan area");
  if (!inp.bars && !inp.mesh) notFigured.push("reinforcing (pass bars or mesh from the structural sheets)");
  if (inp.base_depth_in === undefined) notFigured.push("base course under the slab (pass base_depth_in)");
  notFigured.push("forms at blockouts and cut-out openings, reinforcing chairs, dowels, thickened edges and depressions");
  out.not_figured = notFigured;
  return out as {
    area_sf: number; thickness_in: number; concrete_cy: number; waste_pct: number; waste_source: string; order_cy: number;
    edge_form_lf: number; edge_form_sf: number; rebar?: ReturnType<typeof rebarQuantities>; rebar_spacing_in?: number;
    mesh_sf?: number; mesh_lap_in?: number; base_cy?: number; vapor_barrier_sf?: number; not_figured: string[];
  };
}

export interface FootingInput {
  length_lf: number;
  width_in: number;
  depth_in: number;
  /** continuous bars along the footing: how many, and their size */
  bars?: RebarSpec & { count: number };
  waste_pct?: number;
}

/** A continuous footing: its volume, the two side forms, and continuous bars. */
export function footingQuantities(inp: FootingInput) {
  const len = Math.max(0, inp.length_lf);
  if (!(inp.width_in > 0) || !(inp.depth_in > 0)) throw new Error("width_in and depth_in must be positive");
  const notFigured: string[] = [];
  const out = {
    length_lf: r2(len), width_in: inp.width_in, depth_in: inp.depth_in,
    ...concreteOrder(len * inp.width_in * inp.depth_in / 144, inp.waste_pct),
    form_sf: r2(2 * len * inp.depth_in / 12),
  } as Record<string, unknown>;
  if (inp.bars) {
    if (!(inp.bars.count > 0)) throw new Error("bars.count must be positive");
    out.rebar = rebarQuantities(len * inp.bars.count, inp.bars);
    out.rebar_count = inp.bars.count;
    if (inp.bars.lap_in === undefined) notFigured.push("bar laps (pass bars.lap_in from the structural notes): bar LF is the net run");
  } else notFigured.push("footing reinforcing (pass bars: count and size from the footing schedule)");
  notFigured.push("keyways, dowels to the wall and step footings");
  out.not_figured = notFigured;
  return out as {
    length_lf: number; width_in: number; depth_in: number; concrete_cy: number; waste_pct: number; waste_source: string; order_cy: number;
    form_sf: number; rebar?: ReturnType<typeof rebarQuantities>; rebar_count?: number; not_figured: string[];
  };
}

export interface ConcreteWallInput {
  /** wall face area, SF (length × height) */
  area_sf: number;
  thickness_in: number;
  /** bars at this spacing each way, on `faces` faces (1 or 2) */
  bars?: RebarSpec & { spacing_in: number; faces?: number };
  waste_pct?: number;
}

/** A cast wall: volume, both faces of form, and bars each way. */
export function concreteWallQuantities(inp: ConcreteWallInput) {
  const area = Math.max(0, inp.area_sf);
  if (!(inp.thickness_in > 0)) throw new Error("thickness_in must be positive");
  const notFigured: string[] = [];
  const out = {
    area_sf: r2(area), thickness_in: inp.thickness_in,
    ...concreteOrder(area * inp.thickness_in / 12, inp.waste_pct),
    form_sf: r2(2 * area),
  } as Record<string, unknown>;
  if (inp.bars) {
    if (!(inp.bars.spacing_in > 0)) throw new Error("bars.spacing_in must be positive");
    out.rebar = rebarQuantities(barsEachWayLf(area, inp.bars.spacing_in, inp.bars.faces ?? 1), inp.bars);
    out.rebar_spacing_in = inp.bars.spacing_in;
    if (inp.bars.lap_in === undefined) notFigured.push("bar laps (pass bars.lap_in from the structural notes): bar LF is the net run");
  } else notFigured.push("wall reinforcing (pass bars from the structural sheets)");
  notFigured.push("wall openings, pilasters, ties and bracing: trace openings as deducts");
  out.not_figured = notFigured;
  return out as {
    area_sf: number; thickness_in: number; concrete_cy: number; waste_pct: number; waste_source: string; order_cy: number;
    form_sf: number; rebar?: ReturnType<typeof rebarQuantities>; rebar_spacing_in?: number; not_figured: string[];
  };
}

export interface PadInput {
  /** pads counted, each of a stated size */
  count: number;
  length_ft: number;
  width_ft: number;
  depth_in: number;
  waste_pct?: number;
}

/** Spread footings or pads counted, each of its stated plan size and depth. */
export function padQuantities(inp: PadInput) {
  if (!(inp.length_ft > 0) || !(inp.width_ft > 0) || !(inp.depth_in > 0)) throw new Error("length_ft, width_ft and depth_in must be positive");
  const n = Math.max(0, inp.count);
  return {
    count: n, length_ft: inp.length_ft, width_ft: inp.width_ft, depth_in: inp.depth_in,
    ...concreteOrder(n * inp.length_ft * inp.width_ft * inp.depth_in / 12, inp.waste_pct),
    form_sf: r2(n * 2 * (inp.length_ft + inp.width_ft) * inp.depth_in / 12),
  };
}

// ── Glazing ────────────────────────────────────────────────────────────────

export interface GlazingOpeningInput {
  id: string;
  ring: Pt[];
  /** vertical divisions (lites across) */
  bays: number;
  /** horizontal divisions (lites up) */
  rows: number;
  /** frame sightline, inches (face width of a mullion) */
  sightline_in: number;
  /** perimeter sealant beads: 1 = exterior only, 2 = interior and exterior */
  sealant_sides: number;
}

export function glazingOpening(o: GlazingOpeningInput) {
  const b = bbox(o.ring);
  const area = ringAreaSf(o.ring);
  const rect = b.w > 0 && b.h > 0 && Math.abs(area - b.w * b.h) <= 0.02 * b.w * b.h;
  const f = o.sightline_in / 12;
  const liteW = (b.w - (o.bays + 1) * f) / o.bays;
  const liteH = (b.h - (o.rows + 1) * f) / o.rows;
  const lites = o.bays * o.rows;
  const glass = liteW > 0 && liteH > 0 ? lites * liteW * liteH : 0;
  const perim = ringPerimeter(o.ring);
  // equal-spaced mullion lines in the ring's own units — what a derive commits
  const mullions: [Pt, Pt][] = [];
  for (let i = 1; i < o.bays; i++) { const x = b.x0 + (b.w * i) / o.bays; mullions.push([[x, b.y0], [x, b.y1]]); }
  for (let j = 1; j < o.rows; j++) { const y = b.y0 + (b.h * j) / o.rows; mullions.push([[b.x0, y], [b.x1, y]]); }
  return {
    id: o.id, width_ft: r2(b.w), height_ft: r2(b.h), rectangular: rect,
    frame_sf: r2(area), lites, lite_dlo: liteW > 0 && liteH > 0 ? `${r2(liteW * 12)}" × ${r2(liteH * 12)}"` : "sightlines exceed the opening",
    glass_sf: r2(glass),
    vertical_mullion_lf: r2((o.bays - 1) * b.h), horizontal_mullion_lf: r2((o.rows - 1) * b.w),
    perimeter_lf: r2(perim), sealant_lf: r2(perim * o.sealant_sides),
    mullions,
  };
}

// ── Electrical ─────────────────────────────────────────────────────────────

export interface ElectricalInput {
  runs: { tag: string; conduit_lf: number; conductors: number; sets: number; slack_pct: number }[];
  devices: { tag: string; ea: number }[];
  fixtures: { tag: string; ea: number; whip_ft: number }[];
  /** conduit stick length (couplings), ft */
  coupling_every_ft: number;
  /** support spacing, ft */
  strap_every_ft: number;
}

export function electricalRollup(inp: ElectricalInput) {
  const runs = inp.runs.map((r) => ({
    tag: r.tag, conduit_lf: r2(r.conduit_lf), conductors: r.conductors, sets: r.sets, slack_pct: r.slack_pct,
    wire_lf: r2(r.conduit_lf * r.conductors * r.sets * (1 + r.slack_pct / 100)),
    couplings: ceil(r.conduit_lf / inp.coupling_every_ft),
    straps: ceil(r.conduit_lf / inp.strap_every_ft),
  }));
  const devices = inp.devices.map((d) => ({ tag: d.tag, ea: d.ea, boxes: d.ea, plates: d.ea }));
  const fixtures = inp.fixtures.map((x) => ({ tag: x.tag, ea: x.ea, whip_ft: x.whip_ft, whip_lf: r2(x.ea * x.whip_ft) }));
  return {
    runs, devices, fixtures,
    totals: {
      conduit_lf: r2(runs.reduce((n, r) => n + r.conduit_lf, 0)),
      wire_lf: r2(runs.reduce((n, r) => n + r.wire_lf, 0)),
      couplings: runs.reduce((n, r) => n + r.couplings, 0),
      straps: runs.reduce((n, r) => n + r.straps, 0),
      boxes: devices.reduce((n, d) => n + d.boxes, 0),
      whip_lf: r2(fixtures.reduce((n, x) => n + x.whip_lf, 0)),
    },
  };
}

// ── Plumbing ───────────────────────────────────────────────────────────────

export interface PlumbingInput {
  pipes: { tag: string; lf: number; hanger_every_ft?: number; fittings_per_100_lf?: number; insulate?: boolean }[];
  fixtures: { tag: string; counted: number; schedule_qty?: number }[];
}

export function plumbingRollup(inp: PlumbingInput) {
  const notFigured: string[] = [];
  const pipes = inp.pipes.map((p) => {
    if (!p.hanger_every_ft) notFigured.push(`${p.tag}: hangers (pass hanger_every_ft from the spec)`);
    return {
      tag: p.tag, lf: r2(p.lf),
      ...(p.hanger_every_ft ? { hangers: ceil(p.lf / p.hanger_every_ft), hanger_every_ft: p.hanger_every_ft } : {}),
      ...(p.fittings_per_100_lf ? { fittings_allowance: ceil((p.lf * p.fittings_per_100_lf) / 100), fittings_per_100_lf: p.fittings_per_100_lf } : {}),
      ...(p.insulate ? { insulation_lf: r2(p.lf) } : {}),
    };
  });
  // Plan count when the plans tag the mark; the schedule QTY when they never do.
  // A difference is the estimator's to settle, never averaged away.
  const fixtures = inp.fixtures.map((x) => {
    const q = x.schedule_qty;
    const status = q === undefined ? "no_schedule_qty" : x.counted === q ? "match" : x.counted === 0 ? "not_tagged" : "mismatch";
    const carried = status === "not_tagged" ? (q as number) : x.counted;
    return { tag: x.tag, counted: x.counted, ...(q !== undefined ? { schedule_qty: q } : {}), status, carried };
  });
  return {
    pipes, fixtures,
    needs_you: fixtures.filter((x) => x.status === "mismatch" || x.status === "not_tagged")
      .map((x) => x.status === "mismatch"
        ? `${x.tag}: plans count ${x.counted}, schedule QTY ${x.schedule_qty} — carried the plan count; confirm`
        : `${x.tag}: schedule QTY ${x.schedule_qty} but no tags counted on the plans — carried the schedule QTY; confirm`),
    totals: {
      pipe_lf: r2(pipes.reduce((n, p) => n + p.lf, 0)),
      hangers: pipes.reduce((n, p) => n + ((p as { hangers?: number }).hangers ?? 0), 0),
      fixtures: fixtures.reduce((n, x) => n + x.carried, 0),
    },
    not_figured: notFigured,
  };
}
