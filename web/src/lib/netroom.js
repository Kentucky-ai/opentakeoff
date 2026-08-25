// Net engine — the wall-network room detector, ported from the 2026-08-24
// harness (fix-ot-spline/harnesses/work-2026-08-23-oneclick/netC.mjs +
// jarr.mjs) with every measured default baked in. Pure module: no React, no
// DOM, no pdf.js. Input is the canvas's own extractVectorGeometry output.
//
// Mechanisms, in admission order (each one measured on Park / Comfort Inn /
// AU / Harlan before it stayed — see the phase notes in fix-ot-spline/notes):
//   pen-gated strokes + poché + slivers → tier-1; starved sheets (no tier-1)
//   ask wallnetwork.ts for a vouch, then low-low pairing, soft-pair rescue,
//   staged admissions spawn closures; jamb seals; stair nosings; field
//   filter; fixture symbol boxes; door trust tiers; arrangement via JTS
//   (polyarr); growth refuses the wall band and fixture pockets are box-
//   bounded.
import * as O from "./oneclick";
import * as WN from "./wallnetwork";
import { buildPolyArrangement, faceAt, pointInRing } from "./polyarr";

/** Tunables the harness exposed as env flags. Defaults = the shipped config. */
export const DEFAULT_OPTS = Object.freeze({
  GROWMAXW: 0.75,   // ft — growth refuses narrower faces unless touched on 2+ sides
  LCMIN: 0.7,       // ft — line-closure gap floor (window-mullion breaks)
  POCKETSF: 25,     // sf — fixture/starved pocket cap
  GATESF: 15,       // sf — growth absorb gate cap
  HOLESF: 40,       // sf — interior holes smaller than this are NOT subtracted (gross ruler)
});
let OPTS = { ...DEFAULT_OPTS };
export function setNetOptions(o) { OPTS = { ...DEFAULT_OPTS, ...(o || {}) }; }

function unit(L){const d=Math.hypot(L[2]-L[0],L[3]-L[1])||1;return [(L[2]-L[0])/d,(L[3]-L[1])/d];}

