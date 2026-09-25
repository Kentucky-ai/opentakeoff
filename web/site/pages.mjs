// Hand-written public pages. Every claim here is sourced from the repo's own
// manuals (docs/USER_GUIDE.md, docs/AGENT_GUIDE.md, mcp/README.md, README.md);
// when those change, change these. The tool count is generated (ctx.toolCount).
import { page, faq, section, REPO, esc } from "./layout.mjs";
import { CALCS, formHtml, defaults } from "./assets/calc-view.js";

const img = (src, alt, cap, w, h) =>
  `<figure class="plate"><img src="${src}" alt="${esc(alt)}" width="${w}" height="${h}" loading="lazy" decoding="async">${cap ? `<figcaption>${cap}</figcaption>` : ""}</figure>`;

const APP = { "@type": "SoftwareApplication", name: "OpenTakeoff", url: "https://opentakeoff.kentucky-ai.com/", applicationCategory: "BusinessApplication", operatingSystem: "Any (web browser)", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } };
const ld = (type, extra) => ({ "@context": "https://schema.org", "@type": type, ...extra });

const INSTALL_JSON = `{
  "mcpServers": {
    "opentakeoff": {
      "command": "npx",
      "args": ["-y", "opentakeoff-mcp"]
    }
  }
}`;

// ── /agents/ ────────────────────────────────────────────────────────────
function agents(ctx) {
  const q = faq([
    { q: "What is MCP?", a: `<p>The <a href="https://modelcontextprotocol.io">Model Context Protocol</a> is the standard way an AI assistant calls outside tools. OpenTakeoff's server speaks it over stdio, so any MCP client (Claude Code, Claude Desktop, Cursor and others) can drive the takeoff engine directly, with no screen scraping.</p>` },
    { q: "Does it need an account or an API key?", a: `<p>No. OpenTakeoff has no account and no key. The server runs on your machine with <code>npx -y opentakeoff-mcp</code> (Node 20+). The model your client uses is yours, on your own plan with its provider.</p>` },
    { q: "Does the agent's work count automatically?", a: `<p>No. Everything an agent commits lands in the canvas as a dashed, pending proposal. The green APPROVED state has one code path: a person pressing the button. Scales an agent sets are flagged unconfirmed until a person confirms them.</p>` },
    { q: "Is One-Click room detection available to agents?", a: `<p>Not on a default build today. <code>one_click</code> and <code>detect_rooms</code> are gated while the flood engine is re-validated against a wider plan corpus. Agents trace rooms with <code>measure_polygon</code> on the wall faces. <code>OPENTAKEOFF_ONE_CLICK=1</code> registers the gated verbs.</p>` },
    { q: "What does the agent hand back?", a: `<p>A marked-up planset PDF (<code>export_marked_pdf</code>), the numbers (<code>export_report</code>), and the takeoff document itself (<code>export_takeoff</code>), which opens in the browser canvas for review. <code>export_dxf</code> covers work going back into CAD.</p>` },
  ]);
  return page({
    path: "/agents/",
    title: "AI Takeoff Software for Agents: the OpenTakeoff MCP Server",
    description: `Point an AI agent at a construction drawing. OpenTakeoff's open-source MCP server gives it ${ctx.toolCount} takeoff tools to read the plan, set the scale, measure rooms and hand back a marked planset with provenance.`,
    hero: {
      eyebrow: "For agents",
      h1: "The takeoff software <em>for agents</em>.",
      lede: "A drawing contains work an agent can perform. OpenTakeoff gives the agent real tools to read the drawing, measure its scope, record how every number was made, and hand back a marked planset a person can check.",
      ctas: [{ href: "#install", label: "Point an agent at it" }, { href: "/docs/agent-guide/", label: "Agent manual", kind: "ghost" }],
      aside: `<pre><code>$ claude mcp add opentakeoff -- npx -y opentakeoff-mcp</code></pre><pre><code>${esc(INSTALL_JSON)}</code></pre>`,
      crumb: "For agents",
    },
    body:
      section("Install", "Point an agent at it", `<div id="install" class="grid grid-3">
<div class="card"><span class="num">01 · ANY MCP CLIENT</span><h3>npx</h3><p>Add the server to your client's config. No clone, no build. Node 20+.</p><pre><code>npx -y opentakeoff-mcp</code></pre></div>
<div class="card"><span class="num">02 · CLAUDE CODE</span><h3>One line</h3><p>Register it from the terminal, then ask for a takeoff.</p><pre><code>claude mcp add opentakeoff -- npx -y opentakeoff-mcp</code></pre></div>
<div class="card"><span class="num">03 · CLAUDE DESKTOP</span><h3>Bundle</h3><p>Download <code>opentakeoff-mcp.mcpb</code> from the <a href="${REPO}/releases">latest release</a> and double-click it. Dependencies are bundled.</p></div>
</div>
<div class="facts"><div><b>${ctx.toolCount}</b><span>MCP tools on a default build</span></div><div><b>stdio</b><span>runs on your machine</span></div><div><b>Node 20+</b><span>Windows, macOS, Linux; CI runs Windows and Linux</span></div><div><b>Apache-2.0</b><span>open source, on the official MCP registry</span></div></div>`) +
      section("The standard finish", "How an agent runs a takeoff", `<p class="intro">These steps ship inside the server's own <code>initialize</code> instructions, so every client gets the same contract. The deliverable is a marked-up planset, not a numbers report.</p>
<ol class="steps">
<li><strong>Open and scale.</strong><code>load_plan</code>, then <code>set_scale</code> on each sheet it will measure. Scale is a gate: measuring tools refuse an unscaled sheet rather than guess square feet.</li>
<li><strong>Commit shapes under finish-tag conditions.</strong>Rooms go down on their innermost wall faces with <code>measure_polygon</code>, doors crossed on the wall centerline. <code>resolve_tag</code> takes each room's finish from its own schedule row.</li>
<li><strong>Derive what follows.</strong><code>derive_base</code> for base (perimeter minus the openings the agent states; the tool never guesses a door) and <code>derive_transitions</code> where two finishes meet.</li>
<li><strong>Look at what landed.</strong><code>view_sheet</code> renders the work over the drawing, and <code>edit_shape</code> fixes a ring before any total is trusted.</li>
<li><strong>Write the planset.</strong><code>export_marked_pdf</code> for the drawings and <code>export_report</code> for the numbers. A takeoff nobody can check is not a takeoff.</li>
</ol>`, "band-alt") +
      section("Provenance", "Every number carries its receipt", `<div class="split"><div>
<ul class="checks">
<li><strong>How it was made.</strong> Each shape records the scale it was measured at, the method, and whether a person or an agent drew it.</li>
<li><strong>Pencil until a person inks it.</strong> Agent work arrives dashed and pending. Approval has exactly one code path: a person at the canvas.</li>
<li><strong>Corrections keep the original.</strong> When a person fixes a ring, the machine's boundary stays frozen beside the correction.</li>
<li><strong>Refusals are answers.</strong> When the engine can't defend a number it withholds it and says why, rather than filling the gap.</li>
</ul>
<p class="measure" style="margin-top:22px">Read the operating model in the <a href="/docs/agent-guide/">agent manual</a>, then the tool-by-tool reference in the <a href="/docs/mcp/">MCP guide</a>.</p>
</div>${img("/site/img/agent-pending.jpg", "An agent's takeoff imported into the OpenTakeoff canvas: six dashed pending room outlines on a floor finish plan, waiting for review", "An agent's rooms imported into the canvas, pending review", 1400, 875)}</div>`) +
      section("Review", "The same engine a person drives", `<div class="split">${img("/site/img/agent-accepted.jpg", "The same takeoff after a person accepted the batch: the room outlines are now solid and the live count shows the total", "After review: pencil is now ink", 1400, 875)}<div>
<p class="measure">The MCP server and the browser canvas share the same geometry and quantity modules, and the agent's export opens in the canvas as ordinary takeoff records. A person imports it, drags a corner where the agent missed a wall, accepts the batch, and exports. <a href="/docs/user-guide/#reviewing-an-agents-takeoff-start-to-finish">The review loop, step by step →</a></p>
<div class="note">Room detection is the one path that currently differs between the browser and MCP, and One-Click stays gated on both while it is re-validated.</div>
</div></div>`, "band-alt") +
      section("Data", "What leaves your machine", `<div class="grid grid-2">
<div class="card"><h3>Stays local</h3><p>The server reads plans from disk and writes exports to disk on the machine where it runs. OpenTakeoff does not upload your PDF anywhere.</p></div>
<div class="card"><h3>Goes to your assistant</h3><p>Your MCP client receives the tool results it asks for, which can include drawing text, rendered sheet images and quantities. Its provider handles those under its own policy. <a href="/privacy/">Privacy policy →</a></p></div>
</div>`) +
      section("Questions", "Agents and OpenTakeoff", q.html, "band-alt"),
    jsonld: [ld("SoftwareApplication", { ...APP, "@type": "SoftwareApplication", name: "opentakeoff-mcp", applicationCategory: "DeveloperApplication", operatingSystem: "Windows, macOS, Linux (Node 20+)", url: "https://www.npmjs.com/package/opentakeoff-mcp", description: "Open-source MCP server that lets an AI agent perform construction quantity takeoff: load plans, set scale, measure, and export a marked planset." }), q.ld],
  });
}

