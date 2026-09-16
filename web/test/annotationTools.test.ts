import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotationScene, nativeTextRuns, textMatches, markupPatch, applyMarkupPatch, shiftedMarkup, ANNOTATION_DEFAULTS } from '../src/lib/annotationTools.js';

test('arrow heads, line weight, and geometry remain page-relative',()=>{
  const m={type:'arrow',from:[.2,.3],to:[.7,.8],annotation_style:{...ANNOTATION_DEFAULTS,head:'open',both:true,stroke_pt:3}};
  const a=annotationScene(m,1200,800,2),b=annotationScene(m,600,400,1);
  assert.equal(a.paths.length,3);
  assert.equal(a.paths[0].width,6);
  assert.deepEqual(a.paths[0].commands,[['M',240,240],['L',840,640]]);
  assert.ok(a.paths.slice(1).every(p=>!p.fill));
  for(let i=0;i<a.paths.length;i++)for(let j=0;j<a.paths[i].commands.length;j++)assert.deepEqual(a.paths[i].commands[j].slice(1).map(Number).map((v:number)=>v/2),b.paths[i].commands[j].slice(1));
});
test('native text uses viewport scale once and follows rotated baselines',()=>{
  const content={items:[{str:'VERIFY',width:36,transform:[12,0,0,12,100,200],fontName:'f'}],styles:{f:{ascent:.8,descent:-.2}}};
  const horizontal=nativeTextRuns(content,[2,0,0,-2,0,1000])[0];
  assert.equal(horizontal.rect[1][0]-horizontal.rect[0][0],72);
  assert.ok(Math.abs(horizontal.rect[1][1]-horizontal.rect[0][1]-24)<1e-8);
  const rotated=nativeTextRuns(content,[0,2,2,0,0,0])[0];
  assert.equal(rotated.rect[1][1]-rotated.rect[0][1],72);
  assert.ok(Math.abs(rotated.rect[1][0]-rotated.rect[0][0]-24)<1e-8);
});
test('text sweep matches normalized complete runs and excludes different labels',()=>{
  const runs=[{text:'VERIFY',rect:[[0,0],[10,10]]},{text:' verify ',rect:[[20,0],[30,10]]},{text:'HOLD',rect:[[40,0],[50,10]]}];
  assert.equal(textMatches(runs,[[1,1],[9,9]]).length,2);
  assert.equal(textMatches(runs,[[80,80],[90,90]]).length,0);
});
test('batch undo restores exact markup geometry/order and preserves unrelated edits',()=>{
  const before=[{id:'a',text:'first'},{id:'b',text:'middle'},{id:'c',text:'last'}];
  const after=[{id:'a',text:'changed'},{id:'c',text:'last'},{id:'d',text:'new'}];
  const patch=markupPatch(before,after);
  assert.deepEqual(applyMarkupPatch(after,patch,'before'),before);
  assert.deepEqual(applyMarkupPatch(before,patch,'after'),after);
  assert.equal(applyMarkupPatch([...after,{id:'x',text:'independent'}],patch,'before').at(-1)?.id,'x');
});
test('moving a text highlight moves every quad, and cloud notes move with their region',()=>{
  const a={id:'h',type:'highlight',quads:[[[.1,.1],[.2,.1],[.2,.2],[.1,.2]]],rect:[[.1,.1],[.2,.2]]};
  const b=shiftedMarkup(a,.3,.4);
  assert.deepEqual(b.quads[0][0],[.4,.5]);
  assert.deepEqual(a.quads[0][0],[.1,.1]);
  const c=shiftedMarkup({type:'cloud',rect:[[.1,.1],[.2,.2]],note_at:[.2,.3]},.1,.1);
  assert.deepEqual(c.note_at,[.30000000000000004,.4]);
});
test('text highlighter is a translucent multiply-filled quad without a box border',()=>{
  const scene=annotationScene({type:'highlight',quads:[[[.1,.2],[.4,.2],[.4,.3],[.1,.3]]],annotation_style:{...ANNOTATION_DEFAULTS,color:'#ffd60a',opacity:.4}},1000,800);
  assert.equal(scene.paths.length,1);assert.equal(scene.paths[0].blend,'multiply');assert.equal(scene.paths[0].opacity,.4);assert.equal(scene.paths[0].stroke,undefined);
});

test('Sweep joins fragmented CAD labels and does not match isolated suffixes',()=>{
  const run=(text:string,x:number,y:number,w:number)=>({text,quad:[[x,y],[x+w,y],[x+w,y+10],[x,y+10]],rect:[[x,y],[x+w,y+10]]});
  const runs=[run('CPT',10,10,20),run('-',31,10,3),run('1',35,10,5),run('CPT',100,50,20),run('-',121,50,3),run('1',125,50,5),run('VCT',10,100,20),run('-',31,100,3),run('1',35,100,5),run('1',200,200,5)];
  const matches=textMatches(runs,[[9,9],[41,21]]);
  assert.equal(matches.length,2);assert.deepEqual(matches.map((r:{text:string})=>r.text),['CPT-1','CPT-1']);
});
