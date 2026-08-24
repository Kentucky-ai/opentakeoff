// ORACLE — NOT A METHOD. Establishes the ceiling for one hypothesis before we
// pay to build it: "the auto takeoff undershoots because nothing classifies
// furniture, so the flood stops on a sofa instead of the wall."
//
// It cheats deliberately: every segment whose midpoint lies more than INSET ft
// inside one of HIS golden rings is declared non-boundary ink via the `roles`
// plane buildMask already honours (role 2 = stated pattern). Wall ink, which
// lies ON his ring, survives. Then it runs the SHIPPING auto path unchanged.
//
// Read the result as a ceiling only:
//   near 100%  → furniture classification is the whole remaining problem, and
//                a real classifier is worth building.
//   still low  → furniture is NOT the blocker; do not spend a day on it.
//
//   node --import tsx bench/roomdet/oracle.mjs <pdf> <sheet_id> <page> <pxPerFt> [inset_ft] [mode]
//   mode: "drop" (role 2, ink removed) | "soft" (role 0 but softened) — default drop
import { readFileSync } from "fs";
import { createRequire } from "module";
const req = createRequire("/Users/sfgprecon/dev/opentakeoff/web/bench/callouts.mts");
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
const O = await import("../../src/lib/oneclick.ts");
const D = await import("../../src/lib/detectRooms.ts");
const DS = await import("../../src/lib/doorseal.ts");
const G = JSON.parse(readFileSync("/Users/sfgprecon/Desktop/OT-Corpus/all-goldens.json", "utf8"));

const [file, sheetId, pageNo, ftPxArg, insetArg] = process.argv.slice(2);
const ftPx = +ftPxArg;
const INSET = +(insetArg || 0.75);

const doc = await pdfjs.getDocument({ url: file, useSystemFonts: true }).promise;
const page = await doc.getPage(+pageNo);
const vp = page.getViewport({ scale: 1 });
const g = O.extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);

const tc = await page.getTextContent();
const items = [], marks = [];
for (const it of tc.items) {
  if (!(it.str || "").trim()) continue;
  const t = pdfjs.Util.transform(vp.transform, it.transform);
  const h = Math.hypot(t[2], t[3]) || 8;
  items.push({ str: it.str.trim(), x: t[4], y: t[5], h });
  marks.push({ x: t[4], y: t[5], w: it.width || 0, h });
}

const rooms = G.shapes.filter((s) => s.sheet_id === sheetId && s.role === "floor_area");
const toPx = (v) => [v[0] * vp.width, v[1] * vp.height];
const rings = rooms.map((r) => r.verts.map(toPx));
const inRing = (ring, x, y) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
};
const dRing = (ring, x, y) => {
  let m = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy || 1;
    let t = ((x - a[0]) * dx + (y - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    m = Math.min(m, Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)));
  }
  return m;
};

// the cheat: interior ink → role 2 (stated pattern, dropped from the mask)
const n = g.segs.length >> 2;
const roles = new Uint8Array(n);
let dropped = 0;
for (let i = 0; i < n; i++) {
  const mx = (g.segs[i * 4] + g.segs[i * 4 + 2]) / 2;
  const my = (g.segs[i * 4 + 1] + g.segs[i * 4 + 3]) / 2;
  for (const ring of rings) {
    if (!inRing(ring, mx, my)) continue;
    if (dRing(ring, mx, my) / ftPx > INSET) { roles[i] = 2; dropped++; }
    break;
  }
}

const seal = (mo) => {
  if (!process.env.SEAL) return mo;
  return DS.sealDoorways(mo, DS.findDoorSeals(g.segs, g.meta, mo, ftPx)).mo;
};

