// Pin golden polygons for REAL-PDF corpus cases from the current engine trace,
// after the trace has been visually reviewed (issue #184 rounds 2–4). Synthetic
// cases carry goldens by construction; real plans need a human in the loop once
// — this freezes what was reviewed so regressions surface as IoU drops.
//
//   node --import tsx bench/pin-goldens.mts [--dry-run] [--adjudicate <probe>=<reason>]...
//
// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN RE-PIN PROTOCOL  (remediation task 0.9; audit findings B1 + bug #17)
// ─────────────────────────────────────────────────────────────────────────────
// Re-pinning is the operation that concealed this repo's worst measurement
// regression. Between 2730050 and 92c1242 the probe `patient-room-137` fell
// 240.77 → 161.91 SF (−32.75%) and shipped as an improvement, because the only
// thing anyone looked at was the case total — and the case total moved
// 2476.72 → 2489.50 SF, **+0.5%**, since a brand-new toilet probe was added in
// the very same commit that lost 79 SF from the room.
//
// That is the whole design constraint of this file:
//
//   *** THE PER-PROBE RULE IS THE ONE THAT CATCHES THE REAL FAILURE. ***
//   The case-total invariant (+0.5% on that event) and the pairwise-overlap
//   invariant (0.001% on that event) BOTH SAT WELL INSIDE THEIR THRESHOLDS
//   while a room lost a third of its floor. They are reported because they
//   catch a different class of error (floor nobody probes, floor counted
//   twice); they are not, and must never be presented as, the guard.
//
// So: before overwriting anything, every probe is diffed against the goldens
// currently on disk — old SF, new SF, Δ%, and IoU(old, new). Any probe moving
// more than ±2.5%, and any probe added to or removed from an existing case
// (the toilet-probe manoeuvre above), FAILS the re-pin with a non-zero exit
// unless the person re-pinning states, per probe, why the new value is
// correct:
//
//   --adjudicate patient-room-137="the toilet is now its own probe; the room
//                                  no longer annexes it — reviewed on screen"
//
// The reason is written into the corpus JSON as an append-only `adjudications`
// entry alongside the numbers it excuses, so it survives every later re-pin and
// `npm run bench` prints it back on every run. Nothing is written to disk
// unless every case passes: a failed re-pin leaves the goldens untouched.
//
// ORPHAN ADJUDICATIONS (defect F4). A probe REMOVED by a re-pin — including the
// removal half of a rename — has no new probe object to hang its reason on, and
// the first version of this write path did `probes.find(...); if (!out) continue`,
// so the one class of change the protocol calls MOST dangerous was the one class
// whose reason was silently thrown away. Removal reasons (and the removed
// probe's own earlier adjudications, which vanish with the probe object) are
// therefore appended to the CASE-level `adjudications` array, scoped
// `removed-probe <name>`, next to the case-total and overlap rows. Same
// append-only rule, same reprint by `npm run bench`. The write path is covered
// end-to-end by test/repinWritePath.test.ts, which runs THIS script against a
// throwaway copy of the corpus — `diffRepin` unit tests cannot see main().
//
// WHAT GETS PINNED (audit A5b). The golden is THE PRODUCTION RING — traced and
// then vertex-SNAPPED, via `oneClickRing`, exactly as TakeoffCanvas.jsx and
// mcp/src/session.ts compute the `area_sf` a user reads. Until A5b this file
// called bare `traceRegion`, so every golden on disk pinned a number the
// product never returns; the whole-corpus re-pin that fixed it went through
// this protocol, one adjudicated reason per moved probe, and those reasons are
// in the corpus JSON. Goldens also declare `wallSemantics` — see bench/corpus.ts.
import { createRequire } from "module";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { extractVectorGeometry, buildMask, floodRegionSealed, sealRadiiFor, doorWedgeCapPx, minPassRadiusFor, oneClickRing, snapNearest, MASK_MAX_DIM } from "../src/lib/oneclick.ts";
import type { Point } from "../src/lib/oneclick.ts";
import { polyIoU, polyOverlapPx2, ringAreaAbs } from "./score.ts";
import { WALL_SEMANTICS } from "./corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Where cases are read from and written to. Defaults to the real corpus; the
 *  write-path acceptance test points it at a throwaway copy so it can run this
 *  script for real — main(), argv, exit codes, `writeFileSync` — without ever
 *  putting the repo's goldens at risk (F4's test brief: a perturbed COPY).
 *  Case `pdf` paths stay relative to this directory, exactly as on disk. */
