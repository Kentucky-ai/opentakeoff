// Scored evaluation for the sheet graph (#87) against REAL plan sets.
// Method, current results and known gaps: docs/SHEET-GRAPH-EVAL.md
//
//   node --import tsx scripts/graph-eval.mjs <corpus-dir> [setId ...]
//
// The corpus lives OUTSIDE this repo (real plansets never enter it): a
// directory holding sets.json plus keys/<id>.csv and keys/<id>.tags.csv.
// This script is the ruler — it is deliberately dumb and stable, so a number
// measured today is comparable with one measured after a rule change. Do not
// "improve" the scorer to make a run look better; register a new experiment
// instead.
//
// TWO metrics, because one alone is gameable:
//
//   1. CELL accuracy — for every (room, surface) the key states, did
//      resolve_tag return the same code? precision / recall / F1.
//      This is the number that says "the finish it reports is the finish
//      the schedule states".
//
//   2. TAG classification — of the plan tags the graph calls rooms, how many
//      ARE rooms? precision / recall against keys/<id>.tags.csv.
//      This is the number that catches keynote and detail bubbles read as
//      rooms. Cell accuracy alone can sit at 1.000 while the graph invents
//      thirty rooms that do not exist.
//
// Key formats (CSV, header row required):
//   keys/<id>.csv        room,surface,code      surface ∈ FLOOR BASE CEILING
//                                               WALL WALL_N WALL_E WALL_S WALL_W
//                                               (blank code = the schedule
//                                               states none; parser must not
//                                               invent one)
//   keys/<id>.tags.csv   tag,is_room            is_room ∈ 1 | 0
//   keys/<id>.rowsym.csv tag,expect_status,note  expect_status ∈ resolved | refused
//                                               — for a schedule-row mark (T1,
//                                               EBB-2, EF-1 …), does the sweep
//                                               find it DRAWN on a plan sheet?
//                                               `resolved` = ≥ 1 instance (by
//                                               geometry or by label);
//                                               `refused` = the set never
//                                               draws it (a note mention is
//                                               not a drawing). The key is
//                                               read off the RENDERED sheet,
//                                               never off the tool's output.
//
//   3. ROW → SYMBOL — the third metric (2026-09-05): of the schedule rows the
//      key names, how many does sweep_schedule_row resolve to drawn instances,
//      and does it refuse the ones the set never draws? Precision / recall on
//      "resolved". The count itself is not scored here (expected_count is
//      optional in the key and reported, not graded) — this ruler asks the
//      yes/no question first, because a wrong yes is a phantom device in a bid.
//
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Session } from "../src/session.ts";

const [corpusDir, ...only] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const writeReport = process.argv.includes("--report");
if (!corpusDir) {
  console.error("usage: node --import tsx scripts/graph-eval.mjs <corpus-dir> [setId ...] [--report]");
  process.exit(2);
}
const corpus = resolve(corpusDir);
const spec = JSON.parse(readFileSync(join(corpus, "sets.json"), "utf8"));

// ── the ruler ───────────────────────────────────────────────────────────────
/** Canonical surface names. The parser's own labels change as it learns to
 * read new column shapes; the KEY must not. */
const SURFACE_ALIASES = new Map(Object.entries({
  FLOOR: "FLOOR", BASE: "BASE", CEILING: "CEILING", CLG: "CEILING",
  WALL: "WALL", WALLS: "WALL",
  "WALLS N": "WALL_N", "WALLS E": "WALL_E", "WALLS S": "WALL_S", "WALLS W": "WALL_W",
  NORTH: "WALL_N", EAST: "WALL_E", SOUTH: "WALL_S", WEST: "WALL_W",
  "WALL N": "WALL_N", "WALL E": "WALL_E", "WALL S": "WALL_S", "WALL W": "WALL_W",
  // three-tier headers name a column by its parent: FLOOR > FINISH
  "FLOOR FINISH": "FLOOR", "CEILING FINISH": "CEILING", "WALLS NORTH": "WALL_N",
  "WALLS EAST": "WALL_E", "WALLS SOUTH": "WALL_S", "WALLS WEST": "WALL_W",
}));
// underscores and spaces are the same separator: the key writes WALL_E, the
// parser says "WALLS E". A surface the table does not know is DROPPED, and a
// dropped key row silently deflates the score — so unknown surfaces throw.
const canonSurface = (s, strict = false) => {
  const k = String(s || "").trim().toUpperCase().replace(/[_\s]+/g, " ");
  const hit = SURFACE_ALIASES.get(k);
  if (!hit && strict) throw new Error(`unknown surface in key: ${JSON.stringify(s)}`);
  return hit ?? null;
};

