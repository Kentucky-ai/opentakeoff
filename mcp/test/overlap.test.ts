// NO TWO REGIONS THE ENGINE HANDS OVER MAY SHARE FLOOR.
//
// This is the invariant `web/bench/run.mts`'s `pairwiseOverlapFrac` is reaching
// for and structurally cannot express: it compares a case's eight PINNED probes,
// so it can only see overlap between regions someone already thought to pin. It
// reports 0.000% on the sheet below while 16 SF of it is counted twice.
//
// What an estimator actually does is sweep with detect_rooms and then hand-click
// the spaces the sweep didn't name. So that is what this checks — every ring
// detect_rooms commits, plus hand clicks on the unnumbered spaces, run through
// an all-pairs intersection. A double-count is money: two regions that share
// floor put that floor in the bid twice, and neither reply says so.
//
// Deliberately NOT engine-self-referential: the overlap is measured off the
// returned vertex rings by point-in-polygon sampling, not by asking the engine
// whether it thinks it overlapped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));
const KEY = "sample-finish-plan.pdf";

// The spaces on this sheet that carry no room number, so detect_rooms never
// names them and only a hand click reaches them. These are the clicks that
// exposed the defect this test exists for.
const HAND: [string, number, number][] = [
  ["room-158", 3913, 2500],
  ["corridor-CE-5", 4089, 2440],
  ["room-140", 3675, 875],
  ["enclosed-sliver-in-140", 3523, 1080],
];

// A whole-sheet region overlaps everything by construction; it is its own
// defect (detect_rooms reporting the sheet as a room) and is counted as one
// below rather than smeared across 20 pairs.
const OVERSIZE_SF = 10_000;
const MIN_REPORT_SF = 0.05;      // below this is raster noise on a shared wall

type Ring = { name: string; verts: number[][]; sf: number };