const corpusDir = process.env.REPIN_CORPUS_DIR ? resolve(process.env.REPIN_CORPUS_DIR) : join(here, "corpus");

// Coordinates are image px at the pinned scale below. Probes chosen and
// reviewed on screen — see docs/evidence/one-click/ for the captures.
const PINNED = [
  {
    file: "sample-plan.json", pdf: "../../../demo/sample-plan.pdf", scale: 2, ptPerFt: 18 * 2,
    note: "4 identical quadrant rooms; traces reviewed as exact rectangles (issue #184 round 3)",
    probes: [
      { name: "break-103", seed: [432, 216], expect: "golden" as const },
      { name: "corridor-104", seed: [1296, 216], expect: "golden" as const },
      { name: "office-101", seed: [432, 864], expect: "golden" as const },
      { name: "office-102", seed: [1296, 864], expect: "golden" as const },
    ],
  },
  {
    file: "va-finish-plan.json", pdf: "../../../demo/sample-finish-plan.pdf", scale: 2, ptPerFt: 9 * 2,
    note: "VA plan (1/8\" assumed): rooms visually reviewed in-browser (issue #184 rounds 2-4; re-reviewed round 8 for the periodicity classifier + polyline-arc door recognition). Includes drawn-door rooms, a dense-hatch toilet room, and the cloud-bounded corridor.",
    probes: [
      // Round-8 re-pin (item C): the patient room no longer annexes its
      // toilet room — the toilet's PT-tile floor is a different finish zone
      // that the OLD classifier's loose rhythm heuristic merged in by
      // accident (its dashed door arc classified as hatch, so the escalated
      // fill walked through the doorway). With arcs recognized as arcs, the
      // room reads to its own boundaries + entry wedge, and the toilet is
      // its own one-click probe (dense hatch, failure mode #1: the click
      // lands between cross-hatch lines and must measure, not refuse).
      { name: "patient-room-137", seed: [2592, 756], expect: "golden" as const, tags: ["door-swing"] },
      // The room has an inset finish-tag ANNOTATION RING (solid hairline
      // offset lines, 45° corner ties) that the engine cannot yet see past —
      // the room probe reads to the ring, and the perimeter band between
      // ring and wall is measurable only as its own click. This probe pins
      // the band's left strip so that floor is tracked, not lost; the
      // synthetic annotation-ring-room known-fail pins the wall-to-wall
      // intent. (Adversarial re-pin audit, round 8.)
      { name: "patient-room-137-band", seed: [2550, 900], expect: "golden" as const, tags: ["annotation-band"] },
      { name: "patient-toilet-137a", seed: [2668, 1112], expect: "golden" as const, tags: ["hatch", "dense-hatch-room"] },
      { name: "elevator-e01", seed: [2538, 1566], expect: "golden" as const, tags: ["door-swing"] },
      // ward room + its vestibule are TWO probes since the min-passage rule:
      // the old single 294 SF trace reached the vestibule only through a
      // sub-half-foot slit between an annotation leader tip and a wall corner
      // (a raster accident that flipped with resolution — bench round 7).
      // Deterministically they are two spaces behind a double door, clicked
      // separately; nothing the reviewer approved is lost, it's just two rows.
      // Round 8: the ward room's own double doors (polyline arcs, now
      // curve-recognized) unify — the click measures through the open pair,
      // both swing wedges included, down to the vestibule's swing arc; the
      // vestibule keeps the complementary side, so the two tile with no
      // overlap and no gap.
      { name: "ward-room", seed: [4050, 486], expect: "golden" as const, tags: ["door-swing"] },
      { name: "ward-vestibule", seed: [4045, 1230], expect: "golden" as const, tags: ["door-swing", "vestibule"] },
      { name: "cloud-corridor", seed: [1814, 1814], expect: "golden" as const, tags: ["cloud-boundary", "corridor"] },
      { name: "shaded-wing-office", seed: [659, 1551], expect: "golden" as const, tags: ["shaded-wing"] },
      { name: "open-margin", seed: [5443, 3737], expect: "refusal" as const, tags: ["sheet-margin", "known-limit"], knownFail: true },
    ],
  },
];