const PROF=[]; let _pt=0;
const mark=(name)=>{ if(!OPTS.PROFILE) return; const t=(typeof performance!=="undefined"?performance.now():Date.now()); if(_pt) PROF.push([name, Math.round(t-_pt)]); _pt=t; };
export function profile(){ return PROF.slice(); }
export function build(g, ftPx, texts){
  PROF.length=0; _pt=0; mark("start");
  O.markPolylineArcs(g.segs, g.meta);      // polyline-drawn swings get their SEG_CURVE stamp
  // ── ASK THE NETWORK: per-segment wall vouch (junction/crossing/lattice
  // discipline, ported+held-out-validated). A vouched segment is wall evidence
  // even where the hatch classifier claims it or the pen gate would drop it.
  let _vouch=null;
  const vouchAll=()=>{ if(!_vouch) _vouch = OPTS.NOVOUCH ? new Uint8Array(g.segs.length>>2)
    : WN.networkWallSegs(g.segs, g.meta, 1, ftPx); return _vouch; };
  const vouched=new Proxy({},{get:(_,k)=>vouchAll()[k]});
  // ── ink CLASSES from the existing classifiers: hatch, annotation, texture ──
  // a stroke any of them claims is NOT wall evidence (tile grout would pair
  // into phantom walls without this)
  const soft=O.classifyHatchSegs(g.segs, g.meta, 1, O.HATCH_MAX_PITCH_FT*ftPx);
  const hatchOnly=Array.from(soft);
  const annot=O.classifyOffsetAnnotationSegs(g.segs, g.meta, 1, O.ANNOT_OFFSET_MAX_FT*ftPx, O.ANNOT_OFFSET_MIN_FT*ftPx, O.ANNOT_MIN_LEN_FT*ftPx);
  const fleck=g.subpaths?O.classifyFleckSegs(g.segs, g.meta, g.subpaths, 1, ftPx):null;
  const tagbox=(g.subpaths&&texts?.length)?O.classifyTagBoxSegs(g.segs, g.meta, g.subpaths, texts, 1, ftPx):null;
  for(let i=0;i<soft.length;i++){ if(annot&&annot[i])soft[i]=1; if(fleck&&fleck[i])soft[i]=1; if(tagbox&&tagbox[i])soft[i]=1; }
  mark("classifiers");
  const W_MIN=0.15*ftPx, W_MAX=1.6*ftPx, SLIVER_LEN=1.5*ftPx, POCHE_LEN=1.0*ftPx;
  // ── the sheet's furniture pen: the MODAL pen over long strokes. Wall lines
  // are plotted heavier (Kreo's own wall signal); strokes at or below the
  // modal pen stay out of the wall network.
  const penHist=new Map();
  {
    const n=g.segs.length>>2;
    for(let i=0;i<n;i++){
      if(g.meta[i]&(O.SEG_CLIP)) continue;
      const L=Math.hypot(g.segs[i*4+2]-g.segs[i*4], g.segs[i*4+3]-g.segs[i*4+1]);
      if(L<SLIVER_LEN) continue;
      const pen=g.meta[i]>>4;
      penHist.set(pen,(penHist.get(pen)||0)+1);
    }
  }
  const modalPen=[...penHist.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] ?? 0;
  // CONDITIONAL pen gate: heavy pens are wall evidence only when the sheet
  // actually plots walls heavy — the heavy class must carry a real share of
  // the long-stroke ink (Park: ~45%, gate on; Harlan: ~7%, gate off — its
  // pen-2 ink is scattered furniture, and treating it as tier-1 sliced rooms).
  let penTotal=0, penHeavy=0;
  for(const [p,c] of penHist){ penTotal+=c; if(p>modalPen) penHeavy+=c; }
  const penGate = penTotal>0 && penHeavy/penTotal >= 0.15;
  // Symbols come in two dialects: a full corner-to-corner X (millwork), and
  // a centered CHEVRON cluster (tub/shower — four short diagonals symmetric
  // about the fixture center). Detect both as: a CLUSTER of 2+ non-curve
  // diagonal strokes, rising and falling both present, mutually symmetric
  // about the cluster center, fixture-scale bbox.
  const xboxes=[];
  if(!OPTS.NOXBOX){
    const diags=[];
    const n8=g.segs.length>>2;
    for(let i=0;i<n8;i++){
      if(g.meta[i]&(O.SEG_CLIP|O.SEG_CURVE)) continue;
      if(g.meta[i]&O.SEG_FILLONLY) continue;
      const x1=g.segs[i*4],y1=g.segs[i*4+1],x2=g.segs[i*4+2],y2=g.segs[i*4+3];
      const ax=Math.abs(x2-x1), ay=Math.abs(y2-y1);
      if(ax<0.5*ftPx||ay<0.4*ftPx) continue;           // real diagonal, not jitter
      if(ax>12*ftPx||ay>12*ftPx) continue;
      const slope=(y2-y1)/((x2-x1)||1e-9);
      if(Math.abs(slope)<0.12||Math.abs(slope)>8) continue;
      diags.push({x0:Math.min(x1,x2),y0:Math.min(y1,y2),x1:Math.max(x1,x2),y1:Math.max(y1,y2),
                  mx:(x1+x2)/2,my:(y1+y2)/2,rise:(x2-x1)*(y2-y1)>0?1:-1});
    }
    // cluster by bbox proximity (within 1 ft)
    const usedD=new Array(diags.length).fill(false);
    const NEAR=1.0*ftPx;
    for(let i=0;i<diags.length;i++){
      if(usedD[i]) continue;
      const cl=[i]; usedD[i]=true;
      let grew=true;
      while(grew){
        grew=false;
        for(let j=0;j<diags.length;j++){
          if(usedD[j]) continue;
          for(const k of cl){
            const a=diags[k],b=diags[j];
            if(b.x0<a.x1+NEAR&&a.x0<b.x1+NEAR&&b.y0<a.y1+NEAR&&a.y0<b.y1+NEAR){ cl.push(j); usedD[j]=true; grew=true; break; }
          }
        }
      }
      if(cl.length<2) continue;
      let rise=0,fall=0,bx0=1e9,by0=1e9,bx1=-1e9,by1=-1e9,cx=0,cy=0;
      for(const k of cl){
        const d2=diags[k];
        if(d2.rise>0)rise++;else fall++;
        bx0=Math.min(bx0,d2.x0);by0=Math.min(by0,d2.y0);bx1=Math.max(bx1,d2.x1);by1=Math.max(by1,d2.y1);
        cx+=d2.mx;cy+=d2.my;
      }
      if(!rise||!fall) continue;                       // both slopes = a mark, not a leader line
      cx/=cl.length; cy/=cl.length;
      const w=bx1-bx0,h=by1-by0;
      if(w<1.5*ftPx||h<1.2*ftPx||w>12*ftPx||h>12*ftPx) continue;
      // symmetric about the center: every member's midpoint has a mirrored partner
      let sym=0;
      for(const k of cl){
        const d2=diags[k];
        const tx=2*cx-d2.mx, ty=2*cy-d2.my;
        for(const k2 of cl){ if(k2===k)continue; const e=diags[k2];
          if(Math.hypot(e.mx-tx,e.my-ty)<0.5*ftPx){sym++;break;} }
      }
      if(sym<cl.length*0.7) continue;
      xboxes.push([bx0,by0,bx1,by1]);
    }
    // Dialect four: the SLIVER-LOOP rim — a tub drawn as a ring of filled
    // hairline slivers (each its own closed fill subpath). Cluster slivers by
    // adjacency; a plumbing-scale cluster whose members run along ALL FOUR
    // edges of its bbox is a rim loop. A door leaf is one straight sliver
    // (two edges); a wall sliver chain is way past plumbing scale.
    {
      const slivers=[];
      for(const sp of (g.subpaths||[])){
        if(sp.flags&O.SEG_CLIP) continue;
        if(!(sp.flags&O.SEG_FILLONLY)) continue;
        if(!sp.closed) continue;
        const w=sp.x1-sp.x0, h=sp.y1-sp.y0;
        if(Math.min(w,h)>0.3*ftPx) continue;           // hairline band
        if(Math.max(w,h)<0.5*ftPx||Math.max(w,h)>8*ftPx) continue;
        slivers.push([sp.x0,sp.y0,sp.x1,sp.y1]);
      }
      const usedS=new Array(slivers.length).fill(false);
      const T=0.25*ftPx;
      for(let i=0;i<slivers.length;i++){
        if(usedS[i]) continue;
        const cl=[i]; usedS[i]=true;
        let grew=true;
        while(grew){
          grew=false;
          for(let j=0;j<slivers.length;j++){
            if(usedS[j]) continue;
            for(const k of cl){
              const a=slivers[k],b=slivers[j];
              if(b[0]<a[2]+T&&a[0]<b[2]+T&&b[1]<a[3]+T&&a[1]<b[3]+T){ cl.push(j); usedS[j]=true; grew=true; break; }
            }
          }
        }
        if(cl.length<3) continue;
        let bx0=1e9,by0=1e9,bx1=-1e9,by1=-1e9;
        for(const k of cl){const v=slivers[k];bx0=Math.min(bx0,v[0]);by0=Math.min(by0,v[1]);bx1=Math.max(bx1,v[2]);by1=Math.max(by1,v[3]);}
        const w=bx1-bx0,h=by1-by0;
        if(w<1.2*ftPx||h<1.2*ftPx||w>8*ftPx||h>8*ftPx) continue;
        if(Math.min(w,h)>3.4*ftPx) continue;           // plumbing scale
        // all four bbox edges carried by some member
        const E=0.35*ftPx;
        let left=0,right=0,top=0,bot=0;
        for(const k of cl){
          const v=slivers[k];
          if(v[0]-bx0<E&&(v[3]-v[1])>0.4*h) left=1;
          if(bx1-v[2]<E&&(v[3]-v[1])>0.4*h) right=1;
          if(v[1]-by0<E&&(v[2]-v[0])>0.4*w) top=1;
          if(by1-v[3]<E&&(v[2]-v[0])>0.4*w) bot=1;
        }
        if(left+right+top+bot<4) continue;
        xboxes.push([bx0,by0,bx1,by1]);
      }
    }
    // Dialect three: the CLOSED CURVE FIGURE — tubs, toilets, sinks are the
    // rounded things on a plan; walls never are. Two export styles: (a) one
    // closed SubPath with 4+ curve segments; (b) hundreds of single-chord
    // subpaths (each Bezier chord its own path) interleaved with other ink —
    // chain style (b) by endpoint continuity over CURVE segs only, skipping
    // the interleave. A door swing is an open arc that never closes.
    for(const sp of (g.subpaths||[])){
      if(sp.flags&O.SEG_CLIP) continue;
      if(!sp.closed) continue;
      const w=sp.x1-sp.x0, h=sp.y1-sp.y0;
      if(w<1.2*ftPx||h<1.2*ftPx||w>8*ftPx||h>8*ftPx) continue;
      let curves=0;
      for(let i=sp.i0;i<sp.i1;i++) if(g.meta[i]&O.SEG_CURVE) curves++;
      if(curves<4) continue;
      xboxes.push([sp.x0,sp.y0,sp.x1,sp.y1]);
    }
    {
      const n7=g.segs.length>>2;
      let sx=0,sy=0,ex=0,ey=0,bx0=0,by0=0,bx1=0,by1=0,count=0,open=false;
      const flushC=()=>{
        if(open && count>=8){
          const w=bx1-bx0,h=by1-by0;
          if(w>=1.2*ftPx&&h>=1.2*ftPx&&w<=8*ftPx&&h<=8*ftPx&&Math.hypot(ex-sx,ey-sy)<0.5*ftPx){
            xboxes.push([bx0,by0,bx1,by1]);
          }
        }
        open=false; count=0;
      };
      for(let i=0;i<n7;i++){
        if(g.meta[i]&O.SEG_CLIP) continue;                 // interleave: skip, do not break
        if(!(g.meta[i]&O.SEG_CURVE)) continue;             // chain curve chords only
        const x1=g.segs[i*4],y1=g.segs[i*4+1],x2=g.segs[i*4+2],y2=g.segs[i*4+3];
        if(open && Math.hypot(x1-ex,y1-ey)<2){
          ex=x2; ey=y2; count++;
          bx0=Math.min(bx0,x2);by0=Math.min(by0,y2);bx1=Math.max(bx1,x2);by1=Math.max(by1,y2);
        } else {
          flushC();
          open=true; sx=x1; sy=y1; ex=x2; ey=y2; count=1;
          bx0=Math.min(x1,x2);by0=Math.min(y1,y2);bx1=Math.max(bx1,x2);by1=Math.max(by1,y2);
        }
      }
      flushC();
    }
  }
  const onXbox=(rect)=>{
    // run rect centroid inside (or hugging) a fixture box
    let cx=0,cy=0; for(const p of rect){cx+=p[0];cy+=p[1];} cx/=rect.length; cy/=rect.length;
    const M=0.55*ftPx;
    for(const b of xboxes){ if(cx>=b[0]-M&&cx<=b[2]+M&&cy>=b[1]-M&&cy<=b[3]+M) return true; }
    return false;
  };

  const inXboxPt=(x,y,M=0.55*ftPx)=>{ for(const b of xboxes){ if(x>=b[0]-M&&x<=b[2]+M&&y>=b[1]-M&&y<=b[3]+M) return true; } return false; };
  const extractPools=(useVouch)=>{
  const poche=[];       // material rings
  const pocheLum=[];    // fill luminance per poché ring (-1 unknown)
  const rawLines=[];    // [x0,y0,x1,y1] face-line candidates from slivers
  const rawStrokes=[];  // stroked straight segments heavier than the furniture pen
  const rawLow=[];      // modal-pen strokes: admitted only when paired with tier-1 evidence
  const rawVouch=[];    // network-vouched chains: the wall evidence a starved sheet states
  const rawLowFrag=[];  // sub-length unclaimed pieces: a wall line broken by claims/pen changes (starved pass only)
  const rawSoft=[];     // claimed (soft, unvouched) chains: candidate other-faces for pair rescue (starved pass only)
  for(const s of (g.subpaths||[])){
    if(s.flags & O.SEG_CLIP) continue;
    if(!(s.flags & O.SEG_FILLONLY)){
      // stroked figure: its LONG segments are candidate wall faces. SEG_CURVE is
      // NOT disqualifying — CAD exports emit straight wall polylines as
      // degenerate beziers (Park), and a true arc's chords are short anyway.
      // walls arrive as chorded polylines (bezier-emitted, 10-15px chords) —
      // merge collinear CONNECTED chords into full lines before length-gating
      {
        let cx1=0,cy1=0,cx2=0,cy2=0,cpen=-1,open=false,cvL=0,ctL=0;
        let sx1=0,sy1=0,sx2=0,sy2=0,sOpen=false;
        const flushS=()=>{
          if(!sOpen) return; sOpen=false;
          if(Math.hypot(sx2-sx1,sy2-sy1)>=SLIVER_LEN) rawSoft.push([sx1,sy1,sx2,sy2]);
        };
        const flush=()=>{
          if(!open) return; open=false;
          const L=Math.hypot(cx2-cx1,cy2-cy1);
          const vFrac=ctL>0?cvL/ctL:0;
          cvL=0; ctL=0;
          const seg=[cx1,cy1,cx2,cy2];
          if(L<SLIVER_LEN){ if(useVouch && L>=0.5*ftPx) rawLowFrag.push(seg); return; }
          if(penGate && cpen > modalPen) rawStrokes.push(seg);
          else if(vFrac>=0.6) rawVouch.push(seg);             // the network vouches: wall (used only when tier-1 starves)
          else if(L>=2.0*ftPx) rawLow.push(seg);
        };
        for(let i=s.i0;i<s.i1;i++){
          if(g.meta[i] & O.SEG_CLIP){ flush(); flushS(); continue; }
          if(soft[i] && !(useVouch&&vouched[i])){
            flush();
            // claimed ink still gets CHAINED (not admitted): softpair rescue
            // reads it on starved sheets, the STAIR family test on all sheets.
            {
              const x1=g.segs[i*4],y1=g.segs[i*4+1],x2=g.segs[i*4+2],y2=g.segs[i*4+3];
              const L=Math.hypot(x2-x1,y2-y1);
              if(L>=0.5){
                if(sOpen && Math.hypot(x1-sx2,y1-sy2)<0.75){
                  const dx=sx2-sx1, dy=sy2-sy1, ex=x2-sx1, ey=y2-sy1;
                  const cr=dx*ey-dy*ex, span=Math.hypot(ex,ey)||1;
                  if(Math.abs(cr)/span < 0.7){ sx2=x2; sy2=y2; continue; }
                }
                flushS();
                sOpen=true; sx1=x1; sy1=y1; sx2=x2; sy2=y2;
              }
              continue;
            }
          }
          flushS();
          const x1=g.segs[i*4],y1=g.segs[i*4+1],x2=g.segs[i*4+2],y2=g.segs[i*4+3];
          const L=Math.hypot(x2-x1,y2-y1);
          if(L<0.5){ continue; }
          const pen=g.meta[i]>>4;
          if(open && pen===cpen && Math.hypot(x1-cx2,y1-cy2)<0.75){
            // collinear with the accumulated span?
            const dx=cx2-cx1, dy=cy2-cy1, ex=x2-cx1, ey=y2-cy1;
            const cr=dx*ey-dy*ex;
            const span=Math.hypot(ex,ey)||1;
            if(Math.abs(cr)/span < 0.7){ cx2=x2; cy2=y2; ctL+=L; if(useVouch&&vouched[i])cvL+=L; continue; }
          }
          flush();
          open=true; cx1=x1; cy1=y1; cx2=x2; cy2=y2; cpen=pen; ctL=L; cvL=(useVouch&&vouched[i])?L:0;
        }
        flush(); flushS();
      }
      continue;
    }
    if(!s.closed) continue;
    const nseg=s.i1-s.i0; if(nseg<3) continue;
    const ring=[]; let per=0;
    for(let i=s.i0;i<s.i1;i++){
      ring.push([g.segs[i*4],g.segs[i*4+1]]);
      per+=Math.hypot(g.segs[i*4+2]-g.segs[i*4], g.segs[i*4+3]-g.segs[i*4+1]);
    }
    let a=0; for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length];a+=p[0]*q[1]-q[0]*p[1];}
    a=Math.abs(a)/2;
    const w = per>0 ? 2*a/per : 0;
    const dia=Math.max(s.x1-s.x0, s.y1-s.y0);
    if(w>=W_MIN && w<=W_MAX && dia>=POCHE_LEN){ poche.push(ring); pocheLum.push(s.fillLum==null?-1:s.fillLum); continue; }
    if(w<W_MIN && dia>=SLIVER_LEN){
      // long edges of the sliver = wall face lines
      const minL=Math.max(SLIVER_LEN*0.6, 6*Math.max(w,0.5));
      for(let i=0;i<ring.length;i++){
        const p=ring[i], q=ring[(i+1)%ring.length];
        if(Math.hypot(q[0]-p[0],q[1]-p[1])>=minL) rawLines.push([p[0],p[1],q[0],q[1]]);
      }
    }
  }

  return {poche, pocheLum, rawLines, rawStrokes, rawLow, rawVouch, rawLowFrag, rawSoft};
  };
  // baseline pools first; only a STARVED sheet asks the network (measured:
  // on a seeded sheet the vouch admits casework and fragments rooms).
  mark("(pools-start)");
  let {poche, pocheLum, rawLines, rawStrokes, rawLow, rawVouch, rawSoft} = extractPools(false);
  let starved=false;
  if(poche.length===0 && rawLines.length===0 && rawStrokes.length===0){
    starved=true;
    ({poche, pocheLum, rawLines, rawStrokes, rawLow, rawVouch, rawSoft} = extractPools(true));
  }
  mark("extractPools");
  // ── WALL FILL LUMINANCE (his eye, Liminal 2026-08-24: "the walls are a
  // darker grey than the cabinets"). Among wall-scale filled bands, the lum
  // class carrying the most extent is the wall fill. Bands at a LIGHTER lum
  // are cabinets/fixtures: they leave the material pool. Only fires when one
  // class dominates (≥50% of band extent) and is a real grey (not white) —
  // a sheet whose walls are black or unfilled is untouched.
  if(!OPTS.NOWALLLUM && pocheLum.length===poche.length && poche.length){
    const ext=new Map();
    poche.forEach((ring,i)=>{ let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; for(const q of ring){x0=Math.min(x0,q[0]);y0=Math.min(y0,q[1]);x1=Math.max(x1,q[0]);y1=Math.max(y1,q[1]);} const l=pocheLum[i]; ext.set(l,(ext.get(l)||0)+Math.max(x1-x0,y1-y0)); });
    let tot=0, best=-1, bestE=0; for(const [l,e] of ext){ tot+=e; if(e>bestE){bestE=e;best=l;} }
    if(tot>0 && bestE/tot>=0.5 && best>=0 && best<250){
      const keep=[], keepL=[];
      poche.forEach((ring,i)=>{ if(pocheLum[i]>best+20) return; keep.push(ring); keepL.push(pocheLum[i]); });
      if(OPTS.LUMLOG) console.error(`WALLLUM dominant lum=${best} share=${(bestE/tot).toFixed(2)} poche ${poche.length}→${keep.length}`);
      poche.length=0; poche.push(...keep); pocheLum.length=0; pocheLum.push(...keepL);
    }
  }
  // ── dedup/merge collinear close lines (the sliver's two faces, double-draws) ──
  const DUP_D=0.12*ftPx;
  const lines=mergeLines(rawLines, DUP_D);
  const strokes=mergeLines(rawStrokes, DUP_D);
  const strokeStage=strokes.map(()=>starved?"vouch":"pen");
  // ── STARVED-SHEET admission: tier-1 starts at filled poché and the pen
  // gate, so a sheet that fills nothing and plots one pen (AU) admits NOTHING
  // and refuses to find a wall unless it already found one. That sheet still
  // STATES its walls; the network's junction/crossing/lattice discipline reads
  // them. Only a starved sheet needs this — on a seeded sheet the vouch admits
  // casework and fragments rooms (measured: Park 11->8, CI 23->8).
  for(const L of mergeLines(rawVouch, DUP_D)){ strokes.push(L); strokeStage.push("vouch"); }   // empty unless the sheet starved
  // ── staged admission of modal-pen lines: a furniture-pen line is a wall FACE
  // exactly when it runs parallel to tier-1 wall evidence at wall thickness
  // with real overlap (the other face of the same wall).
  let diagLows=[], diagLowsAdmitted=[];
  {
    const lows=mergeLines(rawLow, DUP_D);
    diagLows=lows;
    const tier1=[...lines, ...strokes];
    for(const ring of poche){
      for(let i=0;i<ring.length;i++){
        const p=ring[i],q=ring[(i+1)%ring.length];
        if(Math.hypot(q[0]-p[0],q[1]-p[1])>=1.5*ftPx) tier1.push([p[0],p[1],q[0],q[1]]);
      }
    }
    const TL=0.15*ftPx, TH=1.2*ftPx;
    const pairsWith=(L,T)=>{
      const u=unit(L);
      const nrm=[-u[1],u[0]];
      const v=unit(T);
      if(Math.abs(u[0]*v[0]+u[1]*v[1])<0.985) return false;
      const dd=Math.abs((T[0]-L[0])*nrm[0]+(T[1]-L[1])*nrm[1]);
      if(dd<TL||dd>TH) return false;
      const t=(x,y)=>(x-L[0])*u[0]+(y-L[1])*u[1];
      const a0=Math.min(t(L[0],L[1]),t(L[2],L[3])), a1=Math.max(t(L[0],L[1]),t(L[2],L[3]));
      const b0=Math.min(t(T[0],T[1]),t(T[2],T[3])), b1=Math.max(t(T[0],T[1]),t(T[2],T[3]));
      const ov=Math.min(a1,b1)-Math.max(a0,b0);
      if(ov < 1.5*ftPx) return false;
      // MUTUAL: a wall's two faces run the same length. A 3 ft door leaf
      // standing 0.3 ft off a 12 ft jamb wall overlaps it fully but covers a
      // quarter of it — that is a leaf, not the wall's other face (Park
      // Breakroom/Workroom, his eye: "different weight").
      // seeded sheets only: a starved sheet's face lines arrive fragmented
      // (AU 15→10 with this on) — there the old overlap floor stands
      return starved ? true : ov >= 0.5*Math.max(a1-a0, b1-b0);
    };
    const unadmitted=[];
    for(const L of lows){
      let hit=false;
      for(const T of tier1){ if(pairsWith(L,T)){hit=true;break;} }
      if(hit){ strokes.push(L); strokeStage.push("lowT1"); diagLowsAdmitted.push(L); }
      else unadmitted.push(L);
    }
    if(starved && !OPTS.NOLOWPAIR){
      // LOW-LOW pairing: a double-line wall states itself — two long parallel
      // lines a wall-thickness apart with real mutual overlap. The old
      // SELFSEED rule, but no longer gated on an empty tier-1 (the network
      // vouch fills tier-1, which silently disabled it — the two mechanisms
      // were never measured TOGETHER before this).
      const MINLEN=3.0*ftPx, TLo=0.15*ftPx, THi=0.90*ftPx, OVL=2.5*ftPx;
      const longs=unadmitted.filter(L=>Math.hypot(L[2]-L[0],L[3]-L[1])>=MINLEN);
      const near2=(A2,B2)=>{
        const u=unit(A2), v=unit(B2);
        if(Math.abs(u[0]*v[0]+u[1]*v[1])<0.9995) return false;
        const nx=-u[1], ny=u[0];
        const d=Math.abs((B2[0]-A2[0])*nx+(B2[1]-A2[1])*ny);
        if(d<TLo||d>THi) return false;
        const t=(x,y)=>(x-A2[0])*u[0]+(y-A2[1])*u[1];
        const a0=Math.min(t(A2[0],A2[1]),t(A2[2],A2[3])), a1=Math.max(t(A2[0],A2[1]),t(A2[2],A2[3]));
        const b0=Math.min(t(B2[0],B2[1]),t(B2[2],B2[3])), b1=Math.max(t(B2[0],B2[1]),t(B2[2],B2[3]));
        return Math.min(a1,b1)-Math.max(a0,b0) >= OVL;
      };
      // (connectivity gate on pairs: MEASURED NO-OP on the furniture
      // undershoots and it deletes real walls at rooms 7/8 — do not re-add)
      const keep=new Set();
      for(let i=0;i<longs.length;i++) for(let j=i+1;j<longs.length;j++)
        if(near2(longs[i],longs[j])){ keep.add(i); keep.add(j); }
      for(const i of keep){ strokes.push(longs[i]); strokeStage.push("lowpair"); diagLowsAdmitted.push(longs[i]); }
    }
    // (measured and REMOVED on AU: fragment-merged lows and T-T both-ends
    // admission — no rooms gained alone or on top of the pair rescue)
    if(starved && !OPTS.NOSOFTPAIR){
      // PAIR RESCUE of claimed ink: a hatch-claimed chain lying a wall
      // thickness from tier-1 evidence with real overlap is the wall's OTHER
      // FACE — the classifier read the window band's rhythm and ate the wall
      // line with it.
      for(const L of mergeLines(rawSoft, DUP_D)){
        for(const T of tier1){ if(pairsWith(L,T)){ strokes.push(L); strokeStage.push("softpair"); break; } }
      }
    }
    // SELF-SEED. Tier-1 evidence starts at filled poché, so a sheet that fills
    // nothing (AU: 0 fill-only figures) leaves tier1 EMPTY and admits nothing —
    // the engine refuses to find a wall unless it already found one. But a
    // double-line wall states itself: two long parallel lines a wall-thickness
    // apart. When there is no poché to seed from, pair the lows against EACH
    // OTHER at that thickness and admit both members.
    if(OPTS.SELFSEED && tier1.length===0){
      const MINLEN=3.0*ftPx, TLo=0.20*ftPx, THi=0.90*ftPx, OVL=2.5*ftPx;
      const longs=lows.filter(L=>Math.hypot(L[2]-L[0],L[3]-L[1])>=MINLEN);
      const near=(A,B)=>{
        const u=unit(A), v=unit(B);
        if(Math.abs(u[0]*v[0]+u[1]*v[1])<0.9995) return false;
        const nx=-u[1], ny=u[0];
        const d=Math.abs((B[0]-A[0])*nx+(B[1]-A[1])*ny);
        if(d<TLo||d>THi) return false;
        const t=(x,y)=>(x-A[0])*u[0]+(y-A[1])*u[1];
        const a0=Math.min(t(A[0],A[1]),t(A[2],A[3])), a1=Math.max(t(A[0],A[1]),t(A[2],A[3]));
        const b0=Math.min(t(B[0],B[1]),t(B[2],B[3])), b1=Math.max(t(B[0],B[1]),t(B[2],B[3]));
        return Math.min(a1,b1)-Math.max(a0,b0) >= OVL;
      };
      const keep=new Set();
      for(let i=0;i<longs.length;i++) for(let j=i+1;j<longs.length;j++)
        if(near(longs[i],longs[j])){ keep.add(i); keep.add(j); }
      for(const i of keep) strokes.push(longs[i]);
      if(OPTS.SEEDLOG) console.error(`self-seed: ${longs.length} long lows -> ${keep.size} admitted as wall faces`);
    }
  }

  // helper: is (x,y) within tol of any currently ADMITTED wall evidence?
  const nearWallSeed=(()=>{
    const pool=[];
    for(const ring of poche) for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length];pool.push([p[0],p[1],q[0],q[1]]);}
    for(const L of lines) pool.push(L);
    for(const L of strokes) pool.push(L);
    return (x,y,tol)=>{
      for(const T of pool){
        const dx=T[2]-T[0],dy=T[3]-T[1],LL=dx*dx+dy*dy||1;
        let t=((x-T[0])*dx+(y-T[1])*dy)/LL; t=Math.max(0,Math.min(1,t));
        if(Math.hypot(x-T[0]-dx*t,y-T[1]-dy*t)<=tol) return true;
      }
      return false;
    };
  })();
  mark("merge+admission");
  // ── STAIR NOSING admission: a stair flight is a FAMILY of parallel treads
  // at riser pitch (0.65-1.35 ft), uniform length (stringer to stringer),
  // ends aligned. The estimator's floor boundary is the EXTREMAL tread (the
  // nosing at the landing edge) — dashed above-cut-plane treads never bound,
  // so without this the landing face falls down the flight into the lower
  // landing (Comfort Inn stair pairs, +250-390%).
  const stairRects=[];
  if(!OPTS.NOSTAIR){
    if(OPTS.STAIRLOG) console.error("STAIR mechanism entered");
    const cands=[];   // unpaired-low candidates for tread families
    {
      const lowsAll=mergeLines(rawLow, DUP_D);
      const admittedSet=new Set(diagLowsAdmitted);
      for(const L of lowsAll){ if(!admittedSet.has(L)) cands.push(L); }
    }
    // hatch-claimed chains: treads at riser pitch are exactly what the hatch
    // classifier claims — the family test is the discriminator.
    {
      for(const L of mergeLines(rawSoft, DUP_D)) cands.push(L);
    }
    // DASHED treads never reach the low pool (each dash dies at the length
    // gate) — chain axis-aligned short plain segs into dash-lines and let the
    // family test decide if they are a stair.
    {
      const shorts=[];
      const n9=g.segs.length>>2;
      for(let i=0;i<n9 && shorts.length<80000;i++){
        if(g.meta[i]&O.SEG_CLIP) continue;
        // soft (hatch-claimed) dashes stay IN: a stair's treads at riser
        // pitch are exactly what the hatch classifier claims — the family
        // test below is the discriminator, and only extremals ever admit.
        const x1=g.segs[i*4],y1=g.segs[i*4+1],x2=g.segs[i*4+2],y2=g.segs[i*4+3];
        const L=Math.hypot(x2-x1,y2-y1);
        if(L<0.15*ftPx||L>1.5*ftPx) continue;
        const ax=Math.abs(x2-x1), ay=Math.abs(y2-y1);
        if(Math.min(ax,ay)>0.08*Math.max(ax,ay)) continue;   // axis-aligned dashes only
        shorts.push([x1,y1,x2,y2]);
      }
      if(OPTS.STAIRLOG) console.error(`STAIR shorts=${shorts.length}`);
      // dash gaps run 0.3-0.7 ft — the default merge tolerance (0.12 ft) never
      // bridges them; treads tolerate a looser lateral band because the family
      // pitch test is the real gate.
      for(const [L,cov] of mergeLinesCov(shorts, 0.25*ftPx)){
        const len=Math.hypot(L[2]-L[0],L[3]-L[1]);
        if(cov>=0.4 && len>=2.5*ftPx && len<=9*ftPx) cands.push(L);
      }
    }
    if(OPTS.STAIRLOG){
      console.error(`STAIR cands=${cands.length}`);
      const box=OPTS.STAIRBOX?OPTS.STAIRBOX.split(",").map(Number):null;
      if(box) for(const L of cands){
        const x0=Math.min(L[0],L[2]),x1=Math.max(L[0],L[2]),y0=Math.min(L[1],L[3]),y1=Math.max(L[1],L[3]);
        if(x1>=box[0]&&x0<=box[2]&&y1>=box[1]&&y0<=box[3])
          console.error(`STAIR cand (${L[0].toFixed(0)},${L[1].toFixed(0)})-(${L[2].toFixed(0)},${L[3].toFixed(0)}) len ${(Math.hypot(L[2]-L[0],L[3]-L[1])/ftPx).toFixed(1)}ft`);
      }
    }
    const used=new Array(cands.length).fill(false);
    const geo=cands.map(L=>{
      const u=unit(L);
      const flip=(Math.abs(u[0])>=Math.abs(u[1])?u[0]<0:u[1]<0);
      const ux=flip?-u[0]:u[0], uy=flip?-u[1]:u[1];
      const n=[-uy,ux];
      const off=L[0]*n[0]+L[1]*n[1];
      const t0=L[0]*ux+L[1]*uy, t1=L[2]*ux+L[3]*uy;
      return {ux,uy,off,t0:Math.min(t0,t1),t1:Math.max(t0,t1),len:Math.abs(t1-t0)};
    });
    const P_LO=0.65*ftPx, P_HI=1.35*ftPx;
    for(let i=0;i<cands.length;i++){
      if(used[i]) continue;
      const a=geo[i];
      if(a.len<2.5*ftPx||a.len>9*ftPx) continue;      // tread width: a real flight
      const fam=[i];
      for(let j=0;j<cands.length;j++){
        if(j===i||used[j]) continue;
        const b=geo[j];
        if(Math.abs(a.ux*b.ux+a.uy*b.uy)<0.9995) continue;
        if(b.len<2.5*ftPx||b.len>9*ftPx) continue;
        if(Math.max(a.len,b.len)/Math.min(a.len,b.len)>1.35) continue;
        if(Math.abs(b.t0-a.t0)>0.9*ftPx||Math.abs(b.t1-a.t1)>0.9*ftPx) continue;  // aligned ends
        fam.push(j);
      }
      if(OPTS.STAIRBOX){
        const box=OPTS.STAIRBOX.split(",").map(Number);
        const L=cands[i];
        if(Math.min(L[0],L[2])>=box[0]&&Math.max(L[0],L[2])<=box[2]&&Math.min(L[1],L[3])>=box[1]&&Math.max(L[1],L[3])<=box[3])
          console.error(`STAIR seed i=${i} (${L[0].toFixed(0)},${L[1].toFixed(0)})-(${L[2].toFixed(0)},${L[3].toFixed(0)}) famN=${fam.length}`);
      }
      if(fam.length<4) continue;
      fam.sort((p,q)=>geo[p].off-geo[q].off);
      // collapse near-duplicate offsets (same tread arriving via two pools)
      {
        const ded=[fam[0]];
        for(let k=1;k<fam.length;k++)
          if(geo[fam[k]].off-geo[ded[ded.length-1]].off>0.1*ftPx) ded.push(fam[k]);
        fam.length=0; fam.push(...ded);
      }
      // a real sheet embeds the flight in aligned CLUTTER (fixtures in rooms
      // above share the extent) — the stair is the longest CONTIGUOUS RUN of
      // members at riser pitch, not the whole family.
      const runs2=[]; let run=[fam[0]];
      for(let k=1;k<fam.length;k++){
        const d=geo[fam[k]].off-geo[fam[k-1]].off;
        if(d>=P_LO&&d<=P_HI) run.push(fam[k]);
        else { if(run.length>=4) runs2.push(run); run=[fam[k]]; }
      }
      if(run.length>=4) runs2.push(run);
      for(const r of runs2){
        const span=geo[r[r.length-1]].off-geo[r[0]].off;
        if(span>16*ftPx) continue;                    // longer than any flight
        const endsOn=(L)=>nearWallSeed(L[0],L[1],0.6*ftPx)&&nearWallSeed(L[2],L[3],0.6*ftPx);
        if(OPTS.STAIRLOG){
          const L0=cands[r[0]];
          console.error(`STAIR RUN n=${r.length} at (${L0[0].toFixed(0)},${L0[1].toFixed(0)}) span=${(span/ftPx).toFixed(1)}ft endsOn=${endsOn(cands[r[0]])},${endsOn(cands[r[r.length-1]])}`);
        }
        let both=true;
        for(const e of [r[0],r[r.length-1]]){
          if(endsOn(cands[e])){ strokes.push(cands[e]); strokeStage.push("stair"); diagLowsAdmitted.push(cands[e]); }
          else both=false;
        }
        // the FLIGHT between the nosings is a stair, not floor — material.
        if(both){
          const gA=geo[r[0]], gB=geo[r[r.length-1]];
          const t0=Math.max(gA.t0,gB.t0), t1=Math.min(gA.t1,gB.t1);
          const n=[-gA.uy,gA.ux];
          const p=(t,off)=>[gA.ux*t+n[0]*off, gA.uy*t+n[1]*off];
          stairRects.push([p(t0,gA.off),p(t1,gA.off),p(t1,gB.off),p(t0,gB.off)]);
        }
        for(const k of r) used[k]=true;
      }
    }
  }
  mark("stair");
  // ── FIELD FILTER (starved sheets): an admitted stroke with 2+ admitted
  // parallel neighbours on EACH side inside a 3 ft window (real mutual
  // overlap) is interior to a striped FIELD — floor pattern, not wall. The
  // extremal course survives (one-sided), same doctrine as the hatch
  // classifier. Rhythm is NOT required: plank layouts mix seams and casework
  // edges, which defeats the regularity band and is how these got vouched.
  if((starved||OPTS.FIELDALL) && !OPTS.NOFIELD){
    const WINF=3.0*ftPx, OVLF=0.5;
    const nStrokes=strokes.length;
    const pool=OPTS.FIELDLINES?[...strokes,...lines]:strokes;
    const info=pool.map(L=>{
      const u=unit(L);
      const flip=(Math.abs(u[0])>=Math.abs(u[1])?u[0]<0:u[1]<0);
      const ux=flip?-u[0]:u[0], uy=flip?-u[1]:u[1];
      const n=[-uy,ux];
      const off=L[0]*n[0]+L[1]*n[1];
      const t0=L[0]*ux+L[1]*uy, t1=L[2]*ux+L[3]*uy;
      return {ux,uy,off,t0:Math.min(t0,t1),t1:Math.max(t0,t1)};
    });
    const drop=new Set();
    for(let i=0;i<pool.length;i++){
      const a=info[i]; let lo=0,hi=0;
      const alen=a.t1-a.t0;
      for(let j=0;j<pool.length;j++){
        if(i===j) continue;
        const b=info[j];
        if(Math.abs(a.ux*b.ux+a.uy*b.uy)<0.9995) continue;
        const d=b.off-a.off;
        if(Math.abs(d)<0.5||Math.abs(d)>WINF) continue;
        const ov=Math.min(a.t1,b.t1)-Math.max(a.t0,b.t0);
        if(ov < OVLF*alen) continue;
        if(d<0) lo++; else hi++;
      }
      if(lo>=2&&hi>=2) drop.add(i);
    }
    if(drop.size){
      const kept=strokes.filter((_,i)=>!drop.has(i));
      const keptStage=strokeStage.filter((_,i)=>!drop.has(i));
      strokes.length=0; strokes.push(...kept);
      strokeStage.length=0; strokeStage.push(...keptStage);
      if(OPTS.FIELDLINES){
        const keptL=lines.filter((_,i)=>!drop.has(nStrokes+i));
        lines.length=0; lines.push(...keptL);
      }
    }
  }
  mark("field");
  // ── DOOR SWING ARCS: the drafter's own statement of every hinged opening ──
  // chain curve chords (the flagNonDoorArcs chaining rule), circle-fit, accept
  // door-radius quarter-ish sweeps; closure = hinge (center) -> strike endpoint.
  const veto=O.flagNonDoorArcs(g.segs, g.meta);
  const nseg=g.segs.length>>2;
  const segLen=(i)=>Math.hypot(g.segs[i*4+2]-g.segs[i*4], g.segs[i*4+3]-g.segs[i*4+1]);
  const arcs=[];
  {
    let chain=[];
    const tryWindow=(win)=>{
      if(win.length<3) return null;
      const fit=kasa(win);
      if(!fit) return null;
      const r=fit.r;
      if(r<1.8*ftPx || r>4.5*ftPx) return null;
      const P0=[g.segs[win[0]*4], g.segs[win[0]*4+1]];
      const P1=[g.segs[win[win.length-1]*4+2], g.segs[win[win.length-1]*4+3]];
      const a0=Math.atan2(P0[1]-fit.cy,P0[0]-fit.cx), a1=Math.atan2(P1[1]-fit.cy,P1[0]-fit.cx);
      let sweep=Math.abs(a1-a0); if(sweep>Math.PI) sweep=2*Math.PI-sweep;
      if(!(sweep>0.7 && sweep<2.1)) return null;
      return {C:[fit.cx,fit.cy], P0, P1, r};
    };
    const flush=()=>{
      if(chain.length>=3 && !chain.some(i=>veto[i])){
        const whole=tryWindow(chain);
        if(whole) arcs.push(whole);
      }
      chain=[];
    };
    for(let i=0;i<nseg;i++){
      if(segLen(i)<0.5) continue;
      if(!(g.meta[i]&O.SEG_CURVE) || (g.meta[i]&O.SEG_CLIP)){ flush(); continue; }
      if(chain.length){
        const p=chain[chain.length-1];
        const gap=Math.hypot(g.segs[i*4]-g.segs[p*4+2], g.segs[i*4+1]-g.segs[p*4+3]);
        if(g.meta[i]!==g.meta[p] || gap>Math.max(segLen(i),segLen(p))) flush();
      }
      chain.push(i);
    }
    flush();
  }
  function kasa(chain){
    const xs=[g.segs[chain[0]*4]], ys=[g.segs[chain[0]*4+1]];
    for(const i of chain){ xs.push(g.segs[i*4+2]); ys.push(g.segs[i*4+3]); }
    const m=xs.length; let mx=0,my=0;
    for(let i=0;i<m;i++){mx+=xs[i];my+=ys[i];} mx/=m;my/=m;
    let sxx=0,sxy=0,syy=0,sxz=0,syz=0;
    for(let i=0;i<m;i++){const x=xs[i]-mx,y=ys[i]-my,z=x*x+y*y;sxx+=x*x;sxy+=x*y;syy+=y*y;sxz+=x*z;syz+=y*z;}
    const det=sxx*syy-sxy*sxy; if(Math.abs(det)<1e-9) return null;
    const cx=(sxz*syy-syz*sxy)/(2*det), cy=(syz*sxx-sxz*sxy)/(2*det);
    let r=0; for(let i=0;i<m;i++) r+=Math.hypot(xs[i]-mx-cx,ys[i]-my-cy); r/=m;
    if(!(r>0)) return null;
    const tol=Math.max(0.75,r*0.06);
    for(let i=0;i<m;i++){ if(Math.abs(Math.hypot(xs[i]-mx-cx,ys[i]-my-cy)-r)>tol) return null; }
    return {cx:cx+mx, cy:cy+my, r};
  }
  // nearness to any wall face line (for strike-endpoint scoring)
  mark("arcs");
  // ── ANNOTATION STROKES ARE NOT WALLS. Park plots dimension arrows, grain
  // marks and text outlines at the wall pen, so the pen gate admits them and
  // a ring notches around "GRAIN". Two facts the drawing states: (1) a wall
  // never sits inside a text box; (2) a wall LANDS on other walls at both
  // ends — a leaf, a dimension, a grain arrow floats free at one end.
  if(!OPTS.NOANNOT){
    // rotated marks ("GRAIN") report w/h in their own frame — box the larger
    // extent both ways so a vertical label is covered too
    const tb=(texts||[]).map(t=>{ const e=Math.max(t.w,t.h); return [t.x-0.2*ftPx, t.y-e-0.2*ftPx, t.x+e+0.2*ftPx, t.y+0.2*ftPx]; });
    const inText=(x,y)=>{ for(const b of tb){ if(x>=b[0]&&x<=b[2]&&y>=b[1]&&y<=b[3]) return true; } return false; };
    const pool=[];
    for(const ring of poche) for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length];pool.push([p[0],p[1],q[0],q[1]]);}
    for(const L of lines) pool.push(L);
    for(const L of strokes) pool.push(L);
    const near=(x,y,tol,skip)=>{
      for(let k=0;k<pool.length;k++){ if(k===skip) continue; const T=pool[k];
        const dx=T[2]-T[0],dy=T[3]-T[1],LL=dx*dx+dy*dy||1;
        let t=((x-T[0])*dx+(y-T[1])*dy)/LL; t=Math.max(0,Math.min(1,t));
        if(Math.hypot(x-T[0]-dx*t,y-T[1]-dy*t)<=tol) return true; }
      return false;
    };
    const base=poche.reduce((n,r)=>n+r.length,0)+lines.length;
    // THE LEAF IS THE RADIUS OF ITS OWN SWING ARC. A stroke lying on the
    // hinge→start or hinge→end radius of a detected swing, no longer than the
    // swing radius, is the door leaf — drawn double, lying on the wall line,
    // pairing with a short jamb stub: none of the other tests can see it.
    const onRadius=(L)=>{
      const len=Math.hypot(L[2]-L[0],L[3]-L[1]);
      const u=unit(L);
      for(const a of arcs){
        if(len>1.25*a.r) continue;
        for(const P of [a.P0,a.P1]){
          const rx=P[0]-a.C[0], ry=P[1]-a.C[1], rl=Math.hypot(rx,ry)||1;
          if(Math.abs((rx*u[0]+ry*u[1])/rl)<0.985) continue;         // parallel to the radius
          const nx=-ry/rl, ny=rx/rl;
          const d1=Math.abs((L[0]-a.C[0])*nx+(L[1]-a.C[1])*ny), d2=Math.abs((L[2]-a.C[0])*nx+(L[3]-a.C[1])*ny);
          if(d1>0.35*ftPx||d2>0.35*ftPx) continue;
          const t1=((L[0]-a.C[0])*rx+(L[1]-a.C[1])*ry)/rl, t2=((L[2]-a.C[0])*rx+(L[3]-a.C[1])*ry)/rl;
          const lo=Math.max(0,Math.min(t1,t2)), hi=Math.min(rl,Math.max(t1,t2));
          if(hi-lo>=0.6*len) return true;
        }
      }
      return false;
    };
    // (arc-radius leaf drop: OPT-IN only — a swing's START radius is the leaf's
    // closed position, i.e. the wall face itself; measured CI 28→20, AU 15→12)
    if(OPTS.LEAFARC){
      const keptL=lines.filter(L=>!onRadius(L)); lines.length=0; lines.push(...keptL);
    }
    const kept=[], keptStage=[];
    strokes.forEach((L,i)=>{
      const mx=(L[0]+L[2])/2,my=(L[1]+L[3])/2;
      const len=Math.hypot(L[2]-L[0],L[3]-L[1]);
      if(OPTS.LEAFARC && onRadius(L)) return;
      // text outline: the WHOLE stroke inside one text box (a midpoint test
      // dropped wall strokes passing under a tag — measured CI 28→27, AU 15→14)
      if(!OPTS.NOANNOT_TEXT && len<4*ftPx && inText(L[0],L[1]) && inText(L[2],L[3]) && inText(mx,my)) return;
      if(len<7*ftPx){
        const k=base+i;
        const e1=near(L[0],L[1],0.4*ftPx,k), e2=near(L[2],L[3],0.4*ftPx,k);
        // BOTH ends free = floating annotation (dimension, grain arrow).
        if(!OPTS.NOANNOT_FREE && !e1&&!e2) return;
        // ONE free end AND unpaired = an open door leaf along the wall, a
        // witness line, a counter edge. A wall stub at a cased opening ends
        // free too, but it is PAIRED (its other face line, or poché) — that
        // is what protects it (a bare one-end rule cost CI 28→25, AU 15→12).
        // seeded sheets only: a starved sheet (AU) draws partitions as SINGLE
        // lines, so "unpaired" is not evidence there (measured AU 15→13)
        if(!OPTS.NOANNOT_LEAF && !starved && (!e1||!e2)){
          const u=unit(L), n=[-u[1],u[0]];
          let paired=false;
          for(let q=0;q<pool.length&&!paired;q++){
            if(q===k) continue;
            const T=pool[q], v=unit(T);
            if(Math.abs(u[0]*v[0]+u[1]*v[1])<0.985) continue;
            const d=Math.abs((T[0]-L[0])*n[0]+(T[1]-L[1])*n[1]);
            // a wall's two faces run TOGETHER: partner within a wall
            // thickness (≤0.8 ft, or coincident poché edge) over most of
            // this stroke's length. A witness line grazing a real wall 0.94 ft
            // away over 27% of itself is not paired (Park GRAIN, measured).
            if(d>0.8*ftPx) continue;
            const t=(x,y)=>(x-L[0])*u[0]+(y-L[1])*u[1];
            const a0=Math.min(t(L[0],L[1]),t(L[2],L[3])), a1=Math.max(t(L[0],L[1]),t(L[2],L[3]));
            const b0=Math.min(t(T[0],T[1]),t(T[2],T[3])), b1=Math.max(t(T[0],T[1]),t(T[2],T[3]));
            const ov2=Math.min(a1,b1)-Math.max(a0,b0);
            if(ov2 >= 0.6*len && ov2 >= 0.5*(b1-b0)) paired=true;   // mutual: not a leaf against a long wall
          }
          if(!paired) return;
        }
      }
      kept.push(L); keptStage.push(strokeStage[i]);
    });
    strokes.length=0; strokes.push(...kept); strokeStage.length=0; strokeStage.push(...keptStage);
  }
  mark("annotation");
  // ── pair face lines into wall RUNS ──
  // sliver+sliver or sliver+stroke; NEVER stroke+stroke (furniture would become walls)
  const T_MIN=0.15*ftPx, T_MAX=1.5*ftPx, OVL_MIN=0.8*ftPx;
  const all=[...lines.map(L=>({L,sliver:true})), ...strokes.map(L=>({L,sliver:false}))];
  const runs=[]; // {ax,ay,ux,uy, t0,t1, thick}
  for(let i=0;i<all.length;i++) for(let j=i+1;j<all.length;j++){
    const L1=all[i].L, L2=all[j].L;
    const u1=unit(L1), u2=unit(L2);
    const dot=u1[0]*u2[0]+u1[1]*u2[1];
    if(Math.abs(dot)<0.985) continue;
    // lateral distance between the two lines
    const n=[-u1[1],u1[0]];
    const d=( (L2[0]-L1[0])*n[0]+(L2[1]-L1[1])*n[1] + (L2[2]-L1[0])*n[0]+(L2[3]-L1[1])*n[1] )/2;
    const ad=Math.abs(d);
    if(ad<T_MIN||ad>T_MAX) continue;
    // overlap along axis
    const t=(x,y)=>(x-L1[0])*u1[0]+(y-L1[1])*u1[1];
    const a0=Math.min(t(L1[0],L1[1]),t(L1[2],L1[3])), a1=Math.max(t(L1[0],L1[1]),t(L1[2],L1[3]));
    const b0=Math.min(t(L2[0],L2[1]),t(L2[2],L2[3])), b1=Math.max(t(L2[0],L2[1]),t(L2[2],L2[3]));
    const o0=Math.max(a0,b0), o1=Math.min(a1,b1);
    if(o1-o0<OVL_MIN) continue;
    // centerline
    const cx=L1[0]+n[0]*d/2, cy=L1[1]+n[1]*d/2;
    runs.push({ax:cx,ay:cy,ux:u1[0],uy:u1[1],t0:o0,t1:o1,thick:ad,li:i,lj:j});
  }

  // (thickness-mode filtering removed: it kept 2in leaf/glazing junk and dropped
  //  real 4.7in partitions — the pen gate is the furniture discriminator)

  // material polys from runs (for solid test + blocking checks)
  const runRect=(r)=>{
    const n=[-r.uy,r.ux], h=r.thick/2+0.01;
    const p=(t,s)=>[r.ax+r.ux*t+n[0]*s, r.ay+r.uy*t+n[1]*s];
    return [p(r.t0,-h),p(r.t1,-h),p(r.t1,h),p(r.t0,h)];
  };
  // ── FIXTURE X-BOXES: a rectangle with BOTH corner-to-corner diagonals is
  // the drafting symbol for a tub/shower/millwork — never a wall. Any
  // run-derived material lying on such a box is a fixture rim, not a
  // partition (Comfort Inn: every tub rim paired into a phantom 0.33 ft
  // wall and walled the tub out of its own bathroom, 7 baths at -31%).
  // Only THIN material drops inside a fixture box — a rim band is ≤0.35 ft;
  // a wall crossing the box margin is wall-thick and stays.
  const RIM_MAX=0.35*ftPx;
  const ringW=(ring)=>{let a=0,per=0;for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length];a+=p[0]*q[1]-q[0]*p[1];per+=Math.hypot(q[0]-p[0],q[1]-p[1]);}a=Math.abs(a)/2;return per>0?2*a/per:0;};
  const runMats=[];
  runs.forEach(R=>{ const rect=runRect(R); if(R.thick<=RIM_MAX&&onXbox(rect)) return; runMats.push(rect); });
  const pocheMats=poche.filter(r=>!(ringW(r)<=RIM_MAX&&onXbox(r)));
  if(OPTS.XBOXLOG) console.error(`XBOX boxes=${xboxes.length} runs=${runs.length} dropped=${runs.length-runMats.length} pocheDropped=${poche.length-pocheMats.length}`);
  const material=[...pocheMats, ...runMats, ...stairRects];
  const inMaterial=(x,y)=>{for(const r of material){ if(pointInRing(r,x,y)) return true;} return false;};

  // ── wall-ink proximity: is (x,y) within tol of ANY wall evidence segment ──
  const wallInk=[];
  for(const ring of poche) for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length];wallInk.push(p[0],p[1],q[0],q[1]);}
  for(const L of lines) wallInk.push(L[0],L[1],L[2],L[3]);
  for(const L of strokes) wallInk.push(L[0],L[1],L[2],L[3]);
  const inkGrid=new Map();
  const IG=2*ftPx;
  for(let i=0;i+3<wallInk.length;i+=4){
    const x0=Math.min(wallInk[i],wallInk[i+2]), x1=Math.max(wallInk[i],wallInk[i+2]);
    const y0=Math.min(wallInk[i+1],wallInk[i+3]), y1=Math.max(wallInk[i+1],wallInk[i+3]);
    for(let gx=Math.floor(x0/IG);gx<=Math.floor(x1/IG);gx++)
      for(let gy=Math.floor(y0/IG);gy<=Math.floor(y1/IG);gy++){
        const k=gx+','+gy; const b=inkGrid.get(k); if(b)b.push(i); else inkGrid.set(k,[i]);
      }
  }
  const nearWall=(x,y,tol)=>{
    for(const dgx of [-1,0,1]) for(const dgy of [-1,0,1]){
      const b=inkGrid.get((Math.floor(x/IG)+dgx)+','+(Math.floor(y/IG)+dgy));
      if(!b) continue;
      for(const i of b){
        const x1=wallInk[i],y1=wallInk[i+1],x2=wallInk[i+2],y2=wallInk[i+3];
        const dx=x2-x1,dy=y2-y1,L2=dx*dx+dy*dy||1;
        let t=((x-x1)*dx+(y-y1)*dy)/L2; t=Math.max(0,Math.min(1,t));
        if(Math.hypot(x-x1-dx*t,y-y1-dy*t)<=tol) return true;
      }
    }
    return false;
  };

  mark("runs+material");
  // ── run ENDS + poché caps = opening endpoints ──
  // an END: {x,y (center), dir (outward unit along axis), halfWidth, corners:[p1,p2]}
  const ends=[];
  for(const r of runs){
    // a door hangs between WALL ends: a 1.9 ft dimension-tick pair is a run
    // too, and its end paired with a partition's end sealed a 4.3 ft strip
    // into a Park office (measured, both scales)
    if(r.t1-r.t0 < 3*ftPx) continue;
    const n=[-r.uy,r.ux], h=r.thick/2;
    for(const [tt,sgn] of [[r.t0,-1],[r.t1,1]]){
      const cx=r.ax+r.ux*tt, cy=r.ay+r.uy*tt;
      ends.push({x:cx,y:cy,dir:[r.ux*sgn,r.uy*sgn],hw:h,
        corners:[[cx+n[0]*h,cy+n[1]*h],[cx-n[0]*h,cy-n[1]*h]]});
    }
  }
  // poché ring caps
  for(const ring0 of poche){
    const ring=mergeRing(ring0), nn=ring.length; if(nn<4) continue;
    for(let i=0;i<nn;i++){
      const p=ring[i], q=ring[(i+1)%nn];
      const len=Math.hypot(q[0]-p[0],q[1]-p[1]);
      if(len<W_MIN||len>2.0*ftPx) continue;
      const prev=ring[(i-1+nn)%nn], next=ring[(i+2)%nn];
      const lp=Math.hypot(p[0]-prev[0],p[1]-prev[1]);
      const ln=Math.hypot(next[0]-q[0],next[1]-q[1]);
      if(lp<len*1.2||ln<len*1.2) continue;
      const dx=(q[0]-p[0])/len, dy=(q[1]-p[1])/len;
      const fp=[(p[0]-prev[0])/lp,(p[1]-prev[1])/lp], fn=[(next[0]-q[0])/ln,(next[1]-q[1])/ln];
      if(Math.abs(fp[0]*dx+fp[1]*dy)>0.35) continue;
      if(Math.abs(fn[0]*dx+fn[1]*dy)>0.35) continue;
      let nx=-dy, ny=dx;
      const mx=(p[0]+q[0])/2, my=(p[1]+q[1])/2;
      if(pointInRing(ring,mx+nx*2,my+ny*2)){nx=-nx;ny=-ny;}
      if(pointInRing(ring,mx+nx*2,my+ny*2)) continue;
      ends.push({x:mx,y:my,dir:[nx,ny],hw:len/2,corners:[p,q]});
    }
  }

  const arcClosures=[];
  for(const a of arcs){
    // a DOOR swing hinges ON a wall and strikes A wall; an arc that touches no
    // wall ink is a fixture curve, not a door — no closure at all.
    if(!nearWall(a.C[0],a.C[1],0.45*ftPx)) continue;
    const score=(E)=>{
      const ux2=(E[0]-a.C[0])/a.r, uy2=(E[1]-a.C[1])/a.r;
      let sc=0;
      for(const t of [0.2,0.45,0.7]){
        const x=E[0]+ux2*t*ftPx, y=E[1]+uy2*t*ftPx;
        if(inMaterial(x,y)||nearWall(x,y,0.2*ftPx)) sc++;
      }
      if(nearWall(E[0],E[1],0.3*ftPx)) sc++;
      return sc;
    };
    const s0=score(a.P0), s1=score(a.P1);
    if(Math.max(s0,s1)<2) continue;
    arcClosures.push(s0>=s1?[a.C,a.P0]:[a.C,a.P1]);
  }

  // ── LINE-END closures: two collinear wall-line ends facing each other across
  // a door-scale clear gap are one interrupted wall line — an OPENING. Bridge
  // each face line, so the doorway closes at the finish face (his ruler).
  mark("ends+wallInk");
  // ── FINISH FAMILY at a point: direction signature of LONG hatch strokes
  // within reach. Tile grid = two orthogonal buckets; carpet stipple is
  // short and never votes (reads as 'none'). Two openings' sides with
  // DIFFERENT signatures = a drawn finish change = a boundary his ruler
  // stops at (the TR-01 transition), even with no door and no wall.
  const finishGrid=new Map(); const FG=2*ftPx;
  {
    const n=g.segs.length>>2;
    for(let i=0;i<n;i++){
      if(!hatchOnly[i]) continue;
      const x1=g.segs[i*4],y1=g.segs[i*4+1],x2=g.segs[i*4+2],y2=g.segs[i*4+3];
      const L=Math.hypot(x2-x1,y2-y1); if(L<1.5*ftPx) continue;
      let ang=Math.atan2(y2-y1,x2-x1)*180/Math.PI; if(ang<0)ang+=180; if(ang>=180)ang-=180;
      const bkt=Math.round(ang/15)%12;
      // vote along the stroke so long tile lines register near openings too
      const steps=Math.max(1,Math.round(L/(1.5*ftPx)));
      for(let k=0;k<=steps;k++){
        const px=x1+(x2-x1)*k/steps, py=y1+(y2-y1)*k/steps;
        const key=Math.floor(px/FG)+','+Math.floor(py/FG);
        const b=finishGrid.get(key); if(b)b.push(px,py,bkt); else finishGrid.set(key,[px,py,bkt]);
      }
    }
  }
  const finishSig=(x,y,r)=>{
    const h=new Array(12).fill(0); let tot=0;
    for(let gx=Math.floor((x-r)/FG);gx<=Math.floor((x+r)/FG);gx++)
      for(let gy=Math.floor((y-r)/FG);gy<=Math.floor((y+r)/FG);gy++){
        const b=finishGrid.get(gx+','+gy); if(!b) continue;
        for(let i=0;i<b.length;i+=3){ if(Math.hypot(b[i]-x,b[i+1]-y)<=r){ h[b[i+2]]++; tot++; } }
      }
    if(tot<3) return null;
    const order=h.map((c,b)=>[c,b]).sort((a,b)=>b[0]-a[0]);
    const fam=new Set(); let cov=0;
    for(const [c,b] of order){ if(cov/tot>=0.7||c===0) break; fam.add(b); cov+=c; }
    return fam;
  };
  // the drafter DRAWS the transition (TR-01): a stroke spanning the connector,
  // parallel, within 0.35 ft — a hatch difference alone fires across open
  // plans (measured: Park 11→8, CI 28→22, AU 15→10 without this).
  // grid of LONG non-clip segments (≥1.5 ft) for the transition-line test —
  // a full scan per wide-gap candidate was 57 of 60 s on a 105k-seg sheet
  const longGrid=new Map(); const LG=8*ftPx;
  {
    const n=g.segs.length>>2;
    for(let i=0;i<n;i++){
      if(g.meta[i]&O.SEG_CLIP) continue;
      const x1=g.segs[i*4],y1=g.segs[i*4+1],x2=g.segs[i*4+2],y2=g.segs[i*4+3];
      if(Math.hypot(x2-x1,y2-y1)<1.5*ftPx) continue;
      const gx0=Math.floor(Math.min(x1,x2)/LG),gx1=Math.floor(Math.max(x1,x2)/LG),gy0=Math.floor(Math.min(y1,y2)/LG),gy1=Math.floor(Math.max(y1,y2)/LG);
      for(let gx=gx0;gx<=gx1;gx++) for(let gy=gy0;gy<=gy1;gy++){ const k=gx+','+gy; const b=longGrid.get(k); if(b)b.push(i); else longGrid.set(k,[i]); }
    }
  }
  const transitionUnder=(ax,ay,bx,by)=>{
    const dx=bx-ax, dy=by-ay, L=Math.hypot(dx,dy)||1, ux=dx/L, uy=dy/L;
    const cand=new Set();
    const gx0=Math.floor(Math.min(ax,bx)/LG),gx1=Math.floor(Math.max(ax,bx)/LG),gy0=Math.floor(Math.min(ay,by)/LG),gy1=Math.floor(Math.max(ay,by)/LG);
    for(let gx=gx0;gx<=gx1;gx++) for(let gy=gy0;gy<=gy1;gy++){ const b=longGrid.get(gx+','+gy); if(b) for(const i of b) cand.add(i); }
    for(const i of cand){
      const x1=g.segs[i*4],y1=g.segs[i*4+1],x2=g.segs[i*4+2],y2=g.segs[i*4+3];
      const sl=Math.hypot(x2-x1,y2-y1); if(sl<0.5*L) continue;
      const vx=(x2-x1)/sl, vy=(y2-y1)/sl;
      if(Math.abs(vx*ux+vy*uy)<0.985) continue;
      const lat1=Math.abs((x1-ax)*(-uy)+(y1-ay)*ux), lat2=Math.abs((x2-ax)*(-uy)+(y2-ay)*ux);
      if(lat1>0.35*ftPx||lat2>0.35*ftPx) continue;
      const t1=(x1-ax)*ux+(y1-ay)*uy, t2=(x2-ax)*ux+(y2-ay)*uy;
      const lo=Math.max(0,Math.min(t1,t2)), hi=Math.min(L,Math.max(t1,t2));
      if(hi-lo>=0.6*L) return true;
    }
    return false;
  };
  const crossesXbox=(ax,ay,bx,by)=>{
    const M=0.55*ftPx;
    for(let t=0;t<=1.0001;t+=0.1){ const x=ax+(bx-ax)*t, y=ay+(by-ay)*t;
      for(const b of xboxes){ if(x>=b[0]-M&&x<=b[2]+M&&y>=b[1]-M&&y<=b[3]+M) return true; } }
    return false;
  };
  const finishDiffers=(ax,ay,bx,by)=>{
    // cheap first: the hatch signatures; the transition-line search last
    {
      const dx=bx-ax, dy=by-ay, L=Math.hypot(dx,dy)||1;
      const nx=-dy/L, ny=dx/L, mx=(ax+bx)/2, my=(ay+by)/2, off=1.2*ftPx;
      const s1=finishSig(mx+nx*off,my+ny*off,1.5*ftPx), s2=finishSig(mx-nx*off,my-ny*off,1.5*ftPx);
      if(!s1&&!s2) return false;
      if(s1&&s2){ let shared=false; for(const b of s1) if(s2.has(b)){shared=true;break;} if(shared) return false; }
    }
    if(crossesXbox(ax,ay,bx,by)) return false;        // a tub rim is not a transition (measured: sealed two baths through the tub)
    if(!transitionUnder(ax,ay,bx,by)) return false;
    // sample both sides of a connector: perpendicular offsets 1.2 ft
    const dx=bx-ax, dy=by-ay, L=Math.hypot(dx,dy)||1;
    const nx=-dy/L, ny=dx/L, mx=(ax+bx)/2, my=(ay+by)/2, off=1.2*ftPx;
    const s1=finishSig(mx+nx*off,my+ny*off,1.5*ftPx), s2=finishSig(mx-nx*off,my-ny*off,1.5*ftPx);
    if(!s1&&!s2) return false;
    if(!s1||!s2) return true;                       // field on one side only
    for(const b of s1) if(s2.has(b)) return false;  // share a direction: same field
    return true;
  };
  mark("finishGrid");
  const lineEnds=[];
  const pushEnds=(x1,y1,x2,y2)=>{
    const d=Math.hypot(x2-x1,y2-y1); if(d<2.0*ftPx) return;
    const ux2=(x2-x1)/d, uy2=(y2-y1)/d;
    lineEnds.push({x:x2,y:y2,ux:ux2,uy:uy2});      // outward at the far end
    lineEnds.push({x:x1,y:y1,ux:-ux2,uy:-uy2});    // outward at the near end
  };
  for(const L of lines) pushEnds(L[0],L[1],L[2],L[3]);
  // tier-1 spawns closures; so do STAGED admissions on a starved sheet (they
  // ARE its walls — softpair/lowpair rescued faces held every closure mouth
  // on AU). Elsewhere the old rule stands: paired lows never spawn closures.
  // stage tags survive the filters (tier1StrokeCount does not: the
  // annotation filter shrinks the list under it — L&N crashed here)
  strokes.forEach((L,si)=>{ if(starved || strokeStage[si]==="pen" || strokeStage[si]==="vouch" || strokeStage[si]==="stair") pushEnds(L[0],L[1],L[2],L[3]); });
  for(const ring of poche){
    const r=mergeRing(ring);
    for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];pushEnds(p[0],p[1],q[0],q[1]);}
  }
  // ── PERFORMANCE: all-pairs over every wall end with a full ink scan per
  // candidate was 56 of 60 s on a 105k-segment sheet. Bucket the ends
  // (cells of GAPMAX) so only reachable pairs are tried, and test crossings
  // by walking the ink grid along the connector.
  const crossesInk=(ax2,ay2,bx2,by2)=>{
    const dxc=bx2-ax2, dyc=by2-ay2;
    const gx0=Math.floor(Math.min(ax2,bx2)/IG), gx1=Math.floor(Math.max(ax2,bx2)/IG);
    const gy0=Math.floor(Math.min(ay2,by2)/IG), gy1=Math.floor(Math.max(ay2,by2)/IG);
    const seen=new Set();
    for(let gx=gx0;gx<=gx1;gx++) for(let gy=gy0;gy<=gy1;gy++){
      const b=inkGrid.get(gx+','+gy); if(!b) continue;
      for(const w of b){
        if(seen.has(w)) continue; seen.add(w);
        const x1=wallInk[w],y1=wallInk[w+1],x2=wallInk[w+2],y2=wallInk[w+3];
        const ex=x2-x1, ey=y2-y1;
        const den=dxc*ey-dyc*ex;
        if(Math.abs(den)<1e-9) continue;
        const t=((x1-ax2)*ey-(y1-ay2)*ex)/den;
        const u=((x1-ax2)*dyc-(y1-ay2)*dxc)/den;
        if(t>0.001&&t<0.999&&u>0.001&&u<0.999) return true;
      }
    }
    return false;
  };
  const GAPMAX_LE=24*ftPx;
  const endGrid=new Map();
  lineEnds.forEach((e,i)=>{ const k=Math.floor(e.x/GAPMAX_LE)+','+Math.floor(e.y/GAPMAX_LE); const b=endGrid.get(k); if(b)b.push(i); else endGrid.set(k,[i]); });
  const lecand=[];
  for(let i=0;i<lineEnds.length;i++){
    const ei=lineEnds[i]; const cx=Math.floor(ei.x/GAPMAX_LE), cy=Math.floor(ei.y/GAPMAX_LE);
    for(let dgx=-1;dgx<=1;dgx++) for(let dgy=-1;dgy<=1;dgy++){
      const bucket=endGrid.get((cx+dgx)+','+(cy+dgy)); if(!bucket) continue;
      for(const j of bucket){ if(j<=i) continue;
    const a=lineEnds[i], b=lineEnds[j];
    if(a.ux*b.ux+a.uy*b.uy > -0.94) continue;                 // anti-parallel
    const vx=b.x-a.x, vy=b.y-a.y, d2=Math.hypot(vx,vy);
    if(d2<(+OPTS.LCMIN||0.7)*ftPx) continue;
    if(d2>7*ftPx){
      // wider than a door: only a FINISH CHANGE across the gap earns a closure
      if(OPTS.NOFINISH || d2>24*ftPx) continue;
      if(!finishDiffers(a.x,a.y,b.x,b.y)) continue;
    }
    const ux2=vx/d2, uy2=vy/d2;
    if(ux2*a.ux+uy2*a.uy<0.94) continue;                      // b lies ahead of a
    if(-ux2*b.ux-uy2*b.uy<0.94) continue;
    if(Math.abs(vx*(-a.uy)+vy*(a.ux)) > 0.3*ftPx) continue;   // collinear
    // blocked = wall ink CROSSING the connector (parallel door-panel lines in
    // the opening must not veto the closure)
    if(crossesInk(a.x+vx*0.06, a.y+vy*0.06, a.x+vx*0.94, a.y+vy*0.94)) continue;
    if(inXboxPt((a.x+b.x)/2,(a.y+b.y)/2)) continue;   // fixture interior: no closure
    lecand.push([d2,i,j]);
      }
    }
  }
  lecand.sort((p2,q2)=>p2[0]-q2[0]);
  const leUsed=new Set(); const lineClosures=[];
  const sl=OPTS.SEALLOG?OPTS.SEALLOG.split(",").map(Number):null;
  for(const [d9,i,j] of lecand){
    const logIt=sl && [i,j].some(k=>lineEnds[k].x>=sl[0]&&lineEnds[k].x<=sl[2]&&lineEnds[k].y>=sl[1]&&lineEnds[k].y<=sl[3]);
    if(leUsed.has(i)||leUsed.has(j)){ if(logIt) console.error(`SEAL skip used (${lineEnds[i].x.toFixed(0)},${lineEnds[i].y.toFixed(0)})-(${lineEnds[j].x.toFixed(0)},${lineEnds[j].y.toFixed(0)}) d=${(d9/ftPx).toFixed(2)}ft`); continue; }
    if(logIt) console.error(`SEAL PAIR (${lineEnds[i].x.toFixed(0)},${lineEnds[i].y.toFixed(0)})-(${lineEnds[j].x.toFixed(0)},${lineEnds[j].y.toFixed(0)}) d=${(d9/ftPx).toFixed(2)}ft`);
    leUsed.add(i); leUsed.add(j);
    lineClosures.push({seg:[[lineEnds[i].x,lineEnds[i].y],[lineEnds[j].x,lineEnds[j].y]], door:false, finish:d9>7*ftPx});
  }
  mark("lineClosures");
  // ── JAMB BRIDGES: a door at a corner ends against a PERPENDICULAR wall.
  // An unconsumed wall end raycasts along its own line; a perpendicular wall
  // hit at door range closes the opening — but only with door evidence in the
  // gap (leaf/panel lines parallel to the connector, or a swing-arc point).
  {
    const nseg2=g.segs.length>>2;
    for(let i=0;i<lineEnds.length;i++){
      if(leUsed.has(i)) continue;
      const e=lineEnds[i];
      // nearest crossing wall-ink hit along the ray, roughly perpendicular
      let bestT=Infinity;
      for(let w=0;w+3<wallInk.length;w+=4){
        const x1=wallInk[w],y1=wallInk[w+1],x2=wallInk[w+2],y2=wallInk[w+3];
        const ex=x2-x1, ey=y2-y1, eL=Math.hypot(ex,ey)||1;
        if(Math.abs((ex*e.ux+ey*e.uy)/eL)>0.5) continue;   // want a crossing wall, not a continuation
        const den=e.ux*ey-e.uy*ex;
        if(Math.abs(den)<1e-9) continue;
        const t=((x1-e.x)*ey-(y1-e.y)*ex)/den;
        const u=((x1-e.x)*e.uy-(y1-e.y)*e.ux)/den;
        if(t>1.5*ftPx && t<(OPTS.NOFINISH?7:24)*ftPx && u>=-0.001 && u<=1.001 && t<bestT) bestT=t;
      }
      if(bestT===Infinity) continue;
      const hx=e.x+e.ux*bestT, hy=e.y+e.uy*bestT;
      // blocked? any wall ink crossing strictly inside
      if(crossesInk(e.x+e.ux*bestT*0.08, e.y+e.uy*bestT*0.08, e.x+e.ux*bestT*0.92, e.y+e.uy*bestT*0.92)) continue;
      // door evidence in the gap — KIND recorded: 'arc' and 'panel' are
      // trusted (drafter-stated door); 'leaf' seals but is not trusted (the
      // loose foot test also fires at casework mouths).
      let evidence=false, kind=null;
      for(const a of arcs){
        for(const P of [a.C,a.P0,a.P1]){
          const mx=(e.x+hx)/2,my=(e.y+hy)/2;
          if(Math.hypot(P[0]-mx,P[1]-my)<1.5*ftPx){evidence=true;kind='arc';break;}
        }
        if(evidence)break;
      }
      if(!evidence){
        for(let si=0;si<nseg2;si++){
          if(g.meta[si]&(O.SEG_CLIP)) continue;
          if(soft[si]) continue;                              // hatch/annotation is never a door panel
          const x1=g.segs[si*4],y1=g.segs[si*4+1],x2=g.segs[si*4+2],y2=g.segs[si*4+3];
          const L=Math.hypot(x2-x1,y2-y1);
          if(L<1.2*ftPx) continue;
          const ux3=(x2-x1)/L, uy3=(y2-y1)/L;
          if(Math.abs(ux3*e.ux+uy3*e.uy)<0.94) continue;      // parallel to connector
          const lat=Math.abs(((x1+x2)/2-e.x)*(-e.uy)+((y1+y2)/2-e.y)*e.ux);
          if(lat>=0.6*ftPx) continue;
          // the panel must SPAN the opening, not merely poke into it
          const t1=(x1-e.x)*e.ux+(y1-e.y)*e.uy, t2=(x2-e.x)*e.ux+(y2-e.y)*e.uy;
          const lo=Math.max(0,Math.min(t1,t2)), hi=Math.min(bestT,Math.max(t1,t2));
          if(hi-lo>=0.6*bestT){evidence=true;kind='panel';break;}
        }
      }
      if(!evidence){
        // OPEN LEAF: the door drawn standing open — a stroke PERPENDICULAR to
        // the connector, door-length (≈ the gap), footed at one end of the
        // opening. The parallel-panel test above cannot see it.
        for(let si=0;si<nseg2;si++){
          if(g.meta[si]&(O.SEG_CLIP)) continue;
          if(soft[si]) continue;
          const x1=g.segs[si*4],y1=g.segs[si*4+1],x2=g.segs[si*4+2],y2=g.segs[si*4+3];
          const L=Math.hypot(x2-x1,y2-y1);
          if(L<0.6*bestT || L>1.4*bestT) continue;
          const ux3=(x2-x1)/L, uy3=(y2-y1)/L;
          if(Math.abs(ux3*e.ux+uy3*e.uy)>0.35) continue;      // perpendicular to connector
          const footNear=(fx,fy)=>Math.hypot(fx-e.x,fy-e.y)<0.5*ftPx||Math.hypot(fx-hx,fy-hy)<0.5*ftPx;
          // the OTHER end must hang FREE — a partition stub footed at the
          // gap end lands its far end on more wall; a leaf sticks into space
          const f1=footNear(x1,y1), f2=footNear(x2,y2);
          // Foot-only (loose) on STARVED sheets: +2 rooms into 5% (7, 20) at
          // one already-failing room's expense (23: -32→-87). On seeded
          // sheets loose is POISON (Park 11→10, CI 23→14 measured) — their
          // partition stubs foot at real alcove mouths; free-end required.
          if(starved && !OPTS.TIGHTLEAF){ if(f1||f2){evidence=true;kind='leaf';break;} }
          else {
            if(f1&&!f2&&!nearWall(x2,y2,0.3*ftPx)){evidence=true;kind='leaf';break;}
            if(f2&&!f1&&!nearWall(x1,y1,0.3*ftPx)){evidence=true;kind='leaf';break;}
          }
        }
      }
      // finish evidence only at WIDE openings (>7 ft): door-scale gaps have
      // their own machinery, and a tub rim reads as a 5 ft "transition"
      if(!evidence && !OPTS.NOFINISH && bestT>7*ftPx && finishDiffers(e.x,e.y,hx,hy)){ evidence=true; kind='finish'; }
      if(!evidence) continue;
      if(bestT>7*ftPx && kind!=='finish') continue;   // wide gaps close on finish evidence only
      if(inXboxPt((e.x+hx)/2,(e.y+hy)/2)) continue;   // no door lives inside a fixture symbol
      leUsed.add(i);
      lineClosures.push({seg:[[e.x,e.y],[hx+e.ux*0.5,hy+e.uy*0.5]], door:true, kind});
    }
  }

  mark("jambBridges");
  // ── pair ends across door-scale gaps: facing, COLLINEAR, similar width, clear between ──
  const GAP_MIN=1.2*ftPx, GAP_MAX=7*ftPx;
  const valid=[];
  for(let i=0;i<ends.length;i++){
    for(let j=i+1;j<ends.length;j++){
      const a=ends[i], b=ends[j];
      const vx=b.x-a.x, vy=b.y-a.y, d=Math.hypot(vx,vy);
      if(d<GAP_MIN||d>GAP_MAX) continue;
      // anti-parallel axes
      if(a.dir[0]*b.dir[0]+a.dir[1]*b.dir[1] > -0.94) continue;
      const ux=vx/d, uy=vy/d;
      if(ux*a.dir[0]+uy*a.dir[1]<0.94) continue;
      if(-ux*b.dir[0]-uy*b.dir[1]<0.94) continue;
      // collinear: b's center off a's axis line by less than the wall is thick
      const anx=-a.dir[1], any_=a.dir[0];
      if(Math.abs(vx*anx+vy*any_) > Math.max(a.hw,b.hw,0.3*ftPx)) continue;
      if(Math.max(a.hw,b.hw)>2.2*Math.min(a.hw,b.hw)) continue;
      let blocked=false;
      // include the near-end samples: a connector that begins INSIDE wall
      // material is crossing a wall, not spanning an opening
      for(const t of [0.06,0.2,0.4,0.6,0.8,0.94]){ if(inMaterial(a.x+vx*t, a.y+vy*t)){blocked=true;break;} }
      if(blocked) continue;
      if(inXboxPt(a.x+vx/2, a.y+vy/2)) continue;      // fixture interior: not a doorway
      valid.push([d,i,j]);
    }
  }
  valid.sort((p,q)=>p[0]-q[0]);          // global greedy: shortest gaps claim their ends first
  const doorQuads=[]; const synth=[];
  const used=new Set();
  for(const [,i,j] of valid){
    if(used.has(i)||used.has(j)) continue;
    used.add(i); used.add(j);
    const a=ends[i], b=ends[j];
    const d11=Math.hypot(b.corners[0][0]-a.corners[0][0],b.corners[0][1]-a.corners[0][1]);
    const d12=Math.hypot(b.corners[1][0]-a.corners[0][0],b.corners[1][1]-a.corners[0][1]);
    const [b1,b2]= d11<=d12 ? [b.corners[0],b.corners[1]] : [b.corners[1],b.corners[0]];
    const a1=a.corners[0], a2=a.corners[1];
    synth.push(a1[0],a1[1],b1[0],b1[1],  a2[0],a2[1],b2[0],b2[1]);
    // jamb caps so the door cell closes even when the drafter drew none
    synth.push(a1[0],a1[1],a2[0],a2[1],  b1[0],b1[1],b2[0],b2[1]);
    doorQuads.push([a1,b1,b2,a2]);
  }

  // ── arrangement over wall ink + closures ──
  mark("endPairs");
  const segs=[];
  // ── JAMB SEALS (starved sheets): a SHORT straight piece, unclaimed by any
  // classifier, with BOTH endpoints on admitted wall evidence, is band
  // geometry — a window-box jamb, a return at an opening. Too short for
  // face admission (SLIVER_LEN) but load-bearing as a barrier: without it the
  // face walks around the wall end into the cavity. Barrier only — spawns no
  // runs, no ends, no closures.
  const jambSeals=[];
  if(starved && !OPTS.NOJAMB){
    const nseg3=g.segs.length>>2;
    const JTOL=0.3*ftPx;
    for(let i=0;i<nseg3;i++){
      if(g.meta[i]&O.SEG_CLIP) continue;
      if(soft[i]) continue;
      const x1=g.segs[i*4],y1=g.segs[i*4+1],x2=g.segs[i*4+2],y2=g.segs[i*4+3];
      const L=Math.hypot(x2-x1,y2-y1);
      if(L<0.4*ftPx || L>=2.0*ftPx) continue;
      if(!nearWall(x1,y1,JTOL) || !nearWall(x2,y2,JTOL)) continue;
      jambSeals.push(x1,y1,x2,y2);
    }
  }
  for(let i=0;i<jambSeals.length;i+=4) segs.push(jambSeals[i],jambSeals[i+1],jambSeals[i+2],jambSeals[i+3]);
  for(const ring of poche) for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length];segs.push(p[0],p[1],q[0],q[1]);}
  for(const L of lines) segs.push(L[0],L[1],L[2],L[3]);
  // every pen-gated stroke line is a barrier (an unpaired wall face still stops
  // a room); runs are still what MATERIAL is made of
  const strokeUsed=new Set(strokes.map((_,i)=>i));
  for(const L of strokes) segs.push(L[0],L[1],L[2],L[3]);
  for(let i=0;i<synth.length;i+=4) segs.push(synth[i],synth[i+1],synth[i+2],synth[i+3]);
  // arc closures: EXTEND each end along the closure line until it crosses wall
  // geometry (hinge/strike are drawn a frame-width off the wall corner; a
  // dangling closure seals nothing).
  const EXT=0.9*ftPx;
  const cross=(px_,py_,dx,dy)=>{ // nearest hit t in (0, EXT] of ray p+t*d against wall segs
    let best=Infinity;
    for(let i=0;i+3<segs.length;i+=4){
      const x1=segs[i],y1=segs[i+1],x2=segs[i+2],y2=segs[i+3];
      const ex=x2-x1, ey=y2-y1;
      const den=dx*ey-dy*ex;
      if(Math.abs(den)<1e-9) continue;
      const t=((x1-px_)*ey-(y1-py_)*ex)/den;
      const u=((x1-px_)*dy-(y1-py_)*dx)/den;
      if(t>1e-6 && t<=EXT && u>=-0.001 && u<=1.001 && t<best) best=t;
    }
    return best;
  };
  const extendedClosures=[];
  for(const [a,b] of arcClosures){
    let ax=a[0],ay=a[1],bx=b[0],by=b[1];
    const d=Math.hypot(bx-ax,by-ay)||1;
    const ux2=(bx-ax)/d, uy2=(by-ay)/d;
    const tb=cross(bx,by,ux2,uy2);        // beyond strike
    if(tb<Infinity){ bx+=ux2*(tb+0.5); by+=uy2*(tb+0.5); }
    const ta=cross(ax,ay,-ux2,-uy2);      // beyond hinge
    if(ta<Infinity){ ax-=ux2*(ta+0.5); ay-=uy2*(ta+0.5); }
    extendedClosures.push({seg:[[ax,ay],[bx,by]], door:true, kind:'arc'});
  }
  for(const c of lineClosures) extendedClosures.push(c);
  // closures become thin MATERIAL STRIPS: growth must stop at a door in BOTH
  // directions, and a bare line would be merged across by room growth.
  const closureStrips=[];      // door strips only — these are SOLID
  const trustedStrips=[];      // arc/panel-evidenced door strips — real doors
  const passStrips=[];         // window/interruption closures — bays live beyond
  for(const {seg:[a,b], door, kind} of extendedClosures){
    const d=Math.hypot(b[0]-a[0],b[1]-a[1])||1;
    const nx=-(b[1]-a[1])/d, ny=(b[0]-a[0])/d;
    const w=0.09*ftPx;
    const q=[[a[0]+nx*w,a[1]+ny*w],[b[0]+nx*w,b[1]+ny*w],[b[0]-nx*w,b[1]-ny*w],[a[0]-nx*w,a[1]-ny*w]];
    if(door){ closureStrips.push(q); if(kind==='arc'||kind==='panel') trustedStrips.push(q); }
    else passStrips.push(q);
    for(let i=0;i<4;i++){const p1=q[i],p2=q[(i+1)%4];segs.push(p1[0],p1[1],p2[0],p2[1]);}
  }
  // ── HEAL the network: a fragmented wall face or a T-junction stops a hair
  // short of the wall it meets; a dangling barrier splits no face. Extend each
  // segment end along its own direction to the first wall geometry within reach.
  {
    const HEAL=0.75*ftPx;
    const m=segs.length>>2;
    const hit=(px_,py_,dx,dy,self)=>{
      let best=Infinity;
      for(let j=0;j<m;j++){
        if(j===self) continue;
        const x1=segs[j*4],y1=segs[j*4+1],x2=segs[j*4+2],y2=segs[j*4+3];
        const ex=x2-x1, ey=y2-y1;
        const den=dx*ey-dy*ex;
        if(Math.abs(den)<1e-9) continue;
        const t=((x1-px_)*ey-(y1-py_)*ex)/den;
        const u=((x1-px_)*dy-(y1-py_)*dx)/den;
        if(t>1e-6 && t<=HEAL && u>=-0.001 && u<=1.001 && t<best) best=t;
      }
      return best;
    };
    for(let i=0;i<m;i++){
      const x1=segs[i*4],y1=segs[i*4+1],x2=segs[i*4+2],y2=segs[i*4+3];
      const d=Math.hypot(x2-x1,y2-y1)||1;
      const ux2=(x2-x1)/d, uy2=(y2-y1)/d;
      const t2=hit(x2,y2,ux2,uy2,i);
      if(t2<Infinity){ segs[i*4+2]=x2+ux2*(t2+0.3); segs[i*4+3]=y2+uy2*(t2+0.3); }
      const t1=hit(x1,y1,-ux2,-uy2,i);
      if(t1<Infinity){ segs[i*4]=x1-ux2*(t1+0.3); segs[i*4+1]=y1-uy2*(t1+0.3); }
    }
  }
  mark("segs+seals+heal");
  const arr=buildPolyArrangement(segs, 2);

  mark("arrangement");
  // ── material VALIDATION: a wall separates two DIFFERENT faces; a filled
  // fixture or a furniture band has the same room face on both sides — drop it
  // from material (it stays in the linework; it just isn't solid).
  {
    const sideFaces=(poly)=>{
      // longest edge, probe outward from both long sides
      let bi=0,bl=0;
      for(let i=0;i<poly.length;i++){
        const p=poly[i],q=poly[(i+1)%poly.length];
        const L=Math.hypot(q[0]-p[0],q[1]-p[1]);
        if(L>bl){bl=L;bi=i;}
      }
      const p=poly[bi],q=poly[(bi+1)%poly.length];
      const mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2;
      const L=bl||1, nx=-(q[1]-p[1])/L, ny=(q[0]-p[0])/L;
      // walk from edge midpoint across the poly to find its width, then step beyond
      const inP=(x,y)=>pointInRing(poly,x,y);
      let dirIn=inP(mx+nx*1.5,my+ny*1.5)?1:-1;
      let w=0.5;
      while(w<2.5*ftPx && inP(mx+dirIn*nx*w,my+dirIn*ny*w)) w+=1.5;
      const s1=[mx-dirIn*nx*2.5, my-dirIn*ny*2.5];
      const s2=[mx+dirIn*nx*(w+2.5), my+dirIn*ny*(w+2.5)];
      return [faceAt(arr,s1[0],s1[1]), faceAt(arr,s2[0],s2[1])];
    };
    // a face line in TWO overlapping runs: the THIN run is the wall, the thick
    // one is furring/casework riding the same line — drop the thick one
    const dominated=new Set();
    for(let a=0;a<runs.length;a++) for(let b=0;b<runs.length;b++){
      if(a===b||dominated.has(a)) continue;
      const R=runs[a], R2=runs[b];
      if(R2.thick>=R.thick*0.8) continue;
      if(R.li!==R2.li&&R.li!==R2.lj&&R.lj!==R2.li&&R.lj!==R2.lj) continue;
      if(Math.min(R.t1,R2.t1)-Math.max(R.t0,R2.t0) < 1.5*ftPx) continue;
      dominated.add(a);
    }
    // map dominated/source onto the X-box-filtered material list
    const runMatSrc=[], dominatedMat=new Set();
    {
      let mi2=0;
      runs.forEach((R,ri)=>{
        const rect=runRect(R);
        if(R.thick<=RIM_MAX&&onXbox(rect)) return;
        runMatSrc.push(R);
        if(dominated.has(ri)) dominatedMat.add(mi2);
        mi2++;
      });
    }
    const kept=[];
    for(let mi=0;mi<material.length;mi++){
      const poly=material[mi];
      if(mi>=pocheMats.length+runMats.length){ kept.push(poly); continue; }   // stair flights: evidence-backed, keep
      if(mi>=pocheMats.length){
        const r=runMatSrc[mi-pocheMats.length];
        if(dominatedMat.has(mi-pocheMats.length)) continue;
        // run-derived material must LOOK like a wall: long, and long vs thick
        const len=r.t1-r.t0;
        if(len<4*ftPx || len<5*r.thick) continue;
      }
      const [f1,f2]=sideFaces(poly);
      if(f1>=0 && f1===f2) continue;      // same space on both sides — not a wall
      kept.push(poly);
    }
    material.length=0; material.push(...kept);
  }

  mark("materialValidation");
  const inDoor=(x,y)=>{for(const q of doorQuads){ if(pointInRing(q,x,y)) return true;} return false;};
  const inStrip=(x,y)=>{for(const q of closureStrips){ if(pointInRing(q,x,y)) return true;} return false;};
  const fixtureFace=(fi)=>{
    const F=arr.faces[fi];
    const M=0.30*ftPx;   // absorption margin: rim strips yes, wall band no
    const fA=Math.max(1,(F.x1-F.x0)*(F.y1-F.y0));
    for(const b of xboxes){
      // absorption is for PLUMBING-scale fixtures (tub/shower/sink, short
      // side ≤3.2 ft); a bed/desk symbol still drops rims and suppresses
      // doors but never absorbs. And the face must be 60% CONTAINED in the
      // box — a centroid test let a 15 ft wall-cavity ribbon in because its
      // midpoint grazed a toilet box.
      if(Math.min(b[2]-b[0],b[3]-b[1])>3.2*ftPx) continue;
      const ix=Math.min(F.x1,b[2]+M)-Math.max(F.x0,b[0]-M);
      const iy=Math.min(F.y1,b[3]+M)-Math.max(F.y0,b[1]-M);
      if(ix<=0||iy<=0) continue;
      if(ix*iy/fA>=0.6) return true;
    }
    return false;
  };
  const memo=new Map();
  const solid=(fi)=>{
    let v=memo.get(fi); if(v!==undefined) return v;
    const f=arr.faces[fi];
    // HAIRLINE face: the cavity between a double-drawn line's two strokes.
    // Too thin to be space, too thin to have formed a run — solid by its own
    // geometry (w = 2A/P in feet).
    let per=0;
    for(let i=0;i<f.ring.length;i++){const p=f.ring[i],q=f.ring[(i+1)%f.ring.length];per+=Math.hypot(q[0]-p[0],q[1]-p[1]);}
    // hairline cavities are wall material — EXCEPT inside a fixture symbol
    // box, where the hairline is the tub/millwork rim and the floor runs
    // under it (his gross ruler).
    if(per>0 && (2*f.area)/per < 0.12*ftPx && !fixtureFace(fi)){ memo.set(fi,true); return true; }
    const [px,py]=repPoint(f);
    v=inMaterial(px,py)||inDoor(px,py)||inStrip(px,py);   // door strips solid; window/pass strips gate-decided
    memo.set(fi,v); return v;
  };
  // WINDOW BAYS: his ruler runs through a window closure into the recess even
  // where the drafter poché'd the wall band solid. A small face reached through
  // a pass strip is floor, not wall.
  // only strips over a REAL opening qualify (a strip bridging a drafting break
  // INSIDE a wall band sits in material and must not open the wall)
  const inPass=(x,y)=>{for(const q of passStrips){ if(pointInRing(q,x,y)) return true;} return false;};
  const inPoche=(x,y)=>{for(const r of poche){ if(pointInRing(r,x,y)) return true;} return false;};
  const passFace=new Map();
  const isPassFace=(fi)=>{
    let v=passFace.get(fi); if(v!==undefined) return v;
    const [px,py]=repPoint(arr.faces[fi]);
    v=inPass(px,py); passFace.set(fi,v); return v;
  };
  const BAY_MAX=5.5*ftPx*ftPx;
  const bayMemo=new Map();
  const effSolid=(fi)=>{
    if(!solid(fi)) return false;
    let v=bayMemo.get(fi); if(v!==undefined) return v;
    v=true;
    const F=arr.faces[fi];
    if(F.area<=BAY_MAX){
      const [px,py]=repPoint(F);
      const pocheCovered=inPoche(px,py);
      if(isPassFace(fi)) v=false;
      else if(pocheCovered){
        for(const o of arr.adj[fi]){
          if(arr.faces[o].area<=BAY_MAX && isPassFace(o)){ v=false; break; }
        }
      }
    }
    bayMemo.set(fi,v); return v;
  };
  // GROWTH-ONLY refusal: a face too NARROW to be habitable floor is band or
  // cavity — growth never absorbs one. Seeding still uses plain solid(), so a
  // click inside a narrow room is answered, just never annexed.
  const GROWMAXW=OPTS.GROWMAXW!==undefined ? +OPTS.GROWMAXW : 0.75;
  const widthMemo=new Map();
  const faceW=(fi)=>{
    let v=widthMemo.get(fi); if(v!==undefined) return v;
    const f=arr.faces[fi]; let per=0;
    for(let i=0;i<f.ring.length;i++){const p=f.ring[i],q=f.ring[(i+1)%f.ring.length];per+=Math.hypot(q[0]-p[0],q[1]-p[1]);}
    v=per>0?(2*f.area)/per:0; widthMemo.set(fi,v); return v;
  };
  // a narrow face that touches a DOOR CELL is the door recess between leaf
  // and jamb — his ruler runs through the door to the jamb, so growth must
  // not refuse it as wall band
  const doorCellsAll=[...doorQuads, ...closureStrips];
  const doorTouchMemo=new Map();
  const doorTouch=(fi)=>{
    let v=doorTouchMemo.get(fi); if(v!==undefined) return v;
    v=false; const F=arr.faces[fi]; const R=0.35*ftPx;
    outer: for(let i=0;i<F.ring.length;i++){
      const p=F.ring[i],q=F.ring[(i+1)%F.ring.length]; const mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2;
      const d=Math.hypot(q[0]-p[0],q[1]-p[1])||1; const nx=-(q[1]-p[1])/d, ny=(q[0]-p[0])/d;
      for(const s9 of [1,-1]){ const x=mx+nx*R*s9,y=my+ny*R*s9; for(const poly of doorCellsAll){ if(pointInRing(poly,x,y)){v=true;break outer;} } }
    }
    doorTouchMemo.set(fi,v); return v;
  };
  // (door-recess absorb measured CI 29→26, AU 15→13 — opt-in until it earns)
  // a door RECESS is a few square feet between leaf and jamb; a wall-band
  // cavity touching a door strip is a long ribbon — size is the discriminator
  const RECESS_MAX=(+OPTS.RECESSSF||3)*ftPx*ftPx;
  // OPT-IN (DOORRECESS): measured CI 29→26, AU 15→13 at any size cap — the
  // Workroom jamb lands visually but the count says it costs more elsewhere
  const narrowFace=GROWMAXW>0 ? (fi)=>faceW(fi)<GROWMAXW*ftPx && !(OPTS.DOORRECESS && arr.faces[fi].area<=RECESS_MAX && doorTouch(fi)) : null;
  // ── DOOR ACCESS: does this face's boundary touch a door cell? Every real
  // room has one; a cell carved off the room by casework does not (Kreo's
  // room-graph: rooms are nodes, doors are edges). Test: sample points just
  // outside each boundary edge midpoint; a door quad/strip within reach.
  // trusted = swing-arc / spanning-panel evidence, plus end-pair quads (two
  // CAPPED run ends facing across a door gap — wall-drawn openings) unless
  // NOENDTRUST. Loose-leaf bridges seal but are NOT trusted.
  const doorPolys=[...(OPTS.NOENDTRUST?[]:doorQuads), ...trustedStrips];
  const doorMemo=new Map();
  const doorAccess=(fi)=>{
    let v=doorMemo.get(fi); if(v!==undefined) return v;
    v=false;
    const F=arr.faces[fi];
    const REACH=0.35*ftPx;
    outer:
    for(const ring of [F.ring, ...F.holes]){
      for(let i=0;i<ring.length;i++){
        const p=ring[i],q=ring[(i+1)%ring.length];
        const mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2;
        const d=Math.hypot(q[0]-p[0],q[1]-p[1])||1;
        const nx=-(q[1]-p[1])/d, ny=(q[0]-p[0])/d;
        for(const s9 of [1,-1]){
          const x=mx+nx*REACH*s9, y=my+ny*REACH*s9;
          for(const poly of doorPolys){ if(pointInRing(poly,x,y)){ v=true; break outer; } }
        }
      }
    }
    doorMemo.set(fi,v); return v;
  };
  const growSolid=solid;
  mark("solid+fixture");
  const doorCellPolys=[...doorQuads, ...closureStrips];
  // per-segment hatch flag for the FIELD mode (finish-pattern flood)
  const hatchFlags=hatchOnly;
  return {arr, solid, growSolid, narrowFace, doorAccess, doorCellPolys, fixtureFace, xboxes, starved, effSolid, poche, hatchFlags, ftPx, segsIn:g.segs, lines, strokes, runs, ends, doorQuads, material, arcs, arcClosures, extendedClosures, arrSegs:segs,
          strokeStage,
          diag:{hatch:hatchOnly, annot, fleck, tagbox, soft, modalPen, penGate, lows:diagLows, lowsAdmitted:diagLowsAdmitted, W_MIN, W_MAX, SLIVER_LEN},
          stats:{poche:poche.length, lines:lines.length, strokes:strokes.length, strokeUsed:strokeUsed.size, runs:runs.length, ends:ends.length, doors:doorQuads.length, arcs:arcs.length, arcC:arcClosures.length, lineC:lineClosures.length,
                 faces:arr.faces.length}};

  function repPoint(f){
    const r=f.ring;
    let cx=0,cy=0,Ar=0;
    for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];const c=p[0]*q[1]-q[0]*p[1];Ar+=c;cx+=(p[0]+q[0])*c;cy+=(p[1]+q[1])*c;}
    Ar/=2; if(Ar){cx/=6*Ar;cy/=6*Ar;} else {cx=r[0][0];cy=r[0][1];}
    if(pointInRing(r,cx,cy)) return [cx,cy];
    for(let i=0;i<r.length;i++){
      const p=r[i],q=r[(i+1)%r.length];
      const mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2;
      const dx=q[0]-p[0],dy=q[1]-p[1],L=Math.hypot(dx,dy)||1;
      for(const sgn of [1,-1]){
        const tx=mx-sgn*dy/L*0.5, ty=my+sgn*dx/L*0.5;
        if(pointInRing(r,tx,ty)) return [tx,ty];
      }
    }
    return [cx,cy];
  }
}


