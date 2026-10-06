// Run from web/ after `npm run build`:
//   PLAYWRIGHT_MODULE=/.../index.mjs BROWSER_PATH=/.../chrome \
//   node scripts/verify-sheet-tree.mjs ../docs/review/sheet-folder-tree/results.json [dist]
// Makes a 6 x 5 generated plan set (scripts/make-sheet-set.mjs, nothing committed),
// then drives the Premium Sheets tree: numbers after open, after the gallery,
// after a reload; reader timings; themes; a narrow viewport; the keyboard.
// Screenshots go next to results.json.
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.argv[2]), dist = resolve(process.argv[3] || 'dist');
const shots = dirname(out);
mkdirSync(shots, { recursive: true });
const BASE = 'http://127.0.0.1:5271/';
const FILES = 6, PAGES = 5;

const setDir = process.env.SET_DIR ? resolve(process.env.SET_DIR) : mkdtempSync(join(tmpdir(), 'sheet-set-'));
execFileSync(process.execPath, ['scripts/make-sheet-set.mjs', setDir, '--files', String(FILES), '--pages', String(PAGES), '--filler', '2000'], { stdio: 'inherit' });
const manifest = JSON.parse(readFileSync(join(setDir, 'expected.json'), 'utf8'));
const expected = manifest.map(m => m.number).sort();
const paths = readdirSync(setDir).filter(f => f.endsWith('.pdf')).sort().map(f => join(setDir, f));

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5271', '--strictPort', '--outDir', dist]);
await new Promise((res, rej) => { server.stdout.once('data', res); server.once('error', rej); server.once('exit', c => rej(new Error(`server exited ${c}`))); });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const consoleErrors = [], blocked = new Set(), checks = [];
let spawns = 0, phase = 'open';
page.on('worker', w => { if (w.url().includes('pdf.worker')) spawns++; });
page.on('pageerror', e => consoleErrors.push({ phase, error: String(e) }));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push({ phase, type: m.type(), text: m.text(), url: m.location().url }); });
await page.route('**/*', r => {
  const url = r.request().url();
  if (/^(http:\/\/127\.0\.0\.1:5271\/|blob:|data:)/.test(url)) return r.continue();
  blocked.add(url); return r.abort();
});
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8 });
  Object.defineProperty(navigator, 'deviceMemory', { value: 8 });
});
const shot = async (name, top = true) => {
  // the panel back at its top, so the first folders are in the picture
  if (top) await page.evaluate(() => { for (let e = document.querySelector('[role=tree]'); e; e = e.parentElement) if (e.scrollTop) e.scrollTop = 0; });
  await page.mouse.move(900, 600); // off the panel: no hover highlight in the picture
  await page.screenshot({ path: join(shots, name) }); console.log('shot', name);
};
const check = (label, ok, detail) => { checks.push({ check: label, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); };
const rowTexts = () => page.locator('[role=treeitem]').evaluateAll(rs => rs.map(r => ({
  kind: r.classList.contains('calm-tree-folder') ? 'folder' : 'sheet',
  number: r.querySelector('strong.calm-sheet-number')?.textContent ?? null,
  text: r.innerText.replace(/\s+/g, ' ').trim(),
})));
const numbersShown = async () => (await rowTexts()).filter(r => r.number).map(r => r.number).sort();
// every folder open, so every sheet row is on screen
const expandAll = async () => {
  for (let i = 0; i < FILES + 2; i++) {
    const closed = page.locator('.calm-tree-folder[aria-expanded=false]');
    if (!(await closed.count())) break;
    await closed.first().click();
  }
};
const sheetsPanel = async () => {
  if (!(await page.getByRole('tree', { name: 'Sheets' }).isVisible().catch(() => false))) await page.getByRole('button', { name: 'Sheets', exact: true }).click();
  await page.getByRole('tree', { name: 'Sheets' }).waitFor();
};
const settle = async ms => { await page.waitForTimeout(ms); };
const results = { expected };
let report;
try {
  // 1. open
  await page.goto(BASE + '?workspace=premium');
  await page.locator('input[name="sheet-file"]').first().setInputFiles(paths);
  // adding files lands on the gallery: open the first sheet from its card
  await page.waitForFunction(n => document.querySelectorAll('[data-sheetkey]').length === n, FILES * PAGES, { timeout: 60000 });
  await page.locator('[data-sheetkey]').first().getByTitle('Open just this sheet', { exact: true }).dispatchEvent('click');
  await page.locator('[data-sheetkey]').first().waitFor({ state: 'detached', timeout: 30000 });
  await settle(3000);
  await sheetsPanel();
  await expandAll();
  await settle(1000);
  results.rowsAfterOpen = await rowTexts();
  results.shownAfterOpen = await numbersShown();
  await shot('01-tree-after-open.png');

  // 3. gallery: every card into view, thumbnails drawn, close
  phase = 'gallery';
  await page.getByRole('button', { name: 'Open visual gallery', exact: true }).click();
  await page.locator('[data-sheetkey]').first().waitFor();
  const cards = await page.locator('[data-sheetkey]').count();
  for (let i = 0; i < cards; i++) { await page.locator('[data-sheetkey]').nth(i).scrollIntoViewIfNeeded(); await settle(150); }
  const drawn = () => page.evaluate(() => [...document.querySelectorAll('[data-sheetkey] img')].filter(i => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0).length);
  const t0 = Date.now(); let last = -1, same = 0;
  while (Date.now() - t0 < 90000 && same < 6) { const n = await drawn(); same = n === last ? same + 1 : 0; last = n; await settle(500); }
  results.galleryCards = cards; results.galleryThumbnailsDrawn = last;
  await shot('02-gallery-all-thumbnails.png');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-sheetkey]').first().waitFor({ state: 'detached' });
  phase = 'after gallery';
  await sheetsPanel();
  await expandAll();
  await settle(500);
  results.shownAfterGallery = await numbersShown();
  await shot('03-tree-after-gallery.png');

  // 4. reader durations
  const durations = await page.evaluate(() => performance.getEntriesByName('sheet-number').map(e => e.duration));
  durations.sort((a, b) => a - b);
  results.readerMs = { count: durations.length, p95: durations.length ? +durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)].toFixed(2) : null, max: durations.length ? +durations[durations.length - 1].toFixed(2) : null };
  await page.evaluate(() => performance.clearMeasures('sheet-number'));

  // 5. reload
  phase = 'reload';
  const spawnsBefore = spawns;
  await page.reload();
  await page.locator('canvas').first().waitFor({ timeout: 60000 }).catch(() => {});
  await sheetsPanel();
  await expandAll();
  results.shownAfterReload = await numbersShown();
  results.workerSpawnsAfterReload = spawns - spawnsBefore;
  await settle(1500);
  results.shownAfterReloadSettled = await numbersShown();
  results.workerSpawnsAfterReloadSettled = spawns - spawnsBefore;
  results.rowsAfterReload = await rowTexts();
  await shot('04-tree-after-reload.png');

  // 6. themes, narrow viewport, keyboard
  phase = 'themes';
  const setLook = async label => {
    await page.getByRole('button', { name: 'Layout', exact: false }).filter({ hasText: 'Layout' }).first().click();
    await page.getByLabel('Workspace surface').selectOption(label);
    await page.getByRole('button', { name: 'Close layout settings' }).click();
    await settle(400);
  };
  await setLook('light');
  await sheetsPanel();
  await shot('05-tree-light-theme.png');
  await setLook('graphite');
  await sheetsPanel();
  await shot('06-tree-graphite-theme.png');
  await page.setViewportSize({ width: 900, height: 900 });
  await settle(500);
  await sheetsPanel();
  await shot('07-tree-900px-wide.png');
  results.narrow = await page.evaluate(() => ({ docScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  check('900 px: no horizontal page scroll', results.narrow.docScrollWidth <= results.narrow.innerWidth, results.narrow);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await settle(400);

  phase = 'keyboard';
  const kb = [];
  const focused = () => page.evaluate(() => { const a = document.activeElement; return a?.closest?.('[role=treeitem]') ? (a.getAttribute('data-row') || '') : `(${a?.tagName}${a?.getAttribute?.('aria-label') ? ' ' + a.getAttribute('aria-label') : ''})`; });
  await sheetsPanel();
  await page.getByLabel('Find a sheet').focus();
  await page.keyboard.press('Tab');
  kb.push({ key: 'Tab (search box into tree)', focus: await focused() });
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'End', 'Home', 'ArrowLeft', 'ArrowRight', 'ArrowRight']) {
    await page.keyboard.press(key);
    kb.push({ key, focus: await focused() });
  }
  results.focusedElementsAtShot = await page.evaluate(() => [...document.querySelectorAll(':focus, :focus-within')].map(e => `${e.tagName}${e.getAttribute('role') ? '[' + e.getAttribute('role') + ']' : ''}${e.className ? '.' + String(e.className).split(' ')[0] : ''}`));
  await shot('08-keyboard-focus-row.png', false);
  const toolBefore = await page.evaluate(() => document.querySelector('[aria-pressed=true][data-tool], [data-tool][aria-pressed=true]')?.getAttribute('data-tool') ?? null);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  const rowsAfterDelete = (await rowTexts()).length;
  kb.push({ key: 'Delete, Backspace', rowsBefore: results.rowsAfterReload.length, rowsAfter: rowsAfterDelete });
  await page.keyboard.press('Tab');
  kb.push({ key: 'Tab (leaves the tree)', focus: await focused() });
  results.keyboard = kb;
  check('keyboard: Delete/Backspace on a row remove nothing', rowsAfterDelete >= results.rowsAfterReload.length - 0, { rowsAfterDelete });
  check('keyboard: Tab leaves the tree', !kb[kb.length - 1].focus.startsWith('file') && !(kb[kb.length - 1].focus.includes('::') ));

  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('all 30 numbers shown after the gallery', eq(results.shownAfterGallery, expected), { got: results.shownAfterGallery.length });
  check('all 30 numbers shown after the reload', eq(results.shownAfterReload, expected), { got: results.shownAfterReload.length });
  check('reader max < 50 ms', results.readerMs.max !== null && results.readerMs.max < 50, results.readerMs);
  check('no console errors but blocked requests', consoleErrors.filter(m => !(m.url && blocked.has(m.url))).length === 0);
  report = { browser: browser.version(), set: `${FILES} files x ${PAGES} pages, filler 2000, generated by scripts/make-sheet-set.mjs`, ...results, consoleErrors, blockedRequests: [...blocked], checks, shots: readdirSync(shots).filter(f => f.endsWith('.png')).sort() };
  report = { expected: report.expected, shownAfterOpen: report.shownAfterOpen, shownAfterGallery: report.shownAfterGallery, shownAfterReload: report.shownAfterReload, readerMs: report.readerMs, workerSpawnsAfterReload: report.workerSpawnsAfterReload, consoleErrors, ...report };
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ shown: [results.shownAfterOpen.length, results.shownAfterGallery.length, results.shownAfterReload.length], readerMs: results.readerMs, spawns: results.workerSpawnsAfterReload, checks: checks.filter(c => !c.ok) }));
  if (checks.some(c => !c.ok)) process.exitCode = 1;
} catch (e) {
  console.log((await page.locator('body').innerText().catch(() => '')).slice(-2000));
  await page.screenshot({ path: join(tmpdir(), 'verify-sheet-tree.fail.png') }).catch(() => {});
  throw e;
} finally { await browser.close(); server.kill(); }
