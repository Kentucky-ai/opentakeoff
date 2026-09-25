// Mirrors the repo's manuals (docs/*.md) onto the site at build time, so the
// markdown stays the one source and the site can never drift from it. Heading
// ids use GitHub's slug rules (same as scripts/check-doc-links.mjs), so every
// #anchor that works on GitHub works here too.
import { readFileSync, existsSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, posix, basename } from "node:path";
import { Marked, Renderer } from "marked";
import { page, REPO, esc } from "./layout.mjs";

export const DOCS = [
  {
    src: "docs/USER_GUIDE.md", path: "/docs/user-guide/", nav: "User manual", kicker: "FOR THE PERSON AT THE CANVAS",
    title: "OpenTakeoff User Manual: Flooring and Construction Takeoff in the Browser",
    description: "The complete OpenTakeoff user manual: opening plan sets, setting scale, conditions and waste, the measuring tools, roll goods, the report and exports, and reviewing an agent's takeoff.",
  },
  {
    src: "docs/AGENT_GUIDE.md", path: "/docs/agent-guide/", nav: "Agent manual", kicker: "FOR THE AGENT, AND WHOEVER WIRES IT UP",
    title: "OpenTakeoff Agent Manual: Running a Takeoff over MCP",
    description: "How an AI agent runs a construction takeoff with OpenTakeoff over MCP: the operating model, the standard finish, withheld results, refusals, and a worked session.",
  },
  {
    src: "docs/MCP.md", path: "/docs/mcp/", nav: "MCP guide", kicker: "THE TOOL SURFACE, IN DEPTH",
    title: "Driving OpenTakeoff from an AI Agent (MCP Guide)",
    description: "The OpenTakeoff MCP server in depth: setup, every tool in the order an agent reaches for it, an example session, and the packaged wiki resources.",
  },
  {
    src: "docs/SELF_HOSTING.md", path: "/docs/self-hosting/", nav: "Self-hosting", kicker: "RUN YOUR OWN COPY",
    title: "Self-Hosting OpenTakeoff",
    description: "Host your own OpenTakeoff: the static build, the one MIME-type gotcha, and optional Microsoft 365 annotation sync.",
  },
];

// GitHub's slug rules — keep identical to scripts/check-doc-links.mjs.
export function slugify(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
  return text.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
}

/**
 * Render one doc. `repoRoot` is the checkout root; `outDir` is dist/. Images the
 * doc references are copied to dist/docs/assets/ (the site CSP is img-src 'self').
 */
export function renderDoc(doc, repoRoot, outDir) {
  const md = readFileSync(join(repoRoot, doc.src), "utf8");
  const srcDir = posix.dirname(doc.src);
  const bySrc = new Map(DOCS.map((d) => [d.src, d.path]));
  const assetDir = join(outDir, "docs", "assets");

  const rewriteHref = (href) => {
    if (!href || /^(https?:|mailto:|#)/.test(href)) return href;
    const [p, frag] = href.split("#");
    const rel = posix.normalize(posix.join(srcDir, decodeURIComponent(p)));
    if (bySrc.has(rel)) return bySrc.get(rel) + (frag ? `#${frag}` : "");
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) return `${REPO}/${statSync(abs).isDirectory() ? "tree" : "blob"}/main/${rel}${frag ? `#${frag}` : ""}`;
    return `${REPO}/blob/main/${rel}`;
  };
  const rewriteSrc = (src) => {
    if (!src || /^(https?:|data:)/.test(src)) return src;
    const rel = posix.normalize(posix.join(srcDir, src));
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return `${REPO}/raw/main/${rel}`;
    const name = rel.replace(/^docs\//, "").replace(/\//g, "-");
    mkdirSync(assetDir, { recursive: true });
    copyFileSync(abs, join(assetDir, name));
    return `/docs/assets/${name}`;
  };
  const rewriteHtml = (html) =>
    html
      .replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (_, a, s, b) => a + rewriteSrc(s) + b)
      .replace(/(<a\b[^>]*\bhref=")([^"]+)(")/g, (_, a, h, b) => a + rewriteHref(h) + b);

  const seen = new Map();
  const toc = [];
  let h1 = null;
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(t) {
      if (t.type === "link") t.href = rewriteHref(t.href);
      if (t.type === "image") t.href = rewriteSrc(t.href);
      if (t.type === "html") t.text = rewriteHtml(t.text);
    },
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        if (depth === 1 && !h1) {
          h1 = inner;
          return `<h1>${inner}</h1>`;
        }
        const base = slugify(text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        if (depth === 2) toc.push({ id, label: inner.replace(/<[^>]+>/g, "") });
        return `<h${depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>`;
      },
      table(token) {
        return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>`;
      },
      image({ href, title, text }) {
        return `<img src="${href}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy">`;
      },
    },
  });
  const body = marked.parse(md);
  const tocHtml = toc.length
    ? `<nav class="toc" aria-label="On this page"><details open><summary class="sr-mobile">On this page</summary><p>On this page</p>${toc.map((t) => `<a href="#${t.id}">${t.label}</a>`).join("")}</details></nav>`
    : "<div></div>";
  const html = page({
    path: doc.path,
    title: doc.title,
    description: doc.description,
    active: "/docs/",
    hero: null,
    body: `<div class="wrap doc-layout">${tocHtml}<article class="prose"><p class="doc-source">Mirrored from <a href="${REPO}/blob/main/${doc.src}">${doc.src}</a> on every deploy · <a href="/docs/">all manuals</a></p>${body}</article></div>`,
    jsonld: [{ "@context": "https://schema.org", "@type": "TechArticle", headline: doc.title, description: doc.description, url: `https://opentakeoff.kentucky-ai.com${doc.path}`, isBasedOn: `${REPO}/blob/main/${doc.src}`, publisher: { "@type": "Organization", name: "Kentucky AI", url: "https://kentucky-ai.com" } }],
  });
  return { path: doc.path, html, md, toc, h1, basename: basename(doc.src), dir: dirname(doc.src) };
}
