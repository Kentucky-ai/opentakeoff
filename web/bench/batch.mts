// Batch-fill detection metrics runner — what a whole sheet of unprompted
// proposals looks like:
//   npm run bench:batch                 (every corpus case with a PDF)
//   npm run bench:batch va-finish-plan
//   npm run bench:batch -- --jitter     (also re-measure each seed ±1 ft; slow)
//
// REPORTS, NEVER GATES, exits 0 always: RFC item F isn't built yet. These are
// the numbers to build it against (issue #184 item 4). Room-level PRECISION —
// "is this proposal a real room?" — is deliberately absent: it needs a full
// room census, which is human truth we don't have (item 2).
import { createRequire } from "module";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { extractVectorGeometry, buildMask, floodRegionSealed, sealRadiiFor, doorWedgeCapPx, minPassRadiusFor, traceRegion, MASK_MAX_DIM } from "../src/lib/oneclick.ts";
import { roomLabelSeeds, detectRegions, sheetBounds, ROOM_LABEL_RE } from "../src/lib/detectRooms.ts";
import { polyIoU, ringAreaAbs } from "./score.ts";
import type { Point } from "../src/lib/oneclick.ts";
import { batchMetrics, batchReach, batchCoverage, seedStability, TINY_PROPOSAL_SF, type Proposal } from "./batch.ts";
import { parseAreaCallouts } from "./callouts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const jitter = argv.includes("--jitter");
const only = argv.filter((a) => !a.startsWith("--"));
const req = createRequire(import.meta.url);
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));

const files = readdirSync(join(here, "corpus"))
  .filter((f) => f.endsWith(".json"))
  .filter((f) => !only.length || only.includes(f.replace(".json", "")))
  .map((f) => join(here, "corpus", f));

