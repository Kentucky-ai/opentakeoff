// Run from web/ with the dev server up (npm run dev -- --port 5191):
//   PLAYWRIGHT_MODULE=/.../playwright/index.mjs node --import tsx scripts/verify-estimate-panel.mjs ../docs/review/estimate-panel [http://localhost:5191/]
// A real takeoff on the bundled sample, then the estimate: sets the plan's own scale, traces one
// CPT-1 and one LVT-1 room with the Area tool, seeds Company setup defaults, opens Estimate, types
// placeholder prices (leaving LVT-1's adhesive unpriced on purpose), and checks the panel against
// lib/estimate.js run on the SAVED project, the Excel download, persistence across a reload, and
// that changing Company setup later never re-prices the project until asked.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { conditionTotals } from '../src/lib/totals.js';
import { priceEstimate } from '../src/lib/estimate.js';
import { OT_WATERMARK } from '../src/lib/branding.js';
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = pw.chromium ?? pw.default.chromium;
const out = resolve(process.argv[2]), BASE = process.argv[3] || 'http://localhost:5191/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const checks = [], errors = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', e => errors.push(String(e)));
const money = (v) => `$${(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const saved = () => page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('opentakeoff');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => { const g = r.result.transaction('meta').objectStore('meta').get('annotations'); g.onsuccess = () => { r.result.close(); res(g.result); }; };
}));
const engine = (doc) => priceEstimate({ rows: conditionTotals(doc.conditions, doc.shapes), conditions: doc.conditions, settings: doc.estimate_settings });
const panel = () => page.getByRole('dialog', { name: 'Estimate' });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('opentakeoff_estimating_defaults', JSON.stringify({ overhead_pct: 10, profit_pct: 20, profit_mode: 'markup', tax_pct: 6 })));
await page.getByRole('button', { name: /Just open the sample plan/ }).click();
await page.waitForTimeout(7000);

// Scale from the plan, then two rooms with the Area tool (A, four clicks, Enter).
await page.getByRole('button', { name: /Set scale/ }).first().click();
await page.getByRole('button', { name: /Plan says .* use it/ }).click();
await page.waitForTimeout(800);
const trace = async (pts) => {
  await page.keyboard.press('a');
  for (const [x, y] of pts) { await page.mouse.click(x, y); await page.waitForTimeout(120); }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
};
await page.locator('select').filter({ hasText: 'CPT-1' }).first().selectOption({ label: 'CPT-1' });
await trace([[462, 302], [568, 302], [568, 378], [462, 378]]);
await page.locator('select').filter({ hasText: 'LVT-1' }).first().selectOption({ label: 'LVT-1' });
await trace([[722, 602], [798, 602], [798, 676], [722, 676]]);
await page.keyboard.press('Escape');
await page.waitForTimeout(2500);   // autosave debounce
let doc = await saved();
const tags = new Map(doc.conditions.map((c) => [c.id, c.finish_tag]));
const traced = doc.shapes.map((s) => tags.get(s.condition_id));
check('two rooms traced on the scaled sample (CPT-1, LVT-1)', traced.includes('CPT-1') && traced.includes('LVT-1') && doc.shapes.every((s) => s.computed?.area_sf > 0), doc.shapes.map((s) => [tags.get(s.condition_id), s.computed?.area_sf]));

// Open Estimate from the toolbar: markups seeded from Company setup.
await page.getByRole('button', { name: /^Estimate$/ }).first().click();
await page.waitForTimeout(600);
check('toolbar Estimate opens the panel', await panel().isVisible());
check('markups seeded from Company setup (10 / 20 / 6)', (await panel().locator('input[name=markup-overhead_pct]').inputValue()) === '10' && (await panel().locator('input[name=markup-profit_pct]').inputValue()) === '20' && (await panel().locator('input[name=markup-tax_pct]').inputValue()) === '6');
check('both traced conditions listed, both unpriced', (await panel().locator('tr[data-estimate-line]').count()) === 2 && /2 lines are not fully priced/.test(await panel().textContent()));

// Placeholder prices. CPT-1 in SY with its adhesive priced; LVT-1 per SF, adhesive left empty.
const line = (tag) => panel().locator(`tr[data-estimate-line="${tag}"]`);
await line('CPT-1').locator('select[name=price-unit]').selectOption('SY');
await line('CPT-1').locator('input[name=price-material]').fill('20');
await line('CPT-1').locator('input[name=price-labor]').fill('5');
await line('CPT-1').getByRole('button', { name: /1 material/ }).click();
await panel().locator('input[name=price-supply]').first().fill('40');
await line('LVT-1').locator('input[name=price-material]').fill('3.5');
await line('LVT-1').locator('input[name=price-labor]').fill('2');
await page.waitForTimeout(2500);
doc = await saved();
const byTag = Object.fromEntries(doc.conditions.map((c) => [c.finish_tag, c]));
check('prices saved on the conditions', JSON.stringify(byTag['CPT-1'].pricing) === JSON.stringify({ unit: 'SY', material: 20, labor: 5 }) && byTag['LVT-1'].pricing?.material === 3.5 && byTag['LVT-1'].pricing?.labor === 2, { cpt: byTag['CPT-1'].pricing, lvt: byTag['LVT-1'].pricing });
check('supply price saved on the CPT-1 adhesive row only', byTag['CPT-1'].materials[0].price === 40 && !('price' in byTag['LVT-1'].materials[0]));
check('project markups saved with the project', JSON.stringify(doc.estimate_settings) === JSON.stringify({ tax_pct: 6, overhead_pct: 10, profit_pct: 20, profit_mode: 'markup' }), doc.estimate_settings);
const e = engine(doc);
const text = await panel().textContent();
check('panel base bid equals the engine on the saved project', text.includes(money(e.total)), { engine: e.total });
check('LVT-1 flagged: only its adhesive is missing', e.unpriced.length === 1 && e.unpriced[0].finish_tag === 'LVT-1' && /1 line is not fully priced/.test(text) && /LVT-1 \(material row: Adhesive\)/.test(text), e.unpriced);
check('total labelled "priced so far" while a line is incomplete', /Base bid — priced so far/.test(text));
await page.screenshot({ path: join(out, 'estimate-panel.png') });

// Excel.
const dl = page.waitForEvent('download');
await panel().getByRole('button', { name: /^Excel$/ }).click();
const file = await dl;
const xlsx = unzipSync(new Uint8Array(await (await import('node:fs/promises')).readFile(await file.path())));
const sheetNames = (strFromU8(xlsx['xl/workbook.xml']).match(/name="[^"]+"/g) || []).map((s) => s.slice(6, -1));
const s1 = strFromU8(xlsx['xl/worksheets/sheet1.xml']);
check('Excel has Estimate, Materials and Unpriced tabs', JSON.stringify(sheetNames) === JSON.stringify(['Estimate', 'Materials', 'Unpriced']), sheetNames);
check('Excel base bid and watermark', s1.includes('Base bid') && s1.includes(`<v>${e.total}</v>`) && s1.includes(OT_WATERMARK.split(' · ')[0]));

// Company setup changes later: this project keeps its markups until asked.
await page.evaluate(() => localStorage.setItem('opentakeoff_estimating_defaults', JSON.stringify({ overhead_pct: 15, profit_pct: 20, profit_mode: 'markup', tax_pct: 6 })));
await page.keyboard.press('Escape');
await page.getByRole('button', { name: /^Estimate$/ }).first().click();
await page.waitForTimeout(400);
check('a later Company setup change does not re-price the project', (await panel().locator('input[name=markup-overhead_pct]').inputValue()) === '10');
await panel().getByRole('button', { name: /^Company defaults$/ }).click();
await page.waitForTimeout(400);
check('Company defaults applies the new 15% on request', (await panel().locator('input[name=markup-overhead_pct]').inputValue()) === '15');

// Reload: the estimate comes back the same.
await page.waitForTimeout(2500);
const before = engine(await saved()).total;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(6000);
const again = page.getByRole('button', { name: /Just open the sample plan/ });
if (await again.count()) { await again.click(); await page.waitForTimeout(7000); }
await page.getByRole('button', { name: /^Estimate$/ }).first().click();
await page.waitForTimeout(600);
check('after a reload the estimate shows the same base bid', (await panel().textContent()).includes(money(before)), { before });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, 'estimate-panel-phone.png') });
check('no page errors', errors.length === 0, errors);

await browser.close();
const results = { base: BASE, passed: checks.filter(c => c.ok).length, total: checks.length, checks };
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(`${results.passed}/${results.total}`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail ?? '')}`);
process.exit(results.passed === results.total ? 0 : 1);
