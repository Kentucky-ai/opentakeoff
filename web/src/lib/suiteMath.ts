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
 * "6 in 12", and a low-slope "1/4 per ft" / "1/4\" per foot" (= 0.25/12).
 * Returns null for anything it cannot read — never a guess.
 */
export function parsePitch(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 && raw <= 48 ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/["”″]/g, "");
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:\/|:|in)\s*12$/);
  if (m) return parsePitch(Number(m[1]));
  m = s.match(/^(\d+)\s*\/\s*(\d+)\s*(?:in(?:ch)?\s*)?(?:per|\/)\s*(?:ft|foot|')$/);
  if (m && Number(m[2]) > 0) return parsePitch(Number(m[1]) / Number(m[2]));   // inches of rise per foot = rise per 12
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:in(?:ch)?\s*)?(?:per|\/)\s*(?:ft|foot|')$/);
  if (m) return parsePitch(Number(m[1]));
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
 * line cut out (no starter across a door opening). Each run is a 2-point
 * segment in the ring's own units; tol is in those units too.
 */
export function starterRuns(wall: Pt[], doors: Pt[][], tol: number): [Pt, Pt][] {
  const cuts: [number, number, number][] = [];   // [xmin, xmax, y] of each door bottom
  for (const d of doors) for (const [a, b] of bottomEdges(d, tol)) cuts.push([Math.min(a[0], b[0]), Math.max(a[0], b[0]), (a[1] + b[1]) / 2]);
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
    for (const [s0, s1] of spans) if (s1 - s0 > 1e-6) out.push([[s0, yAt(s0)], [s1, yAt(s1)]]);
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
    const starter = starterRuns(w.ring, doorRings, 0.5).reduce((n, [a, b]) => n + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
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