const out: unknown[] = [];
for (const file of files) {
  const c = JSON.parse(readFileSync(file, "utf8"));
  if (!c.pdf) continue;
  const caseName = file.replace(/^.*[\\/]/, "").replace(".json", "");
  const doc = await pdfjs.getDocument({ url: join(dirname(file), c.pdf), useSystemFonts: true }).promise;
  const page = await doc.getPage(c.page || 1);
  const vp = page.getViewport({ scale: c.scale });
  const ops = await page.getOperatorList();
  const g = extractVectorGeometry(ops, vp.transform, pdfjs.OPS);
  const tc = await page.getTextContent();
  const items: { str: string; x: number; y: number; h: number }[] = [];
  for (const it of tc.items as Array<{ str?: string; transform: number[] }>) {
    const str = it.str || "";
    if (!str.trim()) continue;
    const t = pdfjs.Util.transform(vp.transform, it.transform);
    // h = device-space glyph height; detectRooms uses it to drop the seed clear
    // of a tag box drawn around the label (mcp/src/pdf.ts does the same)
    items.push({ str, x: +t[4].toFixed(1), y: +t[5].toFixed(1), h: +Math.hypot(t[2], t[3]).toFixed(1) });
  }

  const pxPerFt = c.ptPerFt;
  const baseDim = Math.min(MASK_MAX_DIM, Math.max(vp.width, vp.height, 2));
  const mo = buildMask(g.segs, vp.width, vp.height, baseDim, g.meta, pxPerFt);
  const mppf = mo.ws * pxPerFt;
  const radii = sealRadiiFor(mppf), wedgeCap = doorWedgeCapPx(mppf), minPass = minPassRadiusFor(mppf);

  // the shipped batch path, verbatim
  const patternOnly = items.filter((it) => (it.str || "").trim().split(/\s+/).some((t) => ROOM_LABEL_RE.test(t))).length;
  const seedsRaw = roomLabelSeeds(items);                       // text filters, no spatial gate
  const seeds = roomLabelSeeds(items, { bounds: sheetBounds(vp.width, vp.height) });
  const regions = detectRegions(mo, seeds);
  const proposals: Proposal[] = [];
  for (const r of regions) {
    const ring = traceRegion(r.flood) as Point[] | null;
    if (ring && ring.length >= 3) proposals.push({ label: r.str, seed: r.seed, ring });
  }

  const m = batchMetrics(proposals, seeds.length, pxPerFt);
  const goldenProbes = (c.probes as Array<{ name: string; expect: string; golden?: Point[]; knownFail?: boolean }>)
    .filter((p) => p.expect === "golden" && !p.knownFail && p.golden);
  const goldens = goldenProbes.map((p) => p.golden!);
  const cov = batchCoverage(proposals, goldenProbes.map((p) => ({ name: p.name, ring: p.golden! })), pxPerFt);
  const reach = batchReach(proposals, goldens, seeds.map((s) => s.seed), (a, b) => polyIoU(a, b, 8));
  // roomLabelSeeds tokenizes on whitespace, so "250 SF" — an AREA CALLOUT —
  // yields the token "250" and is counted as a room tag. Separate the two, or
  // "reach" flatters itself with seeds no room tag actually provided.
  const calloutAt = new Set(parseAreaCallouts(items).map((c) => `${c.x},${c.y}`));
  const tagSeeds = seeds.filter((s) => !calloutAt.has(`${s.seed[0]},${s.seed[1]}`));
  const tagReach = batchReach(
    proposals.filter((p) => !calloutAt.has(`${p.seed[0]},${p.seed[1]}`)),
    goldens, tagSeeds.map((s) => s.seed), (a, b) => polyIoU(a, b, 8),
  );

  console.log(`\n══ ${caseName} ══  ${items.length} text items`);
  console.log(`  seeding    ${m.labels} room-number labels → ${m.proposals} proposals (${m.refused} refused by the engine)`);
  if (patternOnly !== seeds.length) console.log(`             ${patternOnly} numerals matched the room pattern → ${patternOnly - seedsRaw.length} rejected as text (printed areas, dimensions, drawing numbers, title-block words), ${seedsRaw.length - seeds.length} more outside the drawing extent`);
  console.log(`  floor      Σ ${m.sumProposedSF.toFixed(0)} SF | double-counted ${m.overlapSF.toFixed(0)} SF (${(m.overlapFrac * 100).toFixed(1)}%)  [per-cell, blind under ~4 px of shared width; the bench gates human-measured cases at 0.5%]`);
  if (m.duplicates.length) console.log(`  duplicates ${m.duplicates.length} label pair(s) proposing the same space: ${m.duplicates.slice(0, 6).map(([a, b]) => `${a}/${b}`).join(", ")}${m.duplicates.length > 6 ? " …" : ""}`);
  if (m.nested.length) console.log(`  nested     ${m.nested.length} pair(s) one-inside-another (a closet in a suite is fine; a hole read as floor is not): ${m.nested.slice(0, 6).map(([a, b]) => `${a}/${b}`).join(", ")}${m.nested.length > 6 ? " …" : ""}`);
  console.log(`  sizes      min ${m.minSF.toFixed(0)} SF · median ${m.medianSF.toFixed(0)} SF · max ${m.maxSF.toFixed(0)} SF${m.maxSF > 10 * Math.max(m.medianSF, 1) ? "   ← an outlier this far above the median is usually paper space, not a room" : ""}`);
  if (m.tiny.length) console.log(`  sub-${TINY_PROPOSAL_SF}-SF   ${m.tiny.length} of ${m.proposals} proposals under the fixture-sized threshold — a seed that landed inside the box drawn around the room tag, or in one floor-tile cell: ${m.tiny.slice(0, 10).join(", ")}${m.tiny.length > 10 ? " …" : ""}`);
  console.log(`  reach      ${reach.withLabel}/${reach.goldens} pinned rooms contain a seed anchor — but only ${tagReach.withLabel}/${tagReach.goldens} from an actual ROOM TAG (the rest are area callouts like "250 SF", whose numeric token roomLabelSeeds keeps)`);
  console.log(`  recall     ${reach.recallHalf}/${reach.goldens} pinned rooms matched at IoU ≥ 0.5 · ${reach.recallNine}/${reach.goldens} at ≥ 0.9 — from room tags alone: ${tagReach.recallHalf}/${tagReach.goldens} and ${tagReach.recallNine}/${tagReach.goldens}`);
  console.log(`             (a match against an engine-pinned golden can be a self-comparison: the golden was pinned from a trace of this same engine)`);
  console.log(`  coverage   ${cov.coveredSF.toFixed(0)}/${cov.knownSF.toFixed(0)} SF of known floor is in SOME proposal (${(cov.frac * 100).toFixed(1)}%)  [floor in no proposal is invisible to every metric above]`);
  for (const r of cov.rows.filter((x) => x.frac < 0.9)) {
    console.log(`               ${r.name.padEnd(24)} ${(r.frac * 100).toFixed(1)}% covered (${r.coveredSF.toFixed(0)}/${r.knownSF.toFixed(0)} SF)${r.frac < 0.05 ? "   ← proposed by NOTHING" : ""}`);
  }

  let stability: ReturnType<typeof seedStability> | undefined;
  if (jitter) {
    const d = pxPerFt;                                     // one foot
    const offs: Array<[number, number]> = [[d, 0], [-d, 0], [0, d], [0, -d]];
    const remeasure = (x: number, y: number): Point[] | null => {
      const f = floodRegionSealed(mo, x, y, 0.5, radii, wedgeCap, minPass);
      if (f.status !== "ok") return null;
      const ring = traceRegion(f) as Point[] | null;
      return ring && ring.length >= 3 ? ring : null;
    };
    stability = seedStability(proposals, remeasure, offs, (a, b) => polyIoU(a, b, 8));
    const solid = stability.filter((s) => s.held === s.tried).length;
    const brittle = stability.filter((s) => s.held <= 1);
    console.log(`  stability  ${solid}/${stability.length} proposals survive a ±1 ft seed move unchanged; ${brittle.length} hold ≤1 of 4${brittle.length ? `: ${brittle.slice(0, 8).map((s) => s.label).join(", ")}` : ""}`);
  }
  out.push({ caseName, metrics: m, reach, tagReach, coverage: cov, stability });
}

writeFileSync(join(here, "batch-results.json"), JSON.stringify({ cases: out }, null, 1));
console.log(`\nWhat these numbers cannot tell you: whether a proposal is a REAL room. That is`);
console.log(`precision against a full room census — human truth (bench/from-takeoff.mts).`);
console.log(`Everything above is measurable on any plan, today, and is where batch fill fails first.`);