export function mergeRing(ring){
  const out=[];
  for(const p of ring){
    while(out.length>=2){
      const a=out[out.length-2], b=out[out.length-1];
      const cr=(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
      const L=Math.hypot(p[0]-a[0],p[1]-a[1]);
      if(Math.abs(cr) < 0.5*L) out.pop(); else break;
    }
    out.push(p);
  }
  return out;
}

// mergeLines + fraction of the merged span actually covered by pieces
export function mergeLinesCov(raw, dupD){
  const out=[];
  for(const L of mergeLines(raw, dupD)){
    const u=unit(L);
    const t=(x,y)=>(x-L[0])*u[0]+(y-L[1])*u[1];
    const span=Math.hypot(L[2]-L[0],L[3]-L[1])||1;
    const ivs=[];
    for(const P of raw){
      const n=[-u[1],u[0]];
      const v=unit(P);
      if(Math.abs(u[0]*v[0]+u[1]*v[1])<0.99) continue;
      const off=Math.abs((P[0]-L[0])*n[0]+(P[1]-L[1])*n[1]);
      if(off>dupD*1.5) continue;
      const a=t(P[0],P[1]), b=t(P[2],P[3]);
      ivs.push([Math.min(a,b),Math.max(a,b)]);
    }
    ivs.sort((a,b)=>a[0]-b[0]);
    let cov=0, cur=-Infinity, hi=-Infinity;
    for(const [a,b] of ivs){
      if(a>hi){ cov+=Math.max(0,hi-cur); cur=a; hi=b; }
      else hi=Math.max(hi,b);
    }
    cov+=Math.max(0,hi-cur);
    out.push([L, Math.max(0,Math.min(1,cov/span))]);
  }
  return out;
}

// merge near-duplicate / collinear-touching lines into canonical face lines
export function mergeLines(rawLines, dupD){
  const canon=[];
  const items=rawLines.map(L=>{
    const u=unit(L);
    // canonical direction (positive x, or positive y when vertical-ish)
    const flip = (Math.abs(u[0])>=Math.abs(u[1]) ? u[0]<0 : u[1]<0);
    const ux=flip?-u[0]:u[0], uy=flip?-u[1]:u[1];
    const n=[-uy,ux];
    const off=L[0]*n[0]+L[1]*n[1];
    const t0=L[0]*ux+L[1]*uy, t1=L[2]*ux+L[3]*uy;
    return {ux,uy,n,off,t0:Math.min(t0,t1),t1:Math.max(t0,t1)};
  });
  items.sort((a,b)=>a.off-b.off);
  const mergedFlags=new Array(items.length).fill(false);
  for(let i=0;i<items.length;i++){
    if(mergedFlags[i]) continue;
    const g0=items[i];
    const cluster=[g0]; mergedFlags[i]=true;
    for(let j=i+1;j<items.length;j++){
      if(mergedFlags[j]) continue;
      const g1=items[j];
      if(Math.abs(g1.ux*g0.ux+g1.uy*g0.uy)<0.9995) continue;
      if(Math.abs(g1.off-g0.off)>dupD) continue;
      // must touch/overlap along axis (allow small gap = dashes)
      if(g1.t0>g0.t1+dupD*4 || g0.t0>g1.t1+dupD*4){
        // check against whole cluster extent
        const ct0=Math.min(...cluster.map(c=>c.t0)), ct1=Math.max(...cluster.map(c=>c.t1));
        if(g1.t0>ct1+dupD*4 || ct0>g1.t1+dupD*4) continue;
      }
      cluster.push(g1); mergedFlags[j]=true;
    }
    const off=cluster.reduce((s,c)=>s+c.off,0)/cluster.length;
    const t0=Math.min(...cluster.map(c=>c.t0)), t1=Math.max(...cluster.map(c=>c.t1));
    canon.push([g0.n[0]*off+g0.ux*t0, g0.n[1]*off+g0.uy*t0, g0.n[0]*off+g0.ux*t1, g0.n[1]*off+g0.uy*t1]);
  }
  return canon;
}


// ── growth + outline (from jarr.mjs) ─────────────────────────────────────
export function growRoom(A,seed,solid,maxAbsorb,bayThrough,narrow,doorless,pocketMax,pocketNeedFat,fixture,pocketFixtureOnly){
  if(seed<0) return [];
  if(solid(seed)) return [];
  // absorb SMALLEST-FIRST with a per-face gate and a cumulative cap: a room's
  // own fragments are pocket-scale and few; another room reached through a
  // leak is big — refuse it rather than blob, and refuse chain-creep too.
  // A NARROW face (wall-band width) is absorbed only when the region already
  // touches it on 2+ faces — an interior slot, not fringe along a wall.
  const seen=new Set([seed]);
  const cap = maxAbsorb!==undefined ? Math.max(maxAbsorb, 0.5*A.faces[seed].area) : Infinity;
  let absorbed=0;
  const frontier=new Set();
  const pushN=(f)=>{ for(const o of A.adj[f]){ if(!seen.has(o)) frontier.add(o); } };
  const contacts=(f)=>{ let c=0; for(const o of A.adj[f]) if(seen.has(o)) c++; return c; };
  pushN(seed);
  while(frontier.size){
    let best=-1,bestA=Infinity;
    for(const o of frontier){
      if(narrow && narrow(o) && contacts(o)<2) continue;   // fringe band: leave in frontier
      if(A.faces[o].area<bestA){bestA=A.faces[o].area;best=o;}
    }
    if(best<0) break;
    frontier.delete(best);
    if(seen.has(best)) continue;
    if(solid(best)) continue;
    // a DOORLESS cell is not another room — casework carved it off this one.
    // It bypasses the area gate (but never the solid test or the narrow rule).
    const dl = doorless && doorless(best);
    if(!dl && maxAbsorb!==undefined && bestA>maxAbsorb) continue;
    if(!dl && absorbed+bestA>cap) break;
    absorbed+=bestA;
    seen.add(best); pushN(best);
  }
  // FIXTURE POCKETS: a narrow face the main loop refused can be the only
  // path into a tub/counter pocket the estimator's GROSS ruler runs over.
  // Absorb the component beyond when it is SMALL and dead-ended (touches
  // only this region, solid, or more narrow faces) — a neighbouring ROOM
  // reached through an unclosed doorway is protected by the size cap.
  if(narrow && pocketMax){
    let changed=true;
    while(changed){
      changed=false;
      const boundary=new Set();
      for(const f of seen) for(const o of A.adj[f]) if(!seen.has(o)&&!solid(o)&&narrow(o)&&(!pocketFixtureOnly||(fixture&&fixture(o)))) boundary.add(o);
      for(const h of boundary){
        const comp=new Set([h]); const st=[...A.adj[h]].filter(o=>!seen.has(o)&&o!==h);
        let total=A.faces[h].area, ok=true, fat=false, hasFix=fixture?fixture(h):false;
        while(st.length&&ok){
          const f=st.pop();
          if(comp.has(f)||seen.has(f)) continue;
          if(solid(f)){ continue; }
          // fixture mode: the SYMBOL BOX is the pocket's natural boundary —
          // without it the flood escapes along rim strips into open floor.
          if(pocketFixtureOnly && !(fixture&&fixture(f))) continue;
          total+=A.faces[f].area;
          if(total>pocketMax){ ok=false; break; }
          if(!narrow(f)) fat=true;
          if(fixture&&fixture(f)) hasFix=true;
          comp.add(f);
          for(const o of A.adj[f]) if(!seen.has(o)&&!comp.has(o)) st.push(o);
        }
        // a POCKET holds something (the tub — a fat face); a chain of narrow
        // cavity slivers along the wall band is the band itself — refuse it,
        // or every room inflates by its own wall cavity. In fixtureOnly mode
        // (seeded sheets) the component must contain a SYMBOL-MARKED face.
        if(globalThis.POCKLOG){
          const F=A.faces[h];
          globalThis.POCKLOG.push(`pocket h[${F.x0.toFixed(0)},${F.y0.toFixed(0)}] ok=${ok} fat=${fat} hasFix=${hasFix} fixOnly=${pocketFixtureOnly} total=${total.toFixed(0)}`);
        }
        // (tiny ≤6 SF pockets on seeded sheets: measured CI 28→26 — band
        // cavities chain under the cap; wall-mounted panels stay a named miss)
        if(ok&&(fat||!pocketNeedFat)&&(!pocketFixtureOnly||hasFix)&&total<=pocketMax){
          for(const f of comp) seen.add(f);
          changed=true;
        }
      }
    }
  }
  // WINDOW BAYS: a hairline sliver (solid) on the room boundary with nothing
  // but a small dead-end space beyond is a bay mouth — the finish runs into
  // the bay. A hairline with another ROOM beyond stays a wall.
  if(bayThrough){
    const isHair=(f)=>{const F=A.faces[f];let per=0;
      for(let i=0;i<F.ring.length;i++){const p=F.ring[i],q=F.ring[(i+1)%F.ring.length];per+=Math.hypot(q[0]-p[0],q[1]-p[1]);}
      return per>0 && (2*F.area)/per < bayThrough.hairW;};
    {
      let roomA=0; for(const f of seen) roomA+=A.faces[f].area;
      let bayBudget=bayThrough.frac*roomA;
      const boundary=new Set();
      for(const f of seen) for(const o of A.adj[f]) if(!seen.has(o)&&isHair(o)) boundary.add(o);
      for(const h of boundary){
        if(bayBudget<=0) break;
        // component beyond the hairline
        const comp=new Set(); const st2=[...A.adj[h]].filter(o=>!seen.has(o)&&o!==h);
        let total=0, ok=true;
        while(st2.length && ok){
          const f=st2.pop();
          if(comp.has(f)||seen.has(f)) continue;
          if(isHair(f)){ comp.add(f); continue; }
          if(solid(f)){ ok=false; break; }
          total+=A.faces[f].area;
          if(total>bayThrough.maxArea){ ok=false; break; }
          comp.add(f);
          for(const o of A.adj[f]) if(!seen.has(o)&&!comp.has(o)) st2.push(o);
        }
        // window bays live at the building PERIMETER; an interior pocket
        // behind a hairline is a wall cavity, not a bay
        let perim=false;
        if(!A.hull){
          let hx0=Infinity,hy0=Infinity,hx1=-Infinity,hy1=-Infinity;
          for(const F of A.faces){hx0=Math.min(hx0,F.x0);hy0=Math.min(hy0,F.y0);hx1=Math.max(hx1,F.x1);hy1=Math.max(hy1,F.y1);}
          A.hull=[hx0,hy0,hx1,hy1];
        }
        for(const f of comp){
          const F=A.faces[f];
          const m=bayThrough.perimFt;
          if(F.voidEdge || F.x0-A.hull[0]<m || F.y0-A.hull[1]<m || A.hull[2]-F.x1<m || A.hull[3]-F.y1<m){perim=true;break;}
        }
        if(ok && comp.size && total<=bayBudget && perim){
          seen.add(h); for(const f of comp) seen.add(f);
          bayBudget-=total;
        }
      }
    }
  }
  return [...seen];
}

/** boundary of a face set: DIRECTED edges used exactly once, chained
 *  start-to-end (face rings share opposite directions on interior edges,
 *  so the border keeps one consistent orientation and closes). */
export function roomOutline(A,set){
  const cnt=new Map(); const geo=new Map();
  const reg=(r)=>{
    for(let i=0;i<r.length;i++){
      const a=r[i],b=r[(i+1)%r.length];
      const ka=Math.round(a[0])+','+Math.round(a[1]), kb=Math.round(b[0])+','+Math.round(b[1]);
      if(ka===kb) continue;
      const key=ka<kb?ka+'|'+kb:kb+'|'+ka;
      cnt.set(key,(cnt.get(key)||0)+1);
      geo.set(key,[a,b]);
    }
  };
  for(const fi of set){ const f=A.faces[fi]; reg(f.ring); for(const h of f.holes) reg(h); }
  const border=[...cnt.entries()].filter(([,c])=>c%2===1).map(([k])=>geo.get(k));
  // chain by endpoints
  const pk=(p)=>Math.round(p[0])+','+Math.round(p[1]);
  const byStart=new Map();
  border.forEach((e,i)=>{ const k=pk(e[0]); const l=byStart.get(k); if(l)l.push(i); else byStart.set(k,[i]); });
  const used=new Set(); const rings=[];
  for(let s=0;s<border.length;s++){
    if(used.has(s)) continue;
    const ring=[border[s][0]]; used.add(s);
    let prev=border[s][0], cur=border[s][1];
    for(let guard=0;guard<=border.length;guard++){
      ring.push(cur);
      const cands=(byStart.get(pk(cur))||[]).filter(i=>!used.has(i));
      if(!cands.length) break;
      // sharpest right turn keeps the walk on this region at pinch points
      const back=Math.atan2(prev[1]-cur[1], prev[0]-cur[0]);
      let bi=-1, bt=Infinity;
      for(const i of cands){
        const nx=border[i][1];
        let t=back-Math.atan2(nx[1]-cur[1], nx[0]-cur[0]);
        while(t<=1e-9) t+=Math.PI*2;
        while(t>Math.PI*2) t-=Math.PI*2;
        if(t<bt){bt=t;bi=i;}
      }
      used.add(bi);
      prev=cur; cur=border[bi][1];
      if(pk(cur)===pk(ring[0])) { break; }
    }
    if(ring.length>=3) rings.push(ring);
  }
  if(!rings.length) return {ring:[],holes:[]};
  const areaOf=(r)=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2;};
  rings.sort((a,b)=>areaOf(b)-areaOf(a));
  return {ring:rings[0], holes:rings.slice(1)};
}


