// Callout cross-check runner — the drawing's own numbers vs One-Click:
//   npm run bench:callouts                 (every corpus case with a PDF)
//   npm run bench:callouts va-finish-plan  (one case)
//
// REPORTS, NEVER GATES. It always exits 0: a disagreement here is a question
// about measurement convention, not a regression. The gated answer-key path
// is bench/from-takeoff.mts, where a human applied the convention on purpose.
//
// Why this exists: 12 of the corpus's 21 gating goldens are the engine's own
// traces, reviewed by eye — a self-consistency record, not an accuracy one
// (issue #184 round 9). Printed area callouts are the one quantity on a plan
// the engine did not author, and they cost nothing to check.
import { createRequire } from "module";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { extractVectorGeometry, buildMask, floodRegionSealed, sealRadiiFor, doorWedgeCapPx, minPassRadiusFor, traceRegion, MASK_MAX_DIM } from "../src/lib/oneclick.ts";
import { parseAreaCallouts, nearMissCallouts, nearbyText, sweepOffsetsFor, checkCallouts, summarize, type TextItem, type CalloutRow } from "./callouts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const req = createRequire(import.meta.url);
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));

const files = readdirSync(join(here, "corpus"))
  .filter((f) => f.endsWith(".json"))
  .filter((f) => !only.length || only.includes(f.replace(".json", "")))
  .map((f) => join(here, "corpus", f));

const out: Array<{ caseName: string; rows: CalloutRow[]; summary: ReturnType<typeof summarize> }> = [];

for (const file of files) {
  const c = JSON.parse(readFileSync(file, "utf8"));
  if (!c.pdf) continue;                                  // segments-only cases carry no text layer
  const caseName = file.replace(/^.*[\\/]/, "").replace(".json", "");
  const doc = await pdfjs.getDocument({ url: join(dirname(file), c.pdf), useSystemFonts: true }).promise;
  const page = await doc.getPage(c.page || 1);
  const vp = page.getViewport({ scale: c.scale });
  const ops = await page.getOperatorList();
  const g = extractVectorGeometry(ops, vp.transform, pdfjs.OPS);

  // positioned text in the same image px the seeds and goldens live in
  const tc = await page.getTextContent();
  const items: TextItem[] = [];
  for (const it of tc.items as Array<{ str?: string; transform: number[] }>) {
    const str = it.str || "";
    if (!str.trim()) continue;
    const t = pdfjs.Util.transform(vp.transform, it.transform);
    items.push({ str, x: +t[4].toFixed(1), y: +t[5].toFixed(1) });
  }

  const callouts = parseAreaCallouts(items);
  const pxPerFt = c.ptPerFt;                             // image px per foot at the pinned scale
  const baseDim = Math.min(MASK_MAX_DIM, Math.max(vp.width, vp.height, 2));
  const mo = buildMask(g.segs, vp.width, vp.height, baseDim, g.meta, pxPerFt);
  const mppf = mo.ws * pxPerFt;
  const radii = sealRadiiFor(mppf), wedgeCap = doorWedgeCapPx(mppf), minPass = minPassRadiusFor(mppf);

  // one seed → SF, through exactly the flood the canvas runs
  const measure = (x: number, y: number): number | null => {
    const f = floodRegionSealed(mo, x, y, 0.5, radii, wedgeCap, minPass);
    if (f.status !== "ok") return null;
    const ring = traceRegion(f);
    if (!ring || ring.length < 3) return null;
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2) / (pxPerFt * pxPerFt);
  };

  console.log(`\n══ ${caseName} ══  ${callouts.length} area callout(s) in ${items.length} text items`);
  const misses = nearMissCallouts(items);
  if (misses.length) console.log(`   ${misses.length} near-miss(es) this parser declined: ${misses.slice(0, 6).map((m) => JSON.stringify(m)).join(", ")}${misses.length > 6 ? " …" : ""}`);
  if (!callouts.length) { console.log("   (no area annotation this parser recognizes — see the near-misses above before concluding the plan prints no areas)"); continue; }

  const rows = checkCallouts(callouts, measure, (co) => sweepOffsetsFor(pxPerFt, co.sf), (co) => nearbyText(items, co.x, co.y, 10 * pxPerFt));
  for (const r of rows) {
    const err = r.err == null ? "     n/a" : `${(r.err * 100 >= 0 ? "+" : "")}${(r.err * 100).toFixed(1)}%`.padStart(8);
    const eng = r.engine_sf == null ? "  no region" : `${r.engine_sf.toFixed(0)} SF`.padStart(11);
    const flag = r.engine_sf == null ? "" : r.stable ? "" : "  [UNSTABLE — the sweep found no single answer; not averaged]";
    console.log(`  ${r.raw.padEnd(10)} drawing ${String(r.printed_sf).padStart(6)} SF | engine ${eng} | ${err} | ${r.agreement}/${r.seeds} seeds agree, ${r.regions} distinct region(s)${r.refused ? `, ${r.refused} refused` : ""}${flag}`);
    if (r.context.length) console.log(`               near: ${r.context.join(" · ")}`);
  }
  const sum = summarize(rows);
  if (sum.matched) {
    console.log(`  ── ${sum.matched}/${sum.total} stable${sum.unstable ? ` (${sum.unstable} seed-unstable, excluded)` : ""} · median |error| ${(sum.medianAbsErr * 100).toFixed(1)}% · mean |error| ${(sum.meanAbsErr * 100).toFixed(1)}% · signed ${(sum.meanSignedErr * 100).toFixed(1)}% · range ${(sum.minErr * 100).toFixed(1)}%…${(sum.maxErr * 100).toFixed(1)}%`);
  }
  console.log(`  → ${sum.verdict}`);
  out.push({ caseName, rows, summary: sum });
}

writeFileSync(join(here, "callout-results.json"), JSON.stringify({ cases: out }, null, 1));
console.log(`\nA callout is what the DRAWING says, not a graded answer key: it may annotate a`);
console.log(`finish zone rather than a room's floor, or follow a different boundary convention.`);
console.log(`Read a disagreement as a question to settle with a human, never as a bench failure.`);
