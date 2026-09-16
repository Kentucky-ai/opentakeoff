import { cloudBezier } from './geometry.js';

export const ANNOTATION_DEFAULTS = { color: '#dc3d43', stroke_pt: 1.5, font_pt: 10, opacity: 0.32, head: 'filled', both: false, mode: 'freehand', width_pt: 10, line_style: 'solid' };
export const ANNOTATION_PRESETS = [
  { id: 'review', name: 'Review', tool: 'cloud', style: { ...ANNOTATION_DEFAULTS } },
  { id: 'direction', name: 'Direction', tool: 'arrow', style: { ...ANNOTATION_DEFAULTS, color: '#2563eb', stroke_pt: 2 } },
  { id: 'key', name: 'Key information', tool: 'highlighter', style: { ...ANNOTATION_DEFAULTS, color: '#ffd60a', mode: 'text' } },
];
const clamp = (n, a, b, fallback) => Number.isFinite(+n) ? Math.max(a, Math.min(b, +n)) : fallback;
export function annotationStyle(s = {}) {
  s = s && typeof s === 'object' ? s : {};
  return { color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : ANNOTATION_DEFAULTS.color,
    stroke_pt: clamp(s.stroke_pt, .5, 6, 1.5), font_pt: clamp(s.font_pt, 6, 24, 10), opacity: clamp(s.opacity, .1, .75, .32),
    width_pt: clamp(s.width_pt, 2, 40, 10), head: ['filled', 'open', 'none'].includes(s.head) ? s.head : 'filled',
    both: !!s.both, mode: ['freehand', 'straight', 'text'].includes(s.mode) ? s.mode : 'freehand',
    line_style: ['solid', 'dashed', 'dotted'].includes(s.line_style) ? s.line_style : 'solid' };
}
export const box = (a, b) => [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]];
export const intersects = (a, b) => a[0][0] <= b[1][0] && a[1][0] >= b[0][0] && a[0][1] <= b[1][1] && a[1][1] >= b[0][1];
export function bounds(points) {
  return [[Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))], [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]];
}
export function markupBounds(m) {
  const pts = m.quads?.flat() || m.pts || m.rect || [m.from, m.to, m.target, m.at].filter(Boolean);
  return pts?.length ? bounds(pts) : null;
}
export function shiftedMarkup(m, dx, dy) {
  const mv = p => [p[0] + dx, p[1] + dy];
  const out = { ...m };
  for (const k of ['at', 'target', 'from', 'to', 'note_at']) if (m[k]) out[k] = mv(m[k]);
  for (const k of ['pts', 'rect']) if (m[k]) out[k] = m[k].map(mv);
  if (m.quads) out.quads = m.quads.map(q => q.map(mv));
  return out;
}
export function noteLines(text, limit = 36) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + word.length + 1 > limit) { lines.push(line); line = ''; }
      let rest = word;
      while (rest.length > limit) { if (line) { lines.push(line); line = ''; } lines.push(rest.slice(0, limit)); rest = rest.slice(limit); }
      line += (line ? ' ' : '') + rest;
    }
    lines.push(line);
  }
  return lines;
}
const path = pts => pts.map((p, i) => [i ? 'L' : 'M', ...p]);
export function pathString(commands, transform = p => p) {
  return commands.map(([verb, ...v]) => {
    const ps = [];
    for (let i = 0; i < v.length; i += 2) ps.push(transform([v[i], v[i + 1]]).join(','));
    return verb + ps.join(' ');
  }).join(' ');
}
// All dimensions are page-relative. pixelScale is the image pixels per PDF point.
// The scene is shared by the canvas and vector PDF export.
export function annotationScene(m, W, H, pixelScale = 2) {
  const s = annotationStyle({ ...m.annotation_style, color: m.color || m.annotation_style?.color });
  const P = p => [p[0] * W, p[1] * H];
  const paths = [], texts = [];
  const stroke = s.stroke_pt * pixelScale;
  const add = (commands, extra = {}) => paths.push({ commands, stroke: s.color, width: stroke, opacity: 1, ...extra });
  const head = (a, b) => {
    if (s.head === 'none') return;
    const size = Math.max(6, s.stroke_pt * 4) * pixelScale, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) return;
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], base = [b[0] - u[0] * size, b[1] - u[1] * size];
    const pts = [[base[0] - u[1] * size * .42, base[1] + u[0] * size * .42], b, [base[0] + u[1] * size * .42, base[1] - u[0] * size * .42]];
    add([...path(pts), ...(s.head === 'filled' ? [['Z']] : [])], { fill: s.head === 'filled' ? s.color : undefined, dash: undefined });
  };
  const leader = (a, b) => { add(path([a, b])); head(a, b); if (s.both) head(b, a); };
  const noteOrigin = at => {
    const lines=noteLines(m.text),font=s.font_pt*pixelScale,pad=5*pixelScale;
    const w=Math.max(45*pixelScale,...lines.map(l=>l.length*font*.62))+pad*2;
    const h=Math.max(1,lines.length)*font*1.35+pad*2;
    return [Math.max(0,Math.min(W-w,at[0])),Math.max(0,Math.min(H-h,at[1]))];
  };
  const note = (raw) => {
    const at=noteOrigin(raw);
    const lines = noteLines(m.text), font = s.font_pt * pixelScale, pad = 5 * pixelScale;
    const width = Math.max(45 * pixelScale, ...lines.map(l => l.length * font * .62)) + pad * 2;
    const height = Math.max(1, lines.length) * font * 1.35 + pad * 2;
    add([...path([at, [at[0] + width, at[1]], [at[0] + width, at[1] + height], [at[0], at[1] + height]]), ['Z']], { fill: '#ffffff' });
    lines.forEach((text, i) => texts.push({ text, x: at[0] + pad, y: at[1] + pad + font * (1 + i * 1.35), size: font, color: '#172033' }));
    return [[at[0], at[1]], [at[0] + width, at[1] + height]];
  };
  let noteBox = null;
  if (m.type === 'arrow' && m.from && m.to) leader(P(m.from), P(m.to));
  if (m.type === 'callout' && m.at && m.target) { leader(noteOrigin(P(m.at)), P(m.target)); noteBox = note(P(m.at)); }
  if (m.type === 'text' && m.at) noteBox = note(P(m.at));
  if (m.type === 'cloud' && m.rect) {
    const r = box(...m.rect), a = P(r[0]), b = P(r[1]), cb = cloudBezier(...a, ...b);
    add([['M', ...cb.start], ...cb.segments.map(q => ['C', ...q.flat()]), ['Z']]);
    if (m.text) { const at = noteOrigin(P(m.note_at || [r[0][0], r[1][1] + 12 * pixelScale / H])); add(path([at, [a[0], b[1]]])); noteBox = note(at); }
  }
  if (m.type === 'highlight') {
    if (m.quads?.length) for (const q of m.quads) add([...path(q.map(P)), ['Z']], { fill: s.color, stroke: undefined, opacity: s.opacity, blend: 'multiply' });
    else if (m.pts?.length > 1) add(path(m.pts.map(P)), { width: (m.w ? m.w * W : s.width_pt * pixelScale), opacity: s.opacity, blend: 'multiply' });
    else if (m.rect) { const [a,b] = box(...m.rect); add([...path([P(a), P([b[0],a[1]]), P(b), P([a[0],b[1]])]), ['Z']], {fill:s.color, stroke:undefined, opacity:s.opacity, blend:'multiply'}); }
  }
  const dash = s.line_style === 'dashed' ? [5 * pixelScale, 3 * pixelScale] : s.line_style === 'dotted' ? [pixelScale, 3 * pixelScale] : undefined;
  for (const p of paths) if (p.stroke && !p.fill && m.type !== 'highlight') p.dash = dash;
  if (m.type === 'cloud' && m.rect && Number.isFinite(m.rev) && m.rev > 0) {
    const r=box(...m.rect), x=r[1][0]*W, y=r[0][1]*H-12*pixelScale;
    add([['M',x,y-7*pixelScale],['L',x+7*pixelScale,y+5*pixelScale],['L',x-7*pixelScale,y+5*pixelScale],['Z']],{fill:'#ffffff'});
    texts.push({text:String(m.rev),x:x-2.5*pixelScale,y:y+3*pixelScale,size:8*pixelScale,color:s.color});
  }
  return { paths, texts, noteBox };
}

