// Run from web/ with the dev server up (npm run dev -- --port 5191):
//   PLAYWRIGHT_MODULE=/.../playwright/index.mjs node scripts/verify-premium-plans.mjs ../docs/review/premium-plans [http://localhost:5191/]
// Opens the bundled sample, opens Premium plans from the toolbar and the ⋯ menu, checks the prices and the
// sign-up links, checks Escape closes it, and screenshots desktop and phone widths.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.argv[2]), BASE = process.argv[3] || 'http://localhost:5191/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [], errors = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
async function openSample(viewport) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const sample = page.getByRole('button', { name: /sample/i }).first();
  if (await sample.count()) { await sample.click(); await page.waitForTimeout(2500); }
  for (const name of [/skip/i, /not now/i, /close/i]) { const b = page.getByRole('button', { name }).first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); }
  return page;
}
const page = await openSample({ width: 1440, height: 950 });
// Both entry points: the workspace header and the plan gallery's header; click whichever is on top.
async function openPlans(pg) {
  for (const t of await pg.locator('[data-premium-trigger]').all()) if (await t.click({ timeout: 1500 }).then(() => true, () => false)) break;
  const d = pg.locator('dialog.premium-plans-dialog'); await d.waitFor({ state: 'visible' }); return d;
}
const labels = (await page.locator('[data-premium-trigger]').allTextContents()).map(s => s.trim());
check('every Premium button reads "Premium plans"', labels.length > 0 && labels.every(l => l === 'Premium plans'), labels);
check('no "Request Premium" text anywhere', !(await page.content()).includes('Request Premium'));
const dlg = await openPlans(page);
const text = await dlg.innerText();
for (const s of ['Individual Pro', '$149', 'Team Pro', '$399', '+$129 a seat, 250 credits each', '800 AI credits a month, shared', '300 AI credits a month', 'Enterprise', '50 AI credits']) check(`dialog shows ${s}`, text.includes(s));
const links = await dlg.locator('a').evaluateAll(as => as.map(a => ({ text: a.textContent.trim(), href: a.href, target: a.target })));
check('Individual Pro trial link', links.some(l => l.href === 'https://start.kentucky-ai.com/?plan=single#start' && l.target === '_blank'));
check('Team Pro trial link', links.some(l => l.href === 'https://start.kentucky-ai.com/?plan=team#start' && l.target === '_blank'));
check('sign-in link', links.some(l => l.href === 'https://start.kentucky-ai.com/#signin'));
check('no form or inputs in the dialog', (await dlg.locator('form, input, select').count()) === 0);
await page.screenshot({ path: join(out, 'premium-plans-desktop.png') });
await page.keyboard.press('Escape');
check('Escape closes the dialog', !(await dlg.isVisible()));
const record = await page.evaluate(() => localStorage.getItem('opentakeoff.premiumPrompt'));
check('closing records a dismissal (30-day snooze)', /"dismissed"/.test(record || ''), record);
const phone = await openSample({ width: 390, height: 844 });
if (await phone.locator('[data-premium-trigger]').count()) {
  const d = await openPlans(phone);
  const over = await d.evaluate(el => el.scrollWidth - el.clientWidth);
  check('phone: no sideways scroll in the dialog', over <= 0, over);
  await phone.screenshot({ path: join(out, 'premium-plans-phone.png'), fullPage: false });
} else check('phone: trigger visible', false);
check('no page errors', errors.length === 0, errors);
writeFileSync(join(out, 'results.json'), JSON.stringify({ base: BASE, checks }, null, 2) + '\n');
await browser.close();
const failed = checks.filter(c => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`); for (const f of failed) console.log('FAIL', f.name, f.detail ?? '');
process.exit(failed.length ? 1 : 0);
