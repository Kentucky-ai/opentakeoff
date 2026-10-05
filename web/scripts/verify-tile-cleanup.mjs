// Run from web/: PLAYWRIGHT_MODULE=/.../index.mjs BROWSER_PATH=/.../chrome
// node scripts/verify-tile-cleanup.mjs ../docs/review/508/fixed.json [dist]
import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.argv[2]), dist = resolve(process.argv[3] || 'dist');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5248', '--strictPort', '--outDir', dist]);
await new Promise((res, rej) => { server.stdout.once('data', res); server.once('error', rej); server.once('exit', code => rej(new Error(`server exited ${code}`))); });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(m.type(), m.text()); });
await page.route('**/*', r => /^(http:\/\/127\.0\.0\.1:5248\/|blob:|data:)/.test(r.request().url()) ? r.continue() : r.abort());
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
const settled = async (opens = 0) => {
  await page.waitForFunction(min => {
    const a = window.tileAudit;
    return a.opens > min && a.tiles > 0 && !a.pending.size && performance.now() - a.last > 500;
  }, opens, { timeout: 60000 });
};
const snapshot = async flips => {
  const workers = page.workers().filter(w => w.url().includes('pdfTile.worker'));
  const fonts = await Promise.all(workers.map(w => w.evaluate(() => self.fonts.size)));
  const canvases = await page.locator('canvas').evaluateAll(async es => {
    const result = [];
    for (const c of es.filter(c => c.width > 100 && c.height > 100)) {
      const ctx = c.getContext('2d'); if (!ctx) continue;
      const bytes = ctx.getImageData(0, 0, c.width, c.height).data;
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(n => n.toString(16).padStart(2, '0')).join('');
      result.push({ width: c.width, height: c.height, sha256 });
    }
    return result;
  });
  return { flips, fonts, canvases };
};
try {
  await page.goto('http://127.0.0.1:5248/');
  await page.locator('input[name="sheet-file"]').first().setInputFiles({ name: 'sample-finish-plan.pdf', mimeType: 'application/pdf', buffer: readFileSync('public/demo/sample-finish-plan.pdf') });
  await page.waitForSelector('canvas');
  const classic = page.getByRole('button', { name: 'Classic layout', exact: true }); if (await classic.count()) await classic.click();
  await settled();
  const snapshots = [await snapshot(0)];
  for (let i = 1; i <= 30; i++) {
    const opens = await page.evaluate(() => window.tileAudit.opens);
    await page.getByTitle(i % 2 ? 'Next sheet' : 'Previous sheet', { exact: true }).click();
    await settled(opens);
    if (i === 10 || i === 30) snapshots.push(await snapshot(i));
  }
  assert.equal(snapshots[0].fonts.length, 5);
  if (!process.env.BASELINE) for (const s of snapshots) assert.deepEqual(s.fonts, snapshots[0].fonts);
  assert.deepEqual(snapshots[2].canvases, snapshots[0].canvases, 'same sheet pixels after 30 flips');
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), plan: 'bundled sample-finish-plan.pdf', layout: 'Classic', workers: 5, snapshots, errors };
  mkdirSync(resolve(out, '..'), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  await page.screenshot({ path: out.replace(/\.json$/, '.png') });
  console.log(JSON.stringify(report));
} catch (e) { console.log({errors, audit: await page.evaluate(() => ({...window.tileAudit, pending: [...window.tileAudit.pending]})), workers: page.workers().map(w=>w.url())}); console.log((await page.locator('body').innerText()).slice(-7000)); throw e; }
finally { await browser.close(); server.kill(); }
