// Click a grid over a room's bbox; how many DISTINCT regions come back?
import { createRequire } from "module";
const req = createRequire("/Users/sfgprecon/dev/opentakeoff/web/bench/callouts.mts");
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
const O = await import("/Users/sfgprecon/dev/opentakeoff/web/src/lib/oneclick.ts");
const [file, pageNo, ftPxArg, box, mode="new"] = process.argv.slice(2);
const doc = await pdfjs.getDocument({ url: file, useSystemFonts: true }).promise;
const page = await doc.getPage(+pageNo);
const vp = page.getViewport({ scale: 1 });
const g = O.extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);
const ftPx = +ftPxArg;
const baseDim = Math.min(O.MASK_MAX_DIM, Math.max(vp.width, vp.height, 2));
const tc = await page.getTextContent();
const texts = [];
for (const it of tc.items) {
  if (!(it.str||"").trim()) continue;
  const t = pdfjs.Util.transform(vp.transform, it.transform);
  texts.push({ x:t[4], y:t[5], w:(it.width||0), h:Math.hypot(t[2],t[3])||8 });
}
const mo = mode==="old" ? O.buildMask(g.segs, vp.width, vp.height, baseDim, g.meta, ftPx)
  : mode==="tex" ? O.buildMask(g.segs, vp.width, vp.height, baseDim, g.meta, ftPx, 0, null, null, { subpaths: g.subpaths })
  : O.buildMask(g.segs, vp.width, vp.height, baseDim, g.meta, ftPx, 0, null, null, { subpaths: g.subpaths, texts });
const [x0,y0,x1,y1] = box.split(",").map(Number);
const tally = new Map();
let n=0, leaks=0;
for (let y=y0; y<=y1; y+=12) for (let x=x0; x<=x1; x+=12) {
  n++;
  const r = O.floodRegionSealed(mo,x,y,0.5,O.sealRadiiFor(mo.mppf),O.doorWedgeCapPx(mo.mppf),O.minPassRadiusFor(mo.mppf));
  if (r.status!=="ok") { leaks++; continue; }
  const k = r.count;
  const e = tally.get(k) || { n:0, sf:r.count/(mo.mppf*mo.mppf), v:O.traceRegion(r).length, r };
  e.n++; tally.set(k,e);
}
const sorted=[...tally.entries()].sort((a,z)=>z[1].n-a[1].n);
// what IS each wrong answer? bbox + what bounds it
for (const [k,e] of sorted.slice(0,8)) {
  if (!e.r) continue;
  const ring = O.traceRegion(e.r).map(([x,y])=>[x/mo.ws,y/mo.ws]);
  const xs=ring.map(v=>v[0]), ys=ring.map(v=>v[1]);
  const bw=(Math.max(...xs)-Math.min(...xs))/ftPx, bh=(Math.max(...ys)-Math.min(...ys))/ftPx;
  console.log(`   ${String(e.n).padStart(3)}cl ${e.sf.toFixed(1)}SF ${e.v}v  box ${bw.toFixed(1)}x${bh.toFixed(1)}ft @(${Math.min(...xs).toFixed(0)},${Math.min(...ys).toFixed(0)})  soft=${e.r.softHits} hard=${e.r.hardHits} esc=${!!e.r.hatchFiltered}/${e.r.hatchTier||"-"}`);
}
console.log(`[${mode}] ${n} clicks in the room box → ${tally.size} DISTINCT regions, ${leaks} non-ok`);

const top = sorted[0];
console.log(`   dominant answer covers ${(100*top[1].n/n).toFixed(0)}% of clicks`);
