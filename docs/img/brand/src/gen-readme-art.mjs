// Regenerate (fonts and opentype.js stay out of the repo; any empty directory works):
//   D=$(mktemp -d) && npm i --prefix $D opentype.js@1.3.4 @fontsource/bricolage-grotesque@5 @fontsource/jetbrains-mono@5 @fontsource/inter@5
//   node docs/img/brand/src/gen-readme-art.mjs $D/node_modules
// Writes hero.svg, how-it-works.svg and scan-star.svg to docs/img/brand/, plus two dot-prefixed
// static SVGs that Chrome renders to scan-star.png (512px at 2x) and social-preview.png (1280x640).
// Fonts are SIL Open Font License; outlining them into artwork is permitted.
// Generates the README brand art for OpenTakeoff: animated hero, how-it-works strip,
// standalone scan star, and a static social card. Text is outlined to paths so the SVGs
// render identically on GitHub (no webfonts inside <img>).
import { createRequire } from "node:module";
import { writeFileSync, readFileSync } from "node:fs";
import { scanStarRows } from "../../../../web/src/lib/scanStar.js";

const [DEPS, OUT = new URL(".", import.meta.url).pathname + ".."] = process.argv.slice(2);
const opentype = createRequire(DEPS + "/")("opentype.js");
const F = (p) => { const b = readFileSync(`${DEPS}/@fontsource/${p}`); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const display800 = F("bricolage-grotesque/files/bricolage-grotesque-latin-800-normal.woff");
const display700 = F("bricolage-grotesque/files/bricolage-grotesque-latin-700-normal.woff");
const inter500 = F("inter/files/inter-latin-500-normal.woff");
const inter600 = F("inter/files/inter-latin-600-normal.woff");
const mono500 = F("jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff");
const mono600 = F("jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff");

const NAVY = "#0e1a2e", NAVY2 = "#13233d", CYAN = "#62d4dc", INK = "#eef4fb", MUTED = "#8fa3bb", AMBER = "#f2b64a";
const r1 = (n) => Math.round(n * 10) / 10;

// text → path; anchor "start" | "middle" | "end"
function text(font, str, x, y, size, { anchor = "start", fill = INK, attrs = "", tracking = 0 } = {}) {
  let w = font.getAdvanceWidth(str, size) + tracking * size * (str.length - 1);
  const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  let d = "", cx = x0;
  if (tracking) {
    for (const ch of str) { d += font.getPath(ch, cx, y, size).toPathData(1); cx += font.getAdvanceWidth(ch, size) + tracking * size; }
  } else d = font.getPath(str, x0, y, size).toPathData(1);
  return { svg: `<path d="${d}" fill="${fill}" ${attrs}/>`, w, x0 };
}

function star(cx, cy, height, rows, { fill = CYAN, cls = "", ripple = false, reach = 2.4 } = {}) {
  const s = height / 2;
  return `<g transform="translate(${cx} ${cy}) scale(${s})" fill="${fill}" class="${cls}">` +
    scanStarRows(rows, reach).map((r) =>
      `<rect x="${+r.x.toFixed(4)}" y="${+r.y.toFixed(4)}" width="${+r.w.toFixed(4)}" height="${+r.h.toFixed(4)}"${ripple ? ` style="animation-delay:${(r.ring * 0.07).toFixed(2)}s"` : ""}/>`).join("") + `</g>`;
}

// horizontal scan stripes used to cut "Takeoff"
function stripes(id, x, y, w, h, pitch, fill = 0.66) {
  let s = `<clipPath id="${id}">`;
  for (let yy = y; yy < y + h; yy += pitch) s += `<rect x="${x}" y="${r1(yy)}" width="${w}" height="${r1(pitch * fill)}"/>`;
  return s + `</clipPath>`;
}

function wordmark(cx, baseline, size, clipId) {
  const open = display800.getAdvanceWidth("Open", size), take = display800.getAdvanceWidth("Takeoff", size);
  const x0 = cx - (open + take) / 2;
  const a = text(display800, "Open", x0, baseline, size, { fill: INK });
  const b = text(display800, "Takeoff", x0 + open, baseline, size, { fill: CYAN, attrs: `clip-path="url(#${clipId})"` });
  return { svg: a.svg + b.svg, defs: stripes(clipId, r1(x0 + open - 4), baseline - size, r1(take + 12), size * 1.25, size / 13), x0, w: open + take };
}

// ---------- plan geometry (illustrative floor plan, walls 8px) ----------
const PX_PER_FT = 18; // 1/8" = 1'-0" at render scale 2.0 (144 px per inch)
const area = (pts) => Math.abs(pts.reduce((s, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return s + x * y2 - x2 * y; }, 0)) / 2;
const perim = (pts) => pts.reduce((s, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return s + Math.hypot(x2 - x, y2 - y); }, 0);
const ring134 = [[64, 74], [326, 74], [326, 286], [222, 286], [222, 290], [180, 290], [180, 286], [64, 286]];
const ring137 = [[244, 349], [380, 349], [380, 345], [422, 345], [422, 349], [586, 349], [586, 446], [244, 446]];
const sf = (pts) => (area(pts) / PX_PER_FT ** 2).toFixed(1);
const lf = (pts) => (perim(pts) / PX_PER_FT).toFixed(1);
const ptsAttr = (pts) => pts.map((p) => p.join(",")).join(" ");
const pathOf = (pts) => "M" + pts.map((p) => p.join(",")).join("L") + "Z";

function plan() {
  const wall = `stroke="#a9bcd2" stroke-width="8" stroke-linecap="square" fill="none" opacity=".62"`;
  const W = [
    "M60,70H590V450H60Z",                    // outer
    "M330,70V290", "M240,345V450",           // partitions
    "M60,290H180", "M222,290H450", "M492,290H590",   // corridor north wall, two doors
    "M60,345H120", "M162,345H380", "M422,345H590",   // corridor south wall, two doors
  ];
  const doors = [ // leaf + swing
    "M180,290L180,248", "M180,248A42,42 0 0 1 222,290",
    "M492,290L492,248", "M492,248A42,42 0 0 0 450,290",
    "M120,345L120,387", "M120,387A42,42 0 0 0 162,345",
    "M422,345L422,387", "M422,387A42,42 0 0 1 380,345",
  ];
  let s = `<g ${wall}>${W.map((d) => `<path d="${d}"/>`).join("")}</g>`;
  s += `<g stroke="#a9bcd2" stroke-width="1.6" fill="none" opacity=".45">${doors.map((d) => `<path d="${d}"/>`).join("")}</g>`;
  // casework + a column, the stuff a trace must not follow
  s += `<g stroke="#a9bcd2" stroke-width="1.4" fill="none" opacity=".35"><rect x="350" y="78" width="120" height="26"/><rect x="520" y="200" width="40" height="40"/><path d="M520,200L560,240M560,200L520,240"/></g>`;
  // room labels + finish tags
  const tag = (x, y, t) => { const b = text(mono600, t, x, y + 4.5, 12, { anchor: "middle", fill: "#c9d6e6" }); return `<rect x="${r1(x - b.w / 2 - 7)}" y="${y - 10}" width="${r1(b.w + 14)}" height="20" rx="10" fill="none" stroke="#c9d6e6" stroke-width="1.2" opacity=".7"/>${b.svg}`; };
  const lbl = (x, y, t) => text(mono500, t, x, y, 13, { anchor: "middle", fill: MUTED }).svg;
  s += `<g opacity=".9">${lbl(195, 168, "OFFICE 134")}${tag(195, 190, "CPT-1")}${lbl(460, 168, "CONF 135")}${tag(460, 190, "CPT-1")}${lbl(150, 405, "STOR 136")}${tag(150, 427, "VCT-1")}${lbl(415, 405, "OPEN OFFICE 137")}${tag(415, 427, "LVT-2")}${lbl(325, 322, "CORRIDOR 130")}</g>`;
  return s;
}

// ---------- HERO ----------
function hero() {
  const W = 1280, H = 540;
  const wm = wordmark(930, 318, 86, "cut");
  const per134 = r1(perim(ring134)), per137 = r1(perim(ring137));
  const chip = (x, y, cls, label, qty) => {
    const a = text(inter600, label, x + 12, y + 20, 13, { fill: NAVY });
    const b = text(mono600, qty, x + 12 + a.w + 10, y + 20, 13, { fill: NAVY });
    const w = r1(a.w + b.w + 34);
    return `<g class="${cls}"><rect x="${x}" y="${y}" width="${w}" height="30" rx="7" fill="${CYAN}"/>${a.svg}${b.svg}</g>`;
  };
  const cursor = (cls, pts, kt) => `<g class="cursor ${cls}">${star(0, 0, 22, 7, { fill: "#ffffff" })}<circle r="15" fill="none" stroke="#fff" stroke-width="1.2" opacity=".55"/>` +
    `<animateMotion dur="11s" repeatCount="indefinite" path="${pathOf(pts)}" keyPoints="0;0;1;1" keyTimes="${kt}" calcMode="linear"/></g>`;
  const tag1 = text(inter500, "The open-source foundation for construction takeoff.", 930, 368, 22, { anchor: "middle", fill: INK });
  const tag2 = text(inter500, "Measure plans in your browser. Hand the same engine to your AI agent.", 930, 398, 16, { anchor: "middle", fill: MUTED });
  const cmd = text(mono600, "npx -y opentakeoff-mcp", 0, 0, 17);
  const cmdW = cmd.w + 70, cmdX = r1(930 - cmdW / 2);
  const cmdP = text(mono600, "$", cmdX + 20, 461, 17, { fill: CYAN });
  const cmdT = text(mono600, "npx -y opentakeoff-mcp", cmdX + 40, 461, 17, { fill: INK });
  const status = text(mono500, `2 rooms · ${(+sf(ring134) + +sf(ring137)).toFixed(1)} SF · marked set ready`, 64, 500, 13, { fill: CYAN });
  const kicker = text(mono600, "AI-NATIVE · AGPL-3.0 · RUNS IN YOUR BROWSER", 930, 82, 12, { anchor: "middle", fill: CYAN, tracking: 0.12 });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">OpenTakeoff</title>
<desc id="d">The scan star beside the OpenTakeoff wordmark. On the left an agent traces two rooms of a floor plan on their wall faces and each room reports its square footage.</desc>
<defs>
  <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32,0H0V32" fill="none" stroke="${CYAN}" stroke-opacity=".07"/></pattern>
  <pattern id="hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="9" height="9" fill="${CYAN}" fill-opacity=".1"/><path d="M0,0V9" stroke="${CYAN}" stroke-opacity=".35" stroke-width="1.2"/></pattern>
  <linearGradient id="scan" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${CYAN}" stop-opacity="0"/><stop offset=".85" stop-color="${CYAN}" stop-opacity=".22"/><stop offset="1" stop-color="${CYAN}" stop-opacity=".9"/></linearGradient>
  <radialGradient id="glow" cx=".73" cy=".42" r=".45"><stop offset="0" stop-color="${CYAN}" stop-opacity=".16"/><stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></radialGradient>
  <clipPath id="frame"><rect width="${W}" height="${H}" rx="22"/></clipPath>
  <clipPath id="planclip"><rect x="40" y="50" width="580" height="420"/></clipPath>
  ${wm.defs}
</defs>
<style>
  .rip rect{animation:rip 2.6s ease-in-out infinite}
  @keyframes rip{0%,100%{opacity:1}45%{opacity:.28}}
  .sweep{animation:sweep 11s linear infinite}
  @keyframes sweep{0%{transform:translateY(-60px);opacity:0}2%{opacity:1}13%{transform:translateY(400px);opacity:1}15%,100%{transform:translateY(400px);opacity:0}}
  .tr1{stroke-dasharray:${per134};animation:tr1 11s linear infinite}
  @keyframes tr1{0%,14%{stroke-dashoffset:${per134}}38%,93%{stroke-dashoffset:0;opacity:1}98%,100%{stroke-dashoffset:0;opacity:0}}
  .tr2{stroke-dasharray:${per137};animation:tr2 11s linear infinite}
  @keyframes tr2{0%,46%{stroke-dashoffset:${per137}}70%,93%{stroke-dashoffset:0;opacity:1}98%,100%{stroke-dashoffset:0;opacity:0}}
  .f1{animation:f1 11s ease-out infinite}@keyframes f1{0%,38%{opacity:0}43%,93%{opacity:1}98%,100%{opacity:0}}
  .f2{animation:f2 11s ease-out infinite}@keyframes f2{0%,70%{opacity:0}75%,93%{opacity:1}98%,100%{opacity:0}}
  .c1{animation:c1 11s cubic-bezier(.3,1.6,.5,1) infinite;transform-box:fill-box;transform-origin:center}
  @keyframes c1{0%,39%{opacity:0;transform:scale(.6)}43%,93%{opacity:1;transform:scale(1)}98%,100%{opacity:0}}
  .c2{animation:c2 11s cubic-bezier(.3,1.6,.5,1) infinite;transform-box:fill-box;transform-origin:center}
  @keyframes c2{0%,71%{opacity:0;transform:scale(.6)}75%,93%{opacity:1;transform:scale(1)}98%,100%{opacity:0}}
  .st{animation:st 11s ease-out infinite}@keyframes st{0%,78%{opacity:0}82%,93%{opacity:1}98%,100%{opacity:0}}
  .k1{animation:k1 11s steps(1) infinite}@keyframes k1{0%,13.9%{opacity:0}14%,38%{opacity:1}38.1%,100%{opacity:0}}
  .k2{animation:k2 11s steps(1) infinite}@keyframes k2{0%,45.9%{opacity:0}46%,70%{opacity:1}70.1%,100%{opacity:0}}
  .caret{animation:caret 1.1s steps(1) infinite}@keyframes caret{50%{opacity:0}}
  @media (prefers-reduced-motion: reduce){*{animation:none!important}.cursor,.sweep{display:none}}
</style>
<g clip-path="url(#frame)">
  <rect width="${W}" height="${H}" fill="${NAVY}"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="40" y="50" width="580" height="420" rx="6" fill="${NAVY2}" fill-opacity=".55" stroke="${CYAN}" stroke-opacity=".12"/>
  ${plan()}
  <g clip-path="url(#planclip)"><rect class="sweep" x="40" y="10" width="580" height="60" fill="url(#scan)"/></g>
  <polygon class="f1" points="${ptsAttr(ring134)}" fill="url(#hatch)"/>
  <polygon class="f2" points="${ptsAttr(ring137)}" fill="url(#hatch)"/>
  <polygon class="tr1" points="${ptsAttr(ring134)}" fill="none" stroke="${CYAN}" stroke-width="3" stroke-linejoin="round"/>
  <polygon class="tr2" points="${ptsAttr(ring137)}" fill="none" stroke="${CYAN}" stroke-width="3" stroke-linejoin="round"/>
  <g class="f1" fill="${CYAN}">${ring134.map(([x, y]) => `<rect x="${x - 3.5}" y="${y - 3.5}" width="7" height="7"/>`).join("")}</g>
  <g class="f2" fill="${CYAN}">${ring137.map(([x, y]) => `<rect x="${x - 3.5}" y="${y - 3.5}" width="7" height="7"/>`).join("")}</g>
  ${chip(96, 214, "c1", "CPT-1", `${sf(ring134)} SF`)}
  ${chip(455, 357, "c2", "LVT-2", `${sf(ring137)} SF`)}
  <g class="k1">${cursor("", ring134, "0;0.14;0.38;1")}</g>
  <g class="k2">${cursor("", ring137, "0;0.46;0.70;1")}</g>
  <g class="st">${status.svg}</g>
  ${text(mono500, `measure_polygon · on the wall faces · scale 1/8" = 1'-0"`, 64, 40, 12, { fill: MUTED }).svg}

  ${kicker.svg}
  <g class="rip">${star(930, 172, 132, 23)}</g>
  ${wm.svg}
  ${tag1.svg}
  ${tag2.svg}
  <rect x="${cmdX}" y="434" width="${r1(cmdW)}" height="40" rx="10" fill="#08111f" stroke="${CYAN}" stroke-opacity=".45"/>
  ${cmdP.svg}${cmdT.svg}
  <rect class="caret" x="${r1(cmdX + 40 + cmd.w + 6)}" y="445" width="9" height="19" fill="${CYAN}"/>
</g>
</svg>`;
}

// ---------- HOW IT WORKS strip ----------
function how() {
  const W = 1280, H = 250, steps = [
    ["Open", "PDF · image · .zip set", "load_plan"],
    ["Scale", "read the note, never guess", "set_scale"],
    ["Trace", "rooms on the wall faces", "measure_polygon"],
    ["Derive", "base + transitions", "derive_base"],
    ["Deliver", "marked-up planset PDF", "export_marked_pdf"],
  ];
  const x0 = 120, dx = 260, cy = 92;
  const icons = [
    // open: a sheet with folded corner
    (x, y) => `<path d="M${x - 16},${y - 22}H${x + 8}L${x + 18},${y - 12}V${y + 22}H${x - 16}Z M${x + 8},${y - 22}V${y - 12}H${x + 18}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M${x - 9},${y - 2}H${x + 11}M${x - 9},${y + 7}H${x + 11}M${x - 9},${y + 15}H${x + 3}" stroke="currentColor" stroke-width="2"/>`,
    // scale: ruler
    (x, y) => `<rect x="${x - 24}" y="${y - 9}" width="48" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2.4"/>` + [0, 1, 2, 3, 4, 5, 6].map((i) => `<path d="M${x - 18 + i * 6},${y - 9}V${y - 9 + (i % 2 ? 5 : 9)}" stroke="currentColor" stroke-width="1.8"/>`).join(""),
    // trace: room polygon with pips
    (x, y) => `<path d="M${x - 20},${y - 18}H${x + 20}V${y + 18}H${x + 2}V${y + 10}H${x - 10}V${y + 18}H${x - 20}Z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-dasharray="5 3"/>` + [[-20, -18], [20, -18], [20, 18], [-20, 18]].map(([a, b]) => `<rect x="${x + a - 3}" y="${y + b - 3}" width="6" height="6" fill="currentColor"/>`).join(""),
    // derive: perimeter with base line offset
    (x, y) => `<rect x="${x - 20}" y="${y - 18}" width="40" height="36" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="2"/><path d="M${x - 15},${y - 13}H${x + 15}V${y + 13}H${x - 15}Z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-dasharray="2 4" stroke-linecap="round"/>`,
    // deliver: stacked sheets with check
    (x, y) => `<path d="M${x - 12},${y - 24}H${x + 20}V${y + 14}" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="2"/><rect x="${x - 20}" y="${y - 17}" width="32" height="40" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M${x - 11},${y + 3}L${x - 4},${y + 10}L${x + 7},${y - 5}" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  ];
  let s = "";
  const T = 10; // seconds per loop
  steps.forEach(([title, sub, verb], i) => {
    const x = x0 + i * dx;
    const on = (i / 5) * 100, off = Math.min(100, on + 22);
    s += `<style>.s${i}{animation:s${i} ${T}s ease-in-out infinite}@keyframes s${i}{0%,${on.toFixed(0)}%{color:${MUTED}}${(on + 4).toFixed(0)}%,${off.toFixed(0)}%{color:${CYAN}}${Math.min(100, off + 6).toFixed(0)}%,100%{color:${MUTED}}}</style>`;
    s += `<g class="s${i}" style="color:${MUTED}"><circle cx="${x}" cy="${cy}" r="44" fill="${NAVY2}" stroke="currentColor" stroke-width="2"/>${icons[i](x, cy)}</g>`;
    s += text(display700, title, x, 170, 24, { anchor: "middle", fill: INK }).svg;
    s += text(inter500, sub, x, 196, 14, { anchor: "middle", fill: MUTED }).svg;
    s += text(mono500, verb, x, 222, 12.5, { anchor: "middle", fill: CYAN, attrs: `opacity=".85"` }).svg;
    if (i < 4) s += `<path d="M${x + 56},${cy}H${x + dx - 56}" stroke="${CYAN}" stroke-opacity=".3" stroke-width="2" stroke-dasharray="3 6"/>`;
  });
  const runner = `<g class="cursor">${star(0, 0, 26, 7, { fill: CYAN })}<animateMotion dur="${T}s" repeatCount="indefinite" path="M${x0},${cy - 64}H${x0 + 4 * dx}" keyPoints="0;0;0.25;0.25;0.5;0.5;0.75;0.75;1;1" keyTimes="0;0.12;0.2;0.32;0.4;0.52;0.6;0.72;0.8;1" calcMode="spline" keySplines="${Array(9).fill(".5 0 .5 1").join(";")}"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="How a takeoff runs: open the plan, set the scale, trace rooms on the wall faces, derive base and transitions, deliver a marked-up planset PDF.">
<style>@media (prefers-reduced-motion: reduce){*{animation:none!important}.cursor{display:none}}</style>
<defs><clipPath id="hf"><rect width="${W}" height="${H}" rx="22"/></clipPath><pattern id="hg" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32,0H0V32" fill="none" stroke="${CYAN}" stroke-opacity=".06"/></pattern></defs>
<g clip-path="url(#hf)"><rect width="${W}" height="${H}" fill="${NAVY}"/><rect width="${W}" height="${H}" fill="url(#hg)"/>${s}${runner}</g>
</svg>`;
}

// ---------- standalone star ----------
function starMark(animated) {
  const S = 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="The OpenTakeoff scan star">
${animated ? `<style>.rip rect{animation:rip 2.6s ease-in-out infinite}@keyframes rip{0%,100%{opacity:1}45%{opacity:.28}}@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style>` : ""}
<defs><radialGradient id="g" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${CYAN}" stop-opacity=".18"/><stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></radialGradient></defs>
<rect width="${S}" height="${S}" rx="96" fill="${NAVY}"/><rect width="${S}" height="${S}" rx="96" fill="url(#g)"/>
<g class="rip">${star(256, 256, 300, 23, { reach: 1.25 })}</g>
</svg>`;
}

// ---------- social preview (static, 1280x640) ----------
function social() {
  const W = 1280, H = 640;
  const wm = wordmark(640, 430, 112, "cuts");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs><pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32,0H0V32" fill="none" stroke="${CYAN}" stroke-opacity=".07"/></pattern>
<radialGradient id="glow" cx=".5" cy=".38" r=".5"><stop offset="0" stop-color="${CYAN}" stop-opacity=".18"/><stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></radialGradient>${wm.defs}</defs>
<rect width="${W}" height="${H}" fill="${NAVY}"/><rect width="${W}" height="${H}" fill="url(#grid)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
${star(640, 210, 200, 23)}
${wm.svg}
${text(inter500, "The open-source foundation for construction takeoff.", 640, 492, 28, { anchor: "middle", fill: INK }).svg}
${text(mono500, "browser canvas  ·  MCP server for AI agents  ·  AGPL-3.0", 640, 540, 18, { anchor: "middle", fill: CYAN }).svg}
</svg>`;
}

writeFileSync(`${OUT}/hero.svg`, hero());
writeFileSync(`${OUT}/how-it-works.svg`, how());
writeFileSync(`${OUT}/scan-star.svg`, starMark(true));
writeFileSync(`${OUT}/.scan-star-static.svg`, starMark(false));
writeFileSync(`${OUT}/.social-static.svg`, social());
console.log("room 134", sf(ring134), "SF", lf(ring134), "LF; room 137", sf(ring137), "SF");
