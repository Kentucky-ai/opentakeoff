import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../brand/icons.jsx';
import { ANNOTATION_DEFAULTS, ANNOTATION_PRESETS, annotationStyle, annotationScene, pathString, box, bounds, intersects, markupBounds, shiftedMarkup, textMatches } from '../lib/annotationTools.js';
import './AnnotationWorkbench.css';

const supported = m => !m.reference_only && ['arrow','highlight','callout','cloud','text'].includes(m.type);
const colors = ['#dc3d43','#2563eb','#249268','#8b5cf6','#172033','#ffd60a','#ff9f0a'];
const tools = [['arrow','Arrow','arrow'],['highlighter','Highlighter','highlighter'],['callout','Callout','callout'],['cloud','Cloud + note','cloud'],['sweep','Sweep','symbol'],['selection','Select markups','select']];
const ArrowIcon = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 19 19 5M9 5h10v10"/></svg>;
const toolIcon = name => name === 'arrow' ? <ArrowIcon/> : name === 'symbol' ? <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"/><circle cx="9" cy="9" r="1.5"/><circle cx="15" cy="9" r="1.5"/><circle cx="9" cy="15" r="1.5"/><circle cx="15" cy="15" r="1.5"/></svg> : <Icon name={name} size={17}/>;
const norm = (q,p) => [(q[0]-p.xOffset)/p.img.w,q[1]/p.img.h];
const local = (q,p) => [q[0]-p.xOffset,q[1]];
const stagePoint = (q,p) => [q[0]*p.img.w+p.xOffset,q[1]*p.img.h];
const id = () => `mk_${crypto.randomUUID()}`;
const distance = (p,a,b) => { const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1))); return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy); };

export function AnnotationInk({ markup, panel, selected=false, zoom=1 }) {
  const scene = annotationScene(markup,panel.img.w,panel.img.h);
  return <g data-annotation-id={markup.id}>
    {scene.paths.map((p,i)=><path key={i} d={pathString(p.commands)} fill={p.fill||'none'} stroke={p.stroke||'none'} strokeWidth={p.stroke?Math.max(p.width,1.2/zoom):p.width} opacity={p.opacity} strokeDasharray={p.dash?.join(' ')} strokeLinecap="round" strokeLinejoin="round" style={p.blend ? {mixBlendMode:p.blend} : undefined}/>)}
    {scene.texts.map((t,i)=><text key={i} x={t.x} y={t.y} fill={t.color} fontSize={t.size} fontFamily="Arial, sans-serif">{t.text}</text>)}
    {selected && <SelectedHandles markup={markup} panel={panel} zoom={zoom}/>}
  </g>;
}
function handles(m,p) {
  const out=[];
  for (const k of ['from','to','target','at','note_at']) if(m[k]) out.push({key:k,point:stagePoint(m[k],p)});
  if(m.type==='cloud'&&m.text&&!m.note_at&&m.rect){const r=box(...m.rect);out.push({key:'note_at',point:stagePoint([r[0][0],r[1][1]+24/p.img.h],p)});}
  if(m.rect) m.rect.forEach((q,i)=>out.push({key:`rect${i}`,point:stagePoint(q,p)}));
  if(m.annotation_style&&['callout','cloud','text'].includes(m.type)){
    const origin=annotationScene(m,p.img.w,p.img.h).noteBox?.[0];
    if(origin){const key=m.type==='cloud'?'note_at':'at',h=out.find(v=>v.key===key);if(h)h.point=[origin[0]+p.xOffset,origin[1]];}
  }
  return out;
}
function SelectedHandles({markup:m,panel:p,zoom:z}) {
  return <g>{handles(m,{...p,xOffset:0}).map(h=><circle key={h.key} cx={h.point[0]} cy={h.point[1]} r={5/z} fill="#fff" stroke="#2563eb" strokeWidth={1.5/z}/>)}</g>;
}
function paint(group,m,p) {
  if(!group)return;
  group.replaceChildren();
  if(!m||!p)return;
  group.setAttribute('transform',`translate(${p.xOffset},0)`);
  const scene=annotationScene(m,p.img.w,p.img.h);
  for(const path of scene.paths){
    const el=document.createElementNS('http://www.w3.org/2000/svg','path');
    const attrs={d:pathString(path.commands),fill:path.fill||'none',stroke:path.stroke||'none','stroke-width':path.width,opacity:path.opacity,'stroke-linecap':'round','stroke-linejoin':'round'};
    for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));
    if(path.dash)el.setAttribute('stroke-dasharray',path.dash.join(' '));
    if(path.blend)el.style.mixBlendMode=path.blend;
    group.append(el);
  }
  for(const t of scene.texts){const el=document.createElementNS('http://www.w3.org/2000/svg','text');el.textContent=t.text;for(const [k,v] of Object.entries({x:t.x,y:t.y,fill:t.color,'font-size':t.size,'font-family':'Arial, sans-serif'}))el.setAttribute(k,String(v));group.append(el);}
}

