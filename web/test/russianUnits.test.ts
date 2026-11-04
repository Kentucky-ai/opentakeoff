import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materialForDisplay, liquidFactor, LITRES_PER_US_GALLON as K } from '../src/lib/materialUnits.js';
import { estimateForDisplay, pricingDisplay } from '../src/lib/estimatePresentation.js';
import { coverageText } from '../src/lib/coveragePresentation.js';
import { estimateWorkbook } from '../src/lib/estimateExport.js';
import { setLanguage, localizeText } from '../src/lib/i18n/core.js';
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-9, a+' != '+b);
test('liquid conversion preserves the rounded source purchase and cost',()=>{
 const original={name:'Adhesive',unit:'gal',qty:2,per:250,price:20,cost:40,round:true};
 const l=materialForDisplay(original,'l'); close(l.qty,2*K); close(l.per,250/K); close(l.price,20/K); close(l.qty*l.price,40);
 assert.equal(l.cost,40);assert.equal(original.unit,'gal');assert.equal(original.qty,2);
 const gal=materialForDisplay(l,'gal');close(gal.qty,2);close(gal.per,250);close(gal.price,20);
});
test('unknown packaging and UK gallons are never guessed or relabelled',()=>{
 for(const unit of ['pail','bag','kg','imp gal','UK gallon']){const m={unit,qty:2};assert.equal(materialForDisplay(m,'l'),m);assert.equal(liquidFactor(unit,'l'),null);}
});
test('metric coverage expresses the same physical coverage per litre',()=>{
 const m=materialForDisplay({unit:'gal',qty:2,per:250,basis:'area'},'l');
 assert.equal(coverageText(m,'metric'),'1 l / 6.135597 m²');
 assert.equal(coverageText({unit:'roll',per:90,basis:'seam_lf'}),'1 roll / 90 seam LF');
});
test('metric pricing has reversible rates and unchanged costs for every pricing basis',()=>{
 const lines=['SF','SY','LF','EA'].map(unit=>({unit,material_qty:100,labor_qty:80,material_rate:2,labor_rate:3,total:440,materials:[{unit:'gal',qty:2,price:20,cost:40}]}));
 const est={lines,total:1760};const display=estimateForDisplay(est,true,'l');
 assert.equal(display.total,est.total);
 display.lines.forEach((l:any,i:number)=>{close(l.material_qty*l.material_rate,200);close(l.labor_qty*l.labor_rate,240);close(l.material_rate*l.quantity_factor,2);assert.equal(l.total,440);assert.equal(l.source_unit,lines[i].unit);});
 assert.equal(pricingDisplay('SF',true).unit,'m²');assert.equal(pricingDisplay('LF',true).unit,'m');
});
test('the ACTUAL estimate export localizes all three sheets, units and missing-price details',()=>{
 setLanguage('ru');try{
 const est=estimateForDisplay({lines:[{id:'c',finish_tag:'CPT-1',status:'unpriced',unit:'SF',material_qty:337.74,labor_qty:321.66,material_rate:null,labor_rate:null,material_cost:0,labor_cost:0,materials_cost:0,total:0,materials:[{name:'Adhesive',unit:'gal',qty:2,price:null,cost:0,priced:false}]}],settings:{tax_pct:0,overhead_pct:0,profit_pct:0,profit_mode:'markup'},material:0,labor:0,tax:0,cost:0,overhead:0,profit:0,total:0,complete:false,warnings:[],unpriced:[{finish_tag:'CPT-1',status:'unpriced',missing:['material','labor','material row: Adhesive']}]},true,'l');
 const wb=estimateWorkbook({est,localize:localizeText,language:'ru'});
 assert.deepEqual(wb.map(s=>s.name),['Смета','Материалы','Без цены']);
 const cells=wb.flatMap(s=>s.rows.flat()).filter(x=>typeof x==='string');
 for(const forbidden of ['Untitled project','Overhead','Profit','Sales tax','Adhesive','unpriced','SF','gal'])assert.ok(!cells.some(c=>c.includes(forbidden)),forbidden);
 assert.ok(cells.some(c=>c.includes('см. лист «Без цены»')));
 assert.ok(cells.includes('л'));assert.ok(cells.includes('Клей'));assert.ok(cells.includes('м²'));
 const m=wb[1].rows.find(r=>r.includes('Клей'));assert.ok(m);close(m[2],2*K);
 }finally{setLanguage('en');}
});
