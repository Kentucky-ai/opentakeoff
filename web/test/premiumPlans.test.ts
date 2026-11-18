import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
const read=(f:string)=>readFileSync(new URL(f,import.meta.url),'utf8');
const SURFACES=['../src/pages/TakeoffCanvas.jsx','../src/components/PlanNavigator.jsx','../src/components/WorkspaceChrome.jsx'];
test('the open-source app has no Premium plans button, menu item or pricing link',()=>{
  const src=SURFACES.map(read).join('\n');
  assert.equal(/Premium plans|data-premium-trigger|onPremium|openPremiumPricing/.test(src),false);
  assert.equal(/kentucky-ai\.com\/#pricing/.test(src),false);
  assert.equal(existsSync(new URL('../src/lib/premiumPlans.js',import.meta.url)),false);
});
test('the app carries no in-app plans dialog',()=>{
  assert.equal(/premium-plans-dialog|PremiumPlans\b/.test(SURFACES.map(read).join('\n')),false);
});
test('the early-access form and its Netlify form definition are gone',()=>{
  assert.equal(read('../index.html').includes('premium-interest'),false);
});