// ── /flooring-takeoff/ ─────────────────────────────────────────────────
function flooring() {
  const q = faq([
    { q: "Is OpenTakeoff free for flooring takeoff?", a: `<p>Yes. The whole engine is open source under Apache-2.0: no account, no trial, no seat count. Open <a href="/">the canvas</a> and drag in a plan.</p>` },
    { q: "What files can I open?", a: `<p>PDF plan sets, images, or a whole <code>.zip</code> straight off the bid platform (plans, finish schedule and addenda together). Up to four sheets can sit side by side.</p>` },
    { q: "Where are my plans stored?", a: `<p>In your browser (IndexedDB). Opening a plan does not upload it. The takeoff autosaves as you work; export a backup before clearing site data.</p>` },
    { q: "Does waste change my measured square feet?", a: `<p>No. Waste is set per condition and applies only to order quantities in the report. Measured numbers stay measured. Square yards are SF ÷ 9.</p>` },
    { q: "Can I export to Excel?", a: `<p>Yes: the report exports to CSV, Excel and JSON, and the <strong>Marked set</strong> PDF carries your takeoff drawn on the plans for whoever has to check it.</p>` },
    { q: "Does it only do flooring?", a: `<p>Flooring is what it was built for, and the measuring tools work for any trade: area, linear, count, and wall surface (run × height) for paint, wall tile or wallcovering.</p>` },
  ]);
  return page({
    path: "/flooring-takeoff/",
    title: "Flooring Takeoff Software: Free and Open Source | OpenTakeoff",
    description: "Do a flooring takeoff in the browser. Set the scale, trace rooms under finish conditions, and get SF, SY, waste-adjusted order quantities, roll-goods cuts, base and a marked planset. Free, no account.",
    hero: {
      eyebrow: "Flooring takeoff",
      h1: "Measure the floor. <em>Show your work.</em>",
      lede: "Open a plan set, set the scale, trace rooms under the architect's finish tags, and get square feet, square yards, order quantities and a marked planset. It runs in your browser: free, no account, nothing uploaded.",
      ctas: [{ href: "/", label: "Open the canvas" }, { href: "/docs/user-guide/", label: "User manual", kind: "ghost" }],
      aside: img("/site/img/plan-traced.jpg", "Patient rooms traced wall to wall in wood (WD-1) and a clean-linen room in VCT on a real VA medical center floor finish plan, with the live readout showing 743.4 SF", "Sample plan · WD-1 743.4 SF · 82.6 SY", 1280, 540),
      crumb: "Flooring takeoff",
    },
    body:
      section("The working order", "A takeoff you can defend", `<p class="intro">A bid set is forty sheets, and the order you work it in keeps the number defensible. This is the sequence from the <a href="/docs/user-guide/#the-working-order-on-a-real-bid">user manual</a>.</p>
<ol class="steps">
<li><strong>Open the whole set at once.</strong>Drag the <code>.zip</code> in: plans, finish schedule, addenda.</li>
<li><strong>Scale every sheet you'll measure, and check one dimension on each.</strong>The drawn scale note is read off the sheet for you to adopt. <kbd>K</kbd> checks a known dimension in ten seconds.</li>
<li><strong>Build conditions off the architect's schedule.</strong><em>Schedule</em> parses the finish table, and you approve what becomes a condition.</li>
<li><strong>Set waste and supporting materials before you trace.</strong>Waste is per condition. Materials turn square feet into an order: adhesive, primer, underlayment, rounded to whole units.</li>
<li><strong>Measure the floors first.</strong>Press <kbd>A</kbd> and trace room by room on the wall faces. Floors are the bulk of the number, and everything else derives from them.</li>
<li><strong>Derive, don't measure twice.</strong>Base comes off the rooms you traced. <em>Transitions</em> finds where two finishes meet and reports the doorway thresholds it doesn't count.</li>
<li><strong>Walk the set, save a revision, export both.</strong>Report and Excel go to pricing; the Marked set PDF goes to whoever has to check you.</li>
</ol>`) +
      section("What comes out", "Square feet in, an order out", `<div class="split">${img("/site/img/report.jpg", "The OpenTakeoff report: WD-1 743.4 SF at 10% waste ordered as 817.7 SF and 90.9 SY; VCT-1 103.5 SF at 5% ordered as 108.7 SF; and a supporting-materials buy list", "The sample plan's report, as exported", 920, 654)}<div>
<ul class="checks">
<li><strong>Per finish:</strong> measured SF, wall SF, border SF, LF and EA, then waste and the ordered SF and SY. On the sample plan, WD-1's 743.4 SF at 10% orders 817.7 SF (90.9 SY).</li>
<li><strong>A buy list:</strong> each supporting material is its basis ÷ coverage, rounded up to whole buckets and bags.</li>
<li><strong>By sheet, by label, by author:</strong> the same totals sliced for phases, areas, and who drew what.</li>
<li><strong>Exports:</strong> CSV, Excel, JSON, and the Marked set PDF.</li>
</ul></div></div>`, "band-alt") +
      section("Roll goods", "Carpet and sheet goods, figured as cuts", `<div class="grid grid-2"><div>
<p class="measure">Tile and plank come in boxes, so SF plus waste is the whole order. Roll goods don't: a 12′ roll laid into a 14′ room means a seam, and the footage you buy depends on how the cuts nest down the roll.</p>
<p class="measure">Pick <strong>Broadloom carpet</strong>, <strong>Sheet vinyl</strong> or <strong>Sheet rubber</strong> on a condition and set the roll width, maximum roll length, direction and allowances. Every room is then figured into numbered cuts drawn to scale on the plan and nested on the roll. The report adds <strong>Roll Order LF</strong>, <strong>Rolls</strong> and <strong>Seam LF</strong>.</p>
</div><div class="card"><span class="num">QUICK CHECK</span><h3>One room, by hand</h3><p>For a single rectangular room (drops, seams and cut SY in both directions), use the <a href="/tools/carpet-roll-calculator/">carpet roll calculator</a>. The canvas does the whole floor and nests the offcuts.</p></div></div>`) +
      section("Every trade", "Built for flooring. Measures anything.", `<div class="grid grid-3">
<div class="card"><h3>Area &amp; rectangle</h3><p>Floors, ceilings, slabs, roofing: any closed shape, with cut-outs for columns and chases.</p></div>
<div class="card"><h3>Linear</h3><p>Base, trim, transitions, curbs, and runs of anything priced by the foot.</p></div>
<div class="card"><h3>Surface area</h3><p>Wall SF from a run and a height: paint, wall tile, wallcovering, FRP.</p></div>
<div class="card"><h3>Count</h3><p>Fixtures, devices and symbols, counted and tagged on the sheet.</p></div>
<div class="card"><h3>Stitched sheets</h3><p>A floor split at a match line becomes one working surface, so a room crossing the seam traces as one shape.</p></div>
<div class="card"><h3>Markups &amp; RFIs</h3><p>Stamps, clouds and notes live on the drawings with the takeoff.</p></div>
</div>`, "band-alt") +
      section("Questions", "Flooring takeoff, answered", q.html),
    jsonld: [ld("WebPage", { name: "Flooring takeoff software", about: APP }), q.ld],
  });
}

