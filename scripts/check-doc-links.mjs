#!/usr/bin/env node
// check-doc-links.mjs — fail on a broken documentation reference (#197).
//
// Tier 1 (default, offline, deterministic, CI-gating):
//   every `](path)` and `[ref]: path` in the doc set that isn't http(s)/mailto
//   must resolve to a real file relative to the linking file's directory, and
//   every `](#anchor)` (same-file or file.md#anchor) must match a heading's
//   GitHub slug in the target file.
//
// Tier 2 (--issues, network, NEVER gating):
//   report linked GitHub issues/PRs on this repo that are closed — a nudge to
//   reword, not a block. Always exits 0 on its own findings; API failures are
//   reported and swallowed. Run it on a schedule or on pushes, not to gate PRs.
//
// No dependencies on purpose: node:fs and a regex are the whole machine.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const checkIssues = process.argv.includes("--issues");

// The doc set from the issue: top-level READMEs (all languages), docs/, and
// the two nested READMEs contributors actually land on.
const files = [
  ...readdirSync(root).filter((f) => /^README(\.[A-Za-z-]+)?\.md$/.test(f)),
  ...readdirSync(join(root, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f)),
  "mcp/README.md",
  "capture/README.md",
].filter((f) => existsSync(join(root, f)));

// GitHub's slug rules: lowercase, drop everything that isn't a letter, number,
// space, hyphen, or underscore (so `.` `&` and the em-dash vanish — which is
// how "## 3. Scale — set it first" becomes #3-scale--set-it-first, double
// hyphen and all), then spaces → `-`. Duplicate headings get -1, -2, …
function slugify(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // linked heading text → its text
    .replace(/[`*]/g, "")
    .trim();
  return text.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
}

// Per-file scan, fence-aware: headings and links inside ``` blocks are code,
// not documentation, on both sides (a fenced example of a broken link must not
// fail the build; a fenced `# comment` is not an anchor target).
function scan(relPath) {
  const lines = readFileSync(join(root, relPath), "utf8").split("\n");
  const anchors = new Set();
  const links = []; // {line, target}
  const counts = new Map();
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      const base = slugify(h[1]);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const a of line.matchAll(/<a\s[^>]*(?:name|id)="([^"]+)"/g)) anchors.add(a[1]);
    // inline links and images: ](target) with optional <…> and "title"
    for (const m of line.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
      links.push({ line: i + 1, target: m[1].replace(/^<|>$/g, "") });
    }
    // reference-style definitions: [ref]: target
    const d = line.match(/^\s*\[[^\]^]+\]:\s*(\S+)/);
    if (d) links.push({ line: i + 1, target: d[1] });
  }
  return { anchors, links };
}

const scanned = new Map(files.map((f) => [f, scan(f)]));
const failures = [];
const issueLinks = [];

for (const [file, { anchors, links }] of scanned) {
  for (const { line, target } of links) {
    if (/^(https?:|mailto:|data:)/i.test(target)) {
      const gh = target.match(/^https:\/\/github\.com\/Kentucky-ai\/opentakeoff\/(issues|pull)\/(\d+)/);
      if (gh) issueLinks.push({ file, line, kind: gh[1], number: gh[2] });
      continue;
    }
    const [rawPath, fragment] = target.split("#");
    const path = decodeURIComponent(rawPath);
    let targetFile = file;
    if (path) {
      const abs = resolve(join(root, dirname(file)), path);
      targetFile = relative(root, abs);
      if (!existsSync(abs)) {
        failures.push(`${file}:${line}: broken path "${target}" — ${targetFile} does not exist`);
        continue;
      }
    }
    if (fragment !== undefined) {
      if (!targetFile.endsWith(".md")) continue; // anchors into non-markdown are the renderer's business
      if (!scanned.has(targetFile)) scanned.set(targetFile, scan(targetFile));
      if (!scanned.get(targetFile).anchors.has(fragment.toLowerCase())) {
        failures.push(`${file}:${line}: dead anchor "${target}" — no heading in ${targetFile} slugs to #${fragment.toLowerCase()}`);
      }
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error(`::error::${f}`);
  console.error(`\n${failures.length} broken doc link(s) across ${files.length} files.`);
  process.exit(1);
}
console.log(`doc links OK — ${files.length} files, every relative path and anchor resolves.`);

// ── Tier 2: closed-issue nudge. Warnings only, and its own failures are too. ──
if (checkIssues && issueLinks.length) {
  const seen = new Map(); // number → state, one fetch per issue
  for (const { file, line, number } of issueLinks) {
    try {
      if (!seen.has(number)) {
        const res = await fetch(`https://api.github.com/repos/Kentucky-ai/opentakeoff/issues/${number}`, {
          headers: { accept: "application/vnd.github+json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        seen.set(number, (await res.json()).state);
      }
      if (seen.get(number) === "closed") {
        console.warn(`::warning::${file}:${line}: links #${number}, which is CLOSED — consider rewording`);
      }
    } catch (e) {
      console.warn(`::warning::could not check #${number} (${e.message}) — skipping, this tier never fails the build`);
    }
  }
}
