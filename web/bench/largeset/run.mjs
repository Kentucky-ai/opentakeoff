// The large-set benchmark (#580): what opening and moving through a plan set
// of 800+ sheets costs, in a real browser, on a production build.
//
// Run from web/, after `npm run build`:
//   PLAYWRIGHT_MODULE=/.../playwright/index.mjs BROWSER_PATH=/.../chrome \
//   node bench/largeset/run.mjs --pdf /path/to/set.pdf --set odot-cuy-105743 \
//     --label after --out bench/largeset/results/after.json [--dist dist] [--runs 5]
//     [--cores 4] [--device-memory 4]
//
// --cores and --device-memory set what the page is told the device has
// (navigator.hardwareConcurrency / deviceMemory), which is what sizes the
// render pool: 8+ cores get 5 workers, fewer get up to 3, and 4 GB or less
// is the low-memory class with 1. The machine's real speed is not changed.
//
// --set names a record in sets.json: the file's SHA-256 must match it, so a
// number is always for the bytes it claims. The file itself is never
// committed (fetch it from the record's url). Every run is a fresh browser
// profile; each figure reported is the median of the runs.
//
// What is timed, from the moment the file is given to the app:
//   firstPixelMs      the first tile of the first sheet is on screen
//   firstSheetMs      every tile of the first sheet's base layer has landed
//   treeNumberedMs    the Sheets tree has stopped gaining sheet numbers
//   reopenFirstPixelMs  page reload → the open sheet is back on screen
//   textScanMs        every page's text has been read (numbers, scales, search)
//   flipFirstPixelMs  Next sheet → first tile of the new sheet (median of flips)
//   flipCompleteMs    Next sheet → its base layer complete
//   galleryFps        frames per second while the gallery scrolls
//   peakRssMb         the browser's processes, summed, at their highest
//   retainedRssMb     the same after the flips and a forced collection
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const here = dirname(fileURLToPath(import.meta.url));
const pdf = resolve(arg('pdf') ?? (() => { throw new Error('--pdf /path/to/set.pdf is required'); })());
const dist = resolve(arg('dist', 'dist')), out = arg('out') && resolve(arg('out'));
const RUNS = +arg('runs', 5), FLIPS = +arg('flips', 12), label = arg('label', 'run'), setName = arg('set');
const CORES = arg('cores') && +arg('cores'), DEVICE_MEMORY = arg('device-memory') && +arg('device-memory');
const PORT = arg('port', '5283'), BASE = `http://127.0.0.1:${PORT}/`;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const sha256 = await new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(pdf).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const set = setName ? JSON.parse(readFileSync(join(here, 'sets.json'), 'utf8'))[setName] : null;
if (setName && !set) throw new Error(`no set "${setName}" in sets.json`);
if (set && set.sha256 !== sha256) throw new Error(`${pdf} is not ${setName}: sha256 ${sha256}, expected ${set.sha256}`);

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', PORT, '--strictPort', '--outDir', dist]);
await new Promise((res, rej) => { server.stdout.once('data', res); server.once('error', rej); server.once('exit', code => rej(new Error(`server exited ${code}`))); });