// ── /free-takeoff-software/ ────────────────────────────────────────────
function free(ctx) {
  const q = faq([
    { q: "Is it really free?", a: `<p>Yes. The engine, the canvas and the MCP server are open source under Apache-2.0. You can use them commercially, fork them and self-host them. There's no account, trial clock or seat count.</p>` },
    { q: "What's the catch?", a: `<p>It measures; it doesn't price. There's no cost database or bid engine in the box, so you bring your own rates. One-Click room detection is currently gated while it is re-validated, so rooms are traced with the Area tool.</p>` },
    { q: "Do I have to upload my plans?", a: `<p>No. The default workspace runs entirely in your browser and stores projects in browser storage. Optional Google Drive or Microsoft 365 sync is something you choose to connect.</p>` },
    { q: "Can my company run its own copy?", a: `<p>Yes. It builds to static files you can host on any static host. See <a href="/docs/self-hosting/">self-hosting</a> for the one server setting that trips people up.</p>` },
    { q: "Does it work on Windows and Mac?", a: `<p>It's a browser app, so it runs the same in any current Chrome, Edge, Firefox or Safari on Windows, macOS, ChromeOS and Linux. Shortcuts label themselves for the keyboard in front of you.</p>` },
  ]);
  return page({
    path: "/free-takeoff-software/",
    title: "Free Construction Takeoff Software (Open Source) | OpenTakeoff",
    description: "OpenTakeoff is free, open-source construction takeoff software under Apache-2.0. It runs in the browser with no account and no upload, measures area, linear, count and wall surface, and exports CSV, Excel and marked PDFs.",
    hero: {
      eyebrow: "Free · Open source · Apache-2.0",
      h1: "Free construction takeoff software, <em>with nothing held back.</em>",
      lede: "The engine, the canvas and the agent interface are all in the public repository. Open it in a browser tab and start measuring: no account, no trial, no upload.",
      ctas: [{ href: "/", label: "Open the canvas" }, { href: REPO, label: "Read the source", kind: "ghost" }],
      crumb: "Free takeoff software",
    },
    body:
      section("What free means here", "No trial clock. No seat count.", `<div class="grid grid-2"><ul class="checks">
<li><strong>The whole engine is public.</strong> Measuring, scale, conditions, materials, roll goods, reports and exports are all in the Apache-2.0 repository.</li>
<li><strong>No account.</strong> The canvas opens straight to work. Nothing sits behind a sign-in.</li>
<li><strong>Your plans stay on your machine.</strong> Projects autosave to browser storage, and opening a plan uploads nothing.</li>
<li><strong>Agents included.</strong> The MCP server (${ctx.toolCount} tools) is free on npm, so an AI agent can run the same takeoff.</li>
<li><strong>Yours to run.</strong> Fork it, self-host the static build, and put your own name on the URL.</li>
</ul><div class="card"><span class="num">HONEST LIMITS</span><h3>What it isn't</h3><p style="margin-bottom:10px">It measures; it doesn't price. There's no cost database or bid engine in the box.</p><p style="margin-bottom:10px">One-Click room detection is gated while it is re-validated, so trace with <kbd>A</kbd>.</p><p>Managed enterprise packaging (MSIX, Intune) is tracked but not built.</p></div></div>`) +
      section("In the box", "What it measures", `<div class="grid grid-4">
<div class="card"><h3>Scale</h3><p>Reads the drawn scale note per sheet for you to adopt, or calibrate from a known dimension.</p></div>
<div class="card"><h3>Area</h3><p>Polygons and rectangles, cut-outs for deducts, 45°/90° angle lock and snap.</p></div>
<div class="card"><h3>Linear</h3><p>Runs and perimeters, plus base derived from the rooms you traced.</p></div>
<div class="card"><h3>Surface</h3><p>Wall SF as run × height, per condition.</p></div>
<div class="card"><h3>Count</h3><p>Symbols and devices, tallied live per condition.</p></div>
<div class="card"><h3>Conditions</h3><p>Colors, CAD hatches, waste %, multipliers, and supporting materials.</p></div>
<div class="card"><h3>Revisions</h3><p>Save at every addendum so the next round is a comparison.</p></div>
<div class="card"><h3>Exports</h3><p>CSV, Excel, JSON and a marked-up planset PDF; DXF from the MCP server.</p></div>
</div>`, "band-alt") +
      section("Two front ends", "For a person, and for an agent", `<div class="grid grid-2">
<a class="card" href="/flooring-takeoff/"><span class="num">THE CANVAS</span><h3>Trace it yourself</h3><p>Drag in a plan, set the scale, trace, read the report. The browser app is the fastest way to a checked number.</p></a>
<a class="card" href="/agents/"><span class="num">THE MCP SERVER</span><h3>Point an agent at it</h3><p>The same geometry and quantity math, driven by an AI agent that hands back a marked planset for you to review.</p></a>
</div>`) +
      section("Questions", "Free takeoff software, answered", q.html, "band-alt"),
    jsonld: [ld("SoftwareApplication", { ...APP, description: "Free, open-source construction takeoff software under Apache-2.0: area, linear, count and wall surface measurement in the browser, with an MCP server for AI agents.", license: `${REPO}/blob/main/LICENSE`, isAccessibleForFree: true }), q.ld],
  });
}

