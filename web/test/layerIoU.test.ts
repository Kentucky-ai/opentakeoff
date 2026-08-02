// Corpus IoU — the room-detection eval, SCORED (#85 phase 2). Phase 1 proved
// the layer short-circuit qualitatively (layerExtract.test.ts frees one
// tile-grid flood). This file makes the claim a NUMBER and pins it in CI:
// over a corpus of layered fixture scenes with stated ground truth, the
// role-filtered mask must beat the roleless mask on IoU-vs-truth by a floor
// margin, and unlayered scenes must show EXACTLY zero delta (byte-identical
// mask, identical regions) — #85's finish line as a gate, not a PR anecdote.
//
// Fixtures are synthetic op-list scenes (the layerExtract fake-OPS idiom;
// mcp/scripts/make-layered-fixture.mjs is the on-disk precedent): each states
// its layers the way a Revit/AutoCAD export does and carries the truth
// rectangle for every labeled room. The eval loop is the REAL room-detection
// path — roomLabelSeeds → detectRegions over the built mask — so a lift here
// is a lift in detect_rooms, not in a bespoke harness. A room the detector
// refuses (no clean flood at its label) scores IoU 0: refusals are failures
// on this ruler, not exemptions.
//
// The floors are pinned BELOW measured values (measured on this corpus:
// see each fixture's comment) so honest jitter passes and a regression —
// a role that stops excluding, a classifier that stops resolving a dialect —
// fails loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVectorGeometry, buildMask } from "../src/lib/oneclick.ts";
import type { FloodResult } from "../src/lib/oneclick.ts";
import { buildLayerInfos, effectiveLayerRoles, layerRoleCodes, segRoles } from "../src/lib/layers.ts";
import { roomLabelSeeds, detectRegions } from "../src/lib/detectRooms.ts";

// ── the fake-OPS scene kit (same idiom as layerExtract.test.ts) ─────────────
const OPS = {
  save: 1, restore: 2, transform: 3, setLineWidth: 4, setGState: 5,
  constructPath: 10, moveTo: 11, lineTo: 12, curveTo: 13, curveTo2: 14, curveTo3: 15, closePath: 16, rectangle: 17,
  endPath: 20, clip: 21, eoClip: 22, fill: 23, eoFill: 24, stroke: 25,
  beginMarkedContent: 30, beginMarkedContentProps: 31, endMarkedContent: 32,
  paintFormXObjectBegin: 33, paintFormXObjectEnd: 34,
} as const;
const ID = [1, 0, 0, 1, 0, 0];
type Op = [number, unknown[] | null];
const opList = (ops: Op[]) => ({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1]) });
const oc = (id: string): Op => [OPS.beginMarkedContentProps, ["OC", { type: "OCG", id }]];
const END: Op = [OPS.endMarkedContent, null];
const line = (x1: number, y1: number, x2: number, y2: number): Op =>
  [OPS.constructPath, [[OPS.moveTo, OPS.lineTo], [x1, y1, x2, y2]]];
const rect = (x: number, y: number, w: number, h: number): Op =>
  [OPS.constructPath, [[OPS.rectangle], [x, y, w, h]]];
/** Wrap ops in a marked-content scope only when the scene is layered — the
 * unlayered control reuses the exact same drawing calls, so its segment
 * stream is identical byte for byte. */
const on = (layered: boolean, id: string, ...ops: Op[]): Op[] => (layered ? [oc(id), ...ops, END] : ops);

// ── the corpus ───────────────────────────────────────────────────────────────
// 612×612 image px (the fixture-PDF sheet size), mask ws = 1 — cell math is
// exact. Truth rects are room INTERIORS (walls excluded), inclusive bounds.
interface Rect { x0: number; y0: number; x1: number; y1: number }
interface Fixture {
  name: string;
  layered: boolean;
  ops: Op[];
  /** ocg id → declared layer name (the document catalog). */
  names: Record<string, string>;
  /** ids hidden in the default config (/OFF). */
  off?: string[];
  labels: { str: string; x: number; y: number }[];
  truth: Record<string, Rect>;
  /** pinned floors: measured-minus-margin (see header). */
  expect: { filteredMin: number; rolelessMax?: number };
}
const W = 612, H = 612;

