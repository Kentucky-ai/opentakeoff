// Run from web/ with the dev server up (npm run dev -- --port 5191):
//   PLAYWRIGHT_MODULE=/.../playwright/index.mjs node --import tsx scripts/verify-assemblies-estimate.mjs ../docs/review/assemblies-estimate-lines [http://localhost:5191/]
// The reported bug and its fix, on the bundled sample: under CPT-1 draw a rectangle (SF), a line
// (LF) and two counts (EA); the Estimate must show and price three lines. Then an assembly item
// with its own rule and waste, saved as an assembly and applied to LVT-1; then the Excel and the
// proposal PDF, both checked for the OpenTakeoff watermark on every tab and page. Placeholder
// prices only; every number is checked against lib/estimate.js run on the SAVED project.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument, PDFName } from 'pdf-lib';
import { conditionTotals } from '../src/lib/totals.js';
import { priceEstimate } from '../src/lib/estimate.js';
import { OT_NAME, OT_WATERMARK } from '../src/lib/branding.js';
import { escXml } from '../src/lib/xlsx.js';
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = pw.chromium ?? pw.default.chromium;
const out = resolve(process.argv[2]), BASE = process.argv[3] || 'http://localhost:5191/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const checks = [], errors = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
const money = (v) => `$${(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const saved = () => page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('opentakeoff');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => { const g = r.result.transaction('meta').objectStore('meta').get('annotations'); g.onsuccess = () => { r.result.close(); res(g.result); }; };
}));
const engine = (doc) => priceEstimate({ rows: conditionTotals(doc.conditions, doc.shapes), conditions: doc.conditions, settings: doc.estimate_settings });
const panel = () => page.getByRole('dialog', { name: 'Estimate' });
const hex = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
const settle = (ms = 2500) => page.waitForTimeout(ms);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Just open the sample plan/ }).click();
await settle(7000);
await page.getByRole('button', { name: /Set scale/ }).first().click();
await page.getByRole('button', { name: /Plan says .* use it/ }).click();
await settle(800);
const pick = (tag) => page.locator('select').filter({ hasText: 'CPT-1' }).first().selectOption({ label: tag });

// CPT-1: one rectangle (two corners), one line (two points + Enter), two counts.
await pick('CPT-1');
await page.keyboard.press('r');
await page.mouse.click(462, 302); await page.waitForTimeout(150); await page.mouse.click(568, 378);
await page.waitForTimeout(500);
await page.keyboard.press('l');
await page.mouse.click(462, 430); await page.waitForTimeout(150); await page.mouse.click(600, 430); await page.waitForTimeout(150);
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
await page.keyboard.press('c');
await page.mouse.click(700, 320); await page.waitForTimeout(250); await page.mouse.click(740, 320);
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await settle();
let doc = await saved();
const cptId = doc.conditions.find((c) => c.finish_tag === 'CPT-1').id;
const [cptRow] = conditionTotals(doc.conditions, doc.shapes).filter((r) => r.id === cptId);
check('CPT-1 carries SF, LF and 2 EA on the scaled sample', cptRow.total_sf > 0 && cptRow.lf > 0 && cptRow.ea === 2, { total_sf: cptRow.total_sf, lf: cptRow.lf, ea: cptRow.ea, roles: doc.shapes.filter((s) => s.condition_id === cptId).map((s) => s.measure_role) });

// Estimate: three CPT-1 lines, unpriced.
await page.getByRole('button', { name: /^Estimate$/ }).first().click();
await page.waitForTimeout(600);
const line = (unit) => panel().locator(`tr[data-estimate-line="CPT-1"][data-estimate-unit="${unit}"]`);
const units = await panel().locator('tr[data-estimate-line="CPT-1"]').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-estimate-unit')));
check('Estimate shows a CPT-1 line per quantity kind (SF, LF, EA)', JSON.stringify(units) === JSON.stringify(['SF', 'LF', 'EA']), units);
check('unpriced lines are named in the banner', /CPT-1 LF \(material, labor\)/.test(await panel().textContent()) && /CPT-1 EA \(material, labor\)/.test(await panel().textContent()));
await page.screenshot({ path: join(out, '1-estimate-three-lines-unpriced.png') });

// Placeholder prices: SY 30 / 6, LF 2 / 1.5, EA 40 / 25, adhesive $18 a gallon.
await line('SF').locator('select[name=price-unit]').selectOption('SY');
await line('SY').locator('input[name=price-material]').fill('30');
await line('SY').locator('input[name=price-labor]').fill('6');
await line('LF').locator('input[name=price-material]').fill('2');
await line('LF').locator('input[name=price-labor]').fill('1.5');
await line('EA').locator('input[name=price-material]').fill('40');
await line('EA').locator('input[name=price-labor]').fill('25');
await line('SY').getByRole('button', { name: /1 item/ }).click();
await panel().locator('input[name=price-supply]').first().fill('18');
await settle();
doc = await saved();
let cpt = doc.conditions.find((c) => c.id === cptId);
check('prices saved: main line on pricing, LF / EA under by_unit', JSON.stringify(cpt.pricing) === JSON.stringify({ unit: 'SY', material: 30, labor: 6, by_unit: { LF: { material: 2, labor: 1.5 }, EA: { material: 40, labor: 25 } } }), cpt.pricing);
let e = engine(doc);
const cl = e.lines.filter((l) => l.id === cptId);
const text = await panel().textContent();
check('each CPT-1 line costs what the engine says, on the saved project', cl.length === 3 && cl.every((l) => text.includes(money(l.total))), cl.map((l) => [l.unit, l.material_qty, l.labor_qty, l.total]));
check('LF material on lf_net (waste), labor on measured LF', cl[1].material_qty === cptRow.lf_net && cl[1].labor_qty === cptRow.lf && cl[1].material_cost === Math.round(cptRow.lf_net * 2 * 100) / 100, cl[1]);
check('EA: 2 × $40 material + 2 × $25 labor = $130', cl[2].material_qty === 2 && cl[2].total === 130, cl[2]);
check('panel base bid equals the engine', text.includes(money(e.total)), { total: e.total, complete: e.complete });
await page.screenshot({ path: join(out, '2-estimate-three-lines-priced.png') });

// Excel: three CPT-1 rows; every tab ends with the watermark and prints it as the footer.
let dl = page.waitForEvent('download');
await panel().getByRole('button', { name: /^Excel$/ }).click();
const xlsx = unzipSync(new Uint8Array(readFileSync(await (await dl).path())));
const tabs = Object.keys(xlsx).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
const s1 = strFromU8(xlsx['xl/worksheets/sheet1.xml']);
check('Excel Estimate tab has three CPT-1 rows', (s1.match(/<t>CPT-1<\/t>/g) || []).length === 3);
check('every Excel tab carries the watermark cell and print footer', tabs.length >= 2 && tabs.every((k) => { const x = strFromU8(xlsx[k]); return x.includes(`<t>${escXml(OT_WATERMARK)}</t>`) && x.includes(`<oddFooter>${escXml(`&C${OT_WATERMARK}`)}</oddFooter>`); }), tabs);

// Proposal PDF: scope lists the three lines; every page watermarked.
await panel().getByRole('button', { name: /Proposal PDF/ }).click();
await page.waitForTimeout(500);
dl = page.waitForEvent('download');
await page.getByRole('button', { name: /^Download PDF$/ }).click();
const pdf = await PDFDocument.load(readFileSync(await (await dl).path()));
const ptexts = pdf.getPages().map((pg) => pg.node.Contents().asArray().map((ref) => { const st = pdf.context.lookup(ref), f = st.dict.lookup(PDFName.of('Filter')); return Buffer.from(String(f) === '/FlateDecode' ? inflateSync(st.contents) : st.contents).toString('latin1'); }).join(''));
check('proposal: every page has the diagonal and the footer line', ptexts.length >= 1 && ptexts.every((t) => t.includes(hex(OT_NAME)) && t.includes(hex(OT_WATERMARK))), ptexts.length);
check('proposal scope prints the SY, LF and EA quantities', ['SY', 'LF', 'EA'].every((u) => ptexts[0].includes(hex(u))));
await page.getByRole('dialog', { name: 'Proposal' }).getByTitle('Close (Esc)').click();
await page.waitForTimeout(300);
await panel().getByRole('button', { name: 'Close estimate' }).click();
await page.waitForTimeout(400);

// Assembly: add a per-piece item to CPT-1 (2 plates per EA, +5% waste), save the assembly, apply to LVT-1.
await pick('CPT-1');
const MAT = 'Supporting Materials — labor, subfloor & materials for this condition';
if (!(await page.getByTitle(MAT).count())) await page.getByTitle('Measured quantities, conditions, and supporting materials').first().click();
await page.waitForTimeout(400);
await page.getByTitle(MAT).first().click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: '+ add material' }).click();
const rowEl = page.locator('input[name=material-name]').last().locator('..');
await page.locator('input[name=material-name]').last().fill('Floor box plate');
await rowEl.locator('select[name=material-rule]').selectOption('each');
await rowEl.locator('input[name=material-per]').fill('2');
await rowEl.locator('input[name=material-unit]').fill('ea');
await rowEl.locator('select[name=material-basis]').selectOption('count');
await rowEl.locator('input[name=material-waste]').fill('5');
await page.locator('[data-assembly-bar]').getByRole('button', { name: 'save as…' }).click();
await page.locator('input[name=assembly-name]').fill('Carpet + floor boxes');
await page.locator('input[name=assembly-name]').press('Enter');
await settle();
await page.screenshot({ path: join(out, '3-assembly-saved.png') });
doc = await saved();
cpt = doc.conditions.find((c) => c.id === cptId);
const plate = cpt.materials.find((m) => m.name === 'Floor box plate');
check('the new item saved with rule each, per 2, count basis, 5% waste', plate && plate.rule === 'each' && plate.per === 2 && plate.basis === 'count' && plate.waste_pct === 5, plate);
const [rowNow] = conditionTotals(doc.conditions, doc.shapes).filter((r) => r.id === cptId);
check('its order qty: 2 per EA × 2 EA × 1.05 = 4.2 → 5 whole', rowNow.materials.find((m) => m.name === 'Floor box plate').qty === 5, rowNow.materials);
const lib = await page.evaluate(() => JSON.parse(localStorage.getItem('opentakeoff_assembly_library') || '[]'));
check('assembly library holds the recipe, never a price', lib.length === 1 && lib[0].name === 'Carpet + floor boxes' && lib[0].items.length === 2 && !JSON.stringify(lib).includes('price'), lib);

await pick('LVT-1');
await page.waitForTimeout(300);
const matBtn = page.getByTitle('Supporting Materials — labor, subfloor & materials for this condition').first();
if (!(await page.locator('[data-assembly-bar]').count())) await matBtn.click();
await page.waitForTimeout(300);
await page.locator('[data-assembly-bar] select[name=apply-assembly]').selectOption({ label: 'Carpet + floor boxes · 2 items' });
await settle();
const applied = await page.locator('[data-assembly-bar] [role=status]').textContent();
doc = await saved();
const lvt = doc.conditions.find((c) => c.finish_tag === 'LVT-1');
check('applied to LVT-1: plate added, its existing Adhesive skipped, no price carried', lvt.materials.filter((m) => m.name === 'Adhesive').length === 1 && lvt.materials.some((m) => m.name === 'Floor box plate' && m.rule === 'each' && m.waste_pct === 5 && !('price' in m)) && /Adhesive already on LVT-1/.test(applied || ''), { names: lvt.materials.map((m) => m.name), applied });
await page.screenshot({ path: join(out, '4-assembly-applied-lvt.png') });

// Estimate again: the CPT-1 plate is an item on the SY line, unpriced until a price is typed.
await page.getByRole('button', { name: /^Estimate$/ }).first().click();
await page.waitForTimeout(600);
e = engine(await saved());
const main = e.lines.find((l) => l.id === cptId && l.main);
check('CPT-1 item list on the main line includes the plate, missing its price', main.materials.some((m) => m.name === 'Floor box plate' && m.qty === 5 && m.price === null) && main.missing.includes('material row: Floor box plate'), main.missing);
check('total reads "priced so far" while the plate is unpriced', /Base bid — priced so far/.test(await panel().textContent()));
await line('SY').getByRole('button', { name: /2 items/ }).click();
await page.locator('tr[data-estimate-item="Floor box plate"] input[name=price-supply]').fill('4');
await page.locator('tr[data-estimate-item="Floor box plate"] input[name=price-supply-labor]').fill('10');
await settle();
e = engine(await saved());
const plateLine = e.lines.find((l) => l.id === cptId && l.main).materials.find((m) => m.name === 'Floor box plate');
check('plate: material 5 × $4 = $20 on the order qty, labor 4 × $10 = $40 on the measured qty', plateLine.cost === 20 && plateLine.labor_qty === 4 && plateLine.labor_cost === 40, plateLine);
check('panel base bid equals the engine after item prices', (await panel().textContent()).includes(money(e.total)), e.total);
await page.screenshot({ path: join(out, '5-estimate-assembly-items.png') });
check('no page errors', errors.length === 0, errors);

await browser.close();
const results = { base: BASE, passed: checks.filter((c) => c.ok).length, total: checks.length, checks };
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(`${results.passed}/${results.total}`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail ?? '')}`);
process.exit(results.passed === results.total ? 0 : 1);