const median = a => { const s = a.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

// Runs in the page before the app: every tile worker's traffic is watched, so
// "on screen" is the frame after a tile arrives, not a guess from the DOM.
function audit() {
  const NativeWorker = Worker;
  const B = window.__bench = { t0: 0, armed: false, opens: 0, tiles: 0, pending: new Set(), last: 0, firstTile: null, opened: null };
  B.reset = () => { B.t0 = performance.now(); B.armed = false; B.opens = 0; B.tiles = 0; B.pending.clear(); B.firstTile = null; B.opened = null; };
  window.Worker = class extends NativeWorker {
    constructor(url, opts) {
      super(url, opts);
      this.isTile = String(url).includes('pdfTile');
      if (this.isTile) this.addEventListener('message', ({ data: m }) => {
        // only what paints counts: a worker also answers text reads (the
        // Sheets tree's numbers), which go on long after the sheet is drawn
        if (m.type !== 'tile' && m.type !== 'tileError') return;
        B.last = performance.now();
        B.pending.delete(m.reqId); B.tiles++;
        if (m.type === 'tile' && B.armed) { B.armed = false; requestAnimationFrame(() => { B.firstTile = performance.now() - B.t0; }); }
      });
    }
    postMessage(m, ...rest) {
      if (this.isTile && m.type !== 'pageText') {
        B.last = performance.now();
        // the first open after a reset arms the first-tile clock: a tile of
        // the sheet being left never counts for the one being opened
        if (m.type === 'openSheet') { if (!B.opens++) { B.armed = true; B.opened = performance.now() - B.t0; } }
        if (m.type === 'renderTile') B.pending.add(m.reqId);
        if (m.type === 'cancel') B.pending.delete(m.reqId);
      }
      return super.postMessage(m, ...rest);
    }
  };
}

async function oneRun(i) {
  const profile = mkdtempSync(join(tmpdir(), 'ot-largeset-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 1500, height: 1000 }, args: ['--js-flags=--expose-gc'],
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  // nothing leaves the machine: the app is local-only, and so is its benchmark
  await page.route('**/*', r => (/^(http:\/\/127\.0\.0\.1:\d+\/|blob:|data:)/.test(r.request().url()) ? r.continue() : r.abort()));
  await page.addInitScript(({ cores, mem }) => {
    if (cores) Object.defineProperty(navigator, 'hardwareConcurrency', { value: cores });
    if (mem) Object.defineProperty(navigator, 'deviceMemory', { value: mem });
  }, { cores: CORES || 0, mem: DEVICE_MEMORY || 0 });
  await page.addInitScript(audit);
  const rss = () => { try { return Math.round(execSync(`ps -axo rss=,command= | grep -F "${profile}" | grep -v grep | awk '{s+=$1} END {print s+0}'`).toString().trim() / 1024); } catch { return null; } };
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, rss() ?? 0); }, 200);
  const settled = (quietMs = 800) => page.waitForFunction(q => { const b = window.__bench; return b.opens > 0 && b.tiles > 0 && !b.pending.size && performance.now() - b.last > q; }, quietMs, { timeout: 180000 });
  const r = { run: i };
  try {
    await page.goto(BASE);
    await page.locator('input[name="sheet-file"]').first().waitFor({ state: 'attached' });
    await page.waitForTimeout(1500);
    r.idleRssMb = rss();
    await page.evaluate(() => { window.__bench.reset(); window.__benchDrop = window.__bench.t0; });
    await page.locator('input[name="sheet-file"]').first().setInputFiles(pdf);
    await settled();
    Object.assign(r, await page.evaluate(() => { const b = window.__bench; return { firstPixelMs: Math.round(b.firstTile), firstSheetMs: Math.round(b.last - b.t0) }; }));
    r.afterDropRssMb = rss();

    // the Sheets tree: one row per page, a row's label its sheet number once read
    await page.getByRole('button', { name: 'Sheets', exact: true }).click();
    const tree = () => page.evaluate(() => {
      const pages = [...document.querySelectorAll('[role=treeitem]:not(.calm-tree-folder)')];
      return { rows: pages.length, numbered: pages.filter(e => e.querySelector('.calm-sheet-number')).length, at: Math.round(performance.now() - window.__bench.t0) };
    });
    let last = await tree(), changedAt = last.at; r.treeNumberedAt5s = null;
    for (;;) {
      await page.waitForTimeout(250);
      const now = await tree();
      if (r.treeNumberedAt5s === null && now.at >= 5000) r.treeNumberedAt5s = now.numbered;
      if (now.numbered !== last.numbered || now.rows !== last.rows) changedAt = now.at;
      last = now;
      if (now.at - changedAt > 8000 || now.at > 240000) break;
    }
    Object.assign(r, { treeRows: last.rows, treeNumbered: last.numbered, treeNumberedMs: changedAt });
    await page.getByRole('button', { name: 'Sheets', exact: true }).click();

    // The whole-file text scan (sheet numbers, noted scales, search) marks
    // its end; a build from before it did reports null. Flips are timed
    // twice: four right away (while that scan runs, where there is one),
    // then the rest once it is done.
    const timeFlips = async (count) => {
      const out = [];
      for (let f = 0; f < count; f++) {
        await page.evaluate(() => window.__bench.reset());
        // forward while there is a next sheet, else back (a two-sheet plan)
        const next = page.getByTitle('Next sheet', { exact: true }).first();
        await ((await next.isDisabled()) ? page.getByTitle('Previous sheet', { exact: true }).first() : next).click();
        await settled();
        out.push(await page.evaluate(() => { const b = window.__bench; return { first: Math.round(b.firstTile), complete: Math.round(b.last - b.t0) }; }));
      }
      return out;
    };
    const scanDone = () => page.evaluate(() => { const m = performance.getEntriesByName('sheet-text-scan')[0]; return m ? Math.round(m.startTime + m.duration - window.__benchDrop) : null; });
    const during = await timeFlips(4);
    r.flipEarlyFirstPixelMs = median(during.map(f => f.first));
    // only a build that marks the scan's start is waited on for its end
    if (await page.evaluate(() => performance.getEntriesByName('sheet-text-scan-start').length > 0)) {
      for (let w = 0; w < 720 && await scanDone() === null; w++) await page.waitForTimeout(250);
    }
    r.textScanMs = await scanDone();

    const flips = await timeFlips(FLIPS);
    r.flipFirstPixelMs = median(flips.map(f => f.first)); r.flipCompleteMs = median(flips.map(f => f.complete)); r.flips = flips;

    // the gallery, scrolled end to end at a steady rate: frames the page drew
    await page.getByRole('button', { name: 'Sheets', exact: true }).click();
    await page.getByRole('button', { name: 'Open visual gallery', exact: true }).click();
    await page.locator('[data-sheetkey]').first().waitFor();
    await page.waitForTimeout(1500);
    r.galleryFps = await page.evaluate(() => new Promise(res => {
      let el = document.querySelector('[data-sheetkey]');
      while (el && !(el.scrollHeight > el.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      if (!el) { res(null); return; }
      const t0 = performance.now(); let frames = 0;
      const step = now => { frames++; el.scrollTop += 60; if (now - t0 < 4000) requestAnimationFrame(step); else res(Math.round(frames / ((now - t0) / 1000))); };
      requestAnimationFrame(step);
    }));

    // back to the canvas, then reload: the project reopens from the browser's
    // own storage. The clock is the navigation's (performance.now() is 0 at
    // its start), so this includes the app's own boot.
    await page.getByRole('button', { name: 'Close', exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(1200); // the autosave of the open tab
    await page.reload();
    await settled();
    r.reopenFirstPixelMs = await page.evaluate(() => Math.round(window.__bench.firstTile));

    for (let k = 0; k < 3; k++) {
      await page.evaluate(() => globalThis.gc?.());
      await Promise.all(page.workers().map(w => w.evaluate(() => globalThis.gc?.()).catch(() => {})));
      await page.waitForTimeout(700);
    }
    r.retainedRssMb = rss();
  } catch (e) { r.error = String(e).slice(0, 400); }
  clearInterval(sampler);
  r.peakRssMb = peak; if (errors.length) r.pageErrors = errors.slice(0, 5);
  const version = ctx.browser()?.version() ?? null;
  await ctx.close(); rmSync(profile, { recursive: true, force: true });
  return { r, version };
}

const runs = []; let browser = null;
try {
  for (let i = 1; i <= RUNS; i++) { const { r, version } = await oneRun(i); browser = version; runs.push(r); console.error(JSON.stringify({ ...r, flips: undefined })); }
} finally { server.kill(); }
const keys = ['firstPixelMs', 'firstSheetMs', 'reopenFirstPixelMs', 'treeNumberedMs', 'treeNumberedAt5s', 'treeNumbered', 'treeRows', 'textScanMs', 'flipEarlyFirstPixelMs', 'flipFirstPixelMs', 'flipCompleteMs', 'galleryFps', 'idleRssMb', 'afterDropRssMb', 'peakRssMb', 'retainedRssMb'];
const report = {
  label, set: setName ?? null, file: { sha256, bytes: statSync(pdf).size },
  commit: (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return null; } })(),
  machine: { cpu: cpus()[0]?.model, cores: cpus().length, memGb: Math.round(totalmem() / 2 ** 30), os: `${process.platform} ${process.arch}` },
  browser: `Chrome ${browser} (headless)`, viewport: '1500x1000', told: { cores: CORES || cpus().length, deviceMemoryGb: DEVICE_MEMORY || null }, runs: RUNS, flipsPerRun: FLIPS,
  median: Object.fromEntries(keys.map(k => [k, median(runs.map(r => r[k]))])),
  failedRuns: runs.filter(r => r.error).length,
  perRun: runs,
};
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ label, median: report.median, failedRuns: report.failedRuns }, null, 2));
if (report.failedRuns) process.exitCode = 1;
