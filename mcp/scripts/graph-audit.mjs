// Field audit for the sheet graph (#87) — point it at a REAL plan set and
// read what the graph claims against what you know is on the sheets. This is
// the eval loop for phase 3+: your own bid sets are the held-out key.
//
//   node --import tsx scripts/graph-audit.mjs <set.pdf> [addendum.pdf ...]
//
// Multiple PDFs merge into one working set (plans + schedule + addenda), the
// way load_plan merge does. Prints: every sheet's role with its evidence,
// every schedule table (fragments, rotated headers, revised-row counts),
// buildings, EVERY revision marker (text and drawn-delta), the named notes,
// then resolves EVERY room tag the graph found and tallies the refusals by
// reason. Nothing is written; real sets never enter the repo.
//
// How to score it: pick a set where you know the ground truth (a set you bid,
// with its addendum). Every miss falls in one of these bins —
//   - a room the graph missed        → rooms list vs the plan
//   - a wrong finish code            → spot-check resolved rows vs the schedule
//   - a revision it didn't see       → revisions list vs the deltas you know
//   - a refusal that names the wrong reason
// File the miss (with the sheet + bbox the tool printed) as a #87 comment.
import { Session } from "../src/session.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!args.length) {
  console.error("usage: node --import tsx scripts/graph-audit.mjs <set.pdf> [more.pdf ...]");
  process.exit(2);
}

const box = (b) => `[${b.x0},${b.y0} ${b.x1},${b.y1}]`;
const s = new Session();
for (let i = 0; i < args.length; i++) await s.loadPlan(args[i], { merge: i > 0 });

const g = await s.sheetGraph();
if (!g.available) {
  console.log("UNAVAILABLE — no text layer anywhere (a scanned set). The graph refuses cleanly; nothing half-populates.");
  process.exit(0);
}

console.log("═ sheets ═");
for (const sh of g.sheets) {
  const ev = sh.evidence ? ` — "${sh.evidence.text}" ${box(sh.evidence.bbox)}` : " — (sheet-number convention)";
  console.log(`  ${sh.sheet}  ${sh.role} (${sh.confidence.toFixed(2)})${sh.building ? `  building ${sh.building}` : ""}${ev}`);
  for (const t of sh.schedules) {
    console.log(`      ${t.kind}: "${t.title}" ${t.rows} rows${t.continues ? `  ⤷ continues ${t.continues}` : ""}${t.rotated_headers ? "  (rotated headers)" : ""}`);
  }
}

console.log(`\n═ buildings ═  ${g.buildings?.length ? g.buildings.join(", ") : "(none named)"}`);

console.log(`\n═ revisions ═  ${g.revisions?.length ?? 0} marker(s)`);
for (const r of g.revisions ?? []) console.log(`  rev ${r.rev}${r.drawn ? " (drawn delta)" : ""}  ${r.sheet} ${box(r.bbox)}`);
if (!g.revisions?.length) console.log("  none detected — remember: clouds without a delta/REV marker are invisible to these detectors");

if (g.notes?.length) {
  console.log("\n═ named gaps ═");
  for (const n of g.notes) console.log(`  ! ${n}`);
}

console.log(`\n═ rooms ═  ${g.rooms.length} tag(s) on plan-role sheets`);
const tags = [...new Set(g.rooms.map((r) => (r.building ? `${r.building}-${r.tag}` : r.tag)))].sort();
const tally = new Map();
let resolved = 0;
for (const tag of tags) {
  const res = await s.resolveRoomTag(tag);
  if (res.status === "resolved") {
    resolved++;
    const fin = res.finishes.map((f) => `${f.surface}=${f.code}${f.definition ? "†" : ""}`).join("  ");
    const rev = res.revisions?.length ? `   ⚠ rev ${res.revisions.map((v) => v.rev + (v.drawn ? " (drawn)" : "")).join(", ")}` : "";
    console.log(`  ${tag.padEnd(8)} ${(res.room?.name || "").padEnd(14)} ${fin}${rev}`);
  } else {
    const bin = res.reason.split("—")[0].trim();
    tally.set(bin, (tally.get(bin) || 0) + 1);
    console.log(`  ${tag.padEnd(8)} UNRESOLVED — ${res.reason}`);
  }
}

console.log(`\n═ summary ═  resolved ${resolved}/${tags.length}   († = chained to a finish/material definition)`);
for (const [reason, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${reason}`);
