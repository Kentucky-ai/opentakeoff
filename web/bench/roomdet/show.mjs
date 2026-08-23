// SHOW IT: his traced rings vs what the arrangement produces, over the plan.
import { readFileSync, writeFileSync } from "fs";
import zlib from "zlib";
import { createRequire } from "module";
const req = createRequire("/Users/sfgprecon/dev/opentakeoff/web/bench/callouts.mts");
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
const O = await import("/Users/sfgprecon/dev/opentakeoff/web/src/lib/oneclick.ts");
const A = await import("/Users/sfgprecon/dev/opentakeoff/web/src/lib/arrangement.ts");
const G = JSON.parse(readFileSync("/Users/sfgprecon/Desktop/OT-Corpus/all-goldens.json","utf8"));
const [file, sheetId, pageNo, ftPxArg, crop, outName] = process.argv.slice(2);
const doc = await pdfjs.getDocument({url:file,useSystemFonts:true}).promise;
const page = await doc.getPage(+pageNo);
const vp = page.getViewport({scale:1});
const g = O.extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);
const ftPx=+ftPxArg, n=g.segs.length>>2;
const keep=[];
for(let i=0;i<n;i++){
  if (g.meta[i] & O.SEG_CLIP) continue;
  if (g.meta[i] & O.SEG_CURVE) continue;
  const L=Math.hypot(g.segs[i*4+2]-g.segs[i*4], g.segs[i*4+3]-g.segs[i*4+1]);
  if (L < 0.05*ftPx) continue;
  keep.push(g.segs[i*4],g.segs[i*4+1],g.segs[i*4+2],g.segs[i*4+3]);
}
const arr=A.buildArrangement(keep, 0.05*ftPx);
const WALL_W_FT=1.5, memo=new Map();
const solid=(fi)=>{let v=memo.get(fi);if(v!==undefined)return v;const f=arr.faces[fi];
  if(f.area<=0){memo.set(fi,true);return true;}
  let per=0;for(let i=0;i<f.verts.length;i++){const p=f.verts[i],q=f.verts[(i+1)%f.verts.length];per+=Math.hypot(q[0]-p[0],q[1]-p[1]);}
  v=(per>0?(2*f.area)/per:0) < WALL_W_FT*ftPx; memo.set(fi,v); return v;};
const toPx=(v)=>[v[0]*vp.width,v[1]*vp.height];
const shoe=(r)=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2;};
const cen=(r)=>{let cx=0,cy=0,Ar=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];const c=p[0]*q[1]-q[0]*p[1];Ar+=c;cx+=(p[0]+q[0])*c;cy+=(p[1]+q[1])*c;}Ar/=2;return Ar?[cx/(6*Ar),cy/(6*Ar)]:r[0];};
const [cx0,cy0,cx1,cy1]=crop.split(",").map(Number);
const S=+(process.env.UPS||2);
const W=(cx1-cx0)*S, H=(cy1-cy0)*S;
const img=Buffer.alloc(W*H*3,255);
const px=(x,y,r,gg,b)=>{x=Math.round((x-cx0)*S);y=Math.round((y-cy0)*S);if(x>=0&&y>=0&&x<W&&y<H){const o=(y*W+x)*3;img[o]=r;img[o+1]=gg;img[o+2]=b;}};
const line=(a,b,r,gg,bl,wide)=>{const L=Math.max(1,Math.hypot(b[0]-a[0],b[1]-a[1])*S);
  for(let t=0;t<=L;t++){const x=a[0]+(b[0]-a[0])*t/L,y=a[1]+(b[1]-a[1])*t/L;
    px(x,y,r,gg,bl); if(wide){for(const [dx,dy] of [[0.5,0],[0,0.5],[0.5,0.5],[-0.5,0],[0,-0.5]])px(x+dx/S,y+dy/S,r,gg,bl);}}};
// plan, faint
for(let i=0;i+3<g.segs.length;i+=4) line([g.segs[i],g.segs[i+1]],[g.segs[i+2],g.segs[i+3]],185,185,185,false);
const rooms=G.shapes.filter(s=>s.sheet_id===sheetId&&s.role==="floor_area");
const rows=[];
for(const s of rooms){
  const ring=s.verts.map(toPx), hisSF=shoe(ring)/(ftPx*ftPx), c=cen(ring);
  // HIS ring — green
  for(let i=0;i<ring.length;i++) line(ring[i],ring[(i+1)%ring.length],20,150,60,true);
  const fi=A.faceAt(arr,c[0],c[1],solid);
  if(fi<0){rows.push(`${hisSF.toFixed(0)} SF: no face`);continue;}
  const set=A.growRoom(arr,fi,solid);
  if(!set.length){rows.push(`${hisSF.toFixed(0)} SF: none`);continue;}
  let a=0;for(const f of set)a+=arr.faces[f].area;
  const sf=a/(ftPx*ftPx), d=100*(sf-hisSF)/hisSF;
  const out=A.roomOutline(arr,set);
  const good=Math.abs(d)<=5;
  const col=good?[0,90,220]:[225,40,40];       // MINE: blue if within 5%, red if not
  // pull my ring 3px toward its own centre so his green stays visible under it
  const mc=cen(out.ring);
  const shrink=(pt)=>{const dx=pt[0]-mc[0],dy=pt[1]-mc[1],L=Math.hypot(dx,dy)||1;return [pt[0]-dx/L*3, pt[1]-dy/L*3];};
  const mine=out.ring.map(shrink);
  for(let i=0;i<mine.length;i++) line(mine[i],mine[(i+1)%mine.length],col[0],col[1],col[2],true);
  rows.push(`${hisSF.toFixed(0)} → ${sf.toFixed(0)} SF  ${(d>=0?"+":"")+d.toFixed(1)}%`);
}
console.log(rows.join("\n"));
const raw=Buffer.alloc((W*3+1)*H);
for(let y=0;y<H;y++){raw[y*(W*3+1)]=0;img.copy(raw,y*(W*3+1)+1,y*W*3,(y+1)*W*3);}
const idat=zlib.deflateSync(raw,{level:6});
const crcT=(()=>{const t=new Int32Array(256);for(let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[i]=c;}return t;})();
const crc=(bf)=>{let c=-1;for(const b of bf)c=crcT[(c^b)&255]^(c>>>8);return (c^-1)>>>0;};
const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const cc=Buffer.alloc(4);cc.writeUInt32BE(crc(td));return Buffer.concat([l,td,cc]);};
const ih=Buffer.alloc(13);ih.writeUInt32BE(W,0);ih.writeUInt32BE(H,4);ih[8]=8;ih[9]=2;
const out=`/Users/sfgprecon/Desktop/OT-Corpus/${outName}`;
writeFileSync(out,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ih),chunk("IDAT",idat),chunk("IEND",Buffer.alloc(0))]));
console.log("→",out);
