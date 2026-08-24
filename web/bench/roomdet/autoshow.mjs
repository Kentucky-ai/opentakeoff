// PROOF for the AUTO TAKEOFF: what detect_rooms actually returns, over the plan.
// His ring GREEN, the flood's ring BLUE within 5% / RED outside, door seals
// ORANGE. Numbers without a picture are worthless here — this is how the flood
// path reports.
//
//   node --import tsx bench/roomdet/autoshow.mjs <pdf> <sheet_id> <page> <pxPerFt> <x0,y0,x1,y1> <out.png>
//   SEAL=1 to close the openings first;  UPS=2 to upsample the crop.
import { readFileSync, writeFileSync } from "fs";
import zlib from "zlib";
import { createRequire } from "module";
const req = createRequire("/Users/sfgprecon/dev/opentakeoff/web/bench/callouts.mts");
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
const O = await import("../../src/lib/oneclick.ts");
const D = await import("../../src/lib/detectRooms.ts");
const DS = await import("../../src/lib/doorseal.ts");
const G = JSON.parse(readFileSync("/Users/sfgprecon/Desktop/OT-Corpus/all-goldens.json", "utf8"));

const [file, sheetId, pageNo, ftPxArg, crop, outName] = process.argv.slice(2);
const ftPx = +ftPxArg;
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
const mo0 = O.buildMask(
  g.segs, Math.ceil(vp.width), Math.ceil(vp.height), O.MASK_MAX_DIM, g.meta, ftPx, ftPx,
  { pageW: vp.width, pageH: vp.height, renderScale: 1, baseScale: 1 },
  null, { subpaths: g.subpaths || null, texts: marks },
);
let mo = mo0, seals = [];
if (process.env.SEAL) {
  seals = DS.findDoorSeals(g.segs, g.meta, mo0, ftPx);
  mo = DS.sealDoorways(mo0, seals).mo;
}
const mppf = mo.mppf || ftPx * mo.ws;
const seeds = D.roomLabelSeeds(items, { bounds: D.sheetBounds(vp.width, vp.height) });
const regions = D.detectRegions(mo, seeds, undefined, mppf);

const toPx = (v) => [v[0] * vp.width, v[1] * vp.height];
const shoe = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
const cen = (r) => { let cx = 0, cy = 0, A = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; const c = p[0] * q[1] - q[0] * p[1]; A += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c; } A /= 2; return A ? [cx / (6 * A), cy / (6 * A)] : r[0]; };
const inRing = (ring, x, y) => { let s = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) s = !s; } return s; };

const [cx0, cy0, cx1, cy1] = (crop || `0,0,${vp.width},${vp.height}`).split(",").map(Number);
const S = +(process.env.UPS || 1);
const W = Math.round((cx1 - cx0) * S), H = Math.round((cy1 - cy0) * S);
const img = Buffer.alloc(W * H * 3, 255);
const px = (x, y, r, gg, b) => { x = Math.round((x - cx0) * S); y = Math.round((y - cy0) * S); if (x >= 0 && y >= 0 && x < W && y < H) { const o = (y * W + x) * 3; img[o] = r; img[o + 1] = gg; img[o + 2] = b; } };
const line = (a, b, r, gg, bl, wide) => {
  const L = Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]) * S);
  for (let t = 0; t <= L; t++) {
    const x = a[0] + (b[0] - a[0]) * t / L, y = a[1] + (b[1] - a[1]) * t / L;
    px(x, y, r, gg, bl);
    if (wide) for (const [dx, dy] of [[0.5, 0], [0, 0.5], [0.5, 0.5], [-0.5, 0], [0, -0.5]]) px(x + dx / S, y + dy / S, r, gg, bl);
  }
};
// plan, faint
for (let i = 0; i + 3 < g.segs.length; i += 4) line([g.segs[i], g.segs[i + 1]], [g.segs[i + 2], g.segs[i + 3]], 190, 190, 190, false);

// the flood's rings, in image px
const props = [];
for (const r of regions) {
  const ring = O.oneClickRing(r.flood, { nearest: null });
  if (ring.length < 3) continue;
  props.push({
    str: r.str,
    sf: O.ringArea(ring) / (mppf * mppf),
    ring: ring.map(([x, y]) => [x / mo.ws, y / mo.ws]),
    sx: r.seed[0] / mo.ws, sy: r.seed[1] / mo.ws,
  });
}

const rooms = G.shapes.filter((s) => s.sheet_id === sheetId && s.role === "floor_area");
const rows = [];
const used = new Set();
for (const s of rooms) {
  const ring = s.verts.map(toPx);
  const hisSF = shoe(ring) / (ftPx * ftPx);
  for (let i = 0; i < ring.length; i++) line(ring[i], ring[(i + 1) % ring.length], 20, 150, 60, true);   // HIS: green
  let best = null;
  props.forEach((p, i) => {
    if (used.has(i) || !inRing(ring, p.sx, p.sy)) return;
    if (!best || Math.abs(p.sf - hisSF) < Math.abs(best.p.sf - hisSF)) best = { p, i };
  });
  if (!best) { rows.push(`${hisSF.toFixed(0)} SF: no proposal`); continue; }
  used.add(best.i);
  const d = 100 * (best.p.sf - hisSF) / hisSF;
  const col = Math.abs(d) <= 5 ? [0, 90, 220] : [225, 40, 40];
  const mc = cen(best.p.ring);
  const shrink = (pt) => { const dx = pt[0] - mc[0], dy = pt[1] - mc[1], L = Math.hypot(dx, dy) || 1; return [pt[0] - dx / L * 3, pt[1] - dy / L * 3]; };
  const mine = best.p.ring.map(shrink);
  for (let i = 0; i < mine.length; i++) line(mine[i], mine[(i + 1) % mine.length], col[0], col[1], col[2], true);
  rows.push(`${hisSF.toFixed(0)} → ${best.p.sf.toFixed(0)} SF  ${(d >= 0 ? "+" : "") + d.toFixed(1)}%`);
}
// door seals last, on top — ORANGE
for (const s of seals) line(s.hinge, s.strike, 255, 140, 0, true);

console.log(rows.join("\n"));
console.log(`seals ${seals.length}`);
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
const idat = zlib.deflateSync(raw, { level: 6 });
const crcT = (() => { const t = new Int32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; } return t; })();
const crc = (bf) => { let c = -1; for (const b of bf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cc]); };
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
writeFileSync(outName, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]));
console.log("→", outName);
