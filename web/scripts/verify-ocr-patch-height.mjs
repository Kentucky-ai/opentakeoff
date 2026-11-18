// #488, part 1, in headless Chromium: pack the seam patches under height caps
// with the shipped OCR worker (wasm), against each sheet's vector text.
//
//   node scripts/stage-ocr-model.mjs   # once
//   PLAYWRIGHT_MODULE=/abs/path/to/playwright/index.mjs BROWSER_PATH=/abs/path/to/chrome \
//     node scripts/verify-ocr-patch-height.mjs out.json sheet.pdf:2 ...
//
// Add --fixture=path to take the tile reads from a recorded fixture instead of
// reading them (test/fixtures/ocr-seams/demo-sheet2-real.json is demo page 2).
// Playwright is optional review tooling, installed outside the project.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const args = process.argv.slice(2);
const flag = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const [out, ...sheets] = args.filter((a) => !a.startsWith("--"));
const caps = flag("caps", "408,800,1600,2400,4000").split(",").map(Number);
const fixture = flag("fixture", "");
const port = 4191;
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: ["ignore", "pipe", "inherit"] });
let browser;
const results = [];
try {
  await new Promise((ok, bad) => {
    server.stdout.on("data", (b) => { if (String(b).includes(`127.0.0.1:${port}`)) ok(); });
    server.once("exit", (c) => bad(new Error(`vite exited ${c}`)));
  });
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror", String(e)));
  const blocked = [];
  await page.route("**/*", (r) => {
    const u = r.request().url();
    if (u.startsWith(`http://127.0.0.1:${port}/`) || u.startsWith("blob:") || u.startsWith("data:")) return r.continue();
    blocked.push(u);
    return r.abort();
  });
  for (const [i, spec] of sheets.entries()) {
    const at = spec.lastIndexOf(":");
    const file = resolve(spec.slice(0, at)), pageNo = Number(spec.slice(at + 1));
    if (!existsSync(file)) throw new Error(`no such sheet: ${file}`);
    await page.route(`**/__sheet/${i}.pdf`, (r) => r.fulfill({ body: readFileSync(file), contentType: "application/pdf" }));
    const tileWords = fixture ? JSON.parse(readFileSync(fixture, "utf8")).jobs.filter((j) => j.kind === "tile").map((j) => j.words) : undefined;
    // vite's dev server reloads the page when it first meets a dependency
    let res;
    for (let tries = 0; !res; tries++) {
      await page.goto(`http://127.0.0.1:${port}/bench/ocr-patch-height/index.html`);
      await page.waitForSelector("body[data-ready]", { timeout: 120000 });
      try { res = await page.evaluate((a) => window.measurePack(a), { url: `/__sheet/${i}.pdf`, pageNo, caps, tileWords }); }
      catch (e) { if (tries >= 3 || !String(e).includes("Execution context")) throw e; }
    }
    results.push({ sheet: spec, fixture: fixture || undefined, ...res });
    console.log(spec);
    for (const a of res.arms) console.log(`  cap ${a.cap}: ${a.patches} patches [${a.heights}], ${a.lines} lines, ${a.clipped} clipped, recall ${a.recall}, ${a.ms} ms`);
    writeFileSync(out, JSON.stringify({ issue: "#488", engine: "chromium wasm", blocked, results }, null, 1));
  }
  if (blocked.length) console.log("blocked requests:", blocked);
} finally {
  await browser?.close();
  server.kill();
}
