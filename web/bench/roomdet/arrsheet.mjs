// Arrangement on a real sheet, scored against his hand takeoff.
import { readFileSync } from "fs";
import { createRequire } from "module";
const req = createRequire("/Users/sfgprecon/dev/opentakeoff/web/bench/callouts.mts");
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
const O = await import("/Users/sfgprecon/dev/opentakeoff/web/src/lib/oneclick.ts");
const A = await import("/Users/sfgprecon/dev/opentakeoff/web/src/lib/arrangement.ts");
const G = JSON.parse(readFileSync("/Users/sfgprecon/Desktop/OT-Corpus/all-goldens.json","utf8"));
const [file, sheetId, pageNo, ftPxArg] = process.argv.slice(2);
const doc = await pdfjs.getDocument({url:file,useSystemFonts:true}).promise;
const page = await doc.getPage(+pageNo);
const vp = page.getViewport({scale:1});
const g = O.extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);
const ftPx = +ftPxArg;
const n = g.segs.length >> 2;
// ── candidate structural ink ──────────────────────────────────────────────
const fleck = O.classifyFleckSegs(g.segs, g.meta, g.subpaths, 1, ftPx);
const hatch = O.classifyHatchSegs(g.segs, g.meta, 1, O.HATCH_MAX_PITCH_FT * ftPx);
const MODE = process.env.MODE || "all";
const keep = [];
let kept=0;
for (let i = 0; i < n; i++) {
  if (g.meta[i] & O.SEG_CLIP) continue;
  const isFill = !!(g.meta[i] & O.SEG_FILLONLY);
  const pen = g.meta[i] >> 4;
  const L = Math.hypot(g.segs[i*4+2]-g.segs[i*4], g.segs[i*4+3]-g.segs[i*4+1]);
  let take;
  if (MODE === "fill") take = isFill;
  else if (MODE === "fillheavy") take = isFill || (pen >= 2 && L >= 0.5*ftPx);
  else if (MODE === "filllong") take = isFill || (!fleck[i] && !hatch[i] && !(g.meta[i]&O.SEG_CURVE) && L >= 2*ftPx);
  else take = !fleck[i] && !hatch[i] && !(g.meta[i]&O.SEG_CURVE) && L >= 0.15*ftPx;
  if (!take) continue;
  kept++;
  keep.push(g.segs[i*4], g.segs[i*4+1], g.segs[i*4+2], g.segs[i*4+3]);
}
console.log(`${sheetId.slice(0,34)} [MODE=${MODE}]: ${n} segs → ${kept} structural`);
const t0 = Date.now();
const arr = A.buildArrangement(keep, 0.06*ftPx);
console.log(`  arrangement: ${arr.nodes.length} nodes, ${arr.edges.length>>1} edges, ${arr.faces.length} faces in ${Date.now()-t0}ms`);
const bounded = arr.faces.filter(f=>f.area>0);
const roomish = bounded.filter(f=>f.area/(ftPx*ftPx) >= 12);
console.log(`  bounded faces: ${bounded.length}, of them >=12 SF: ${roomish.length}`);
// score
const toPx=(v)=>[v[0]*vp.width, v[1]*vp.height];
const shoe=(r)=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2;};
const cen=(r)=>{let cx=0,cy=0,Ar=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];const c=p[0]*q[1]-q[0]*p[1];Ar+=c;cx+=(p[0]+q[0])*c;cy+=(p[1]+q[1])*c;}Ar/=2;return Ar?[cx/(6*Ar),cy/(6*Ar)]:r[0];};
const rooms = G.shapes.filter(s=>s.sheet_id===sheetId && s.role==="floor_area");
console.log(`   his SF verts |  FACE SF    v    Δ%`);
let ok=0, none=0;
for (const s of rooms) {
  const ring=s.verts.map(toPx); const hisSF=shoe(ring)/(ftPx*ftPx); const [cx,cy]=cen(ring);
  const fi = A.faceAt(arr, cx, cy);
  if (fi < 0) { console.log(`  ${hisSF.toFixed(1).padStart(7)} ${String(s.verts.length).padStart(3)}v |   (no face)`); none++; continue; }
  const f = arr.faces[fi];
  const sf = f.area/(ftPx*ftPx);
  const d = 100*(sf-hisSF)/hisSF;
  if (Math.abs(d)<=5) ok++;
  console.log(`  ${hisSF.toFixed(1).padStart(7)} ${String(s.verts.length).padStart(3)}v | ${sf.toFixed(1).padStart(9)} ${String(f.verts.length).padStart(3)}v ${(d>=0?"+":"")+d.toFixed(1)}%`);
}
console.log(`  → within 5%: ${ok}/${rooms.length}   no face: ${none}`);