// Shared room geometry: room A [80,80]–[380,380] with a 3×3 finish-tile grid
// (4 interior lines — far under HATCH_MIN_RUN, so the pitch heuristics keep
// them hard and a roleless flood traps in one cell), room B [400,80]–[560,380]
// bare (the in-fixture control: filtering must not perturb an ordinary room).
const roomsAB = (layered: boolean, wallId = "w", pattId = "p", ): Op[] => [
  ...on(layered, wallId, rect(80, 80, 300, 300), rect(400, 80, 160, 300)),
  ...on(layered, pattId,
    line(180, 80, 180, 380), line(280, 80, 280, 380),
    line(80, 180, 380, 180), line(80, 280, 380, 280)),
];
const truthA: Rect = { x0: 81, y0: 81, x1: 379, y1: 379 };
const truthB: Rect = { x0: 401, y0: 81, x1: 559, y1: 379 };

const CORPUS: Fixture[] = [
  {
    // measured: filtered 101→1.000 102→1.000 · roleless 101→0.110 102→1.000
    name: "tile-grid (AIA names)",
    layered: true,
    ops: roomsAB(true),
    names: { w: "A-WALL-FULL", p: "A-FLOR-PATT" },
    labels: [{ str: "101", x: 130, y: 130 }, { str: "102", x: 480, y: 230 }],
    truth: { "101": truthA, "102": truthB },
    expect: { filteredMin: 0.95, rolelessMax: 0.6 },
  },
  {
    // measured: filtered 101→1.000 102→1.000 · roleless 101→0.110 102→1.000
    // Same scene, field-dialect names: an xref-bind prefix and separator
    // drift — the lift must survive the normalizer, not just clean AIA names.
    name: "tile-grid (xref + separator dialect)",
    layered: true,
    ops: roomsAB(true),
    names: { w: "ARCH-FLOOR|A-WALL FULL HT", p: "XREF$0$A-FLOR-PATT" },
    labels: [{ str: "101", x: 130, y: 130 }, { str: "102", x: 480, y: 230 }],
    truth: { "101": truthA, "102": truthB },
    expect: { filteredMin: 0.95, rolelessMax: 0.6 },
  },
  {
    // measured: filtered 104→1.000 · roleless 104→0.248
    // Column grid lines crossing the room: annotation ink (A-GRID), but two
    // stroked full-height lines are no hatch FAMILY, so heuristics keep them
    // hard and the roleless flood traps in one quadrant. (A diagonal leader
    // would NOT discriminate here — a 4-connected scanline flood steps through
    // a Bresenham staircase — so the fixture uses the ink that actually bites:
    // grid chains cross every room on a real plan.)
    name: "column grid lines quarter the room",
    layered: true,
    ops: [
      ...on(true, "w", rect(80, 80, 300, 300)),
      ...on(true, "a", line(230, 80, 230, 380), line(80, 230, 380, 230), line(300, 140, 340, 140)),
    ],
    names: { w: "A-WALL-FULL", a: "A-GRID" },
    labels: [{ str: "104", x: 150, y: 150 }],
    truth: { "104": truthA },
    expect: { filteredMin: 0.95, rolelessMax: 0.6 },
  },
  {
    // measured: filtered 105→1.000 · roleless 105→0.498
    // A demolished wall bisecting the room, hidden in the default config: its
    // ops are still IN the operator list (pdf.js emits hidden optional
    // content; only the renderer skips it), so a roleless mask traces
    // demolition — exactly the RFC's "honor visibility or you will trace
    // demolition" hazard, scored.
    name: "hidden demolition wall bisects",
    layered: true,
    ops: [
      ...on(true, "w", rect(80, 80, 300, 300)),
      ...on(true, "d", line(80, 230, 380, 230)),
    ],
    names: { w: "A-WALL-FULL", d: "A-WALL-DEMO" },
    off: ["d"],
    labels: [{ str: "105", x: 230, y: 150 }],
    truth: { "105": truthA },
    expect: { filteredMin: 0.95, rolelessMax: 0.6 },
  },
  {
    // measured: filtered 106→1.000 · roleless 106→0.834
    // Casework/furniture drawn inside the room: real geometry, never a room
    // boundary. Roleless, the closed outlines punch unreachable holes in the
    // flood; the stated layer frees the full finish area.
    name: "furniture carves the interior",
    layered: true,
    ops: [
      ...on(true, "w", rect(80, 80, 300, 300)),
      ...on(true, "f", rect(130, 130, 80, 80), rect(260, 250, 90, 90)),
    ],
    names: { w: "A-WALL-FULL", f: "A-FURN" },
    labels: [{ str: "106", x: 238, y: 180 }],
    truth: { "106": truthA },
    expect: { filteredMin: 0.95 },
  },
  {
    // measured: filtered == roleless, both rooms → identical regions.
    // The unlayered control: SAME drawing calls as the tile-grid fixture with
    // no marked content at all. Nothing is stated, nothing may change —
    // asserted below down to mask bytes (the invisible-fallback invariant).
    name: "unlayered control (zero delta)",
    layered: false,
    ops: roomsAB(false),
    names: {},
    labels: [{ str: "101", x: 130, y: 130 }, { str: "102", x: 480, y: 230 }],
    truth: { "101": truthA, "102": truthB },
    expect: { filteredMin: 0 },
  },
];