// ── calculators ───────────────────────────────────────────────────────
const CALC_PAGES = [
  {
    id: "sfsy", path: "/tools/sf-to-sy/", short: "SF to SY",
    title: "Square Feet to Square Yards Calculator (SF to SY) | OpenTakeoff",
    description: "Convert square feet to square yards for carpet and flooring: SY = SF ÷ 9. Add waste to get an order quantity. Free, instant, shareable.",
    eyebrow: "Calculator", h1: "Square feet to <em>square yards</em>",
    lede: "Carpet is sold by the square yard, and plans measure in square feet. One square yard is exactly nine square feet.",
    formula: "SY = SF ÷ 9\nSY ordered = SF ÷ 9 × (1 + waste%)",
    notes: `<p class="measure">Convert the <strong>measured</strong> area, then apply waste once. If your square feet already came from a roll-cut layout (drops × roll width × length), don't add cutting waste again, because the cut quantity already includes it.</p>`,
    faq: [
      { q: "How many square feet are in a square yard?", a: "<p>Nine. A yard is three feet, so a square yard is 3 ft × 3 ft = 9 SF.</p>" },
      { q: "How do I convert SF to SY?", a: "<p>Divide by 9. 1,250 SF ÷ 9 = 138.89 SY.</p>" },
      { q: "Should carpet tile be quoted in SY too?", a: "<p>Carpet tile is often packaged by the carton and sold by the square yard. Convert the net area, add waste, then round up to whole cartons with the <a href=\"/tools/flooring-order-calculator/\">order calculator</a>.</p>" },
    ],
  },
  {
    id: "order", path: "/tools/flooring-order-calculator/", short: "Waste & cartons",
    title: "Flooring Waste and Carton Calculator (with Attic Stock) | OpenTakeoff",
    description: "Turn measured square feet into a flooring order: add waste and attic stock as separate lines, then round up to whole cartons. Free tile, plank and LVT calculator.",
    eyebrow: "Calculator", h1: "Waste, attic stock, <em>whole cartons</em>",
    lede: "Measured square feet aren't an order. Add waste for the cuts, attic stock for the owner, and round up to what the supplier actually ships.",
    formula: "waste    = net × waste%\nattic    = net × attic%          (a share of NET, not compounded)\nrequired = net + waste + attic\ncartons  = ⌈ required ÷ coverage per carton ⌉\nordered  = cartons × coverage",
    notes: `<p class="measure">Keeping net, waste, attic stock and package rounding as four separate lines is what makes a quote checkable: a supplier or PM can see exactly where every square foot above the measured area came from. It's the same waste math the OpenTakeoff report uses (ordered = measured × (1 + waste%)).</p>`,
    faq: [
      { q: "How much waste should I add for tile or LVT?", a: "<p>It depends on the install: layout, pattern (straight, diagonal, herringbone), plank or tile size, and how cut-up the rooms are. Set it per finish; this calculator won't pick a number for you.</p>" },
      { q: "What is attic stock?", a: "<p>Extra material left with the owner for future repairs, usually required in the specification's closeout section as a percentage or a number of cartons.</p>" },
      { q: "Is attic stock a percentage of net or of net plus waste?", a: "<p>Here it's a percentage of the net measured area, shown on its own line, so it never compounds with waste.</p>" },
    ],
  },
  {
    id: "roll", path: "/tools/carpet-roll-calculator/", short: "Carpet roll cuts",
    title: "Carpet Roll Calculator: Drops, Seams and Cut Yardage | OpenTakeoff",
    description: "Figure broadloom carpet cuts for a room: number of drops, drop length with trim and pattern repeat, seams, and cut square yards, in both directions. Free carpet yardage calculator.",
    eyebrow: "Calculator", h1: "Carpet roll cuts, <em>both directions</em>",
    lede: "A room's square yards aren't what you buy. You buy full-width drops off the roll. This works out the drops, seams and cut yardage for one room, both ways, cheaper first.",
    formula: "drops      = ⌈ room width across the roll ÷ roll width ⌉\ndrop       = room length + trim, rounded UP to whole pattern repeats\ncut LF     = drops × drop\ncut SY     = cut LF × roll width ÷ 9\nseams      = drops − 1   (seam LF = seams × room length)",
    notes: `<p class="measure">This is the one-room hand check. It uses full-width drops only and doesn't reuse offcuts, so the leftover strip from the last drop counts as waste here. A real floor nests those offcuts into other rooms. That's what the canvas's roll-goods layout does across the whole takeoff, with the cuts numbered on the plan and <strong>Roll Order LF</strong>, <strong>Rolls</strong> and <strong>Seam LF</strong> in the report.</p><p class="measure">The cut yardage already includes cutting waste. Don't add a waste percentage on top of it.</p>`,
    faq: [
      { q: "How do I calculate carpet yardage for a room?", a: "<p>Divide the room's width by the roll width and round up to get the number of drops. Multiply by the room length plus trim to get linear feet, then multiply by the roll width and divide by 9 for square yards.</p>" },
      { q: "How does pattern repeat change the quantity?", a: "<p>Each drop has to start at the same point in the pattern, so its length rounds up to a whole number of repeats. A 20′ room with 6″ trim and a 24″ repeat needs 22′ drops, not 20′-6″.</p>" },
      { q: "Which direction should the carpet run?", a: "<p>Usually whichever needs less carpet, unless light, traffic or a corridor decides it. The calculator shows both. Direction is also a setting on a roll-goods condition in the canvas.</p>" },
    ],
  },
  {
    id: "base", path: "/tools/base-calculator/", short: "Wall base",
    title: "Wall Base Calculator: Linear Feet, Openings and Coils | OpenTakeoff",
    description: "Figure rubber or vinyl wall base: wall perimeter minus door and cased openings, plus waste, rounded up to whole pieces or coils. Free base LF calculator.",
    eyebrow: "Calculator", h1: "Wall base, <em>net of the openings</em>",
    lede: "Base runs on the wall faces and stops at every door. Take the perimeter, deduct the openings you can count, add waste, and round up to whole sticks or coils.",
    formula: "deduct   = openings × opening width\nnet      = perimeter − deduct\nrequired = net × (1 + waste%)\npieces   = ⌈ required ÷ piece or coil length ⌉",
    notes: `<p class="measure">Count the openings off the plan; don't guess them. In the canvas, base derives from the rooms you traced, less the door openings you state, and <strong>Transitions</strong> reports the doorway thresholds separately. Measure physical base runs with the Linear tool when you need actual installed segments, for example where casework or a wall stub interrupts the base.</p>`,
    faq: [
      { q: "How do I calculate wall base?", a: "<p>Measure the perimeter of each room on the finish face, subtract the width of every door and cased opening, add waste, and divide by the piece or coil length, rounding up.</p>" },
      { q: "Do I deduct doors from base?", a: "<p>Yes. Base stops at the door frame, so each opening's width comes off the perimeter. Count them from the plan rather than assuming.</p>" },
      { q: "Coils or sticks?", a: "<p>Both work here. Enter 4′ or 8′ for sticks, or your coil length (commonly 100′–120′) for coils.</p>" },
    ],
  },
];

