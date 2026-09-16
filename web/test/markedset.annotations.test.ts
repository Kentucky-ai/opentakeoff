import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, degrees, rgb } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { buildMarkedSetPdf } from '../src/lib/markedset.js';

for (const rotation of [0,90]) test(`premium markup PDF retains vector paths, notes and multiply highlight at ${rotation} degrees`,async()=>{
  const source=await PDFDocument.create();const pg=source.addPage([300,200]);pg.setRotation(degrees(rotation));
  pg.drawRectangle({x:20,y:160,width:20,height:20,color:rgb(0,0,0)});
  const sourceBytes=await source.save();
  const style={color:'#dc3d43',stroke_pt:2,head:'open',both:true};
  const marks=[
    {id:'a',sheet_id:'sample.pdf',type:'arrow',from:[.1,.1],to:[.4,.4],annotation_style:style},
    {id:'c',sheet_id:'sample.pdf',type:'cloud',rect:[[.1,.6],[.2,.8]],annotation_style:style},
    {id:'n',sheet_id:'sample.pdf',type:'callout',target:[.2,.5],at:[.45,.55],text:'CHECK\nWIDTH',annotation_style:style},
    {id:'h',sheet_id:'sample.pdf',type:'highlight',quads:[[[.02,.02],[.4,.02],[.4,.22],[.02,.22]]],annotation_style:{color:'#ffd60a',opacity:.4}},
  ];
  const {bytes}=await buildMarkedSetPdf({projectName:'Public annotation test',dark:false,sheets:[{key:'sample.pdf',file:'sample.pdf',page:1,label:'A-101'}],shapes:[],markups:marks,conditions:[],company:null,clientInfo:null,
    loadPdfData:async()=>sourceBytes,getPage:async()=>({rotate:rotation,getViewport:({scale}:{scale:number})=>rotation===90?{width:200*scale,height:300*scale,transform:[0,scale,scale,0,0,0]}:{width:300*scale,height:200*scale,transform:[scale,0,0,-scale,0,200*scale]}})});
  const out=await PDFDocument.load(bytes);assert.equal(out.getPageCount(),2);
  const page:any=out.getPages()[1],gs:any=page.node.Resources().lookup(PDFName.of('ExtGState'));
  assert.ok(gs.entries().some(([,ref]:any)=>String(out.context.lookup(ref)).includes('/Multiply')));
  let contents='';for(const ref of page.node.Contents().asArray()){
    const stream:any=out.context.lookup(ref),filter=stream.dict.lookup(PDFName.of('Filter'));
    const raw=String(filter)==='/FlateDecode'?inflateSync(stream.contents):stream.contents;
    contents+=Buffer.from(raw).toString('latin1');
  }
  assert.ok(contents.includes(Buffer.from('CHECK').toString('hex').toUpperCase()));
  assert.ok(contents.includes(Buffer.from('WIDTH').toString('hex').toUpperCase()));
});
