// Run from web/: PLAYWRIGHT_MODULE=/.../index.mjs BROWSER_PATH=/.../chrome
// node scripts/verify-doc-lru.mjs ../docs/review/302-doc-lru/fixed.json [dist]
// Twelve 3-page PDFs are made here from the bundled sample, each with its own
// marker word, so every file is a distinct document.
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.argv[2]), dist = resolve(process.argv[3] || 'dist');
const BASE = 'http://127.0.0.1:5261/';
const MARKERS = ['KESTREL', 'OSPREY', 'PLOVER', 'HERON', 'BITTERN', 'CURLEW', 'GANNET', 'WAXWING', 'NUTHATCH', 'TANAGER', 'GROSBEAK', 'PHALAROPE'];
const IDLE_CAP = 4; // docIdleMax on a desktop-class device (deviceMemory 8 below)
const name = i => `set-${String(i + 1).padStart(2, '0')}.pdf`;
const key = (file, p = 1) => (p > 1 ? `${file}#${p}` : file); // the app's sheet key

const sample = await PDFDocument.load(readFileSync('public/demo/sample-finish-plan.pdf'));
const files = [];
for (let i = 0; i < MARKERS.length; i++) {
  const doc = await PDFDocument.create();
  for (const p of await doc.copyPages(sample, [0, 1, 0])) doc.addPage(p);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of doc.getPages()) p.drawText(`MARKER ${MARKERS[i]}`, { x: 60, y: 60, size: 48, font, color: rgb(0.8, 0, 0) });
  doc.setTitle(`Synthetic set ${i + 1}`);
  files.push({ name: name(i), mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
}
const SHEETS = files.length * 3;

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5261', '--strictPort', '--outDir', dist]);
await new Promise((res, rej) => { server.stdout.once('data', res); server.once('error', rej); server.once('exit', code => rej(new Error(`server exited ${code}`))); });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [], consoleMessages = [], blocked = new Set();
let phase = 'gallery';
let spawns = 0;
page.on('worker', w => { if (w.url().includes('pdf.worker')) spawns++; });
page.on('pageerror', e => errors.push({ phase, error: String(e) }));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleMessages.push({ phase, type: m.type(), text: m.text(), url: m.location().url }); });
await page.route('**/*', r => {
  const url = r.request().url();
  if (/^(http:\/\/127\.0\.0\.1:5261\/|blob:|data:)/.test(url)) return r.continue();
  blocked.add(url); return r.abort();
});
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8 });
  Object.defineProperty(navigator, 'deviceMemory', { value: 8 });
  const NativeWorker = Worker;
  window.tileAudit = { opens: 0, tiles: 0, pending: new Set(), last: 0 };
  window.Worker = class extends NativeWorker {
    constructor(url, opts) {
      super(url, opts);
      this.auditTiles = String(url).includes('pdfTile.worker');
      if (this.auditTiles) this.addEventListener('message', ({ data: m }) => {
        window.tileAudit.last = performance.now();
        if (m.type === 'tile' || m.type === 'tileError') { window.tileAudit.pending.delete(m.reqId); window.tileAudit.tiles++; }
      });
    }
    postMessage(m, ...args) {
      if (this.auditTiles) {
        window.tileAudit.last = performance.now();
        if (m.type === 'openSheet') window.tileAudit.opens++;
        if (m.type === 'renderTile') window.tileAudit.pending.add(m.reqId);
        if (m.type === 'cancel') window.tileAudit.pending.delete(m.reqId);
      }
      return super.postMessage(m, ...args);
    }
  };
});
const docs = () => page.workers().filter(w => w.url().includes('pdf.worker')).length;
const thumbs = () => page.evaluate(() => [...document.querySelectorAll('[data-sheetkey] img')].filter(i => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0).map(i => i.closest('[data-sheetkey]').dataset.sheetkey));
// nothing changes for 2 s: pdf.js workers, spawns, drawn thumbnails, and no indexing line
const quiet = async (label, extra = async () => '') => {
  let last = '', same = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const sig = `${docs()}|${spawns}|${(await thumbs()).length}|${/Indexing \d/.test(await page.locator('body').innerText())}|${await extra()}`;
    if (sig === last && !sig.includes('|true|')) { if (++same >= 4) return; } else same = 0;
    last = sig;
    await page.waitForTimeout(500);
  }
  throw new Error(`${label}: never settled (${last})`);
};
// the canvas has opened `opens` sheets and every requested tile has landed
const canvasSettled = async opens => {
  await page.waitForFunction(min => {
    const a = window.tileAudit;
    return a.opens > min && a.tiles > 0 && !a.pending.size && performance.now() - a.last > 500;
  }, opens, { timeout: 60000 });
  await quiet('canvas');
};
const tabFiles = () => page.locator('[data-sheet-tab] > button:first-child').evaluateAll(bs => bs.map(b => b.title));
const openFromNavigator = async file => {
  const opens = await page.evaluate(() => window.tileAudit.opens);
  const item = page.locator(`.calm-sheet-list button[title$=" · ${file}"]`).first();
  if (!(await item.isVisible())) await page.getByRole('button', { name: 'Sheets', exact: true }).click();
  await item.click();
  await canvasSettled(opens);
};
const toGallery = async () => {
  const g = page.getByRole('button', { name: 'Open visual gallery', exact: true });
  if (!(await g.isVisible())) await page.getByRole('button', { name: 'Sheets', exact: true }).click();
  await g.click();
  await page.locator('[data-sheetkey]').first().waitFor();
};
const counts = {}, spawnsAt = {}, checks = [];
// a fixed-build check: recorded, and the run fails after writing its record
const check = (label, fn) => { try { fn(); checks.push({ check: label, ok: true }); } catch (e) { checks.push({ check: label, ok: false, message: e.message }); } };
const at = label => { counts[label] = docs(); spawnsAt[label] = spawns; };
// tabs on files whose cards are off the gallery's first screen
const [A, B, C] = [9, 10, 11].map(name);
try {
  await page.goto(BASE);
  await page.locator('input[name="sheet-file"]').first().setInputFiles(files);
  await page.waitForFunction(n => document.querySelectorAll('[data-sheetkey]').length === n, SHEETS, { timeout: 60000 });
  await quiet('gallery');
  at('gallery');

  phase = 'three tabs';
  // A from its gallery card's View button, clicked in place: scrolling down to
  // it would draw (and load) that row's thumbnails first. B and C from the list.
  const opens = await page.evaluate(() => window.tileAudit.opens);
  await page.locator(`[data-sheetkey="${key(A)}"]`).getByTitle('Open just this sheet', { exact: true }).dispatchEvent('click');
  await canvasSettled(opens);
  for (const f of [B, C]) await openFromNavigator(f);
  assert.deepEqual(await tabFiles(), [A, B, C].map(f => key(f)), 'three tabs open');
  at('threeTabs');

  // close A then B: B is the last closed
  phase = 'close two';
  for (const f of [A, B]) {
    await page.locator('[data-sheet-tab]').filter({ has: page.locator(`button[title="${key(f)}"]`) }).getByTitle('Close tab', { exact: true }).click();
  }
  await quiet('closed two tabs');
  assert.deepEqual(await tabFiles(), [key(C)], 'one tab left');
  at('afterClosingTwo');

  // reopen the last-closed file before anything else touches the cache
  phase = 'reopen';
  await openFromNavigator(B);
  await page.waitForTimeout(1500);
  at('afterReopen');
  counts.reopenSpawns = spawnsAt.afterReopen - spawnsAt.afterClosingTwo;

  // every thumbnail draws: scroll the gallery through, collecting drawn cards
  phase = 'gallery scroll';
  await toGallery();
  const drawn = new Set();
  const grid = page.locator('[data-sheetkey]').first().locator('xpath=ancestor::div[contains(@style,"overflow: auto")][1]');
  for (let top = 0; ; top += 400) {
    await grid.evaluate((el, y) => { el.scrollTop = y; }, top);
    await quiet('gallery scroll');
    for (const k of await thumbs()) drawn.add(k);
    if (await grid.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)) break;
  }
  at('afterGalleryScroll');
  counts.thumbnailsDrawn = drawn.size;

  // search one file's marker: its three sheets match
  phase = 'search';
  const target = 6;
  await page.getByPlaceholder('Search sheet text…', { exact: true }).fill(MARKERS[target]);
  const matchLine = page.getByText(/^\d+ of \d+ sheets match$/);
  await matchLine.waitFor({ timeout: 60000 });
  await quiet('search', () => matchLine.innerText());
  const match = await matchLine.innerText();
  const hits = await page.locator('[data-sheetkey]').evaluateAll(cs => cs.map(c => c.dataset.sheetkey));
  at('afterSearch');
  // the gallery with its search, before the tab switches leave it
  mkdirSync(resolve(out, '..'), { recursive: true });
  await page.screenshot({ path: out.replace(/\.json$/, '.png') });

  // preview one sheet of each of five other files: more than the idle cap,
  // so any file not kept for its tab is pushed out by them
  phase = 'previews';
  await page.getByPlaceholder('Search sheet text…', { exact: true }).fill('');
  await page.waitForFunction(n => document.querySelectorAll('[data-sheetkey]').length === n, SHEETS);
  const previewed = [0, 1, 2, 3, 4].map(name);
  for (const f of previewed) {
    await page.locator(`[data-sheetkey="${key(f)}"]`).getByRole('button', { name: 'Preview', exact: true }).dispatchEvent('click');
    const dialog = page.getByRole('dialog', { name: /^Sheet preview: / });
    await dialog.locator('canvas:not([hidden])').waitFor({ timeout: 60000 });
    await dialog.getByRole('button', { name: 'Close sheet preview', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  }
  await quiet('previews');
  at('afterPreviews');

  // the files in open tabs must still be loaded: switching to each starts no
  // pdf.js worker
  phase = 'switch tabs';
  const openTabs = await tabFiles();
  assert.deepEqual([...openTabs].sort(), [B, C].map(f => key(f)).sort(), 'two tabs open');
  const switchSpawns = {};
  // close the gallery back onto B, the last tab opened; then C, then B again
  {
    const before = spawns;
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('[data-sheetkey]').first().waitFor({ state: 'detached' });
    await quiet('gallery closed');
    at('galleryClosed');
    switchSpawns['gallery closed'] = spawns - before;
  }
  for (const f of [C, B]) {
    const before = spawns;
    await openFromNavigator(f);
    at(`switchTo ${f}`);
    switchSpawns[f] = spawns - before;
  }
  counts.totalSpawns = spawns;

  if (!process.env.BASELINE) {
    // pinned: none in the gallery, three with three tabs, one after closing two
    check(`gallery: at most ${IDLE_CAP} pdf.js documents`, () => assert.ok(counts.gallery <= IDLE_CAP, `${counts.gallery}`));
    check(`three tabs: at most 3 + ${IDLE_CAP}`, () => assert.ok(counts.threeTabs <= 3 + IDLE_CAP, `${counts.threeTabs}`));
    check(`after closing two: at most 1 + ${IDLE_CAP}`, () => assert.ok(counts.afterClosingTwo <= 1 + IDLE_CAP, `${counts.afterClosingTwo}`));
    check(`gallery scrolled and searched, two tabs open: at most 2 + ${IDLE_CAP}`, () => assert.ok(Math.max(counts.afterGalleryScroll, counts.afterSearch) <= 2 + IDLE_CAP, `${counts.afterGalleryScroll}, ${counts.afterSearch}`));
    check('reopening the last-closed tab loads no new pdf.js document', () => assert.equal(counts.reopenSpawns, 0));
    check('closing the gallery and switching to each open tab after the scroll and search loads no new pdf.js document', () => assert.deepEqual(switchSpawns, { 'gallery closed': 0, [key(C)]: 0, [key(B)]: 0 }));
    check(`five previews, two tabs open: at most 2 + ${IDLE_CAP}`, () => assert.ok(counts.afterPreviews <= 2 + IDLE_CAP, `${counts.afterPreviews}`));
    check('the search starts at most 2 pdf.js workers over the scrolled gallery', () => assert.ok(spawnsAt.afterSearch - spawnsAt.afterGalleryScroll <= 2, `${spawnsAt.afterSearch - spawnsAt.afterGalleryScroll}`));
    check('the gallery after adding 12 PDFs starts at most 18 pdf.js workers', () => assert.ok(spawnsAt.gallery <= 18, `${spawnsAt.gallery}`));
    check('every thumbnail drew', () => assert.equal(drawn.size, SHEETS));
    check('search line', () => assert.equal(match, `3 of ${SHEETS} sheets match`));
    check('search hits are the marked file\'s sheets', () => assert.deepEqual([...hits].sort(), [1, 2, 3].map(p => key(name(target), p)).sort()));
    check('no uncaught page errors', () => assert.deepEqual(errors, []));
    // console: nothing but the requests this script blocked, and the tile
    // workers' stale-detail warning main logs too on the reopen (#508's review)
    const known = (m) => (m.type === 'error' && blocked.has(m.url) && /Failed to load resource/.test(m.text))
      || (m.type === 'warning' && /^\[tiles\] detail crop failed — keeping the previous crop: Error: sheet not open/.test(m.text));
    check('no console errors or warnings but blocked requests and the known tile warning', () => assert.deepEqual(consoleMessages.filter(m => !known(m)), []));
  }
  const report = {
    browser: browser.version(), build: process.env.BASELINE ? 'baseline' : 'fixed',
    plan: `${files.length} PDFs made from the bundled sample-finish-plan.pdf, 3 pages each, one marker word per file`,
    layout: 'Premium (default)', device: { deviceMemory: 8, hardwareConcurrency: 8, idleCap: IDLE_CAP },
    sheets: SHEETS, tabs: { opened: [A, B, C], closed: [A, B], reopened: B, openAfterSearch: openTabs, switchedTo: [C, B] }, previewed,
    pdfjsDocuments: counts, pdfjsSpawnsSoFar: spawnsAt, tabSwitchSpawns: switchSpawns,
    search: { query: MARKERS[target], line: match, hits }, checks,
    blockedRequests: [...blocked], console: consoleMessages, errors,
  };
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  const failed = checks.filter(c => !c.ok);
  if (failed.length) { console.error('FAILED:', failed); process.exitCode = 1; }
} catch (e) { console.log({ counts, spawnsAt, errors, consoleMessages, spawns, docs: docs(), audit: await page.evaluate(() => ({ ...window.tileAudit, pending: [...window.tileAudit.pending] })) }); console.log((await page.locator('body').innerText()).slice(-3000)); await page.screenshot({ path: join(tmpdir(), 'verify-doc-lru.fail.png') }).catch(() => {}); throw e; }
finally { await browser.close(); server.kill(); }