// ── FIELD mode: the finish pattern states its own region ─────────────────────
// Direction-bucketed LONG hatch strokes form a family signature (tile grid =
// two orthogonal buckets); the region grows over faces whose ink matches,
// crosses DOOR CELLS only, and treats small ink-less faces as neutral
// pockets. Measured: safe on Park (11/13 held), POISON as a default click
// (Comfort Inn 23→4) — so it is a MODE the estimator picks for open plans
// (teller lines, lobbies), never the default.
function fieldIndex(net){
  if (net._field) return net._field;
  const {arr, hatchFlags, ftPx} = net; const segs = net.segsIn;
  const grid=new Map(); const HG=4*ftPx;
  const n=segs.length>>2;
  for(let i=0;i<n;i++){
    if(!hatchFlags[i]) continue;
    const x1=segs[i*4],y1=segs[i*4+1],x2=segs[i*4+2],y2=segs[i*4+3];
    const L=Math.hypot(x2-x1,y2-y1); if(L<1.5*ftPx) continue;
    let ang=Math.atan2(y2-y1,x2-x1)*180/Math.PI; if(ang<0)ang+=180; if(ang>=180)ang-=180;
    const bkt=Math.round(ang/15)%12; const mx=(x1+x2)/2, my=(y1+y2)/2;
    const k=Math.floor(mx/HG)+','+Math.floor(my/HG); const b=grid.get(k); if(b)b.push(mx,my,bkt); else grid.set(k,[mx,my,bkt]);
  }
  const famMemo=new Map();
  const inkFam=(fi)=>{ let v=famMemo.get(fi); if(v!==undefined) return v;
    const F=arr.faces[fi]; const h=new Array(12).fill(0); let tot=0;
    for(let gx=Math.floor(F.x0/HG);gx<=Math.floor(F.x1/HG);gx++) for(let gy=Math.floor(F.y0/HG);gy<=Math.floor(F.y1/HG);gy++){
      const b=grid.get(gx+','+gy); if(!b) continue;
      for(let i=0;i<b.length;i+=3){ if(b[i]<F.x0||b[i]>F.x1||b[i+1]<F.y0||b[i+1]>F.y1) continue; if(pointInRing(F.ring,b[i],b[i+1])){h[b[i+2]]++;tot++;} } }
    v={h,tot}; famMemo.set(fi,v); return v; };
  const inDoorCell=(fi)=>{ const F=arr.faces[fi]; const px=(F.x0+F.x1)/2,py=(F.y0+F.y1)/2; for(const q of net.doorCellPolys){ if(pointInRing(q,px,py)) return true; } return false; };
  net._field={inkFam,inDoorCell}; return net._field;
}
export function netFieldAt(net, x, y, ftPx){
  const {arr, solid} = net; const {inkFam,inDoorCell}=fieldIndex(net);
  let seedF=faceAt(arr,x,y,solid); if(seedF<0) return null;
  const {h,tot}=inkFam(seedF); if(tot<4) return null;             // no coherent field under the click
  const order=h.map((c,b)=>[c,b]).sort((a,b)=>b[0]-a[0]); const fam=[]; let cov=0;
  for(const [c,b] of order){ if(cov/tot>=0.7||c===0) break; fam.push(b); cov+=c; }
  if(!fam.length||fam.length>3) return null;
  const famMatch=(fi)=>{ const {h,tot}=inkFam(fi); if(!tot) return false; let s=0; for(const b of fam) s+=h[b]; return s/tot>=0.6; };
  const NEUTRAL=12*ftPx*ftPx;
  const open2=(o)=>famMatch(o)||(inkFam(o).tot===0&&arr.faces[o].area<=NEUTRAL);
  const set=new Set([seedF]); const st=[seedF];
  while(st.length){ const f=st.pop();
    for(const o of arr.adj[f]){ if(set.has(o)) continue;
      if(solid(o)){ if(!inDoorCell(o)) continue; let bey=false; for(const o2 of arr.adj[o]){ if(o2!==f&&!set.has(o2)&&!solid(o2)&&open2(o2)){bey=true;break;} } if(!bey) continue; set.add(o); st.push(o); continue; }
      if(!open2(o)) continue; set.add(o); st.push(o); } }
  const out=roomOutline(arr,[...set]); if(out.ring.length<3) return null;
  const shoe=(r)=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2;};
  let area=shoe(out.ring); const holes=[]; for(const hh of out.holes){ const hA=shoe(hh); if(hA>=OPTS.HOLESF*ftPx*ftPx){ area-=hA; holes.push(hh); } }
  // a finish edge is a straight line the drafter drew — the arrangement ring
  // notches at every tile grout crossing; merge collinear and drop sub-1 ft
  // jogs (the ruler runs along the tile edge, not each grout joint)
  const ring=simplifyRing(out.ring, 0.15*ftPx, 1.0*ftPx, ftPx, null);
  return { ring, holes, areaPx: area, faces: set.size, seedFace: seedF, starved: !!net.starved, field: true };
}

