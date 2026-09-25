// Shared shell for the static public pages (the site build, scripts/build-site.mjs).
// These pages are plain HTML on purpose: search crawlers and AI crawlers that do
// not run JavaScript read them whole. The canvas at / stays the React app.

export const ORIGIN = "https://opentakeoff.kentucky-ai.com";
export const REPO = "https://github.com/Kentucky-ai/opentakeoff";

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const NAV = [
  { href: "/agents/", label: "For agents" },
  { href: "/flooring-takeoff/", label: "Flooring" },
  { href: "/tools/", label: "Calculators" },
  { href: "/docs/", label: "Docs" },
];

const FONTS =
  "https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600&family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap";

export function markSvg(cls = "mark") {
  // Inline copy of site/assets/mark.svg (gradient ids are per-instance safe:
  // every copy defines identical stops).
  return `<svg class="${cls}" viewBox="30 20 1145 530" aria-hidden="true" focusable="false"><defs><linearGradient id="otm-l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e6c88c"/><stop offset=".55" stop-color="#c9a466"/><stop offset="1" stop-color="#a98748"/></linearGradient><linearGradient id="otm-r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bfa06a"/><stop offset=".6" stop-color="#94784a"/><stop offset="1" stop-color="#7a6139"/></linearGradient><linearGradient id="otm-d" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6e5634"/><stop offset="1" stop-color="#4f3c22"/></linearGradient></defs><path fill="url(#otm-l)" d="M338 112 540 28V130L338 192Z"/><path fill="url(#otm-r)" d="M540 28 748 110V192L540 130Z"/><path fill="url(#otm-l)" d="M108 345 528 185V540H330V355L108 398Z"/><path fill="url(#otm-r)" d="M552 185 978 340V392L758 350V540H552Z"/><path fill="url(#otm-l)" d="M38 455 292 420V545H38Z"/><path fill="url(#otm-d)" d="M790 418 1165 470V545H790Z"/></svg>`;
}

// Fine architectural linework behind the hero — the banner's compass geometry.
const LINEWORK = `<svg class="linework" viewBox="0 0 1200 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1"><circle cx="600" cy="300" r="250"/><circle cx="600" cy="220" r="150"/><circle cx="600" cy="390" r="110"/><path d="M600 0V600M350 300H850M0 520H1200"/><path d="M360 300A240 240 0 0 1 600 60" stroke-dasharray="2 6"/></g><g fill="currentColor"><circle cx="600" cy="300" r="4"/><circle cx="600" cy="150" r="3"/><circle cx="600" cy="450" r="3"/><circle cx="350" cy="300" r="2.5"/><circle cx="850" cy="300" r="2.5"/></g></svg>`;

function header(active) {
  const links = NAV.map(
    (n) => `<a href="${n.href}"${active && active.startsWith(n.href) ? ' aria-current="page"' : ""}>${n.label}</a>`,
  ).join("");
  return `<header class="site-header"><div class="wrap bar"><a class="lockup" href="/" aria-label="OpenTakeoff — open the canvas">${markSvg()}<span class="wordmark">OpenTakeoff</span></a><nav aria-label="Site">${links}<a href="${REPO}" class="ext">GitHub</a></nav><a class="btn btn-gold btn-sm" href="/">Open the canvas</a></div></header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="wrap"><div class="foot-grid"><div class="foot-brand">${markSvg("mark mark-lg")}<p class="wordmark">OpenTakeoff</p><p class="tag">The takeoff software for agents.</p></div><div><h2>Use it</h2><a href="/">Open the canvas</a><a href="/agents/">Connect an agent (MCP)</a><a href="/flooring-takeoff/">Flooring takeoff</a><a href="/free-takeoff-software/">Free takeoff software</a></div><div><h2>Calculators</h2><a href="/tools/sf-to-sy/">SF to SY</a><a href="/tools/flooring-order-calculator/">Waste &amp; cartons</a><a href="/tools/carpet-roll-calculator/">Carpet roll cuts</a><a href="/tools/base-calculator/">Wall base</a></div><div><h2>Reference</h2><a href="/docs/user-guide/">User manual</a><a href="/docs/agent-guide/">Agent manual</a><a href="/docs/mcp/">MCP reference</a><a href="${REPO}">Source on GitHub</a><a href="https://www.npmjs.com/package/opentakeoff-mcp">opentakeoff-mcp on npm</a></div></div><p class="legal">Apache-2.0 · Built by <a href="https://kentucky-ai.com">Kentucky AI</a> · <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <a href="/llms.txt">llms.txt</a></p></div></footer>`;
}