function calcPage(c) {
  const q = faq(c.faq);
  const vals = defaults(c.id);
  const others = CALC_PAGES.filter((o) => o.id !== c.id).map((o) => `<a class="card" href="${o.path}"><h3>${o.short}</h3><p>${esc(o.description.split(".")[0])}.</p></a>`).join("");
  return page({
    path: c.path,
    title: c.title,
    description: c.description,
    hero: { eyebrow: c.eyebrow, h1: c.h1, lede: c.lede, crumb: c.short },
    scripts: ["/site/calc-ui.js"],
    body:
      `<section class="band" style="border-top:0"><div class="wrap"><div class="calc" data-calc="${c.id}"><form autocomplete="off" aria-label="${esc(c.short)} inputs">${formHtml(c.id)}</form><div class="readout" aria-live="polite"><div class="readout-body">${CALCS[c.id].render(vals)}</div><button type="button" class="btn btn-ghost btn-sm share" hidden>Copy link to this result</button></div></div></div></section>` +
      section("How it's computed", "The formula", `<pre class="formula"><code>${esc(c.formula)}</code></pre>${c.notes}`, "band-alt") +
      section("From the plan", "Measure it instead of typing it", `<div class="split"><p class="measure">These numbers come from somewhere: a room traced at the right scale. <a href="/">Open the canvas</a>, drag in the plan, and the report carries the same math across every room of the takeoff, with a marked planset that shows where each number came from.</p><p class="ctas" style="justify-content:flex-start"><a class="btn btn-gold" href="/">Open the canvas</a><a class="btn btn-ghost" style="color:var(--fg);border-color:var(--accent-rule)" href="/flooring-takeoff/">How a flooring takeoff runs</a></p></div>`) +
      section("Questions", `${c.short}, answered`, q.html, "band-alt") +
      section("More calculators", "", `<div class="grid grid-3">${others}</div>`),
    jsonld: [ld("WebApplication", { name: c.title.split(" | ")[0], url: `https://opentakeoff.kentucky-ai.com${c.path}`, applicationCategory: "UtilitiesApplication", operatingSystem: "Any (web browser)", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }, isAccessibleForFree: true, publisher: { "@type": "Organization", name: "Kentucky AI", url: "https://kentucky-ai.com" } }), q.ld],
  });
}