// ── the click API ───────────────────────────────────────────────────────────
/** Build the net for a sheet once (seconds on a dense sheet); cache per sheet. */
export function buildNet(g, ftPx, texts){
  return build(g, ftPx, texts || []);
}

/** Room at (x,y) image px. Returns null when the click lands in wall
 *  material or no enclosed face exists. ring/holes in image px. */
export function netRoomAt(net, x, y, ftPx){
  const {arr, solid, narrowFace, fixtureFace, starved} = net;
  let fi = faceAt(arr, x, y, solid);
  // a click on a fixture pocket: nudge to the largest open face within 3 ft
  if (fi < 0 || arr.faces[fi].area < 12*ftPx*ftPx) {
    let best = fi, bestA = fi >= 0 ? arr.faces[fi].area : -1;
    for (const dx of [-3,-1.5,0,1.5,3]) for (const dy of [-3,-1.5,0,1.5,3]) {
      const f2 = faceAt(arr, x+dx*ftPx, y+dy*ftPx, solid);
      if (f2 >= 0 && arr.faces[f2].area > bestA) { bestA = arr.faces[f2].area; best = f2; }
    }
    fi = best;
  }
  if (fi < 0) return null;
  // a label box / tag / fixture pocket is not a room — refuse rather than
  // propose a 2 SF ring around "WB-01"
  if (arr.faces[fi].area < 8*ftPx*ftPx) return null;
  // ...and the SHEET is not a room either: a click outside the building lands
  // in the face bounded by the drawing border. Refuse a face that spans most
  // of the whole arrangement in both directions.
  {
    if (!arr.hull) { let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; for (const F of arr.faces) { x0=Math.min(x0,F.x0); y0=Math.min(y0,F.y0); x1=Math.max(x1,F.x1); y1=Math.max(y1,F.y1); } arr.hull=[x0,y0,x1,y1]; }
    const F=arr.faces[fi], H=arr.hull;
    if ((F.x1-F.x0) > 0.6*(H[2]-H[0]) && (F.y1-F.y0) > 0.6*(H[3]-H[1])) return null;
  }
  const GATE = Math.max(Math.min(OPTS.GATESF*ftPx*ftPx, 0.5*arr.faces[fi].area), 6*ftPx*ftPx);
  const POCKET = OPTS.POCKETSF*ftPx*ftPx;
  const set = growRoom(arr, fi, solid, GATE, undefined, narrowFace, null, POCKET||undefined, false, fixtureFace, !starved);
  if (!set.length) return null;
  const out = roomOutline(arr, set);
  if (out.ring.length < 3) return null;
  const shoe=(r)=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2;};
  let area = shoe(out.ring);
  const holes = [];
  for (const h of out.holes) { const hA = shoe(h); if (hA >= OPTS.HOLESF*ftPx*ftPx) { area -= hA; holes.push(h); } }
  // The arrangement rings carry a vertex at EVERY noded intersection along a
  // straight wall and every hairline jog where the band was refused — a
  // 60-handle ring for a 4-corner room. Simplify to what an estimator draws:
  // merge collinear runs (0.12 ft lateral) and drop notches shallower than
  // 0.4 ft (jamb pockets, band cavities) that his ruler runs straight past.
  const doorPolys = net.doorCellPolys || [];
  const doorAt = (x,y,r)=>{ for(const q of doorPolys){ for(const p of q){ if(Math.hypot(p[0]-x,p[1]-y)<=r) return true; } let cx=0,cy=0; for(const p of q){cx+=p[0];cy+=p[1];} if(Math.hypot(cx/q.length-x,cy/q.length-y)<=r) return true; } return false; };
  const ring = simplifyRing(out.ring, 0.12*ftPx, 0.4*ftPx, ftPx, doorAt);
  return { ring, holes, areaPx: area, faces: set.length, seedFace: fi, starved };
}