// ── protocol constants ──────────────────────────────────────────────────────
export const REPIN_LIMITS = {
  /** THE rule. A single probe moving more than this fails the re-pin. 2.5% is
   *  the same band `run.mts` gates human-measured rooms at (THRESHOLDS.humanMaxSfErr). */
  probeDelta: 0.025,
  /** Reported, and gated — but see the header: on bug #17 this read +0.5%. */
  caseTotalDelta: 0.025,
  /** Adjacency tiling: two probes claiming the same floor is double-counted SF. */
  overlapFrac: 0.005,
  /** An adjudication shorter than this is not a reason, it is a keystroke. */
  minReasonChars: 20,
  /** Sampling cell (image px) for IoU(old,new). IoU is REPORTED, never gated —
   *  4 px costs a quarter of 2 px and moves the VA readings by ≤0.013. */
  iouCell: 4,
  /** Sampling cell for the pairwise overlap, which IS gated, so it keeps
   *  run.mts's CROSS_CELL resolution. */
  overlapCell: 2,
};

/** Adjudication keys that are not probe names. */
export const CASE_TOTAL_KEY = "@case-total";
export const OVERLAP_KEY = "@overlap";

export type RepinVerdict = "unchanged" | "moved" | "added" | "removed" | "refusal";

export interface ProbeDelta {
  name: string;
  verdict: RepinVerdict;
  oldSF: number | null;
  newSF: number | null;
  /** (new − old) / old, signed. null when one side has no golden. */
  deltaPct: number | null;
  /** IoU of the old and new golden rings — a probe can hold its area and still
   *  have moved somewhere else entirely, which Δ% alone cannot see. */
  iou: number | null;
  /** true ⇒ this row needs an explicit adjudication or the re-pin fails. */
  flagged: boolean;
  /** the reason supplied, once accepted. */
  adjudication?: string;
}

export interface CaseRepinDiff {
  caseFile: string;
  /** no prior corpus file on disk: nothing can be concealed, so additions pass. */
  newCase: boolean;
  probes: ProbeDelta[];
  caseTotal: { oldSF: number; newSF: number; deltaPct: number | null; flagged: boolean; adjudication?: string };
  overlap: { sf: number; frac: number; flagged: boolean; adjudication?: string };
  /** empty ⇔ the re-pin may proceed. */
  failures: string[];
  ok: boolean;
  /** adjudication keys this case actually consumed. A multi-case re-pin has to
   *  pool these before it can say an adjudication went unused — see
   *  `reportUnusedAdjudications`. */
  usedAdjudications: string[];
}

export interface RepinProbeInput { name: string; golden?: Point[] | null }

/** Shoelace area of a ring in image px, converted to SF at `pxPerFt`. */
export function ringSF(ring: Point[], pxPerFt: number): number {
  if (!ring || ring.length < 3 || !pxPerFt) return 0;
  return ringAreaAbs(ring) / (pxPerFt * pxPerFt);
}

/** Parse `--adjudicate <key>=<reason>` (repeatable) and `--dry-run` out of argv.
 *  Malformed flags throw rather than being ignored — a typo'd adjudication that
 *  silently does nothing is how a guard gets talked around. */
