// Run from web/ with the dev server up (npm run dev -- --port 5191):
//   PLAYWRIGHT_MODULE=/.../playwright/index.mjs node scripts/verify-company-setup.mjs ../docs/review/company-setup [http://localhost:5191/]
// Opens the bundled sample, fills Company setup from the File menu with placeholder values, checks what
// was saved, follows the Project info link back to it, exports the .otprofile, wipes the browser's
// company records, imports the profile and checks everything came back. Also screenshots the dialog
// at phone width and checks it never scrolls sideways.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = pw.chromium ?? pw.default.chromium;
const out = resolve(process.argv[2]), BASE = process.argv[3] || 'http://localhost:5191/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const checks = [], errors = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1500 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', e => errors.push(String(e)));
const ls = (k) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), k);
const dialog = () => page.getByRole('dialog', { name: 'Company setup' });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Just open the sample plan/ }).click();
await page.waitForTimeout(7000);

// File → Company setup…
await page.getByTitle('Files and workspace').click();
await page.getByRole('button', { name: /^Company setup…/ }).click();
check('File → Company setup… opens the dialog', await dialog().isVisible());
const d = dialog();
await d.locator('input[name=company-name]').fill('Sample Flooring Co');
await d.locator('textarea[name=company-address]').fill('100 Example Ave\nAnytown, ST 00000');
await d.locator('input[name=company-phone]').fill('555-0100');
await d.locator('input[name=company-email]').fill('bids@example.com');
await d.locator('input[name=company-license]').fill('LIC-000');
await d.locator('input[name=estimating-overhead_pct]').fill('10');
await d.locator('input[name=estimating-profit_pct]').fill('25');
await d.locator('input[value=margin]').check();
await d.locator('input[name=estimating-tax_pct]').fill('6');
await d.locator('input[name=estimating-valid_days]').fill('45');
await d.locator('textarea[name=proposal-inclusions]').fill('Material and labor for the scope shown');
await d.locator('textarea[name=proposal-exclusions]').fill('Floor prep beyond 1/8 in. in 10 ft');
await d.locator('textarea[name=proposal-terms]').fill('Net 30');
check('typing in the dialog never arms a canvas tool (the name kept every letter)', (await d.locator('input[name=company-name]').inputValue()) === 'Sample Flooring Co');
check('margin preview reads ×1.333', /× 1\.333/.test(await d.textContent()));
await d.screenshot({ path: join(out, 'company-setup.png') });

const profiles = await ls('opentakeoff_company_profiles');
const prof = profiles?.profiles?.[0] || {};
check('trade name saved with phone, email, license', prof.name === 'Sample Flooring Co' && prof.phone === '555-0100' && prof.email === 'bids@example.com' && prof.license === 'LIC-000', prof);
const defaults = await ls('opentakeoff_estimating_defaults');
check('estimating defaults saved', defaults && defaults.overhead_pct === 10 && defaults.profit_pct === 25 && defaults.profit_mode === 'margin' && defaults.tax_pct === 6 && defaults.valid_days === 45, defaults);
check('proposal text saved', defaults && defaults.terms === 'Net 30' && /Floor prep/.test(defaults.exclusions), defaults && { inclusions: defaults.inclusions, exclusions: defaults.exclusions, terms: defaults.terms });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Esc closes the dialog', !(await dialog().count()));

// Report → Project info shows the same identity and links to Company setup.
await page.getByRole('button', { name: /^Report$/ }).first().click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: /^Project info$/ }).click();
await page.waitForTimeout(400);
check('Project info shows the shared trade name', (await page.locator('input[name=company-name]').inputValue()) === 'Sample Flooring Co');
await page.getByRole('button', { name: /Company setup — markups and proposal terms/ }).click();
await page.waitForTimeout(400);
check('Project info links to Company setup', await dialog().isVisible());
check('Company setup reopens with the saved overhead', (await dialog().locator('input[name=estimating-overhead_pct]').inputValue()) === '10');
// Start the profile round-trip from a clean canvas (the report stays open behind the dialogs).
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(6000);
const reopen = page.getByRole('button', { name: /Just open the sample plan/ });
if (await reopen.count()) { await reopen.click(); await page.waitForTimeout(7000); }

// Export profile → wipe → import profile.
await page.getByTitle('Files and workspace').click();
const dl = page.waitForEvent('download');
await page.getByRole('button', { name: /^Export profile…/ }).click();
const file = join(tmpdir(), `verify-company-setup-${Date.now()}.otprofile`);
await (await dl).saveAs(file);
const exported = JSON.parse(readFileSync(file, 'utf8'));
check('.otprofile carries company_profiles and estimating_defaults', exported.company_profiles?.profiles?.[0]?.license === 'LIC-000' && exported.estimating_defaults?.terms === 'Net 30');
await page.evaluate(() => { for (const k of ['opentakeoff_company_profiles', 'opentakeoff_company', 'opentakeoff_estimating_defaults']) localStorage.removeItem(k); });
check('wiped before import', (await ls('opentakeoff_company_profiles')) === null && (await ls('opentakeoff_estimating_defaults')) === null);
const backup = page.waitForEvent('download');
await page.locator('input[name=profile-import]').setInputFiles(file);
await backup;   // applying a profile downloads the current setup as a backup first
await page.waitForTimeout(1500);
const restored = await ls('opentakeoff_company_profiles');
const restoredDefaults = await ls('opentakeoff_estimating_defaults');
check('import restores the trade name and contact fields', restored?.profiles?.[0]?.email === 'bids@example.com');
check('import restores the defaults and proposal text', restoredDefaults?.profit_mode === 'margin' && restoredDefaults?.terms === 'Net 30');

// Phone width: the dialog fits without sideways scroll.
await page.setViewportSize({ width: 390, height: 844 });
await page.getByTitle('Files and workspace').click();
await page.getByRole('button', { name: /^Company setup…/ }).click();
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => {
  const el = document.querySelector('[role=dialog][aria-label="Company setup"]');
  return el ? Math.max(0, el.scrollWidth - el.clientWidth, el.getBoundingClientRect().right - window.innerWidth) : -1;
});
check('no sideways scroll at 390 px', overflow === 0, overflow);
await page.screenshot({ path: join(out, 'company-setup-phone.png') });
check('no page errors', errors.length === 0, errors);

await browser.close();
const results = { base: BASE, passed: checks.filter(c => c.ok).length, total: checks.length, checks };
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(`${results.passed}/${results.total}`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail ?? '')}`);
process.exit(results.passed === results.total ? 0 : 1);