const bbox = (p: number[][]) => [
  Math.min(...p.map((v) => v[0])), Math.min(...p.map((v) => v[1])),
  Math.max(...p.map((v) => v[0])), Math.max(...p.map((v) => v[1])),
];
const inside = (x: number, y: number, poly: number[][]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
/** Shared area of two rings, in SF. Grid-sampled over the bbox intersection —
 *  the step is derived from that rectangle alone, so the answer is
 *  deterministic for a given pair and precise to well under MIN_REPORT_SF at
 *  these sizes. */
function overlapSf(a: number[][], b: number[][], sfPerPx: number) {
  const A = bbox(a), B = bbox(b);
  const x0 = Math.max(A[0], B[0]), y0 = Math.max(A[1], B[1]);
  const x1 = Math.min(A[2], B[2]), y1 = Math.min(A[3], B[3]);
  if (x1 <= x0 || y1 <= y0) return 0;
  const step = Math.max(0.25, Math.sqrt(((x1 - x0) * (y1 - y0)) / 3_000_000));
  let n = 0;
  for (let x = x0 + step / 2; x < x1; x += step)
    for (let y = y0 + step / 2; y < y1; y += step)
      if (inside(x, y, a) && inside(x, y, b)) n++;
  return n * step * step * sfPerPx;
}

test("no two regions the engine hands over on one sheet share floor", async (t) => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session(), { oneClick: true }).connect(st);
  const client = new Client({ name: "overlap", version: "0.0.0" });
  await client.connect(ct);
  const call = async (name: string, args: unknown) => {
    const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
    const txt = (r.content as { type: string; text?: string }[])
      .find((c) => c.type === "text")?.text ?? "{}";
    return JSON.parse(txt);
  };

  await call("load_plan", { path: PLAN });
  const sc = await call("set_scale", { sheet: KEY, use_detected: true });
  const sfPerPx = (sc.upp as number) ** 2;

  const rings: Ring[] = [];
  const det = await call("detect_rooms", { sheet: KEY, return_verts: true });
  for (const r of det.rooms as { label: string; verts: number[][]; area_sf: number }[]) {
    rings.push({ name: `detect:${r.label}`, verts: r.verts, sf: r.area_sf });
  }
  for (const [name, x, y] of HAND) {
    const r = await call("one_click", { sheet: KEY, x, y, return_verts: true });
    if (r.status === "ok" && r.verts) rings.push({ name: `click:${name}`, verts: r.verts, sf: r.area_sf });
  }

  const usable = rings.filter((r) => r.verts?.length >= 3);
  assert.ok(usable.length >= 20, `only ${usable.length} regions came back — the sweep did not run`);
  const sweepable = usable.filter((r) => r.sf < OVERSIZE_SF);

  const hits: { a: Ring; b: Ring; sf: number }[] = [];
  for (let i = 0; i < sweepable.length; i++)
    for (let j = i + 1; j < sweepable.length; j++) {
      const sf = overlapSf(sweepable[i].verts, sweepable[j].verts, sfPerPx);
      if (sf >= MIN_REPORT_SF) hits.push({ a: sweepable[i], b: sweepable[j], sf });
    }
  hits.sort((x, y) => y.sf - x.sf);
  for (const h of hits) {
    t.diagnostic(`${h.sf.toFixed(2)} SF shared — ${h.a.name} (${h.a.sf.toFixed(2)}) x ${h.b.name} (${h.b.sf.toFixed(2)})`);
  }

  // ── ADJUDICATED, each with the reason it is still here ────────────────────
  //
  // Anything NOT in this table is an unadjudicated double-count and fails. That
  // is the point: a new one must be looked at by a person, not absorbed.
  //
  // 1. detect_rooms labels CORRIDOR CE-5 "557" because the sheet PRINTS
  //    "557 SF" beside it and the printed AREA is read as a room number. The
  //    ring is correct; the name is not, so the same corridor arrives twice —
  //    once from the sweep, once from the hand click that an estimator makes
  //    because "557" did not look like the corridor they were after. This is
  //    the detect_rooms ownership class, open upstream, and it is a NAMING
  //    defect with a geometry symptom.
  // 2. An 11.55 SF enclosed region sitting wholly inside room 140, separately
  //    clickable. Traces to #188 (annotation-ring recovery), a different
  //    mechanism from the door sector, and unfixed.
  //
  // Ceilings, not equalities: these may shrink, and the day one shrinks to
  // nothing the entry must be retired rather than loosened.
  const ADJUDICATED: { a: string; b: string; maxSf: number; why: string }[] = [
    { a: "detect:557", b: "click:corridor-CE-5", maxSf: 641, why: "same corridor, named off its printed area" },
    { a: "click:room-140", b: "click:enclosed-sliver-in-140", maxSf: 12, why: "#188 annotation-ring recovery" },
    { a: "detect:140", b: "click:enclosed-sliver-in-140", maxSf: 12, why: "#188 annotation-ring recovery — the same sliver, now that the sweep reaches 140 (#373)" },
    { a: "detect:153", b: "detect:557", maxSf: 1, why: "a threshold sliver at 153's door against corridor CE-5 — under a third of a square foot, visible only since the sweep reaches 153 (#373)" },
    { a: "detect:153", b: "click:corridor-CE-5", maxSf: 1, why: "the same threshold sliver, corridor arm" },
  ];
  const known = (h: { a: Ring; b: Ring }) =>
    ADJUDICATED.find((k) =>
      (k.a === h.a.name && k.b === h.b.name) || (k.a === h.b.name && k.b === h.a.name));

  // ── cross-arm parity, not double-count (#373) ─────────────────────────────
  // The hand clicks below were stand-ins for rooms the sweep could not reach
  // while the wide tag boxes stopped its ladder. Now that detect_rooms reaches
  // 140 and 158, "detect:140 x click:room-140" is the SAME room measured by two
  // arms, and the honest assertion is that the two arms agree, not that they
  // never touch.
  const sameRoom = (h: { a: Ring; b: Ring }) => {
    const m = (n: string) => n.replace(/^detect:/, "").replace(/^click:room-/, "");
    return h.a.name !== h.b.name && m(h.a.name) === m(h.b.name);
  };
  for (const h of hits.filter(sameRoom)) {
    assert.ok(Math.abs(h.a.sf - h.b.sf) < 0.5, `${h.a.name} and ${h.b.name} are one room traced by two arms and must agree: ${h.a.sf} vs ${h.b.sf} SF`);
  }

  const fresh = hits.filter((h) => !known(h) && !sameRoom(h));
  assert.deepEqual(
    fresh.map((h) => `${h.a.name} x ${h.b.name} = ${h.sf.toFixed(2)} SF`), [],
    "unadjudicated double-count: two regions the engine handed over share floor. "
    + "Either fix it, or add it to ADJUDICATED with the reason it is tolerable.",
  );

  for (const h of hits.filter((x) => !sameRoom(x))) {
    const k = known(h)!;
    assert.ok(h.sf <= k.maxSf, `${h.a.name} x ${h.b.name} grew to ${h.sf.toFixed(2)} SF, past its ${k.maxSf} SF ceiling (${k.why})`);
  }

  // ── the fix this test was written for ─────────────────────────────────────
  // PATIENT ROOM 158 and CORRIDOR CE-5 shared 16.18 SF: a pair of doors swinging
  // into the corridor fit one ~180° arc, the leaf ray landed on room 158's WALL
  // instead of on a panel, and opening that stub let the room walk out through
  // its own doorway. Both regions then reported the sector. See LEAF_MIN_SPAN_R.
  const r158 = usable.find((r) => r.name === "click:room-158");
  const ce5 = usable.find((r) => r.name === "click:corridor-CE-5");
  assert.ok(r158 && ce5, "the two probe clicks must both trace");
  assert.equal(
    +overlapSf(r158!.verts, ce5!.verts, sfPerPx).toFixed(2), 0,
    "room 158 and corridor CE-5 share floor again — the door sector is being annexed by both sides",
  );
});
