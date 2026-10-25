// Run from web/ with the dev server up (npm run dev -- --port 5191):
//   PLAYWRIGHT_MODULE=/.../playwright/index.mjs node scripts/verify-estimate-engine.mjs ../docs/review/estimate-engine [http://localhost:5191/]
// Opens the bundled sample, writes placeholder prices ($1) onto its CPT-1 condition in the saved
// project, reloads, and checks that the canvas keeps them through hydrate, then saves CPT-1 to the
// template Library and checks that the template carries neither the condition's pricing nor any
// material price. Prices stay with the project (lib/estimate.js).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = pw.chromium ?? pw.default.chromium;
const out = resolve(process.argv[2]), BASE = process.argv[3] || 'http://localhost:5191/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const checks = [], errors = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', e => errors.push(String(e)));

// The meta store holds the project ("annotations") and the template library ("condition_templates").
const meta = (op, key, value) => page.evaluate(([op, key, value]) => new Promise((res, rej) => {
  const req = indexedDB.open('opentakeoff');
  req.onerror = () => rej(req.error);
  req.onsuccess = () => {
    const db = req.result, tx = db.transaction('meta', op === 'get' ? 'readonly' : 'readwrite'), st = tx.objectStore('meta');
    const r = op === 'get' ? st.get(key) : st.put(value, key);
    r.onsuccess = () => { const v = r.result; db.close(); res(op === 'get' ? v : true); };
    r.onerror = () => rej(r.error);
  };
}), [op, key, value]);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Just open the sample plan/ }).click();
await page.waitForTimeout(7000);
const before = await meta('get', 'annotations');
const cpt = before?.conditions?.find(c => c.finish_tag === 'CPT-1');
check('sample project saved with a CPT-1 condition', cpt, cpt ? { materials: (cpt.materials || []).length } : undefined);

// Close the tab first so nothing in it can save over the edit, then write the prices.
await page.goto('about:blank');
await page.goto(new URL('/robots.txt', BASE).href);
const edited = structuredClone(before);
const ec = edited.conditions.find(c => c.finish_tag === 'CPT-1');
ec.pricing = { unit: 'SY', material: 1, labor: 1 };
ec.materials = (ec.materials || []).map(m => ({ ...m, price: 1 }));
await meta('put', 'annotations', edited);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(7000);
const after = await meta('get', 'annotations');
const ac = after?.conditions?.find(c => c.finish_tag === 'CPT-1');
check('CPT-1 pricing survives a reload', JSON.stringify(ac?.pricing) === JSON.stringify(ec.pricing), ac?.pricing);
check('CPT-1 material prices survive a reload', (ac?.materials || []).length > 0 && ac.materials.every(m => m.price === 1), (ac?.materials || []).map(m => m.price));

const sheet = page.getByRole('button', { name: /Just open the sample plan/ });
if (await sheet.count()) { await sheet.click(); await page.waitForTimeout(7000); }
await page.getByRole('button', { name: /^Quantities/ }).first().click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: /^Library/ }).first().click();
await page.waitForTimeout(500);
const condPick = page.locator('select').first();
if (await condPick.count()) await condPick.selectOption({ label: 'CPT-1' }).catch(() => {});
await page.getByRole('button', { name: /save CPT-1 to the library/i }).first().click();
await page.waitForTimeout(1000);
await page.screenshot({ path: join(out, 'template-saved.png') });
const tpls = await meta('get', 'condition_templates');
const t = (tpls || []).find(x => x.finish_tag === 'CPT-1');
check('CPT-1 saved to the Library', t);
check('the template has no pricing', t && !('pricing' in t));
check('no template material carries a price', t && (t.materials || []).length > 0 && t.materials.every(m => !('price' in m)), (t?.materials || []).map(m => Object.keys(m)));
check('no page errors', errors.length === 0, errors);

await browser.close();
const results = { base: BASE, passed: checks.filter(c => c.ok).length, total: checks.length, checks };
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(`${results.passed}/${results.total}`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
process.exit(results.passed === results.total ? 0 : 1);