export function parseRepinArgs(argv: string[]): { adjudications: Map<string, string>; dryRun: boolean } {
  const adjudications = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") { dryRun = true; continue; }
    let body: string | undefined;
    if (a === "--adjudicate") body = argv[++i];
    else if (a.startsWith("--adjudicate=")) body = a.slice("--adjudicate=".length);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a} (expected --dry-run or --adjudicate <probe>=<reason>)`);
    else continue;
    if (body === undefined) throw new Error("--adjudicate needs <probe>=<reason>");
    const eq = body.indexOf("=");
    if (eq <= 0) throw new Error(`malformed --adjudicate ${JSON.stringify(body)} — expected <probe>=<reason>`);
    const key = body.slice(0, eq).trim();
    const reason = body.slice(eq + 1).trim();
    if (adjudications.has(key)) throw new Error(`duplicate adjudication for ${key}`);
    adjudications.set(key, reason);
  }
  return { adjudications, dryRun };
}

/** Diff the goldens about to be written against the goldens on disk.
 *  `oldProbes` is what `corpus/<case>.json` holds right now; `newProbes` is
 *  what this run traced. Pure — no I/O, so the acceptance test can replay a
 *  historical re-pin through the exact code path a real one takes. */
export function diffRepin(args: {
  caseFile: string;
  oldProbes: RepinProbeInput[] | null;
  newProbes: RepinProbeInput[];
  pxPerFt: number;
  adjudications?: Map<string, string>;
  /** default true. A re-pin spanning several corpus files must set this false
   *  and pool `usedAdjudications` across cases, or an adjudication naming a
   *  probe in case B is reported unused while checking case A. */
  reportUnusedAdjudications?: boolean;
}): CaseRepinDiff {
  const { caseFile, oldProbes, newProbes, pxPerFt } = args;
  const adj = args.adjudications ?? new Map<string, string>();
  const newCase = oldProbes === null;
  const oldByName = new Map((oldProbes ?? []).map((p) => [p.name, p]));
  const newByName = new Map(newProbes.map((p) => [p.name, p]));
  const failures: string[] = [];
  const used = new Set<string>();

  // an adjudication is accepted only if it is a real sentence; otherwise the
  // row stays flagged AND the empty reason is itself reported.
  const take = (key: string, what: string): string | undefined => {
    const reason = adj.get(key);
    if (reason === undefined) return undefined;
    used.add(key);
    if (reason.length < REPIN_LIMITS.minReasonChars) {
      failures.push(`${what}: adjudication for ${key} is ${reason.length} chars — state why the new value is correct (≥ ${REPIN_LIMITS.minReasonChars})`);
      return undefined;
    }
    return reason;
  };

  const names = [...newByName.keys()];
  for (const n of oldByName.keys()) if (!newByName.has(n)) names.push(n);

  const probes: ProbeDelta[] = [];
  for (const name of names) {
    const o = oldByName.get(name), n = newByName.get(name);
    const og = o?.golden ?? null, ng = n?.golden ?? null;
    const oldSF = og && og.length >= 3 ? ringSF(og, pxPerFt) : null;
    const newSF = ng && ng.length >= 3 ? ringSF(ng, pxPerFt) : null;

    let verdict: RepinVerdict, deltaPct: number | null = null, iou: number | null = null, flagged = false;
    if (oldSF === null && newSF === null) {
      verdict = "refusal";                                   // refusal probes carry no golden
    } else if (oldSF === null) {
      // A probe ADDED to an existing case is exactly the bug #17 manoeuvre: the
      // new toilet probe restored at the case level the floor the patient room
      // had just lost, so the total moved +0.5% and nobody looked further.
      verdict = "added";
      flagged = !newCase;
    } else if (newSF === null) {
      verdict = "removed";                                   // a dropped probe is floor that stopped being measured
      flagged = true;
    } else {
      deltaPct = oldSF > 0 ? (newSF - oldSF) / oldSF : null;
      iou = polyIoU(og!, ng!, REPIN_LIMITS.iouCell);
      flagged = deltaPct === null || Math.abs(deltaPct) > REPIN_LIMITS.probeDelta;
      verdict = flagged ? "moved" : "unchanged";
    }

    const row: ProbeDelta = { name, verdict, oldSF, newSF, deltaPct, iou, flagged };
    if (flagged) {
      const reason = take(name, `probe ${name}`);
      if (reason) { row.adjudication = reason; }
      else {
        const how = verdict === "added" ? `ADDED to an existing case (${newSF!.toFixed(2)} SF)`
          : verdict === "removed" ? `REMOVED from the case (was ${oldSF!.toFixed(2)} SF)`
            : `moved ${(deltaPct! * 100).toFixed(2)}% (${oldSF!.toFixed(2)} → ${newSF!.toFixed(2)} SF, IoU ${iou!.toFixed(3)})`;
        failures.push(`${caseFile} / ${name}: ${how} — exceeds ±${REPIN_LIMITS.probeDelta * 100}%; re-run with --adjudicate ${name}="why the new value is correct"`);
      }
    }
    probes.push(row);
  }

  // ── case total (REPORTED — and demonstrably not the guard, see the header) ──
  const sum = (f: (p: ProbeDelta) => number | null) => probes.reduce((a, p) => a + (f(p) ?? 0), 0);
  const oldTotal = sum((p) => p.oldSF), newTotal = sum((p) => p.newSF);
  const totalDelta = oldTotal > 0 ? (newTotal - oldTotal) / oldTotal : null;
  const totalFlagged = !newCase && totalDelta !== null && Math.abs(totalDelta) > REPIN_LIMITS.caseTotalDelta;
  const caseTotal: CaseRepinDiff["caseTotal"] = { oldSF: oldTotal, newSF: newTotal, deltaPct: totalDelta, flagged: totalFlagged };
  if (totalFlagged) {
    const reason = take(CASE_TOTAL_KEY, "case total");
    if (reason) caseTotal.adjudication = reason;
    else failures.push(`${caseFile}: case total moved ${(totalDelta! * 100).toFixed(2)}% (${oldTotal.toFixed(2)} → ${newTotal.toFixed(2)} SF) — exceeds ±${REPIN_LIMITS.caseTotalDelta * 100}%; re-run with --adjudicate ${CASE_TOTAL_KEY}="..."`);
  }

  // ── adjacency tiling: pairwise overlap of the NEW rings (double-counted floor) ──
  const rings = probes.map((p) => newByName.get(p.name)?.golden).filter((g): g is Point[] => !!g && g.length >= 3);
  let overlapPx2 = 0;
  for (let i = 0; i < rings.length; i++)
    for (let j = i + 1; j < rings.length; j++) overlapPx2 += polyOverlapPx2(rings[i], rings[j], REPIN_LIMITS.overlapCell);
  const overlapSF = overlapPx2 / (pxPerFt * pxPerFt);
  const overlapFrac = newTotal > 0 ? overlapSF / newTotal : 0;
  const overlapFlagged = overlapFrac > REPIN_LIMITS.overlapFrac;
  const overlap: CaseRepinDiff["overlap"] = { sf: overlapSF, frac: overlapFrac, flagged: overlapFlagged };
  if (overlapFlagged) {
    const reason = take(OVERLAP_KEY, "pairwise overlap");
    if (reason) overlap.adjudication = reason;
    else failures.push(`${caseFile}: ${overlapSF.toFixed(2)} SF double-counted across probes (${(overlapFrac * 100).toFixed(2)}% of the case total) — exceeds ${REPIN_LIMITS.overlapFrac * 100}%; re-run with --adjudicate ${OVERLAP_KEY}="..."`);
  }

  // Unused adjudications fail too: pre-authorising a move that did not happen
  // (or misspelling the probe you meant) leaves a blanket permission behind.
  if (args.reportUnusedAdjudications !== false)
    for (const key of adj.keys()) if (!used.has(key)) failures.push(unusedAdjudicationFailure(key));

  return { caseFile, newCase, probes, caseTotal, overlap, failures, ok: failures.length === 0, usedAdjudications: [...used] };
}

export const unusedAdjudicationFailure = (key: string) =>
  `adjudication for "${key}" matched nothing that moved — remove it or fix the probe name`;

const pct = (v: number | null) => (v === null ? "     —" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
const sf = (v: number | null) => (v === null ? "      —" : v.toFixed(2));

/** Human-readable re-pin diff. Per-probe rows first and loudest; the case-total
 *  and adjacency figures follow, explicitly labelled as the checks that would
 *  NOT have caught the regression this protocol exists for. */
export function formatRepinDiff(d: CaseRepinDiff): string {
  const L: string[] = [];
  L.push(`\n── re-pin diff: ${d.caseFile}${d.newCase ? "   [NEW CASE — no prior goldens on disk]" : ""} ──`);
  L.push(`   ${"probe".padEnd(26)} ${"old SF".padStart(9)} ${"new SF".padStart(9)} ${"Δ%".padStart(9)} ${"IoU(old,new)".padStart(13)}  verdict`);
  for (const p of d.probes) {
    const mark = p.flagged ? (p.adjudication ? "ADJUDICATED" : "*** FAILS ±2.5% ***") : p.verdict;
    const why = p.adjudication ? `  ← ${p.adjudication}` : "";
    L.push(`   ${p.name.padEnd(26)} ${sf(p.oldSF).padStart(9)} ${sf(p.newSF).padStart(9)} ${pct(p.deltaPct).padStart(9)} ${(p.iou === null ? "—" : p.iou.toFixed(3)).padStart(13)}  ${mark}${why}`);
  }
  const moved = d.probes.filter((p) => p.flagged);
  L.push(`   per-probe rule (±${REPIN_LIMITS.probeDelta * 100}%): ${moved.length ? `${moved.length} probe(s) flagged — ${moved.filter((p) => p.adjudication).length} adjudicated` : "all probes within band"}`);
  L.push(`   case total: ${d.caseTotal.oldSF.toFixed(2)} → ${d.caseTotal.newSF.toFixed(2)} SF (${pct(d.caseTotal.deltaPct)})${d.caseTotal.flagged ? (d.caseTotal.adjudication ? "  ADJUDICATED" : "  *** FAILS ±2.5% ***") : "  within band"}`);
  L.push(`   adjacency: ${d.overlap.sf.toFixed(2)} SF double-counted (${(d.overlap.frac * 100).toFixed(3)}% of total)${d.overlap.flagged ? "  *** FAILS 0.5% ***" : "  within band"}`);
  if (moved.length && !d.caseTotal.flagged) {
    // The fact this protocol exists for. Keep it printed, not just commented.
    L.push(`   NOTE: ${moved.length} probe(s) moved while the CASE TOTAL stayed inside its band.`);
    L.push(`         That is exactly bug #17: 2730050 → 92c1242 moved patient-room-137`);
    L.push(`         240.77 → 161.91 SF (−32.75%) while the case total moved 2476.72 →`);
    L.push(`         2489.50 SF (+0.5%) — a new toilet probe was added in the same commit.`);
    L.push(`         The per-probe rule is the guard; the case total is not.`);
  }
  return L.join("\n");
}