const run = (rolesArg, label) => {
  const mo0 = O.buildMask(
    g.segs, Math.ceil(vp.width), Math.ceil(vp.height), O.MASK_MAX_DIM, g.meta, ftPx, ftPx,
    { pageW: vp.width, pageH: vp.height, renderScale: 1, baseScale: 1 },
    rolesArg,
    { subpaths: g.subpaths || null, texts: marks },
  );
  const mo = seal(mo0);
  const mppf = mo.mppf || ftPx * mo.ws;
  const seeds = D.roomLabelSeeds(items, { bounds: D.sheetBounds(vp.width, vp.height) });
  const regions = D.detectRegions(mo, seeds, undefined, mppf);
  const props = [];
  for (const r of regions) {
    const ring = O.oneClickRing(r.flood, { nearest: null });
    if (ring.length < 3) continue;
    props.push({ str: r.str, sf: O.ringArea(ring) / (mppf * mppf), sx: r.seed[0] / mo.ws, sy: r.seed[1] / mo.ws });
  }
  let hit = 0, covered = 0;
  const used = new Set();
  const lines = [];
  rooms.forEach((r, ri) => {
    const ring = rings[ri];
    let best = null;
    props.forEach((p, i) => {
      if (used.has(i) || !inRing(ring, p.sx, p.sy)) return;
      if (!best || Math.abs(p.sf - r.sf) < Math.abs(best.p.sf - r.sf)) best = { p, i };
    });
    if (!best) { lines.push(`  ${String(r.sf.toFixed(1)).padStart(8)} SF | no proposal`); return; }
    used.add(best.i); covered++;
    const d = (best.p.sf - r.sf) / r.sf * 100;
    if (Math.abs(d) <= 5) hit++;
    lines.push(`  ${String(r.sf.toFixed(1)).padStart(8)} SF | ${String(best.p.sf.toFixed(1)).padStart(8)} SF  ${d >= 0 ? "+" : ""}${d.toFixed(1)}%  [${best.p.str}] ${Math.abs(d) <= 5 ? "OK" : ""}`);
  });
  console.log(`${label}`);
  for (const l of lines) console.log(l);
  console.log(`  => COVERAGE ${covered}/${rooms.length};  ACCURACY ${hit}/${rooms.length} within 5%`);
  return hit;
};

console.log(`${sheetId.slice(0, 44)}  —  ${dropped}/${n} segments declared interior at inset ${INSET} ft`);
const base = run(null, "\nBASELINE (shipping path, no cheat):");
const ceil = run(roles, `\nORACLE, ALL ROOMS (interior ink erased using HIS rings — NOT A METHOD):`);

// ── per-room attribution ────────────────────────────────────────────────────
// Erase the interior ink of ONE room only, then flood that room's own seed.
// Clean attribution of every undershoot:
//   fixed        → furniture was the blocker. A furniture classifier buys it.
//   still short  → something else stops the flood (not furniture).
//   blows up     → the doorway was never sealed; furniture was holding it in.
console.log(`\nPER-ROOM ATTRIBUTION (erase one room's interior ink, flood that room):`);
const seedsAll = D.roomLabelSeeds(items, { bounds: D.sheetBounds(vp.width, vp.height) });
let nFurn = 0, nOther = 0, nDoor = 0;
rooms.forEach((r, ri) => {
  const ring = rings[ri];
  const one = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const mx = (g.segs[i * 4] + g.segs[i * 4 + 2]) / 2;
    const my = (g.segs[i * 4 + 1] + g.segs[i * 4 + 3]) / 2;
    if (inRing(ring, mx, my) && dRing(ring, mx, my) / ftPx > INSET) one[i] = 2;
  }
  const mo = seal(O.buildMask(
    g.segs, Math.ceil(vp.width), Math.ceil(vp.height), O.MASK_MAX_DIM, g.meta, ftPx, ftPx,
    { pageW: vp.width, pageH: vp.height, renderScale: 1, baseScale: 1 },
    one,
    { subpaths: g.subpaths || null, texts: marks },
  ));
  const mppf = mo.mppf || ftPx * mo.ws;
  const mine = seedsAll.filter((s) => inRing(ring, s.seed[0], s.seed[1]));
  if (!mine.length) { console.log(`  ${String(r.sf.toFixed(1)).padStart(8)} SF | no seed in room`); return; }
  const regions = D.detectRegions(mo, mine, undefined, mppf);
  let best = null;
  for (const rg of regions) {
    const rr = O.oneClickRing(rg.flood, { nearest: null });
    if (rr.length < 3) continue;
    const sf = O.ringArea(rr) / (mppf * mppf);
    if (!best || Math.abs(sf - r.sf) < Math.abs(best - r.sf)) best = sf;
  }
  if (best == null) { console.log(`  ${String(r.sf.toFixed(1)).padStart(8)} SF | no clean flood`); return; }
  const d = (best - r.sf) / r.sf * 100;
  let verdict;
  if (Math.abs(d) <= 5) { verdict = "FURNITURE WAS THE BLOCKER"; nFurn++; }
  else if (d > 25) { verdict = "doorway leaks once furniture is crossed"; nDoor++; }
  else { verdict = "still short — not furniture"; nOther++; }
  console.log(`  ${String(r.sf.toFixed(1)).padStart(8)} SF | ${String(best.toFixed(1)).padStart(8)} SF  ${d >= 0 ? "+" : ""}${d.toFixed(1)}%  ${verdict}`);
});
console.log(`\nATTRIBUTION: furniture-only ${nFurn}   doorway-leak ${nDoor}   other ${nOther}   (of ${rooms.length})`);
console.log(`CEILING (all-rooms oracle): ${base} → ${ceil} of ${rooms.length}`);
