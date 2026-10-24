// Run from web/ with the dev server up (npm run dev -- --port 5191):
//   PLAYWRIGHT_MODULE=/.../playwright/index.mjs node --import tsx scripts/verify-bid-proposal.mjs ../docs/review/bid-proposal [http://localhost:5191/]
// A real takeoff on the bundled sample (plan scale, one CPT-1 and one LVT-1 Area trace), placeholder
// company setup and prices, then the bid proposal: the dialog copies the proposal text from Company
// setup, a job-only exclusion stays with the project, the downloaded PDF carries the letterhead,
// client, base bid (= lib/estimate.js on the saved project) and the OpenTakeoff watermark on every
// page; the marked set from the Report carries the watermark on every page too; the printed report
// strip carries the line. Pages render to PNG with pdftoppm (poppler) when it is installed.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName } from 'pdf-lib';
import { conditionTotals } from '../src/lib/totals.js';
import { priceEstimate } from '../src/lib/estimate.js';
import { OT_NAME, OT_WATERMARK } from '../src/lib/branding.js';
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
const hex = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
const money = (v) => `$${(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
async function pageTexts(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((pg) => {
    let s = '';
    for (const ref of pg.node.Contents().asArray()) {
      const st = doc.context.lookup(ref), f = st.dict.lookup(PDFName.of('Filter'));
      s += Buffer.from(String(f) === '/FlateDecode' ? inflateSync(st.contents) : st.contents).toString('latin1');
    }
    return s;
  });
}
const render = (pdf, first, last, prefix) => {
  try { execFileSync('pdftoppm', ['-png', '-r', '80', '-f', String(first), '-l', String(last), pdf, join(out, prefix)]); return true; } catch { return false; }
};
const saved = () => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('opentakeoff');
  r.onsuccess = () => { const g = r.result.transaction('meta').objectStore('meta').get('annotations'); g.onsuccess = () => { r.result.close(); res(g.result); }; };
}));
const DEFAULTS = { overhead_pct: 10, profit_pct: 15, profit_mode: 'markup', tax_pct: 6, valid_days: 30, inclusions: 'Material and labor for the scope listed\nStandard transitions at doorways', exclusions: 'Floor prep beyond 1/8 in. in 10 ft\nMoisture mitigation', terms: 'Net 30. Price holds for the dates shown.' };

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate((d) => {
  localStorage.setItem('opentakeoff_estimating_defaults', JSON.stringify(d));
  localStorage.setItem('opentakeoff_company_profiles', JSON.stringify({ profiles: [{ id: 'tp_sample', name: 'Sample Flooring Co', address: '100 Example Ave\nAnytown, ST 00000', phone: '555-0100', email: 'bids@example.com', license: 'LIC-000' }], activeId: 'tp_sample' }));
}, DEFAULTS);
await page.getByRole('button', { name: /Just open the sample plan/ }).click();
await page.waitForTimeout(7000);
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

// Price everything (placeholders).
await page.getByRole('button', { name: /^Estimate$/ }).first().click();
const est = page.getByRole('dialog', { name: 'Estimate' });
const line = (tag) => est.locator(`tr[data-estimate-line="${tag}"]`);
await line('CPT-1').locator('select[name=price-unit]').selectOption('SY');
await line('CPT-1').locator('input[name=price-material]').fill('20');
await line('CPT-1').locator('input[name=price-labor]').fill('5');
await line('LVT-1').locator('input[name=price-material]').fill('3.5');
await line('LVT-1').locator('input[name=price-labor]').fill('2');
for (const tag of ['CPT-1', 'LVT-1']) await line(tag).getByRole('button', { name: /1 material/ }).click();
const supplies = est.locator('input[name=price-supply]');
await supplies.nth(0).fill('40');
await supplies.nth(1).fill('30');
await page.waitForTimeout(400);
check('estimate fully priced before the proposal', !(await est.textContent()).includes('not fully priced'));

// Proposal dialog: text copied from Company setup; a job-only exclusion.
await est.getByRole('button', { name: /Proposal PDF/ }).click();
const dlg = page.getByRole('dialog', { name: 'Proposal' });
check('Proposal dialog opens from the Estimate', await dlg.isVisible());
check('proposal text copied from Company setup', (await dlg.locator('textarea[name=proposal-exclusions]').inputValue()) === DEFAULTS.exclusions);
check('letterhead line names the company', (await dlg.textContent()).includes('Sample Flooring Co'));
await dlg.locator('input[name=proposal-client-name]').fill('Example General Contractors');
await dlg.locator('textarea[name=proposal-client-address]').fill('200 Sample Rd\nAnytown, ST 00000');
await dlg.locator('input[name=proposal-client-reference]').fill('Bid 26-001');
await dlg.locator('input[name=proposal-itemized]').nth(1).check();
await dlg.locator('textarea[name=proposal-exclusions]').fill(DEFAULTS.exclusions + '\nAfter-hours work');
await dlg.locator('textarea[name=proposal-scope-note]').fill('Quantities from the sample finish plan AF101.');
await page.screenshot({ path: join(out, 'proposal-dialog.png') });
await page.waitForTimeout(2500);
const doc = await saved();
check('job-only exclusion saved with the project, not in Company setup', /After-hours work/.test(doc.bid_proposal?.exclusions || '') && !/After-hours/.test(await page.evaluate(() => localStorage.getItem('opentakeoff_estimating_defaults'))));
check('client saved with the project', doc.client_info?.client_name === 'Example General Contractors');
const e = priceEstimate({ rows: conditionTotals(doc.conditions, doc.shapes), conditions: doc.conditions, settings: doc.estimate_settings });

const dl = page.waitForEvent('download');
await dlg.getByRole('button', { name: /Download PDF/ }).click();
const file = await dl;
const proposalPdf = join(out, '.proposal.pdf');
await file.saveAs(proposalPdf);
check('file name is "<project> - proposal.pdf" for an unnamed project', file.suggestedFilename() === 'proposal.pdf', file.suggestedFilename());
const ptexts = await pageTexts(readFileSync(proposalPdf));
const p1 = ptexts[0];
for (const [label, s] of [['company', 'Sample Flooring Co'], ['license', 'License LIC-000'], ['client', 'Example General Contractors'], ['reference', 'Ref. Bid 26-001'], ['base bid = engine', money(e.total)], ['job-only exclusion', 'After-hours work'], ['terms', 'Net 30. Price holds for the dates shown.'], ['scope note', 'Quantities from the sample finish plan AF101.']]) {
  check(`proposal PDF shows the ${label}`, ptexts.some((t) => t.includes(hex(s))), s);
}
check('proposal: watermark and footer on every page', ptexts.every((t) => t.includes(hex(OT_NAME)) && t.includes(hex(OT_WATERMARK))), ptexts.length);
const rendered = render(proposalPdf, 1, ptexts.length, 'proposal-page');

// Marked set from the Report: watermark on every page.
await dlg.getByRole('button', { name: 'Close' }).click();
await est.getByRole('button', { name: 'Close estimate' }).click();
await page.getByRole('button', { name: /^Report$/ }).first().click();
await page.waitForTimeout(800);
check('printed report strip carries the line', (await page.locator('.report-flow > thead').first().textContent()).includes(OT_WATERMARK));
await page.getByTitle('Print the report, or generate the marked-set PDF').click();
const mdl = page.waitForEvent('download', { timeout: 120000 });
await page.getByRole('button', { name: /Download marked set/ }).click();
const mfile = await mdl;
const markedPdf = join(out, '.marked-set.pdf');
await mfile.saveAs(markedPdf);
const mtexts = await pageTexts(readFileSync(markedPdf));
check('marked set: watermark and footer on every page', mtexts.length >= 2 && mtexts.every((t) => t.includes(hex(OT_NAME)) && t.includes(hex(OT_WATERMARK))), mtexts.length);
if (rendered) render(markedPdf, 1, 2, 'marked-set-page');
check('pages rendered to PNG (pdftoppm)', rendered && existsSync(join(out, 'proposal-page-1.png')));
check('no page errors', errors.length === 0, errors);

await browser.close();
for (const f of [proposalPdf, markedPdf]) try { execFileSync('rm', ['-f', f]); } catch { /* best effort */ }
const results = { base: BASE, passed: checks.filter(c => c.ok).length, total: checks.length, checks };
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(`${results.passed}/${results.total}`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail ?? '')}`);
process.exit(results.passed === results.total ? 0 : 1);