// ── the ruler ────────────────────────────────────────────────────────────────
type OkFlood = Extract<FloodResult, { status: "ok" }>;

function iouVsRect(f: OkFlood, r: Rect): number {
  const { region, mw, mh, ws } = f;
  let inter = 0, union = 0;
  for (let y = 0; y < mh; y++) {
    const inRowY = y >= r.y0 * ws && y <= r.y1 * ws;
    for (let x = 0; x < mw; x++) {
      const inR = inRowY && x >= r.x0 * ws && x <= r.x1 * ws;
      const inF = region[y * mw + x] !== 0;
      if (inF && inR) inter++;
      if (inF || inR) union++;
    }
  }
  return union ? inter / union : 0;
}

interface Built {
  geo: ReturnType<typeof extractVectorGeometry>;
  roleless: ReturnType<typeof buildMask>;
  filtered: ReturnType<typeof buildMask>;
}
function build(f: Fixture): Built {
  const geo = extractVectorGeometry(opList(f.ops), ID, OPS as never);
  const byId = new Map(Object.entries(f.names).map(([id, name]) => [id, { name, visible: !(f.off || []).includes(id) }]));
  const infos = buildLayerInfos(geo.layerIds!, geo.layerOf, byId);
  const roles = segRoles(geo.layerOf, layerRoleCodes(geo.layerIds!, effectiveLayerRoles(infos)));
  return {
    geo,
    roleless: buildMask(geo.segs, W, H, 3000, geo.meta),
    filtered: buildMask(geo.segs, W, H, 3000, geo.meta, roles),
  };
}

/** Run the REAL room-detection loop over a mask and score each truth room.
 * Refused rooms (no clean flood at the label) score 0. */
