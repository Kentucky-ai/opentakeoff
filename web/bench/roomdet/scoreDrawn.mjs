// Score the DRAWN-ROOM path against his hand takeoff, and against the flood.
import { readFileSync } from "fs";
import { createRequire } from "module";
const req = createRequire("/Users/sfgprecon/dev/opentakeoff/web/bench/callouts.mts");
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
const O = await import("/Users/sfgprecon/dev/opentakeoff/web/src/lib/oneclick.ts");
const D = await import("/Users/sfgprecon/dev/opentakeoff/web/src/lib/drawnrooms.ts");
const [file,pageNo,ftPxArg,goldens] = process.argv.slice(2);
const G = JSON.parse(readFileSync(goldens,"utf8"));
const doc = await pdfjs.getDocument({url:file,useSystemFonts:true}).promise;
const page = await doc.getPage(+pageNo);
const vp = page.getViewport({scale:1});
const g = O.extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);
const ftPx=+ftPxArg;
const sheetSF = (vp.width/ftPx)*(vp.height/ftPx);
const regions = D.drawnRegions(g.segs, g.subpaths, ftPx, sheetSF);
console.log(`drawn room candidates: ${regions.length}  (clip ${regions.filter(r=>r.source==="clip").length}, fill ${regions.filter(r=>r.source==="fill").length}, stroke ${regions.filter(r=>r.source==="stroke").length})\n`);
const baseDim = Math.min(O.MASK_MAX_DIM, Math.max(vp.width, vp.height, 2));
const tc = await page.getTextContent();
const texts=[]; for(const it of tc.items){ if(!(it.str||"").trim()) continue;
  const t=pdfjs.Util.transform(vp.transform,it.transform); texts.push({x:t[4],y:t[5],w:(it.width||0),h:Math.hypot(t[2],t[3])||8}); }
const mo = O.buildMask(g.segs, vp.width, vp.height, baseDim, g.meta, ftPx, 0, null, null, {subpaths:g.subpaths, texts});
const toPx=(v)=>[v[0]*vp.width, v[1]*vp.height];
const shoelace=(r)=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2;};
const centroid=(r)=>{let cx=0,cy=0,A=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];const c=p[0]*q[1]-q[0]*p[1];A+=c;cx+=(p[0]+q[0])*c;cy+=(p[1]+q[1])*c;}A/=2;return A?[cx/(6*A),cy/(6*A)]:r[0];};
const rooms = G.shapes.filter(s=>s.role==="floor_area");
console.log(`   his SF  hisV |  DRAWN SF  v  src   Δ%     |  FLOOD SF   v   Δ%`);
let dOK=0, fOK=0, dUse=0, fUse=0, dNone=0;
for (const s of rooms) {
  const ring=s.verts.map(toPx); const hisSF=shoelace(ring)/(ftPx*ftPx); const [cx,cy]=centroid(ring);
  const dr = D.roomAtPoint(regions, cx, cy);
  const fr = O.floodRegionSealed(mo,cx,cy,0.5,O.sealRadiiFor(mo.mppf),O.doorWedgeCapPx(mo.mppf),O.minPassRadiusFor(mo.mppf));
  let dTxt="   (none)        ", dd=null;
  if (dr){ dd=100*(dr.areaSF-hisSF)/hisSF;
    dTxt=`${dr.areaSF.toFixed(1).padStart(9)} ${String(dr.verts.length).padStart(3)} ${dr.source.padEnd(6)} ${(dd>=0?"+":"")+dd.toFixed(1)}%`.padEnd(17);
    if(Math.abs(dd)<=5){dOK++; if(dr.verts.length<=s.verts.length+4) dUse++;}
  } else dNone++;
  let fTxt="  refused        ";
  if (fr.status==="ok"){ const fs=fr.count/(mo.mppf*mo.mppf), fv=O.traceRegion(fr).length;
    const fd=100*(fs-hisSF)/hisSF;
    fTxt=`${fs.toFixed(1).padStart(9)} ${String(fv).padStart(3)} ${(fd>=0?"+":"")+fd.toFixed(1)}%`;
    if(Math.abs(fd)<=5){fOK++; if(fv<=s.verts.length+4) fUse++;} }
  console.log(`  ${hisSF.toFixed(1).padStart(7)} ${String(s.verts.length).padStart(4)} | ${dTxt} | ${fTxt}`);
}
console.log(`\n  within 5%:   DRAWN ${dOK}/${rooms.length}    FLOOD ${fOK}/${rooms.length}`);
console.log(`  usable as-is: DRAWN ${dUse}/${rooms.length}    FLOOD ${fUse}/${rooms.length}   (drawn found nothing on ${dNone})`);