function toolsIndex() {
  return page({
    path: "/tools/",
    title: "Free Flooring Calculators: SY, Waste, Carpet Rolls, Base | OpenTakeoff",
    description: "Free flooring estimating calculators: square feet to square yards, waste and cartons with attic stock, carpet roll cuts with seams and pattern repeat, and wall base.",
    hero: { eyebrow: "Calculators", h1: "The hand checks, <em>done right</em>", lede: "Four quick calculators for the arithmetic every flooring estimate runs on. Each one shows its formula and makes a link you can share.", crumb: "Calculators" },
    body: `<section class="band" style="border-top:0"><div class="wrap"><div class="grid grid-2">${CALC_PAGES.map((c, i) => `<a class="card" href="${c.path}"><span class="num">0${i + 1}</span><h3>${c.short}</h3><p>${esc(c.description)}</p></a>`).join("")}</div></div></section>` +
      section("Past one room", "The whole takeoff runs the same math", `<p class="measure">The calculators handle one number at a time. The <a href="/">canvas</a> runs the same waste, square-yard and roll-goods math on every room you trace, then exports the report and a marked planset.</p>`, "band-alt"),
  });
}

function docsIndex(docs) {
  return page({
    path: "/docs/",
    title: "OpenTakeoff Documentation: User Manual, Agent Manual, MCP",
    description: "OpenTakeoff documentation: the user manual for the browser canvas, the agent manual and MCP reference for AI agents, and self-hosting notes.",
    hero: { eyebrow: "Documentation", h1: "The manuals", lede: "Mirrored from the repository on every deploy, so these pages always match the code.", crumb: "Docs" },
    body: `<section class="band" style="border-top:0"><div class="wrap"><div class="grid grid-2 doc-cards">${docs.map((d) => `<a class="card" href="${d.path}"><span class="num">${d.kicker}</span><h3>${d.nav}</h3><p>${esc(d.description)}</p></a>`).join("")}</div>
<p class="measure" style="margin-top:32px">Also on GitHub: <a href="${REPO}/blob/main/mcp/README.md">MCP tool-by-tool reference</a> · <a href="${REPO}/blob/main/FEATURES.md">every capability mapped to its code</a> · <a href="${REPO}/blob/main/CHANGELOG.md">changelog</a> · <a href="${REPO}/blob/main/AGENTS.md">AGENTS.md</a> for coding agents.</p></div></section>`,
  });
}

/** [{ path, html }] for every hand-written page. */
export function buildPages(ctx, docs) {
  return [
    { path: "/agents/", html: agents(ctx) },
    { path: "/flooring-takeoff/", html: flooring() },
    { path: "/free-takeoff-software/", html: free(ctx) },
    { path: "/tools/", html: toolsIndex() },
    ...CALC_PAGES.map((c) => ({ path: c.path, html: calcPage(c) })),
    { path: "/docs/", html: docsIndex(docs) },
  ];
}
