#!/usr/bin/env node
// build-site.mjs — the static public pages, generated into dist/ after `vite build`.
//
// The canvas at / is a React app; crawlers that don't run JavaScript (most AI
// crawlers) can't read it. These pages are plain HTML they read whole: the
// agent / flooring / free-software pages, four calculators (worked example
// rendered in), and the repo's manuals mirrored from docs/*.md. It also writes
// sitemap.xml, llms.txt (tool count generated) and llms-full.txt.
//
// Sources: web/site/. Output: web/dist/. Runs as part of `npm run build`, so CI's
// `npm run check` and every Netlify deploy exercise it.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN } from "../site/layout.mjs";
import { buildPages } from "../site/pages.mjs";
import { DOCS, renderDoc } from "../site/docs.mjs";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(web, "..");
const site = join(web, "site");
const dist = join(web, "dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error("build-site: dist/index.html missing — run `vite build` first");
  process.exit(1);
}

// The default tool count is generated into the README and checked in CI
// (mcp/scripts/check-tool-count.mjs), so read it there rather than hardcode it.
const m = readFileSync(join(repo, "README.md"), "utf8").match(/<!--tool-count-->(\d+)<!--\/tool-count-->/);
if (!m) throw new Error("build-site: no <!--tool-count--> marker in README.md");
const ctx = { toolCount: Number(m[1]) };

mkdirSync(join(dist, "site"), { recursive: true });
cpSync(join(site, "assets"), join(dist, "site"), { recursive: true });
cpSync(join(site, "img"), join(dist, "site", "img"), { recursive: true });

const docs = DOCS.map((d) => renderDoc(d, repo, dist));
const pages = [...buildPages(ctx, DOCS), ...docs.map(({ path, html }) => ({ path, html }))];

const problems = [];
for (const { path, html } of pages) {
  if (!html.includes(`<link rel="canonical" href="${ORIGIN}${path}">`)) problems.push(`${path}: canonical mismatch`);
  if (/<script>(?!\s*$)/.test(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, ""))) problems.push(`${path}: inline <script> (CSP is script-src 'self')`);
  if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(html.replace(/<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, ""))) problems.push(`${path}: undefined/NaN in output`);
  const out = join(dist, path, "index.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
}
// every internal link on a generated page must land on a page or file we ship
const shipped = new Set(["/", "/privacy/", "/terms/", "/llms.txt", "/llms-full.txt", ...pages.map((p) => p.path)]);
for (const { path, html } of pages) {
  for (const [, href] of html.matchAll(/href="(\/[^"#?]*)/g)) {
    if (shipped.has(href) || existsSync(join(dist, href))) continue;
    problems.push(`${path}: dead internal link ${href}`);
  }
}
if (problems.length) {
  console.error("build-site: " + problems.join("\n  "));
  process.exit(1);
}

const urls = ["/", ...pages.map((p) => p.path), "/privacy/", "/terms/"];
writeFileSync(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${ORIGIN}${u}</loc></url>`).join("\n")}\n</urlset>\n`,
);

const llms = readFileSync(join(site, "llms.txt"), "utf8").replaceAll("{{TOOL_COUNT}}", String(ctx.toolCount));
if (llms.includes("{{")) throw new Error("build-site: unfilled placeholder in llms.txt");
writeFileSync(join(dist, "llms.txt"), llms);
writeFileSync(
  join(dist, "llms-full.txt"),
  llms + docs.map((d, i) => `\n\n---\n\n<!-- ${DOCS[i].src} · ${ORIGIN}${d.path} -->\n\n${d.md.trim()}\n`).join(""),
);

console.log(`build-site: ${pages.length} pages, ${urls.length} sitemap URLs, ${ctx.toolCount} tools`);
