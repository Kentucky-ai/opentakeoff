// Run from web/ with the dev server up (npm run dev -- --port 5191):
//   PLAYWRIGHT_MODULE=/.../playwright/index.mjs node scripts/verify-premium-plans.mjs ../docs/review/premium-pricing-link [http://localhost:5191/]
// Opens the bundled sample and checks that every Premium entry point (workspace header, plan gallery, ⋯ menu)
// opens https://kentucky-ai.com/#pricing in a new tab with no in-app dialog, then screenshots the buttons.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = pw.chromium ?? pw.default.chromium;
const out = resolve(process.argv[2]), BASE = process.argv[3] || 'http://localhost:5191/';
const PRICING = 'https://kentucky-ai.com/#pricing';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const checks = [], errors = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
// The pricing page itself is never loaded: the test only records which URL each button opened.
await context.route('https://kentucky-ai.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>pricing</title>' }));
const page = await context.newPage();
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE, { waitUntil: 'networkidle' });
async function clickOpens(locator, name) {
  const popup = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  if (!(await locator.click({ timeout: 1500 }).then(() => true, () => false))) return false;
  const tab = await popup;
  const url = tab ? tab.url() : null;
  check(`${name} opens the pricing section in a new tab`, url === PRICING, url);
  check(`${name} shows no in-app plans dialog`, (await page.locator('dialog.premium-plans-dialog').count()) === 0);
  await tab?.close();
  return true;
}
// Whichever Premium button is on top: the plan gallery's on first load, the workspace header's once a sheet is open.
async function clickTopTrigger(name, shot) {
  await page.screenshot({ path: join(out, shot) });
  for (const t of await page.locator('[data-premium-trigger]').all()) if (await clickOpens(t, name)) return;
  check(`${name} could be clicked`, false);
}
await clickTopTrigger('Gallery "Premium plans"', 'gallery-premium-button.png');
const sample = page.getByRole('button', { name: /sample/i }).first();
if (await sample.count()) { await sample.click(); await page.waitForTimeout(2500); }
for (const name of [/skip/i, /not now/i, /close/i]) { const b = page.getByRole('button', { name }).first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); }
// Open the first sheet so the workspace header, not the gallery, is on top.
const view = page.getByRole('button', { name: /^view$/i }).first();
if (await view.isVisible().catch(() => false)) { await view.hover().catch(() => {}); await view.click(); await page.waitForTimeout(2500); }
const labels = (await page.locator('[data-premium-trigger]').allTextContents()).map(s => s.trim());
check('every Premium button reads "Premium plans"', labels.length > 0 && labels.every(l => l === 'Premium plans'), labels);
await clickTopTrigger('Workspace "Premium plans"', 'workspace-premium-button.png');
// Classic layout ⋯ menu item.
const classic = page.getByRole('button', { name: /classic/i }).first();
if (await classic.isVisible().catch(() => false)) { await classic.click(); await page.waitForTimeout(800); }
const more = page.locator('[title^="More — guide"]').first();
check('Classic ⋯ menu is reachable', await more.isVisible().catch(() => false));
if (await more.isVisible().catch(() => false)) {
  await more.click();
  const item = page.getByRole('button', { name: /Premium plans — pricing on kentucky-ai\.com/ }).first();
  if (await item.isVisible().catch(() => false)) { await page.screenshot({ path: join(out, 'menu-premium-item.png') }); await clickOpens(item, '⋯ menu "Premium plans"'); }
  else check('⋯ menu lists "Premium plans — pricing on kentucky-ai.com"', false);
}
check('no page errors', errors.length === 0, errors);
writeFileSync(join(out, 'checks.json'), JSON.stringify({ base: BASE, checks }, null, 2));
await browser.close();
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || c.detail === undefined ? '' : `  ${JSON.stringify(c.detail)}`}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
