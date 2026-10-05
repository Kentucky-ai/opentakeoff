// Run from web/ after building bench/ocr-codes. Playwright is optional review
// tooling, installed outside the project (see the benchmark README).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.argv[2] || '/tmp/ocr-code-review');
mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-ocr-codes', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((accept, reject) => {
    server.stdout.on('data', (b) => { if (String(b).includes('127.0.0.1:4174')) accept(); });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`preview exited ${code}`)));
  });
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [], blockedRequests = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', (r) => {
    if (r.request().url().startsWith('http://127.0.0.1:4174/') || r.request().url().startsWith('blob:')) return r.continue();
    blockedRequests.push(r.request().url()); return r.abort();
  });
  await page.goto('http://127.0.0.1:4174/bench/ocr-codes/index.html');
  async function run(check) {
    await page.locator('#verify').setChecked(check);
    await page.getByRole('button', { name: 'Read fixtures', exact: true }).click();
    await page.waitForSelector('#output[data-done],#output[data-error]', { timeout: 180000 });
    const data = JSON.parse(await page.locator('#output').innerText());
    assert.equal(!!data.codeCheck, check);
    return data;
  }
  await run(true); // warm the models before paired measurements
  const times = []; let checked;
  for (let n = 0; n < 3; n++) {
    const baseline = await run(false); checked = await run(true);
    times.push({ baselineMs: baseline.results.reduce((s, r) => s + r.ms, 0), checkedMs: checked.results.reduce((s, r) => s + r.ms, 0) });
    assert.equal(checked.summary.unflaggedWrong, 0);
    assert.equal(checked.results.find((f) => f.control).summary.flaggedCorrect, 0);
    assert.deepEqual(baseline.results.map((f) => f.rows.map((r) => r.actual)), checked.results.map((f) => f.rows.map((r) => r.actual)));
  }
  writeFileSync(`${out}/checked-browser.json`, JSON.stringify(checked, null, 2) + '\n');
  await page.locator('#fixture').selectOption('arial-narrow-400-100');
  await page.locator('#review').click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Select all', exact: true }).click();
  const flags = await dialog.locator('span[id$="-check"]').evaluateAll((es) => es.map((e) => ({ text: e.textContent, selected: e.parentElement.querySelector('input[type="checkbox"]').checked })));
  assert.ok(flags.length > 0); assert.ok(flags.every((f) => !f.selected));
  // Group selection follows the same rule, while an individual check is allowed.
  const group = dialog.locator('input[data-state]');
  assert.equal(await group.isDisabled(), true, "all scanned codes need individual review");
  assert.equal(await dialog.locator('span[id$="-check"]').evaluateAll((es) => es.some((e) => e.parentElement.querySelector('input[type="checkbox"]').checked)), false);
  await dialog.screenshot({ path: `${out}/dialog-desktop.png` });
  const row = dialog.getByRole('button', {name: 'S-3', exact: true}).locator('..');
  await row.locator('input[type="checkbox"]').check();
  assert.equal(await row.locator('input[type="checkbox"]').isChecked(), true);
  await row.locator('input[type="checkbox"]').uncheck();
  assert.equal(await row.getByTitle('Click to fix the code', { exact: true }).innerText(), 'S-3');
  await row.getByTitle('Click to fix the code', { exact: true }).click();
  await dialog.locator('input:not([type="checkbox"])').fill('SS-3');
  // Editing removes the warning used to locate this row, so press on focus.
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Select all', exact: true }).click();
  await dialog.getByRole('button', { name: /Create .* conditions?/i }).click();
  const selected = JSON.parse(await page.locator('#output').getAttribute('data-created'));
  assert.ok(selected.some((r) => r.finish_tag === 'SS-3'));
  assert.ok(!selected.some((r) => r.finish_tag === 'S-3'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#review').click(); await dialog.waitFor();
  await dialog.screenshot({ path: `${out}/dialog-mobile.png` });
  const mobile = await dialog.evaluate((e) => ({ width: e.clientWidth, scrollWidth: e.scrollWidth }));
  assert.equal(mobile.width, mobile.scrollWidth);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.locator('#fixture').selectOption('combined-guards');
  await page.locator('#review').click(); await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Select all', exact: true }).click();
  const legacy = dialog.getByRole('button', { name: 'G-01(C)', exact: true }).locator('..');
  assert.equal(await legacy.locator('input[type="checkbox"]').isDisabled(), true);
  assert.equal(await legacy.locator('input[type="checkbox"]').isChecked(), false);
  assert.ok((await dialog.innerText()).toLowerCase().includes('check existing g-01c'));
  assert.ok((await dialog.innerText()).includes('Verify scanned codes'));
  assert.ok((await dialog.innerText()).includes('Some codes may already exist without parentheses'));
  const disputed = dialog.getByRole('button', { name: 'S-2', exact: true }).locator('..');
  assert.equal(await disputed.locator('input[type="checkbox"]').isChecked(), false);
  await disputed.locator('input[type="checkbox"]').check();
  await dialog.getByRole('button', { name: 'PT-1', exact: true }).locator('..').locator('input[type="checkbox"]').check();
  await dialog.screenshot({ path: `${out}/combined-guards.png` });
  await dialog.getByRole('button', { name: /Create 2 conditions/i }).click();
  const combinedCreated = JSON.parse(await page.locator('#output').getAttribute('data-created')).map((r) => r.finish_tag);
  assert.deepEqual(combinedCreated, ['S-2', 'PT-1']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#review').click(); await dialog.waitFor();
  const combinedMobile = await dialog.evaluate((e) => ({ width: e.clientWidth, scrollWidth: e.scrollWidth }));
  assert.equal(combinedMobile.width, combinedMobile.scrollWidth);
  await dialog.screenshot({ path: `${out}/combined-guards-mobile.png` });
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.setViewportSize({width: 1280, height: 960});
  await page.locator('#fixture').selectOption('remaining-cases');
  await page.locator('#review').click(); await dialog.waitFor();
  await dialog.getByRole('button', {name: 'Select all', exact: true}).click();
  assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(), 0);
  const stable = dialog.getByRole('button', {name: 'P-110', exact: true}).locator('..');
  assert.equal(await stable.locator('input[type="checkbox"]').isChecked(), false);
  const missing = dialog.getByRole('button', {name: 'set code', exact: true}).locator('..');
  assert.equal(await missing.locator('input[type="checkbox"]').isDisabled(), true);
  assert.ok((await dialog.innerText()).includes('88-2 / SS-2'));
  await dialog.screenshot({path: `${out}/remaining-cases.png`});
  await missing.getByRole('button', {name: 'set code', exact: true}).click();
  await dialog.locator('input:not([type="checkbox"])').fill('SS-2'); await page.keyboard.press('Enter');
  await dialog.getByRole('button', {name: 'Select all', exact: true}).click();
  await stable.locator('input[type="checkbox"]').check();
  await dialog.getByRole('button', {name: 'Create 2 conditions', exact: true}).click();
  const remainingCreated = JSON.parse(await page.locator('#output').getAttribute('data-created')).map(r => r.finish_tag);
  assert.deepEqual(remainingCreated, ['P-110', 'SS-2']);
  assert.deepEqual(errors, []);
  const report = { layout: 'Actual OCR code readings placed in a constructed table; invented headers and descriptions. This measures dialog behavior, not image table extraction. Combined guard case is separately constructed.', browser: await browser.version(), errors, blockedRequests, times, flags, groupSelectionSkipsWarnings: true, explicitSelectionWorks: true, correctedTagCreated: 'SS-3', selectedTags: selected.map((r) => r.finish_tag), mobile, combinedCreated, combinedMobile, remainingCreated, stableAgreementHeld: true, recoveredNumericCodeRequiresEdit: true };
  writeFileSync(`${out}/ui-check.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(`OCR code checks and dialog assertions passed; evidence: ${out}`);
} finally { await browser?.close(); server.kill(); }
