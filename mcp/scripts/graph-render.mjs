// Render a corpus set's sheets for HUMAN (or vision) labelling — the other
// half of the eval loop. The parser reads the text layer; a key read off
// these renders is an INDEPENDENT channel, which is the only thing that makes
// the score mean anything.
//
//   node --import tsx scripts/graph-render.mjs <corpus-dir> <setId> [--bands N]
//
// Writes renders/<setId>-<sheet>-<n>.png. Schedule sheets are cropped to the
// tables the graph found (plus generous margin) and split into horizontal
// bands so the type stays legible; plan sheets render whole.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Session } from "../src/session.ts";

const args = process.argv.slice(2);
const [corpusDir, setId] = args.filter((a) => !a.startsWith("--"));
const bandsArg = args.indexOf("--bands");
const BANDS = bandsArg >= 0 ? Number(args[bandsArg + 1]) : 3;
if (!corpusDir || !setId) {
  console.error("usage: node --import tsx scripts/graph-render.mjs <corpus-dir> <setId> [--bands N]");
  process.exit(2);
}
const corpus = resolve(corpusDir);
const spec = JSON.parse(readFileSync(join(corpus, "sets.json"), "utf8"));
const set = spec.sets.find((s) => s.id === setId);
if (!set) { console.error(`no set "${setId}"`); process.exit(2); }
const outDir = join(corpus, "renders");
mkdirSync(outDir, { recursive: true });

const s = new Session();
for (let i = 0; i < set.files.length; i++) await s.loadPlan(join(set.root ?? spec.root, set.files[i]), { merge: i > 0 });
const g = await s.sheetGraph();

const sheetOf = (key) => s.sheet(key);
const slug = (k) => {
  // keep the PAGE: a combined single-file set has every sheet under one file
  // name, and dropping the "#N" made every render overwrite the last.
  const page = /#(\d+)$/.exec(k)?.[1] ?? "1";
  const base = k.replace(/#\d+$/, "").replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-24);
  return `${base}-p${page}`;
};

// every table region the graph found, per sheet
const regions = new Map();
for (const sh of g.sheets) {
  for (const t of sh.schedules) {
    if (!regions.has(sh.sheet)) regions.set(sh.sheet, []);
    regions.get(sh.sheet).push({ kind: t.kind, title: t.title, region: t.region });
  }
}

let n = 0;
for (const sh of g.sheets) {
  const page = sheetOf(sh.sheet).page;
  const tables = regions.get(sh.sheet) ?? [];
  if (!tables.length) {
    if (!process.argv.includes("--all")) continue;
    // no table found here — render the WHOLE sheet, because "the graph saw
    // nothing" is exactly the case a label needs to check
    const png = await page.renderPng(0.5);
    const p = join(outDir, `${setId}--${slug(sh.sheet)}--full.png`);
    writeFileSync(p, png);
    console.log(`${p}   (${sh.role}, no tables found)`);
    n++;
    continue;
  }
  for (const t of tables) {
    const r = t.region;
    const pad = 40;
    const y0 = Math.max(0, r.y0 - pad), y1 = r.y1 + pad;
    const x0 = Math.max(0, r.x0 - pad), x1 = r.x1 + pad;
    const h = (y1 - y0) / BANDS;
    for (let b = 0; b < BANDS; b++) {
      const by0 = y0 + b * h, by1 = b === BANDS - 1 ? y1 : y0 + (b + 1) * h + 12;
      const out = await page.renderRegionPng({ x0, y0: by0, x1, y1: by1 }, 2400);
      const p = join(outDir, `${setId}--${slug(sh.sheet)}--${t.kind}-${b + 1}of${BANDS}.png`);
      writeFileSync(p, out.png);
      console.log(`${p}   "${t.title}" band ${b + 1}/${BANDS}`);
      n++;
    }
  }
}
console.error(`\n${n} render(s) in ${outDir}`);
process.exit(0);