/**
 * page({ path, title, description, active, hero, body, jsonld, scripts })
 * hero: { eyebrow, h1, lede, ctas: [{href,label,kind}], aside } — omitted = compact title bar.
 */
export function page({ path, title, description, active = path, hero, body, jsonld = [], scripts = [], bodyClass = "" }) {
  const url = ORIGIN + path;
  const crumbs = breadcrumb(path, hero?.crumb || title);
  const ld = [crumbs, ...jsonld].filter(Boolean).map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join("");
  const heroHtml = hero
    ? `<section class="hero${hero.aside ? " hero-split" : ""}">${LINEWORK}<div class="wrap hero-inner"><div class="hero-copy">${hero.eyebrow ? `<p class="eyebrow">${hero.eyebrow}</p>` : ""}<h1>${hero.h1}</h1>${hero.lede ? `<p class="lede">${hero.lede}</p>` : ""}${
        hero.ctas?.length
          ? `<p class="ctas">${hero.ctas.map((c) => `<a class="btn ${c.kind === "ghost" ? "btn-ghost" : "btn-gold"}" href="${c.href}">${c.label}</a>`).join("")}</p>`
          : ""
      }</div>${hero.aside ? `<div class="hero-aside">${hero.aside}</div>` : ""}</div></section>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#0f1b2e">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OpenTakeoff">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${ORIGIN}/og-card.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${ORIGIN}/og-card.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/site/site.css">
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
${ld}
<script defer src="/site/site.js"></script>
${scripts.map((s) => `<script type="module" src="${s}"></script>`).join("\n")}
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "3f37c88a39dc47e79a5304c38ccf68f3"}'></script>
</head>
<body class="${bodyClass}">
<a class="skip" href="#content">Skip to content</a>
${header(active)}
<main id="content">
${heroHtml}
${body}
</main>
${footer()}
</body>
</html>
`;
}

function breadcrumb(path, name) {
  if (path === "/") return null;
  const parts = path.split("/").filter(Boolean);
  const items = [{ "@type": "ListItem", position: 1, name: "OpenTakeoff", item: ORIGIN + "/" }];
  let acc = "";
  parts.forEach((p, i) => {
    acc += "/" + p;
    const last = i === parts.length - 1;
    const label = last ? name : { tools: "Calculators", docs: "Docs" }[p] || p;
    items.push({ "@type": "ListItem", position: i + 2, name: label, item: ORIGIN + acc + "/" });
  });
  return { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items };
}

/** A FAQ block rendered visibly AND as FAQPage JSON-LD from the same source. */
export function faq(items) {
  const html = `<div class="faq">${items.map((q) => `<details><summary>${q.q}</summary><div>${q.a}</div></details>`).join("")}</div>`;
  const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const ld = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((q) => ({ "@type": "Question", name: strip(q.q), acceptedAnswer: { "@type": "Answer", text: strip(q.a) } })),
  };
  return { html, ld };
}

export const section = (kicker, title, inner, cls = "") =>
  `<section class="band ${cls}"><div class="wrap">${kicker ? `<p class="kicker">${kicker}</p>` : ""}${title ? `<h2>${title}</h2>` : ""}${inner}</div></section>`;
