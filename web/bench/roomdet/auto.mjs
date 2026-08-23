// AUTO TAKEOFF, scored — the shipping detect_rooms path end to end, against
// his hand takeoffs. This is the product ruler: not "can a click find a room"
// but "how much of the sheet comes back right with no correction".
//
// It runs the REAL path — canvas-identical buildMask args, roomLabelSeeds,
// detectRegions (sealed flood), oneClickRing — so a number here is a number he
// would get in the app. Nothing is reimplemented.
//
// Reports coverage AND accuracy, because a batch detector that reports only
// its hits lies by omission (detectRooms.ts says so itself): a room his takeoff
// has that the pass never proposed is a miss he pays for by drawing it.
//
//   node --import tsx bench/roomdet/auto.mjs <pdf> <sheet_id> <page> <pxPerFt>
import { readFileSync } from "fs";
import { createRequire } from "module";
const req = createRequire("/Users/sfgprecon/dev/opentakeoff/web/bench/callouts.mts");
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
const O = await import("../../src/lib/oneclick.ts");
const D = await import("../../src/lib/detectRooms.ts");
const G = JSON.parse(readFileSync("/Users/sfgprecon/Desktop/OT-Corpus/all-goldens.json", "utf8"));

const [file, sheetId, pageNo, ftPxArg] = process.argv.slice(2);
const ftPx = +ftPxArg;

const doc = await pdfjs.getDocument({ url: file, useSystemFonts: true }).promise;
const page = await doc.getPage(+pageNo);
const vp = page.getViewport({ scale: 1 });
const g = O.extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);

// positioned text, exactly as the canvas resolves it
const tc = await page.getTextContent();
const items = [], marks = [];
for (const it of tc.items) {
  if (!(it.str || "").trim()) continue;
  const t = pdfjs.Util.transform(vp.transform, it.transform);
  const h = Math.hypot(t[2], t[3]) || 8;
  items.push({ str: it.str.trim(), x: t[4], y: t[5], h });
  marks.push({ x: t[4], y: t[5], w: it.width || 0, h });
}

// canvas-identical mask: render scale === base scale here, so k === 1
const mo = O.buildMask(
  g.segs, Math.ceil(vp.width), Math.ceil(vp.height), O.MASK_MAX_DIM, g.meta, ftPx, ftPx,
  { pageW: vp.width, pageH: vp.height, renderScale: 1, baseScale: 1 },
  null,
  { subpaths: g.subpaths || null, texts: marks },
);
const mppf = mo.mppf || ftPx * mo.ws;

const seeds = D.roomLabelSeeds(items, { bounds: D.sheetBounds(vp.width, vp.height) });
const regions = D.detectRegions(mo, seeds, undefined, mppf);
const nearest = O.snapNearest(g.points);

// each proposal → the ring the product returns, in mask px → SF
const props = [];
for (const r of regions) {
  const ring = O.oneClickRing(r.flood, { nearest: null });
  if (ring.length < 3) continue;
  const sf = O.ringArea(ring) / (mppf * mppf);
  // seed back to image px for golden containment
  props.push({ str: r.str, sf, sx: r.seed[0] / mo.ws, sy: r.seed[1] / mo.ws });
}

const rooms = G.shapes.filter((s) => s.sheet_id === sheetId && s.role === "floor_area");
const toPx = (v) => [v[0] * vp.width, v[1] * vp.height];
const inRing = (ring, x, y) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
};

console.log(`${sheetId.slice(0, 44)}`);
console.log(`  text items ${items.length}  label seeds ${seeds.length}  clean floods ${regions.length}  proposals ${props.length}`);

let hit = 0, covered = 0;
const used = new Set();
for (const r of rooms) {
  const ring = r.verts.map(toPx);
  let best = null;
  props.forEach((p, i) => {
    if (used.has(i) || !inRing(ring, p.sx, p.sy)) return;
    if (!best || Math.abs(p.sf - r.sf) < Math.abs(best.p.sf - r.sf)) best = { p, i };
  });
  if (!best) { console.log(`  ${String(r.sf.toFixed(1)).padStart(8)} SF | no proposal`); continue; }
  used.add(best.i);
  covered++;
  const d = (best.p.sf - r.sf) / r.sf * 100;
  const ok = Math.abs(d) <= 5;
  if (ok) hit++;
  console.log(`  ${String(r.sf.toFixed(1)).padStart(8)} SF | ${String(best.p.sf.toFixed(1)).padStart(8)} SF  ${d >= 0 ? "+" : ""}${d.toFixed(1)}%  [${best.p.str}] ${ok ? "OK" : ""}`);
}
const orphan = props.length - used.size;
console.log(`  => COVERAGE ${covered}/${rooms.length} of his rooms proposed;  ACCURACY ${hit}/${rooms.length} within 5%;  ${orphan} proposals matched no room of his`);