function simplifyRing(ring, colTol, notchTol, ftPx_, doorAt){
  if (ring.length < 4) return ring;
  let pts = ring.slice();
  // 1. RDP-style collinear merge on the closed ring
  const rdp = (arr) => {
    const n = arr.length; if (n < 4) return arr;
    const keep = new Array(n).fill(false);
    // seed with the two farthest-apart points so the closed ring has anchors
    let a0=0,a1=0,best=-1;
    for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){ const d=Math.hypot(arr[i][0]-arr[j][0],arr[i][1]-arr[j][1]); if(d>best){best=d;a0=i;a1=j;} }
    keep[a0]=keep[a1]=true;
    const rec=(i0,i1)=>{ // indices along the ring from i0 to i1 (wrapping)
      const span=(i1-i0+n)%n; if(span<2) return;
      const A=arr[i0],B=arr[i1]; const dx=B[0]-A[0],dy=B[1]-A[1]; const L=Math.hypot(dx,dy)||1;
      let mi=-1,md=-1;
      for(let k=1;k<span;k++){ const i=(i0+k)%n; const P=arr[i];
        const d=Math.abs((P[0]-A[0])*dy-(P[1]-A[1])*dx)/L; if(d>md){md=d;mi=i;} }
      if(md>colTol){ keep[mi]=true; rec(i0,mi); rec(mi,i1); }
    };
    rec(a0,a1); rec(a1,a0);
    return arr.filter((_,i)=>keep[i]);
  };
  pts = rdp(pts);
  // 2. notch removal: a vertex pair (i, i+1) forming a short jog whose both
  //    legs return within notchTol of the line through its neighbours
  let changed=true, guard=0;
  while(changed && guard++<8 && pts.length>4){
    changed=false;
    const n=pts.length;
    for(let i=0;i<n && pts.length>4;i++){
      const P=pts[(i-1+n)%n], A=pts[i], B=pts[(i+1)%n], Q=pts[(i+2)%n];
      const dx=Q[0]-P[0], dy=Q[1]-P[1], L=Math.hypot(dx,dy)||1;
      const dA=Math.abs((A[0]-P[0])*dy-(A[1]-P[1])*dx)/L;
      const dB=Math.abs((B[0]-P[0])*dy-(B[1]-P[1])*dx)/L;
      const jog=Math.hypot(B[0]-A[0],B[1]-A[1]);
      // a hairline jog (band cavity) OR a door-scale jamb pocket — wall-deep
      // (≤0.65 ft) and door-wide (≤4.5 ft) — both flatten: the ruler runs
      // across the opening at the wall face
      const deep=Math.max(dA,dB);
      // a DOOR pocket flattens at any wall depth (≤1.3 ft) when a detected
      // door cell sits in the notch — a thick corner wall's jamb recess
      // (Breakroom) is deeper than a blind 0.65 ft; an alcove with no door
      // keeps its notch, the ruler follows it
      // flattening joins P→Q, so P and Q must be COLLINEAR with the wall
      // run (same depth both sides, and P→Q parallel to the edge before P) —
      // at a corner recess the join would be a diagonal across the room
      const Pp=pts[(i-2+n)%n];
      const eL=Math.hypot(P[0]-Pp[0],P[1]-Pp[1])||1;
      const cosPQ=Math.abs(((P[0]-Pp[0])*dx+(P[1]-Pp[1])*dy)/(eL*L));
      const collinear = Math.abs(dA-dB)<=0.12*ftPx_ && cosPQ>=0.996;
      let doorNotch=false;
      if(doorAt && collinear && deep<=1.3*ftPx_ && jog<=5*ftPx_){ const mx=(A[0]+B[0])/2, my=(A[1]+B[1])/2; doorNotch=doorAt(mx,my,1.2*ftPx_); }
      if((dA<=notchTol && dB<=notchTol && jog<=2*notchTol) || (collinear && deep<=0.65*ftPx_ && jog<=4.5*ftPx_) || doorNotch){
        pts.splice(i, 2); changed=true; break;
      }
    }
  }
  return pts.length>=3 ? pts : ring;
}