const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
// PDF text runs, including rotated runs. Font size is applied exactly once.
export function nativeTextRuns(content, viewport) {
  const scale = Math.hypot(viewport[0], viewport[1]);
  return (content.items || []).filter(it => it.str?.trim() && it.transform).map(it => {
    const t = multiply(viewport, it.transform), f = Math.hypot(t[0], t[1]) || 1, h = Math.hypot(t[2], t[3]) || f;
    const u = [t[0]/f, t[1]/f], v = [t[2]/h, t[3]/h], width = it.width * scale;
    const st = content.styles?.[it.fontName] || {}, ascent = Number.isFinite(st.ascent) ? st.ascent : .8, descent = Number.isFinite(st.descent) ? st.descent : -.2;
    const p = (x, y) => [t[4]+u[0]*x+v[0]*y, t[5]+u[1]*x+v[1]*y];
    const quad = [p(0,ascent*h), p(width,ascent*h), p(width,descent*h), p(0,descent*h)];
    return { text: it.str, quad, rect: bounds(quad) };
  });
}
export const normalizeText = s => String(s || '').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
// CAD PDFs often split one label into separate runs ("CPT", "-", "1").
// Join only adjacent, aligned runs before matching; punctuation and digits must
// never independently seed a whole-sheet sweep when they belong to a label.
export function joinedTextRuns(runs) {
  const directions=new Map();
  for(const r of runs){
    if(!r.quad){directions.set(Symbol(),[r]);continue;}
    const a=r.quad[0],b=r.quad[1],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    if(!length)continue;
    const u=[(b[0]-a[0])/length,(b[1]-a[1])/length],v=[-u[1],u[0]],key=Math.round(Math.atan2(u[1],u[0])*180/Math.PI);
    const dot=(p,d)=>p[0]*d[0]+p[1]*d[1],h=Math.abs(dot(r.quad[3],v)-dot(a,v));
    const row={...r,u,v,h,along:dot(a,u),baseline:dot(r.quad[3],v)};
    if(!directions.has(key))directions.set(key,[]);directions.get(key).push(row);
  }
  const out=[];
  for(const rows of directions.values()){
    if(!rows[0].quad){out.push(...rows);continue;}
    rows.sort((a,b)=>a.baseline-b.baseline||a.along-b.along);
    const lines=[];
    for(const row of rows){let line=lines.at(-1);if(!line||Math.abs(row.baseline-line[0].baseline)>.22*Math.max(row.h,line[0].h)){line=[];lines.push(line);}line.push(row);}
    for(const line of lines){
      line.sort((a,b)=>a.along-b.along);let group=null;
      const flush=()=>{if(!group)return;const {u,v,items}=group,points=items.flatMap(r=>r.quad),xs=points.map(p=>p[0]*u[0]+p[1]*u[1]),ys=points.map(p=>p[0]*v[0]+p[1]*v[1]);
        const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys),P=(x,y)=>[u[0]*x+v[0]*y,u[1]*x+v[1]*y];
        const quad=[P(x0,y0),P(x1,y0),P(x1,y1),P(x0,y1)];out.push({text:group.text,quad,rect:bounds(quad)});};
      for(const row of line){
        const previous=group?.items.at(-1),end=previous?Math.max(...previous.quad.map(p=>p[0]*row.u[0]+p[1]*row.u[1])):0,gap=row.along-end;
        if(!group||gap<-.15*row.h||gap>.65*row.h||row.h/previous.h<.7||row.h/previous.h>1.4){flush();group={u:row.u,v:row.v,items:[row],text:row.text.trim()};}
        else{group.items.push(row);group.text+=(gap>.2*row.h?' ':'')+row.text.trim();}
      }
      flush();
    }
  }
  return out;
}
export function textMatches(runs, region) {
  runs=joinedTextRuns(runs);
  const chosen = runs.filter(r => intersects(r.rect, region));
  const names = new Set(chosen.map(r => normalizeText(r.text)).filter(Boolean));
  return runs.filter(r => names.has(normalizeText(r.text)));
}
// History patches touch only the changed IDs; undo never overwrites unrelated notes.
export function markupPatch(before, after) {
  const a = new Map(before.map(m => [m.id,m])), b = new Map(after.map(m => [m.id,m]));
  const ids = [...new Set([...a.keys(),...b.keys()])].filter(id => JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id)));
  return { ids, before: before.filter(m => ids.includes(m.id)), after: after.filter(m => ids.includes(m.id)), beforeOrder: before.map(m=>m.id), afterOrder: after.map(m=>m.id) };
}
export function applyMarkupPatch(current, patch, side) {
  const replacements = new Map(patch[side].map(m => [m.id,m])), ids = new Set(patch.ids);
  const out = current.flatMap(m => { if (!ids.has(m.id)) return [m]; const r = replacements.get(m.id); replacements.delete(m.id); return r ? [r] : []; });
  const order = patch[side + 'Order'] || [];
  for (const m of replacements.values()) {
    const rank = order.indexOf(m.id);
    const next = out.findIndex(row => order.indexOf(row.id) > rank && order.includes(row.id));
    out.splice(next < 0 ? out.length : next, 0, m);
  }
  return out;
}