// ── the re-pin itself ───────────────────────────────────────────────────────

interface PinnedProbeOut { name: string; seed?: number[]; expect: string; tags?: string[]; knownFail?: boolean; golden?: Point[]; adjudications?: object[] }

/** A row in the CASE-level `adjudications` array. `scope` is what `bench/run.mts`
 *  prints as the subject of a case-level row, so for an orphan it carries the
 *  probe name — two removals in one re-pin must not print identically. `probe`
 *  is the machine-readable copy of that name.
 *
 *  A removal has no `to_sf`: the probe stopped being measured, which is not the
 *  same claim as "it now measures 0 SF". `removed_sf` is what it last measured.
 *  (`from_sf`/`to_sf` are written as a pair or not at all — run.mts's printer
 *  formats `to_sf` unconditionally once it sees a `from_sf`.) Verified against
 *  `npm run bench`: it prints scope, date and reason for these rows; it does not
 *  yet format `removed_sf`, so that number currently lives in the JSON only. */
type CaseAdjudicationOut = Record<string, unknown>;

async function main() {
  const { adjudications, dryRun } = parseRepinArgs(process.argv.slice(2));
  const req = createRequire(import.meta.url);
  const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  const at = new Date().toISOString().slice(0, 10);
  const pending: Array<{ path: string; json: string; diff: CaseRepinDiff }> = [];
  const failures: string[] = [];
  const usedAnywhere = new Set<string>();

  for (const c of PINNED) {
    // case pdf paths are relative to the CASE FILE's directory (bench/corpus/)
    const doc = await pdfjs.getDocument({ url: join(corpusDir, c.pdf), useSystemFonts: true }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: c.scale });
    const ops = await page.getOperatorList();
    const g = extractVectorGeometry(ops, vp.transform, pdfjs.OPS);
    const mo = buildMask(g.segs, vp.width, vp.height, MASK_MAX_DIM, g.meta, c.ptPerFt);
    const mppf = mo.ws * c.ptPerFt;
    // A5b: pin THE PRODUCTION RING. This used to be a bare `traceRegion`, so
    // every golden on disk pinned a quantity the product never returns.
    const nearest = snapNearest(g.points);
    const probes: PinnedProbeOut[] = [];
    for (const p of c.probes) {
      if (p.expect === "refusal") { probes.push({ ...p } as PinnedProbeOut); continue; }
      const f = floodRegionSealed(mo, p.seed[0], p.seed[1], 0.5, sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf));
      if (f.status !== "ok") { console.error(`  ${c.file} ${p.name}: engine refused (${f.status}) — cannot pin`); continue; }
      const ring: Point[] = oneClickRing(f, { nearest }).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
      probes.push({ ...p, golden: ring } as PinnedProbeOut);
      console.log(`  ${c.file} ${p.name}: traced ${ring.length} verts${f.wedges ? " (+swing)" : ""}${f.sealedPx ? ` (sealed@${f.sealedPx})` : ""}`);
    }

    // 0.9: compare against what is ON DISK, before anything is overwritten.
    const path = join(corpusDir, c.file);
    const prior = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    // pooled across cases below — an adjudication naming a probe in the OTHER
    // corpus file has not "matched nothing", it just matched somewhere else.
    const diff = diffRepin({ caseFile: c.file, oldProbes: prior ? prior.probes : null, newProbes: probes, pxPerFt: c.ptPerFt, adjudications, reportUnusedAdjudications: false });
    for (const k of diff.usedAdjudications) usedAnywhere.add(k);
    console.log(formatRepinDiff(diff));
    failures.push(...diff.failures);

    // Adjudications are append-only and live in the corpus JSON, so the reason
    // outlives the terminal it was typed into and every later re-pin keeps it.
    const priorByName = new Map<string, PinnedProbeOut>((prior?.probes ?? []).map((p: PinnedProbeOut) => [p.name, p]));
    const caseAdj: CaseAdjudicationOut[] = [...(prior?.adjudications ?? [])];
    for (const row of diff.probes) {
      if (!row.adjudication) continue;
      const target = probes.find((p) => p.name === row.name);
      if (target) {
        target.adjudications = [...(priorByName.get(row.name)?.adjudications ?? []),
          { at, from_sf: row.oldSF === null ? null : +row.oldSF.toFixed(2), to_sf: row.newSF === null ? null : +row.newSF.toFixed(2), delta_pct: row.deltaPct === null ? null : +(row.deltaPct * 100).toFixed(2), iou_old_new: row.iou === null ? null : +row.iou.toFixed(3), reason: row.adjudication }];
        continue;
      }
      // F4: ORPHAN — the probe was REMOVED by this re-pin (or is the removal
      // half of a rename), so there is no new probe object to attach to. Park
      // the reason on the CASE instead; dropping it here is what falsified the
      // protocol's own "the reason survives every later re-pin" claim, in
      // precisely the case the header calls most dangerous.
      const scope = `removed-probe ${row.name}`;
      // The removed probe's earlier adjudications go with the probe object when
      // it disappears. Carry them onto the case first, in order, so the removal
      // reason lands at the end of that probe's own history rather than instead
      // of it.
      for (const earlier of (priorByName.get(row.name)?.adjudications ?? []) as CaseAdjudicationOut[]) {
        const { at: earlierAt, ...rest } = earlier;      // keeps the case-level key order: at, scope, …
        caseAdj.push({ at: earlierAt, scope, probe: row.name, ...rest });
      }
      caseAdj.push({ at, scope, probe: row.name, removed_sf: row.oldSF === null ? null : +row.oldSF.toFixed(2), reason: row.adjudication });
    }
    for (const p of probes) if (!p.adjudications && priorByName.get(p.name)?.adjudications) p.adjudications = priorByName.get(p.name)!.adjudications;

    if (diff.caseTotal.adjudication) caseAdj.push({ at, scope: "case-total", from_sf: +diff.caseTotal.oldSF.toFixed(2), to_sf: +diff.caseTotal.newSF.toFixed(2), delta_pct: +((diff.caseTotal.deltaPct ?? 0) * 100).toFixed(2), reason: diff.caseTotal.adjudication });
    if (diff.overlap.adjudication) caseAdj.push({ at, scope: "pairwise-overlap", overlap_sf: +diff.overlap.sf.toFixed(2), frac_pct: +(diff.overlap.frac * 100).toFixed(3), reason: diff.overlap.adjudication });

    // F5/F6 handback: preserve the ON-DISK declaration. A case whose file already
    // declares its measurand (a human key declaring centerline or interior-clear)
    // must not be silently overwritten with the engine's measurand on re-pin —
    // the field exists to carry information, and this writer was one of the two
    // tautology sources. Engine-pinned cases with no prior get the engine's value.
    const out = { pdf: c.pdf, scale: c.scale, ptPerFt: c.ptPerFt, wallSemantics: prior?.wallSemantics ?? WALL_SEMANTICS, note: c.note, pinnedAt: "reviewed traces, issue #184", ...(caseAdj.length ? { adjudications: caseAdj } : {}), probes };
    pending.push({ path, json: JSON.stringify(out, null, 1), diff });
  }

  for (const key of adjudications.keys()) if (!usedAnywhere.has(key)) failures.push(unusedAdjudicationFailure(key));

  // Nothing is written unless EVERY case passes. A failed re-pin must leave the
  // goldens exactly as they were — a half-applied re-pin is the worst outcome.
  if (failures.length) {
    console.error(`\nRE-PIN REFUSED — goldens on disk are unchanged:`);
    for (const f of failures) console.error(`  • ${f}`);
    console.error(`\n${failures.length} unadjudicated change(s). Each --adjudicate reason is written into the corpus JSON and printed by every \`npm run bench\`.`);
    process.exit(1);
  }
  if (dryRun) { console.log("\n--dry-run: nothing written."); return; }
  for (const { path, json } of pending) { writeFileSync(path, json); console.log(`wrote ${path.replace(/^.*[\\/]corpus[\\/]/, "corpus/")}`); }
}

// Importable (the acceptance test replays historical re-pins through diffRepin);
// only re-pins when run as the entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