/** Code comparison: whitespace and case normalized, separators unified. A
 * schedule writes "TL-2, TL-2B, PT" and "TL-2,TL-2B,PT" for the same thing.
 * An em-dash, en-dash or lone hyphen all mean "none stated". */
const canonCode = (c) => {
  const t = String(c ?? "").trim().toUpperCase().replace(/\s*,\s*/g, ",").replace(/\s+/g, " ");
  return /^[-–—]*$/.test(t) ? "" : t;
};
const canonTag = (t) => String(t ?? "").trim().toUpperCase().replace(/\s+/g, "");

function readCsv(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((l) => {
    // minimal CSV: quoted fields may contain commas
    const cells = [];
    let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') { q = !q; continue; }
      if (ch === "," && !q) { cells.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
}

const pct = (n) => (n * 100).toFixed(1).padStart(5) + "%";
const f1 = (p, r) => (p + r ? (2 * p * r) / (p + r) : 0);

// ── run one set ─────────────────────────────────────────────────────────────
async function evalSet(set) {
  const s = new Session();
  // a relative root is relative to the corpus directory (a fixture corpus
  // inside the repo says root ".."); an absolute one is used as-is
  const root = resolve(corpus, set.root ?? spec.root ?? ".");
  const files = set.files.map((f) => join(root, f));
  for (let i = 0; i < files.length; i++) await s.loadPlan(files[i], { merge: i > 0 });
  const g = await s.sheetGraph();

  const reported = [...new Set(g.rooms.map((r) => canonTag(r.building ? `${r.building}-${r.tag}` : r.tag)))].sort();
  const resolved = new Map();
  for (const tag of reported) resolved.set(tag, await s.resolveRoomTag(tag));

  const out = { id: set.id, gc: set.gc, project: set.project, reported: reported.length, misses: [] };

  // ── metric 2: tag classification ──
  const tagKey = readCsv(join(corpus, "keys", `${set.id}.tags.csv`));
  if (tagKey) {
    const realTags = new Set(tagKey.filter((r) => r.is_room === "1").map((r) => canonTag(r.tag)));
    const knownTags = new Set(tagKey.map((r) => canonTag(r.tag)));
    let tp = 0, fp = 0;
    for (const t of reported) {
      if (realTags.has(t)) tp++;
      else if (knownTags.has(t)) { fp++; out.misses.push({ kind: "tag-not-a-room", tag: t }); }
      else { fp++; out.misses.push({ kind: "tag-unlabelled", tag: t }); }
    }
    const fn = [...realTags].filter((t) => !reported.includes(t));
    for (const t of fn) out.misses.push({ kind: "tag-missed", tag: t });
    out.tag = { tp, fp, fn: fn.length, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, realTags.size) };
  }

  // ── metric 1: cell accuracy ──
  const cellKey = readCsv(join(corpus, "keys", `${set.id}.csv`));
  if (cellKey) {
    // key → Map<"tag|SURFACE", code>
    const key = new Map();
    for (const row of cellKey) {
      const surf = canonSurface(row.surface, true);   // strict: a key row must never be dropped
      key.set(`${canonTag(row.room)}|${surf}`, canonCode(row.code));
    }
    // parser → same shape
    const got = new Map();
    for (const [tag, res] of resolved) {
      if (res.status !== "resolved") continue;
      for (const f of res.finishes ?? []) {
        const surf = canonSurface(f.surface);
        if (!surf) continue;
        got.set(`${tag}|${surf}`, canonCode(f.code));
      }
    }
    let tp = 0, fp = 0, fn = 0;
    for (const [k, want] of key) {
      const have = got.get(k);
      if (want === "") {                      // the schedule states nothing here
        if (have != null && have !== "") { fp++; out.misses.push({ kind: "cell-invented", at: k, got: have }); }
        continue;                             // a correctly absent cell is not scored as a hit
      }
      if (have == null) { fn++; out.misses.push({ kind: "cell-missing", at: k, want }); }
      else if (have === want) tp++;
      else { fp++; out.misses.push({ kind: "cell-wrong", at: k, want, got: have }); }
    }
    // a cell the parser produced that the key never mentions, for a room the
    // key DOES cover, is an invention
    for (const [k, have] of got) {
      if (key.has(k) || have === "") continue;
      const tag = k.split("|")[0];
      if (![...key.keys()].some((kk) => kk.startsWith(`${tag}|`))) continue;
      fp++; out.misses.push({ kind: "cell-extra", at: k, got: have });
    }
    const p = tp / Math.max(1, tp + fp), r = tp / Math.max(1, tp + fn);
    out.cell = { tp, fp, fn, precision: p, recall: r, f1: f1(p, r) };
  }

  // ── metric 3: row → symbol ──
  const rowsymKey = readCsv(join(corpus, "keys", `${set.id}.rowsym.csv`));
  if (rowsymKey) {
    let tp = 0, fp = 0, fn = 0, right = 0;
    const counts = [];
    for (const row of rowsymKey) {
      const tag = canonTag(row.tag);
      const want = String(row.expect_status || "").trim().toLowerCase();
      if (want !== "resolved" && want !== "refused") throw new Error(`${set.id}.rowsym.csv: expect_status must be resolved|refused, got "${row.expect_status}" for ${tag}`);
      let got = "refused", found = 0, by = "";
      try { const r = await s.sweepScheduleRow(tag); found = r.found; by = r.counted_by; got = r.found > 0 ? "resolved" : "refused"; }
      catch { got = "refused"; }
      if (want === "resolved" && got === "resolved") { tp++; right++; }
      else if (want === "resolved" && got === "refused") { fn++; out.misses.push({ kind: "rowsym-missed", tag }); }
      else if (want === "refused" && got === "resolved") { fp++; out.misses.push({ kind: "rowsym-phantom", tag, got: String(found) }); }
      else right++;
      if (row.expected_count != null && row.expected_count !== "" && got === "resolved") counts.push({ tag, want: Number(row.expected_count), got: found, by });
    }
    out.rowsym = { tp, fp, fn, n: rowsymKey.length, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), right, counts };
  }

  if (!cellKey && !tagKey && !rowsymKey) out.unlabelled = true;
  return out;
}

// ── report ──────────────────────────────────────────────────────────────────
const wanted = spec.sets.filter((s) => !only.length || only.includes(s.id));
const results = [];
for (const set of wanted) {
  process.stderr.write(`· ${set.id} …\n`);
  try { results.push(await evalSet(set)); }
  catch (e) { results.push({ id: set.id, gc: set.gc, project: set.project, error: String(e.message || e) }); }
}

const lines = [];
const say = (l = "") => { lines.push(l); console.log(l); };

say("╔══════════════════════════════════════════════════════════════════════════");
say("║ SHEET GRAPH — scored against real sets");
say("╚══════════════════════════════════════════════════════════════════════════");
say("");
say("set                        cell P    cell R   cell F1     tag P    tag R   reported");
say("────────────────────────────────────────────────────────────────────────────────────");
const agg = { ctp: 0, cfp: 0, cfn: 0, ttp: 0, tfp: 0, tfn: 0 };
for (const r of results) {
  if (r.error) { say(`${r.id.padEnd(26)} ERROR: ${r.error.slice(0, 60)}`); continue; }
  if (r.unlabelled) { say(`${r.id.padEnd(26)} (no key yet)  reported ${r.reported}`); continue; }
  const c = r.cell, t = r.tag;
  if (c) { agg.ctp += c.tp; agg.cfp += c.fp; agg.cfn += c.fn; }
  if (t) { agg.ttp += t.tp; agg.tfp += t.fp; agg.tfn += t.fn; }
  say(`${r.id.padEnd(26)}${c ? pct(c.precision) + "   " + pct(c.recall) + "   " + pct(c.f1) : "    —        —        —   "}`
    + `${t ? "  " + pct(t.precision) + "   " + pct(t.recall) : "      —        —"}   ${String(r.reported).padStart(5)}`);
}
say("────────────────────────────────────────────────────────────────────────────────────");
const cP = agg.ctp / Math.max(1, agg.ctp + agg.cfp), cR = agg.ctp / Math.max(1, agg.ctp + agg.cfn);
const tP = agg.ttp / Math.max(1, agg.ttp + agg.tfp), tR = agg.ttp / Math.max(1, agg.ttp + agg.tfn);
say(`${"CORPUS".padEnd(26)}${pct(cP)}   ${pct(cR)}   ${pct(f1(cP, cR))}  ${pct(tP)}   ${pct(tR)}`);
say("");
say(`cells  ${agg.ctp} right · ${agg.cfp} wrong · ${agg.cfn} missed`);
say(`tags   ${agg.ttp} real · ${agg.tfp} not-rooms reported · ${agg.tfn} real rooms missed`);
say("");
const withRowsym = results.filter((r) => r.rowsym);
if (withRowsym.length) {
  say("── row → symbol (sweep_schedule_row): does a scheduled mark resolve to drawn instances? ──");
  say("set                        rows    P        R     phantom  missed   counts (want→got)");
  let rtp = 0, rfp = 0, rfn = 0;
  for (const r of withRowsym) {
    const x = r.rowsym; rtp += x.tp; rfp += x.fp; rfn += x.fn;
    const cts = x.counts.map((c) => `${c.tag}:${c.want}→${c.got}${c.by === "label" ? "L" : c.by === "mixed" ? "M" : ""}`).join(" ");
    say(`${r.id.padEnd(26)}${String(x.n).padStart(4)}   ${pct(x.precision)}   ${pct(x.recall)}   ${String(x.fp).padStart(5)}   ${String(x.fn).padStart(5)}   ${cts}`);
  }
  const P = rtp / Math.max(1, rtp + rfp), R = rtp / Math.max(1, rtp + rfn);
  say(`${"CORPUS".padEnd(26)}       ${pct(P)}   ${pct(R)}`);
  say("");
}

// worst bins first — this is what the next fix should attack
const bins = new Map();
for (const r of results) for (const m of r.misses ?? []) {
  const k = m.kind;
  if (!bins.has(k)) bins.set(k, []);
  bins.get(k).push({ set: r.id, ...m });
}
if (bins.size) {
  say("── failure bins, worst first ──");
  for (const [kind, items] of [...bins.entries()].sort((a, b) => b[1].length - a[1].length)) {
    say(`${String(items.length).padStart(5)}×  ${kind}`);
    for (const it of items.slice(0, 6)) {
      say(`         ${it.set}  ${it.at ?? it.tag}${it.want != null ? `  want "${it.want}" got "${it.got}"` : it.got != null ? `  got "${it.got}"` : ""}`);
    }
    if (items.length > 6) say(`         … and ${items.length - 6} more`);
  }
}

if (writeReport) {
  const p = join(corpus, "reports", `EVAL-${new Date(spec.stamp ?? Date.now()).toISOString().slice(0, 10)}.txt`);
  writeFileSync(p, lines.join("\n"));
  console.error(`\nwrote ${p}`);
}
process.exit(0);
