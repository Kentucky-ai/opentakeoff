// Cross-sheet: does the DRAWN-POLYGON path hold on other drafters?
import { readFileSync } from "fs";
import { createRequire } from "module";
const req = createRequire("/Users/sfgprecon/dev/opentakeoff/web/bench/callouts.mts");
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
const O = await import("/Users/sfgprecon/dev/opentakeoff/web/src/lib/oneclick.ts");
const D = await import("/Users/sfgprecon/dev/opentakeoff/web/src/lib/drawnrooms.ts");
const G = JSON.parse(readFileSync("/Users/sfgprecon/Desktop/OT-Corpus/all-goldens.json","utf8"));
const [file, sheetId, pageNo, ftPxArg] = process.argv.slice(2);
const doc = await pdfjs.getDocument({url:file,useSystemFonts:true}).promise;
const page = await doc.getPage(+pageNo);
const vp = page.getViewport({scale:1});
const g = O.extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);
let ftPx=+ftPxArg;
// derive px/ft EXACTLY from his own shapes: shoelace(px)/ftPx^2 = his stored SF
{
  const shoe=(r)=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2;};
  const cal=G.shapes.filter(s=>s.sheet_id===sheetId && s.sf>0)
    .map(s=>Math.sqrt(shoe(s.verts.map(v=>[v[0]*vp.width, v[1]*vp.height]))/s.sf))
    .filter(v=>Number.isFinite(v)&&v>0).sort((a,b)=>a-b);
  if (cal.length && !(+ftPxArg>0)) { ftPx = cal[cal.length>>1]; }
}
const sheetSF=(vp.width/ftPx)*(vp.height/ftPx);
const regions = D.drawnRegions(g.segs, g.subpaths, ftPx, sheetSF);
const tc = await page.getTextContent();
const texts=[]; for(const it of tc.items){ if(!(it.str||"").trim()) continue;
  const t=pdfjs.Util.transform(vp.transform,it.transform); texts.push({x:t[4],y:t[5],w:(it.width||0),h:Math.hypot(t[2],t[3])||8}); }
const baseDim=Math.min(O.MASK_MAX_DIM,Math.max(vp.width,vp.height,2));
const mo=O.buildMask(g.segs,vp.width,vp.height,baseDim,g.meta,ftPx,0,null,null,{subpaths:g.subpaths,texts});
const toPx=(v)=>[v[0]*vp.width, v[1]*vp.height];
const shoelace=(r)=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2;};
const centroid=(r)=>{let cx=0,cy=0,A=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];const c=p[0]*q[1]-q[0]*p[1];A+=c;cx+=(p[0]+q[0])*c;cy+=(p[1]+q[1])*c;}A/=2;return A?[cx/(6*A),cy/(6*A)]:r[0];};
const rooms=G.shapes.filter(s=>s.sheet_id===sheetId && s.role==="floor_area");
const src=(regions.length?`${regions.length} candidates (clip ${regions.filter(r=>r.source==="clip").length}/fill ${regions.filter(r=>r.source==="fill").length}/stroke ${regions.filter(r=>r.source==="stroke").length})`:"NONE");
console.log(`\n═══ ${sheetId.slice(0,50)}  p${pageNo} @${ftPx.toFixed(2)}px/ft — ${rooms.length} hand rooms, ${src}`);
let dOK=0,fOK=0,dNone=0,dUse=0;
const rows=[];
for (const s of rooms){
  const ring=s.verts.map(toPx); const hisSF=shoelace(ring)/(ftPx*ftPx); const [cx,cy]=centroid(ring);
  const dr=D.roomAtPoint(regions,cx,cy,{segs:g.segs,meta:g.meta,ftPx});
  const fr=O.floodRegionSealed(mo,cx,cy,0.5,O.sealRadiiFor(mo.mppf),O.doorWedgeCapPx(mo.mppf),O.minPassRadiusFor(mo.mppf));
  let dd=null,dv=0,dsrc="-";
  if(dr){dd=100*(dr.areaSF-hisSF)/hisSF; dv=dr.verts.length; dsrc=dr.source; if(Math.abs(dd)<=5){dOK++; if(dv<=s.verts.length+4)dUse++;}} else dNone++;
  let fd=null,fv=0;
  if(fr.status==="ok"){const fs=fr.count/(mo.mppf*mo.mppf); fv=O.traceRegion(fr).length; fd=100*(fs-hisSF)/hisSF; if(Math.abs(fd)<=5)fOK++;}
  rows.push(`  ${hisSF.toFixed(1).padStart(7)} ${String(s.verts.length).padStart(3)}v | ${dd===null?"  (none)      ":`${(dd>=0?"+":"")+dd.toFixed(1)}%`.padStart(8)+` ${String(dv).padStart(3)}v ${dsrc.padEnd(6)}`} | ${fd===null?"refused":`${(fd>=0?"+":"")+fd.toFixed(1)}%`.padStart(8)+` ${String(fv).padStart(3)}v`}`);
}
console.log(`   his SF verts |  DRAWN Δ    v  src    |  FLOOD Δ     v`);
console.log(rows.join("\n"));
console.log(`  → within 5%:  DRAWN ${dOK}/${rooms.length}  (usable ${dUse})   FLOOD ${fOK}/${rooms.length}   no-polygon: ${dNone}`);