function scoreRooms(mask: ReturnType<typeof buildMask>, f: Fixture): Record<string, number> {
  const found = detectRegions(mask, roomLabelSeeds(f.labels));
  const scores: Record<string, number> = {};
  for (const [label, r] of Object.entries(f.truth)) {
    const hit = found.find((d) => d.str === label);
    scores[label] = hit ? iouVsRect(hit.flood, r) : 0;
  }
  return scores;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (s: Record<string, number>) => Object.entries(s).map(([k, v]) => `${k}→${v.toFixed(3)}`).join(" ");

// ── per-fixture scoring ──────────────────────────────────────────────────────
for (const f of CORPUS.filter((x) => x.layered)) {
  test(`corpus IoU — ${f.name}`, (t) => {
    const { roleless, filtered } = build(f);
    const sr = scoreRooms(roleless, f), sf = scoreRooms(filtered, f);
    t.diagnostic(`${f.name}: filtered ${fmt(sf)} (mean ${mean(Object.values(sf)).toFixed(3)}) · roleless ${fmt(sr)} (mean ${mean(Object.values(sr)).toFixed(3)})`);
    for (const [label, v] of Object.entries(sf)) {
      assert.ok(v >= f.expect.filteredMin, `${f.name} ${label}: filtered IoU ${v.toFixed(3)} under the ${f.expect.filteredMin} floor`);
      // filtering may never do WORSE than the heuristics on any room — the
      // short-circuit only removes stated non-boundary ink (tiny slack: a
      // freed flood reaches wall cells a trapped one couldn't touch)
      assert.ok(v >= sr[label] - 0.02, `${f.name} ${label}: filtered ${v.toFixed(3)} lost ground to roleless ${sr[label].toFixed(3)}`);
    }
    if (f.expect.rolelessMax !== undefined) {
      assert.ok(mean(Object.values(sr)) <= f.expect.rolelessMax,
        `${f.name}: roleless mean ${mean(Object.values(sr)).toFixed(3)} beats ${f.expect.rolelessMax} — the fixture no longer discriminates (heuristics improved? re-pin the corpus)`);
    }
  });
}

test("corpus IoU — aggregate: the stated layers are worth a measured floor over the whole corpus", (t) => {
  const layered = CORPUS.filter((x) => x.layered);
  const sf: number[] = [], sr: number[] = [];
  for (const f of layered) {
    const { roleless, filtered } = build(f);
    sf.push(...Object.values(scoreRooms(filtered, f)));
    sr.push(...Object.values(scoreRooms(roleless, f)));
  }
  const lift = mean(sf) - mean(sr);
  t.diagnostic(`aggregate over ${layered.length} layered fixtures / ${sf.length} rooms: filtered mean ${mean(sf).toFixed(3)} · roleless mean ${mean(sr).toFixed(3)} · lift ${lift.toFixed(3)}`);
  // measured: filtered 1.000, roleless 0.543, lift 0.457 — floor pinned well below
  assert.ok(mean(sf) >= 0.95, `filtered corpus mean ${mean(sf).toFixed(3)} under 0.95`);
  assert.ok(lift >= 0.25, `corpus lift ${lift.toFixed(3)} under the 0.25 floor`);
});

// ── the zero-delta half of the finish line ───────────────────────────────────
test("unlayered control: attribution is invisible — mask bytes identical to the layered scene built roleless, regions identical, IoU delta exactly 0", () => {
  const control = CORPUS.find((x) => !x.layered)!;
  const tile = CORPUS.find((x) => x.name.startsWith("tile-grid (AIA"))!;
  const c = build(control), l = build(tile);
  // the control never stated anything: no ids, no roles, filtered === roleless
  assert.deepEqual(c.geo.layerIds, []);
  assert.deepEqual(Buffer.from(c.filtered.mask), Buffer.from(c.roleless.mask), "no layers ⇒ the role path must be a byte-level no-op");
  // marked-content attribution alone (same drawing calls, OC wrappers added)
  // must not move a single roleless mask byte — the invisible fallback
  assert.deepEqual(c.geo.segs, l.geo.segs, "control and layered scene draw identical segments");
  assert.deepEqual(Buffer.from(c.roleless.mask), Buffer.from(l.roleless.mask), "attribution changed the roleless mask");
  // and the scored delta is exactly zero, room by room
  const a = scoreRooms(c.roleless, control), b = scoreRooms(c.filtered, control);
  assert.deepEqual(a, b);
});

test("roleless byte-identity holds across the whole corpus: omitting roles and passing null build the same mask", () => {
  for (const f of CORPUS) {
    const geo = extractVectorGeometry(opList(f.ops), ID, OPS as never);
    const a = buildMask(geo.segs, W, H, 3000, geo.meta);
    const b = buildMask(geo.segs, W, H, 3000, geo.meta, null);
    assert.deepEqual(Buffer.from(a.mask), Buffer.from(b.mask), f.name);
  }
});
