import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PREMIUM_PRICING, openPremiumPricing} from '../src/lib/premiumPlans.js';
test('every Premium button opens the pricing section on kentucky-ai.com in a new tab, whatever it is called with',()=>{
  assert.equal(PREMIUM_PRICING,'https://kentucky-ai.com/#pricing');
  const opened:unknown[][]=[];
  const g=globalThis as {window?:unknown};
  const prior=g.window;
  g.window={open:(...a:unknown[])=>{opened.push(a);}};
  try { (openPremiumPricing as (...a:unknown[])=>void)({type:'click'}); } finally { g.window=prior; }
  assert.deepEqual(opened,[['https://kentucky-ai.com/#pricing','_blank','noopener,noreferrer']]);
});
test('the app carries no Premium prices or in-app plans dialog: kentucky-ai.com is the only place they are stated',()=>{
  const src=['../src/lib/premiumPlans.js','../src/pages/TakeoffCanvas.jsx','../src/components/PlanNavigator.jsx','../src/components/WorkspaceChrome.jsx']
    .map(f=>readFileSync(new URL(f,import.meta.url),'utf8')).join('\n');
  assert.equal(/premium-plans-dialog|PremiumPlans\b/.test(src),false);
  assert.equal(/\$(99|149|299|399|89|129)\b/.test(readFileSync(new URL('../src/lib/premiumPlans.js',import.meta.url),'utf8')),false);
});
test('the early-access form and its Netlify form definition are gone',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.equal(html.includes('premium-interest'),false);
});