export function useAnnotationWorkbench(options) {
  const current=useRef(options);current.current=options;
  const [mode,setMode]=useState('arrow'), [selected,setSelected]=useState([]), [review,setReview]=useState(null), [editor,setEditor]=useState(null), [busy,setBusy]=useState(false);
  const [sweepKind,setSweepKind]=useState('symbols'), [presetOpen,setPresetOpen]=useState(false), [presetName,setPresetName]=useState('');
  const [saved]=useState(()=>{try {return JSON.parse(localStorage.getItem(options.storageKey)||'null')||{};}catch{return {};}});
  const [styles,setStyles]=useState(()=>saved.styles||{});
  const [presets,setPresets]=useState(()=>Array.isArray(saved.presets)?saved.presets.slice(0,50):ANNOTATION_PRESETS);
  const gesture=useRef(null),anchor=useRef(null),preview=useRef(null),request=useRef(0),frame=useRef(0);
  const active=options.tool==='annotation', style=annotationStyle(styles[mode]||{...ANNOTATION_DEFAULTS,...(mode==='highlighter'?{color:'#ffd60a'}:{})});
  const state=useRef(null);state.current={mode,selected,review,editor,style,sweepKind,active};
  const signature=options.panels.map(p=>p.key).join('|');
  const clear=()=>{gesture.current=null;anchor.current=null;cancelAnimationFrame(frame.current);paint(preview.current);};
  useEffect(()=>{clear();setReview(null);setEditor(null);setSelected([]);request.current++;setBusy(false);},[signature]);
  useEffect(()=>{if(!active){clear();request.current++;setBusy(false);}},[active]);
  useEffect(()=>{try{localStorage.setItem(options.storageKey,JSON.stringify({styles,presets}));}catch{options.message('Tool favorites could not be saved in this browser.');}},[styles,presets,options.storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>()=>{cancelAnimationFrame(frame.current);request.current++;},[]);
  // Reflect selections made in the existing markup list without losing multi-select.
  useEffect(()=>{if(!options.selectedId)setSelected([]);else if(!state.current.selected.includes(options.selectedId))setSelected([options.selectedId]);},[options.selectedId]);
  useEffect(()=>{
    const key=e=>{
      if(e.target?.closest?.('input,textarea,select,[contenteditable="true"]'))return;
      const st=state.current,o=current.current;
      if(e.key==='Escape' && (st.active||st.editor||st.review||gesture.current||anchor.current)){e.preventDefault();e.stopImmediatePropagation();clear();setEditor(null);setReview(null);request.current++;setBusy(false);o.setTool('select');return;}
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&(gesture.current||anchor.current)){e.preventDefault();e.stopImmediatePropagation();clear();return;}
      if((e.key==='Delete'||e.key==='Backspace')&&st.selected.length&&o.tool==='select'){
        const ids=new Set(st.selected);e.preventDefault();e.stopImmediatePropagation();o.commit(o.markups.filter(m=>!ids.has(m.id)));setSelected([]);o.setSelectedId(null);
      }
    };
    window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);
  },[]);
  const arm=(next)=>{clear();options.resetDraft?.();setReview(null);setEditor(null);setSelected([]);options.setSelectedId(null);setMode(next);options.setTool('annotation');request.current++;setBusy(false);};
  const commitNew=rows=>{
    const o=current.current,now=new Date().toISOString();
    const made=rows.map(m=>({...m,id:id(),created_at:now,updated_at:now,condition_id:'',rfi_id:''}));
    o.commit([...o.markups,...made]);setSelected(made.map(m=>m.id));o.setSelectedId(made[0]?.id||null);return made;
  };
  const commitEdit=rows=>{const o=current.current,by=new Map(rows.map(m=>[m.id,{...m,updated_at:new Date().toISOString()}]));o.commit(o.markups.map(m=>by.get(m.id)||m));};
  useEffect(()=>{const next=options.legacyTools?.[options.tool];if(next)arm(next);},[options.tool]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedRows=options.markups.filter(m=>selected.includes(m.id)&&supported(m));
  const setStyle=patch=>{
    const next=annotationStyle({...style,...patch});setStyles(s=>({...s,[mode]:next}));
    if(selectedRows.length && !active)commitEdit(selectedRows.map(m=>({...m,...(patch.width_pt&&m.pts?{w:patch.width_pt*2/(options.panels.find(p=>p.key===m.sheet_id)?.img.w||2000)}:{}),color:patch.color||m.color,annotation_style:annotationStyle({...style,...m.annotation_style,...patch})})));
  };
  const panelFor=q=>current.current.panels.find(p=>q[0]>=p.xOffset&&q[0]<=p.xOffset+p.img.w&&q[1]>=0&&q[1]<=p.img.h);
  const draft=(a,b,p,which=state.current.mode)=>{
    const s=state.current.style,base={sheet_id:p.key,color:s.color,annotation_style:s};
    const na=norm(a,p),nb=norm(b,p);
    if(which==='arrow')return {...base,type:'arrow',from:nb,to:na};
    if(which==='callout')return {...base,type:'callout',target:na,at:nb,text:'Note'};
    if(which==='highlighter')return {...base,type:'highlight',pts:[na,nb],w:s.width_pt*2/p.img.w};
    return {...base,type:'cloud',rect:box(na,nb),text:''};
  };
  async function runRegion(a,b,p) {
    const st=state.current,o=current.current,token=++request.current,region=box(local(a,p),local(b,p));
    if(st.mode==='selection'){
      const r=box(norm(a,p),norm(b,p)),found=o.markups.filter(m=>supported(m)&&m.sheet_id===p.key&&markupBounds(m)&&intersects(markupBounds(m),r));
      setSelected(found.map(m=>m.id));o.setSelectedId(found[0]?.id||null);o.setTool('select');o.message(`${found.length} editable markup${found.length===1?'':'s'} selected.`);return;
    }
    setBusy(true);
    try{
      if(st.mode==='highlighter'){
        const runs=await o.readText(p.key);if(token!==request.current)return;
        const chosen=runs.filter(r=>intersects(r.rect,region));
        if(!chosen.length){o.message('No selectable PDF text in that region. Use Freehand or Straight for scanned content.');return;}
        const quads=chosen.map(r=>r.quad.map(q=>[q[0]/p.img.w,q[1]/p.img.h]));
        commitNew([{...draft(a,b,p),pts:undefined,quads,rect:bounds(quads.flat()),text:chosen.map(r=>r.text).join(' ')}]);
        o.message(`Highlighted ${chosen.length} PDF text run${chosen.length===1?'':'s'}.`);return;
      }
      let rows=[],warning='';
      if(st.sweepKind==='text'){
        const runs=await o.readText(p.key);if(token!==request.current)return;
        rows=textMatches(runs,region).map(r=>({rect:r.rect,text:r.text,checked:true}));
        if(!rows.length){o.message('No matching native PDF text. Sweep over a text label; scanned text needs OCR.');return;}
      }else{
        const res=await o.findSymbols(p.key,region);if(token!==request.current)return;
        const r=box(...(res.seed.rect||region)),w=r[1][0]-r[0][0],h=r[1][1]-r[0][1];
        const candidates=[{at:res.seed.center,rotation:0,seed:true},...res.matches,...res.withheld.map(m=>({...m,held:true}))];
        for(const m of candidates){
          if(rows.some(row=>Math.hypot(row.center[0]-m.at[0],row.center[1]-m.at[1])<Math.max(3,Math.min(w,h)/4)))continue;
          const angle=(m.rotation||0)*Math.PI/180,rw=Math.abs(Math.cos(angle))*w+Math.abs(Math.sin(angle))*h,rh=Math.abs(Math.sin(angle))*w+Math.abs(Math.cos(angle))*h;
          rows.push({center:m.at,rect:[[m.at[0]-rw/2,m.at[1]-rh/2],[m.at[0]+rw/2,m.at[1]+rh/2]],checked:!m.held,held:!!m.held,text:m.seed?'Seed symbol':m.held?'Near match — review':'Matched symbol'});
        }
        warning=(res.complete===false||res.candidates?.dropped>0)?`${res.candidates?.dropped||0} candidates were not scored. This is a partial search.`:'';
      }
      setReview({key:p.key,rows,warning,text:'',kind:'cloud'});o.message(`${rows.length} results — review and choose which to annotate.`);
    }catch(e){o.message(e.message||String(e));}finally{if(token===request.current)setBusy(false);}
  }
  const finish=(a,b,p)=>{
    const st=state.current;
    if(['sweep','selection'].includes(st.mode)||(st.mode==='highlighter'&&st.style.mode==='text')){void runRegion(a,b,p);return;}
    let m=draft(a,b,p);
    if(m.type==='cloud')m={...m,note_at:[m.rect[0][0],Math.min(.95,m.rect[1][1]+24/p.img.h)]};
    if(st.mode==='callout'||st.mode==='cloud'){setEditor({markup:{...m,text:''},text:'',fresh:true});paint(preview.current,m,p);return;}
    commitNew([m]);
  };
  const hit=(q,m,p)=>{
    const pt=local(q,p),radius=8/current.current.tf.current.scale,scene=m.annotation_style?annotationScene(m,p.img.w,p.img.h):null;
    if(scene?.noteBox&&intersects(scene.noteBox,box(pt,pt)))return true;
    if(m.from&&m.to)return distance(pt,local(stagePoint(m.from,p),p),local(stagePoint(m.to,p),p))<=radius;
    if(m.pts?.length>1)return m.pts.slice(1).some((v,i)=>distance(pt,local(stagePoint(m.pts[i],p),p),local(stagePoint(v,p),p))<=Math.max(radius,(m.w||.01)*p.img.w/2));
    const r=markupBounds(m);return !!r&&intersects(r,box(norm(q,p),norm(q,p)));
  };
  const toggleReview=index=>setReview(v=>({...v,rows:v.rows.map((row,j)=>j===index?{...row,checked:!row.checked}:row)}));
  const stop=e=>{e.preventDefault();e.stopPropagation();};
  const onDown=e=>{
    const o=current.current,st=state.current;
    if(e.button!==0||o.spaceRef.current||!o.ready||o.visible===false||st.editor||st.review||busy)return;
    const q=o.toImage(e.clientX,e.clientY),p=panelFor(q);if(!p)return;
    if(o.tool==='select'){
      for(const m of o.markups.filter(m=>st.selected.includes(m.id)&&supported(m)&&m.sheet_id===p.key)){
        const h=handles(m,p).find(h=>Math.hypot(h.point[0]-q[0],h.point[1]-q[1])<9/o.tf.current.scale);
        if(h){stop(e);gesture.current={kind:'handle',original:m,live:m,handle:h.key,p,start:q};e.currentTarget.setPointerCapture(e.pointerId);return;}
      }
      const m=[...o.markups].reverse().find(m=>supported(m)&&m.sheet_id===p.key&&hit(q,m,p));
      if(!m){setSelected([]);return;}
      stop(e);const ids=e.shiftKey?(st.selected.includes(m.id)?st.selected.filter(x=>x!==m.id):[...st.selected,m.id]):(st.selected.includes(m.id)?st.selected:[m.id]);
      setSelected(ids);o.setSelectedId(ids[0]||null);
      if(!e.shiftKey){gesture.current={kind:'move',original:m,live:m,rows:o.markups.filter(m=>ids.includes(m.id)),p,start:q};e.currentTarget.setPointerCapture(e.pointerId);}
      return;
    }
    if(!st.active)return;
    stop(e);if(anchor.current&&anchor.current.p.key!==p.key){clear();o.message('Keep both points on the same sheet.');return;}if(st.mode==='highlighter'&&st.style.mode==='freehand')gesture.current={kind:'ink',p,start:q,points:[q]};
    else gesture.current={kind:'draw',p,start:anchor.current?.point||q,second:!!anchor.current,down:q};
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove=e=>{
    const o=current.current,g=gesture.current,a=anchor.current,st=state.current;
    if(!g&&!a){if(st.active)stop(e);return;}
    stop(e);let q=o.toImage(e.clientX,e.clientY),p=g?.p||a.p;
    q=[Math.max(p.xOffset,Math.min(p.xOffset+p.img.w,q[0])),Math.max(0,Math.min(p.img.h,q[1]))];
    if(e.shiftKey&&(st.mode==='arrow'||st.mode==='highlighter')&&(g?.kind==='draw'||a)){
      const base=g?.start||a.point,angle=Math.round(Math.atan2(q[1]-base[1],q[0]-base[0])/(Math.PI/4))*Math.PI/4,len=Math.hypot(q[0]-base[0],q[1]-base[1]);q=[base[0]+Math.cos(angle)*len,base[1]+Math.sin(angle)*len];
    }
    let m;
    if(g?.kind==='ink'){if(Math.hypot(q[0]-g.points.at(-1)[0],q[1]-g.points.at(-1)[1])*o.tf.current.scale>1)g.points.push(q);m={...draft(g.start,q,p),pts:g.points.map(v=>norm(v,p))};}
    else if(g?.kind==='handle'){
      const n=norm(q,p);m={...g.original};if(g.handle.startsWith('rect')){m.rect=g.original.rect.map(v=>[...v]);m.rect[+g.handle.slice(4)]=n;}else m[g.handle]=n;g.live=m;
    }else if(g?.kind==='move'){m=shiftedMarkup(g.original,(q[0]-g.start[0])/p.img.w,(q[1]-g.start[1])/p.img.h);g.delta=[(q[0]-g.start[0])/p.img.w,(q[1]-g.start[1])/p.img.h];g.live=m;}
    else m=draft(g?.start||a.point,q,p,['sweep','selection'].includes(st.mode)||(st.mode==='highlighter'&&st.style.mode==='text')?'cloud':st.mode);
    if(g)g.end=q;
    cancelAnimationFrame(frame.current);frame.current=requestAnimationFrame(()=>paint(preview.current,m,p));
  };
  const onUp=e=>{
    const g=gesture.current;if(!g)return;stop(e);gesture.current=null;cancelAnimationFrame(frame.current);paint(preview.current);
    const o=current.current,p=g.p,q=g.end||o.toImage(e.clientX,e.clientY),travel=Math.hypot(q[0]-g.start[0],q[1]-g.start[1])*o.tf.current.scale;
    if(g.kind==='move'){if(g.delta&&travel>3)commitEdit(g.rows.map(m=>shiftedMarkup(m,...g.delta)));return;}
    if(g.kind==='handle'){if(g.end&&travel>1)commitEdit([g.live]);return;}
    if(g.kind==='ink'){if(g.points.length>1)commitNew([{...draft(g.start,q,p),pts:g.points.map(v=>norm(v,p))}]);return;}
    if(!panelFor(q)||panelFor(q).key!==p.key){anchor.current=null;o.message('Keep both corners on the same sheet.');return;}
    if(travel>4){anchor.current=null;finish(g.start,q,p);}else if(g.second){anchor.current=null;}else anchor.current={point:g.start,p};
  };
  const onDouble=e=>{
    const o=current.current;if(o.tool!=='select')return;const q=o.toImage(e.clientX,e.clientY),p=panelFor(q);if(!p)return;
    const m=[...o.markups].reverse().find(m=>supported(m)&&['callout','cloud','text'].includes(m.type)&&m.sheet_id===p.key&&hit(q,m,p));
    if(m){stop(e);clear();setEditor({markup:m,text:m.text||'',fresh:false});}
  };
  const applyNote=()=>{if(!editor)return;const m={...editor.markup,text:editor.text.trim(),annotation_style:editor.markup.annotation_style||style};if(m.type==='callout'&&!m.text)return;editor.fresh?commitNew([m]):commitEdit([m]);setEditor(null);paint(preview.current);};
  const applyReview=()=>{
    const p=options.panels.find(p=>p.key===review.key);if(!p)return;
    const chosen=review.rows.filter(r=>r.checked),pad=5*2;
    const made=chosen.map(r=>{const a=[Math.max(0,r.rect[0][0]-pad),Math.max(0,r.rect[0][1]-pad)],b=[Math.min(p.img.w,r.rect[1][0]+pad),Math.min(p.img.h,r.rect[1][1]+pad)];
      const base={sheet_id:p.key,color:style.color,annotation_style:style,text:review.text.trim(),source_region:[a.map((x,i)=>x/(i?p.img.h:p.img.w)),b.map((x,i)=>x/(i?p.img.h:p.img.w))]};
      return review.kind==='cloud'?{...base,type:'cloud',rect:base.source_region}:{...base,type:'callout',target:[(a[0]+b[0])/2/p.img.w,(a[1]+b[1])/2/p.img.h],at:[Math.min(.8,(b[0]+20)/p.img.w),Math.max(0,a[1]/p.img.h)]};});
    if(!made.length)return;commitNew(made);setReview(null);options.setTool('select');options.message(`Added ${made.length} ${review.kind==='cloud'?'clouds':'notes'} — undo removes the whole batch.`);
  };
  const shownStyle=!active&&selectedRows.length?annotationStyle({...style,...selectedRows[0].annotation_style,color:selectedRows[0].color||style.color}):style;
  const controls=(active||selectedRows.length>0)&&!editor&&!review;
  const toolbar=<div className="annotation-workbench" onKeyDown={e=>e.stopPropagation()}>
    <div className="annotation-tool-row" role="toolbar" aria-label="Annotation tools">
      <span className="annotation-caption">Annotate</span>
      {tools.map(([key,label,icon])=><button key={key} type="button" aria-pressed={active&&mode===key} disabled={!options.ready} onClick={()=>arm(key)} title={key==='selection'?'Sweep a box to select editable markups; Shift-click adds individual marks':label}>{toolIcon(icon)}<span>{label}</span></button>)}
      <span className="annotation-divider"/>
      <button type="button" aria-expanded={presetOpen} onClick={()=>setPresetOpen(v=>!v)}><Icon name="stamp" size={17}/>Favorites</button>
      {selectedRows.length>0&&!active&&<span className="annotation-count">{selectedRows.length} selected</span>}
      {busy&&<span role="status" className="annotation-hint">Reading this sheet…</span>}
    </div>
    {presetOpen&&<div className="annotation-favorites">
      {presets.map(p=><button key={p.id} onClick={()=>{arm(p.tool);setStyles(s=>({...s,[p.tool]:annotationStyle(p.style)}));setPresetOpen(false);}}><i style={{background:annotationStyle(p.style).color}}/>{p.name}</button>)}
      <input aria-label="Favorite name" placeholder="Name this style" maxLength={40} value={presetName} onChange={e=>setPresetName(e.target.value)}/>
      <button disabled={!presetName.trim()||presets.length>=50} onClick={()=>{setPresets(ps=>[...ps,{id:id(),name:presetName.trim(),tool:mode,style:shownStyle}]);setPresetName('');}}>Save favorite</button>
    </div>}
    {controls&&<div className="annotation-properties" aria-label="Annotation properties">
      <div className="annotation-swatches">{colors.map(c=><button key={c} aria-label={`Ink ${c}`} aria-pressed={shownStyle.color===c} style={{'--swatch':c}} onClick={()=>setStyle({color:c})}/>)}</div>
      <label>Weight<select aria-label="Annotation line weight" value={shownStyle.stroke_pt} onChange={e=>setStyle({stroke_pt:+e.target.value})}>{[.5,1,1.5,2,3,4,6].map(v=><option key={v} value={v}>{v} pt</option>)}</select></label>
      <label>Line<select aria-label="Annotation line style" value={shownStyle.line_style} onChange={e=>setStyle({line_style:e.target.value})}>{['solid','dashed','dotted'].map(v=><option key={v}>{v}</option>)}</select></label>
      {(mode==='arrow'||mode==='callout'||selectedRows.some(m=>m.type==='arrow'||m.type==='callout'))&&<><label>Head<select aria-label="Arrowhead" value={shownStyle.head} onChange={e=>setStyle({head:e.target.value})}>{['filled','open','none'].map(v=><option key={v}>{v}</option>)}</select></label><label><input type="checkbox" checked={shownStyle.both} onChange={e=>setStyle({both:e.target.checked})}/>Both ends</label></>}
      {(mode==='highlighter'||selectedRows.some(m=>m.type==='highlight'))&&<><div className="annotation-segments">{['freehand','straight','text'].map(v=><button key={v} aria-pressed={shownStyle.mode===v} onClick={()=>{clear();setStyle({mode:v});}}>{v}</button>)}</div><label>Width<select aria-label="Marker width" value={shownStyle.width_pt} onChange={e=>setStyle({width_pt:+e.target.value})}>{[4,6,10,16,24,40].map(v=><option key={v} value={v}>{v} pt</option>)}</select></label><label>Opacity<input aria-label="Highlight opacity" type="range" min=".1" max=".75" step=".05" value={shownStyle.opacity} onChange={e=>setStyle({opacity:+e.target.value})}/></label></>}
      {(mode==='callout'||mode==='cloud'||selectedRows.some(m=>['cloud','callout','text'].includes(m.type)))&&<label>Text<select aria-label="Note text size" value={shownStyle.font_pt} onChange={e=>setStyle({font_pt:+e.target.value})}>{[6,8,10,12,16,20,24].map(v=><option key={v} value={v}>{v} pt</option>)}</select></label>}
      {mode==='sweep'&&active&&<div className="annotation-segments">{[['symbols','Drawn symbols'],['text','PDF text']].map(([v,label])=><button key={v} aria-pressed={sweepKind===v} onClick={()=>{clear();setSweepKind(v);}}>{label}</button>)}</div>}
      {selectedRows.length===1&&!active&&['cloud','callout','text'].includes(selectedRows[0].type)&&<button onClick={()=>setEditor({markup:selectedRows[0],text:selectedRows[0].text||'',fresh:false})}>Edit note</button>}
      <span className="annotation-hint">{!active?'Drag handles to reshape · Shift-click to add':mode==='sweep'?'Box one example → review matches → apply':mode==='selection'?'Box the markups to edit together':mode==='highlighter'&&style.mode==='freehand'?'Drag to highlight · Esc to finish':mode==='highlighter'&&style.mode==='text'?'Box native text to highlight its runs':mode==='arrow'?'Target first, then tail · Shift constrains angle':'Click two points or drag · Esc cancels'}</span>
    </div>}
    {editor&&<div className="annotation-note-editor"><label>{editor.markup.type==='cloud'?'Cloud note (optional)':'Note'}<textarea autoFocus aria-label="Annotation note" rows={2} maxLength={2000} value={editor.text} onChange={e=>setEditor(v=>({...v,text:e.target.value}))} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')applyNote();if(e.key==='Escape'){setEditor(null);paint(preview.current);}}}/></label><button className="annotation-primary" disabled={editor.markup.type==='callout'&&!editor.text.trim()} onClick={applyNote}>Apply note</button><button onClick={()=>{setEditor(null);paint(preview.current);}}>Cancel</button><span className="annotation-hint">⌘/Ctrl + Enter to apply</span></div>}
    {review&&<div className="annotation-review" role="region" aria-label="Confirm Sweep matches">
      <div className="annotation-review-heading"><strong>{review.rows.filter(r=>r.checked).length} of {review.rows.length} selected</strong><span>Check the list or click numbered results on the sheet.</span>{review.warning&&<span role="status">{review.warning}</span>}<button onClick={()=>setReview(r=>({...r,rows:r.rows.map(v=>({...v,checked:!v.held}))}))}>Select matches</button><button onClick={()=>setReview(r=>({...r,rows:r.rows.map(v=>({...v,checked:false}))}))}>Clear selection</button></div>
      <div className="annotation-match-list" role="group" aria-label="Sweep matches">{review.rows.map((r,i)=><label key={i} className={r.checked?'is-selected':''}><input type="checkbox" checked={r.checked} aria-label={`Match ${i+1}: ${r.text}`} onChange={()=>toggleReview(i)}/><span className="annotation-match-number">{i+1}</span><span>{r.text}</span>{r.held&&<small>Check before including</small>}</label>)}</div>
      <div className="annotation-review-actions"><label>Add<select aria-label="Sweep annotation" value={review.kind} onChange={e=>setReview(r=>({...r,kind:e.target.value}))}><option value="cloud">Cloud + optional note</option><option value="callout">Note with leader</option></select></label><input aria-label="Sweep note" placeholder={review.kind==='cloud'?'Optional note for each match':'Note for each match'} maxLength={2000} value={review.text} onChange={e=>setReview(r=>({...r,text:e.target.value}))}/><button className="annotation-primary" disabled={!review.rows.some(r=>r.checked)||(review.kind==='callout'&&!review.text.trim())} onClick={applyReview}>Apply to selected</button><button onClick={()=>setReview(null)}>Cancel</button></div>
    </div>}
  </div>;
  const layer=<g>
    {options.tool==='select'&&selectedRows.filter(m=>!m.annotation_style).map(m=>{const p=options.panels.find(p=>p.key===m.sheet_id);return p?<g key={m.id} transform={`translate(${p.xOffset},0)`}><SelectedHandles markup={m} panel={p} zoom={options.zoom}/></g>:null;})}
    {review&&(()=>{const p=options.panels.find(p=>p.key===review.key);if(!p)return null;return <g transform={`translate(${p.xOffset},0)`}>{review.rows.map((r,i)=>{const [a,b]=r.rect,z=options.zoom;return <g key={i} role="checkbox" tabIndex={0} aria-label={`Sheet match ${i+1}: ${r.text}`} aria-checked={r.checked} onKeyDown={e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();e.stopPropagation();toggleReview(i);}}} style={{pointerEvents:'all',cursor:'pointer'}} onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();toggleReview(i);}}><rect x={a[0]-4/z} y={a[1]-4/z} width={Math.max(10/z,b[0]-a[0]+8/z)} height={Math.max(10/z,b[1]-a[1]+8/z)} fill={r.checked?'#2563eb':'#ed9a23'} fillOpacity={r.checked?.13:.05} stroke={r.checked?'#2563eb':'#ed9a23'} strokeWidth={2/z} strokeDasharray={r.checked?undefined:`${4/z} ${3/z}`}/><text x={a[0]} y={a[1]-8/z} fontSize={11/z} fill={r.checked?'#2563eb':'#b66b00'}>{i+1}{r.held?' ?':''}</text></g>;})}</g>;})()}
    <g ref={preview} style={{pointerEvents:'none'}}/>
  </g>;
  return {toolbar,layer,selected,active,onPointerDownCapture:onDown,onPointerMoveCapture:onMove,onPointerUpCapture:onUp,onDoubleClickCapture:onDouble,onPointerCancelCapture:e=>{if(gesture.current){stop(e);clear();}},render:(m,p)=>m.annotation_style&&supported(m)?<AnnotationInk key={m.id} markup={m} panel={p} selected={options.tool==='select'&&selected.includes(m.id)} zoom={options.zoom}/>:null};
}
