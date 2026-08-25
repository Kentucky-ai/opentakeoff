// Arrangement over ALL ink + merge across non-wall edges. Wall = poché.
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
const ftPx = +ftPxArg, n = g.segs.length>>2;
// ── input: all VISIBLE ink (clip is invisible; curves are door swings) ──
const keep=[]; let kept=0;
for (let i=0;i<n;i++){
  if (g.meta[i] & O.SEG_CLIP) continue;
  if (g.meta[i] & O.SEG_CURVE) continue;
  const L=Math.hypot(g.segs[i*4+2]-g.segs[i*4], g.segs[i*4+3]-g.segs[i*4+1]);
  if (L < 0.05*ftPx) continue;
  kept++; keep.push(g.segs[i*4],g.segs[i*4+1],g.segs[i*4+2],g.segs[i*4+3]);
}
const t0=Date.now();
const arr=A.buildArrangement(keep, 0.05*ftPx);
console.log(`${sheetId.slice(0,34)}: ${n}→${kept} segs | ${arr.nodes.length} nodes ${arr.faces.length} faces | ${Date.now()-t0}ms`);
// ── SOLID = a THIN face. A wall is thin; that is what makes it a wall.
// width ~ 2*area/perimeter (exact from the face, no colour or threshold guess
// about what ink "is"). A room is feet wide; a wall is inches.
const WALL_W_FT = +(process.env.WALLW || 1.25);
const solidMemo=new Map();
const solid=(fi)=>{
  let v=solidMemo.get(fi); if(v!==undefined) return v;
  const f=arr.faces[fi];
  if(f.area<=0){solidMemo.set(fi,true);return true;}
  let per=0;
  for(let i=0;i<f.verts.length;i++){const p=f.verts[i],q=f.verts[(i+1)%f.verts.length];per+=Math.hypot(q[0]-p[0],q[1]-p[1]);}
  const w = per>0 ? (2*f.area)/per : 0;
  // A wall face is thin AND LONG — it separates spaces, which is what makes
  // it a wall. A sliver between a fixture and the wall behind it is thin and
  // SHORT; treating those as wall material fragmented small rooms until no
  // face survived and the click found nothing at all.
  v = w < WALL_W_FT*ftPx;
  solidMemo.set(fi,v); return v;
};
// ── score ──
const toPx=(v)=>[v[0]*vp.width,v[1]*vp.height];
const shoe=(r)=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2;};
const cen=(r)=>{let cx=0,cy=0,Ar=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];const c=p[0]*q[1]-q[0]*p[1];Ar+=c;cx+=(p[0]+q[0])*c;cy+=(p[1]+q[1])*c;}Ar/=2;return Ar?[cx/(6*Ar),cy/(6*Ar)]:r[0];};
const rooms=G.shapes.filter(s=>s.sheet_id===sheetId&&s.role==="floor_area");
console.log(`   his SF verts |  ROOM SF   v   faces   Δ%`);
let ok=0;
for(const s of rooms){
  const ring=s.verts.map(toPx), hisSF=shoe(ring)/(ftPx*ftPx), [cx,cy]=cen(ring);
  const fi=A.faceAt(arr,cx,cy,solid);
  if(fi<0){console.log(`  ${hisSF.toFixed(1).padStart(7)} ${String(s.verts.length).padStart(3)}v |  (no face)`);continue;}
  const seed=fi;
  const set=seed>=0?A.growRoom(arr,seed,solid):[];
  if(!set.length){console.log(`  ${hisSF.toFixed(1).padStart(7)} ${String(s.verts.length).padStart(3)}v |  (no room)`);continue;}
  let a=0; for(const f of set) a+=arr.faces[f].area;
  const sf=a/(ftPx*ftPx);
  const out=A.roomOutline(arr,set);
  const d=100*(sf-hisSF)/hisSF;
  if(Math.abs(d)<=5)ok++;
  console.log(`  ${hisSF.toFixed(1).padStart(7)} ${String(s.verts.length).padStart(3)}v | ${sf.toFixed(1).padStart(8)} ${String(out.ring.length).padStart(3)}v ${String(set.length).padStart(5)}  ${(d>=0?"+":"")+d.toFixed(1)}%`);
}
console.log(`  → within 5%: ${ok}/${rooms.length}`);
