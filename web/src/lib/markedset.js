// Marked-Set PDF export — distribute the takeoff off-app, fully client-side.
//
// One click builds a distribution-ready PDF: every sheet that carries takeoff
// shapes or markups, with the work burned in as drawn — condition colors,
// clipped hatch linework, per-shape quantity chips, count markers, cobalt
// markups — plus a legend cover: per-condition totals (net of deducts,
// ×multiplier, waste-adjusted), swatches, hatch names, and a BY SHEET
// breakdown. A PM or GC reads it with zero OpenTakeoff access.
//
// Coordinate law (the part that bites): shape verts are normalized to the
// sheet's VISUAL (rotated) raster. Light pages are vector copies of the source
// (crisp at any zoom), so every point maps through the INVERSE of the pdf.js
// viewport transform into PDF user space — rotation and viewBox offsets come
// along for free. Dark pages are built the way the canvas dark mode works: the
// page rastered, pixel-inverted (difference-with-white), laid as an image on a
// fresh unrotated page — visual coords map straight in, no derotation.
//
// pdf-lib is lazy-loaded (like ingest's image→PDF wrap), so the export costs
// nothing until used and the app stays zero-install.

import { conditionTotals, sheetTotals, roundSheetRow, hasMultipliers, BY_SHEET_BASE_NOTE } from "./totals.js";
import { approvalInk, approvalTally, APPROVAL_R } from "./approvals.js";
import { pointInPoly, starPath, arrowheadPath, cloudBezier, chiselRibbon } from "./geometry.js";
import { transformPath, svgPlacedBox } from "./svgpath.js";
import { rfiStatus } from "./rfi.js";
import { RENDER_SCALE } from "./sheets";
import { stitchPagePlan, memberEmbed } from "./stitches";
import { pdfDashFor, boostForDark, clampWeight } from "./lineStyles.js";
import { dimLabel } from "./units";
import i18n from "../i18n/index.js";

const _t = (key, options) => i18n.t(key, { ns: "lib", ...options });

const COBALT = "#1f3fc7";
const DEDUCT_RED = "#b03a26";
const DARK_BG = [0.055, 0.07, 0.09];       // matches the canvas dark stage
const RASTER_MAX = 2800;                    // dark-mode raster cap, long side px

// hatch style → parallel-line families [angleDeg, pitch(image px)] that match
// the canvas pattern's geometric read; decorative styles approximate — the
// legend names the true style. Pitches ×2 vs the 10px canvas tile for print.
const HATCH_FAMILIES = {
  diag: [[45, 14]], diag2: [[135, 14]], cross: [[45, 14], [135, 14]],
  diagdense: [[45, 7]], horiz: [[0, 10]], vert: [[90, 10]],
  grid: [[0, 10], [90, 10]], brick: [[0, 10]], plank: [[0, 10]],
  herring: [[45, 14], [135, 14]], basket: [[0, 10], [90, 10]],
  checker: [[45, 7]], wave: [[0, 10]], dots: [[45, 20]], speckle: [[45, 20]],
};

// Signal-set (2026-07) hatches carry real per-tile segments instead of a
// line-family approximation — every one of them is segment-representable, so
// the print keeps pattern identity. Authored in canvas SVG tile units and
// scaled ×2 at draw time, matching the line families' print pitch convention.
const TILE_K = 2;
const hexSegs = (cx, cy, s) => {
  const h = 0.866 * s;
  const p = [[cx - s, cy], [cx - s / 2, cy - h], [cx + s / 2, cy - h], [cx + s, cy], [cx + s / 2, cy + h], [cx - s / 2, cy + h]];
  return p.map((a, i) => [...a, ...p[(i + 1) % 6]]);
};
const ovalSegs = (cx, cy, rx, ry, rotDeg, n = 16) => {
  const rot = (rotDeg * Math.PI) / 180, c = Math.cos(rot), s = Math.sin(rot), pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n, ex = rx * Math.cos(a), ey = ry * Math.sin(a);
    pts.push([cx + ex * c - ey * s, cy + ex * s + ey * c]);
  }
  return pts.slice(1).map((p, i) => [...pts[i], ...p]);
};
const HATCH_TILES = {
  iso: { w: 13.86, h: 8, segs: [[0, 8, 13.86, 0], [0, 0, 13.86, 8], [6.93, 0, 6.93, 8]] },
  honeycomb: { w: 12, h: 6.9282, segs: [...hexSegs(0, 0, 4), ...hexSegs(6, 3.4641, 4)] },
  scan: { w: 16, h: 8, segs: [[0, 2, 10, 2], [8, 6, 16, 6], [0, 6, 2, 6]] },
  plus: { w: 12, h: 12, segs: [[6, 3.5, 6, 8.5], [3.5, 6, 8.5, 6], [0, -2.5, 0, 2.5], [-2.5, 0, 2.5, 0]] },
  circuit: {
    w: 20, h: 20,
    segs: [[2, 2, 10, 2], [10, 2, 10, 10], [14, 18, 14, 13], [14, 13, 18, 13]],
    dots: [[2, 2], [10, 10], [14, 18], [18, 13]],
  },
  topo: { w: 24, h: 24, segs: [...ovalSegs(12, 12, 8, 5, -18), ...ovalSegs(12, 12, 4.6, 2.6, -18, 12)] },
};

// tile-based hatch (image px): per-tile segments clipped to the polygon; a
// spec's dots come back separately for the caller to draw as filled circles.
function hatchTiles(poly, spec) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const w = spec.w * TILE_K, h = spec.h * TILE_K;
  const segs = [], dots = [];
  for (let ty = Math.floor(y0 / h) * h; ty < y1 + h; ty += h) {
    for (let tx = Math.floor(x0 / w) * w; tx < x1 + w; tx += w) {
      for (const [ax, ay, bx, by] of spec.segs) {
        segs.push(...clipSegToPoly(tx + ax * TILE_K, ty + ay * TILE_K, tx + bx * TILE_K, ty + by * TILE_K, poly));
      }
      for (const [cx, cy] of spec.dots || []) {
        const x = tx + cx * TILE_K, y = ty + cy * TILE_K;
        if (pointInPoly(x, y, poly)) dots.push([x, y]);
      }
    }
  }
  return { segs, dots };
}

const hex = (h) => {
  const s = String(h || "#888").replace("#", "");
  const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.padEnd(6, "0");
  const out = [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
  // a malformed color (imported/hand-edited) must never reach pdf-lib as NaN
  return out.some(Number.isNaN) ? [0.53, 0.53, 0.53] : out;
};
const num = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d || 0).toLocaleString(undefined, { maximumFractionDigits: d }); // || 0 normalizes -0 so a −0.05 delta never prints "-0"

// pdf-lib's standard Helvetica encodes WinAnsi only — one CJK/emoji code point
// in ANY drawn string (project name, company/client fields, condition tags,
// markup text) used to throw "WinAnsi cannot encode" and abort the whole
// export. Every string is funneled through this before it reaches
// drawText/widthOfTextAtSize: printable ASCII and Latin-1 (0xA0–0xFF, which
// covers the · and × this module emits) pass through, plus the WinAnsi
// typographic marks — … (the right-align clamp appends it) and the common
// dashes/quotes/bullet users paste. Thin/narrow no-break spaces (some locales'
// digit group separator) soften to a plain space. Everything else becomes "?",
// iterated by CODE POINT so an emoji's surrogate pair maps to ONE "?" and no
// pair is ever bisected.
// zero-gate a legend quantity at DISPLAY precision (num renders 1dp for SF/LF,
// 0dp for EA): gating on round2 truthiness left 0.01–0.04 slivers printing as
// "0 SF" (and "-0 SF" for negatives).
const shows = (v, d = 1) => Math.round(Math.abs(v) * 10 ** d) !== 0;

const WINANSI_EXTRAS = new Set([..."…–—‘’“”•", ..."€™Šš‹›ŒœŽžŸƒ†‡‰ˆ˜"]); // full printable cp1252 0x80–0x9F
export function winAnsiSafe(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTRAS.has(ch)) out += ch;
    else if (cp === 0x2009 || cp === 0x202f) out += " ";
    else out += "?";
  }
  return out;
}

// clip segment A→B (image px) against a polygon, even-odd: returns kept
// [ax,ay,bx,by] sub-segments whose midpoints are inside.
function clipSegToPoly(ax, ay, bx, by, poly) {
  const ts = [0, 1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [px, py] = poly[j], [qx, qy] = poly[i];
    const rx = bx - ax, ry = by - ay, sx = qx - px, sy = qy - py;
    const den = rx * sy - ry * sx;
    if (!den) continue;
    const t = ((px - ax) * sy - (py - ay) * sx) / den;
    const u = ((px - ax) * ry - (py - ay) * rx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k], t1 = ts[k + 1];
    if (t1 - t0 < 1e-6) continue;
    const mx = ax + ((t0 + t1) / 2) * (bx - ax), my = ay + ((t0 + t1) / 2) * (by - ay);
    if (pointInPoly(mx, my, poly)) out.push([ax + t0 * (bx - ax), ay + t0 * (by - ay), ax + t1 * (bx - ax), ay + t1 * (by - ay)]);
  }
  return out;
}

// hatch a polygon (image px): families of parallel lines clipped even-odd.
function hatchLines(poly, style) {
  const fams = HATCH_FAMILIES[style];
  if (!fams) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const out = [];
  for (const [deg, pitch] of fams) {
    const th = (deg * Math.PI) / 180, ux = Math.cos(th), uy = Math.sin(th), nx = -uy, ny = ux;
    let d0 = Infinity, d1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const [cx, cy] of corners) {
      const d = cx * nx + cy * ny, t = cx * ux + cy * uy;
      d0 = Math.min(d0, d); d1 = Math.max(d1, d); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    for (let d = d0 + pitch / 2; d < d1; d += pitch) {
      const ax = nx * d + ux * t0, ay = ny * d + uy * t0, bx = nx * d + ux * t1, by = ny * d + uy * t1;
      out.push(...clipSegToPoly(ax, ay, bx, by, poly));
    }
  }
  return out;
}

function shapeChip(shape, cond, M = false) {
  const cp = shape.computed || {};
  const tag = cond?.finish_tag || "";
  const uA = (sf) => (M ? sf * 0.09290304 : sf);
  const uL = (lf) => (M ? lf * 0.3048 : lf);
  const AU = M ? "m²" : "SF", LU = M ? "m" : "LF";
  switch (shape.measure_role) {
    case "floor_area": return `${tag} · ${num(uA(cp.area_sf || 0))} ${AU}`;
    case "deduct": return `-${num(uA(cp.area_sf || 0))} ${AU} ${_t("marked_set.deduct_suffix")}`;
    case "surface_area": return `${tag} · ${num(uA(cp.area_sf || 0))} ${AU} ${_t("marked_set.wall_suffix")}`;
    case "linear": return `${tag} · ${num(uL(cp.perimeter_lf || 0))} ${LU}`;
    default: return "";
  }
}
const centroid = (pts) => {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
};

// difference-with-white pixel inversion (the canvas dark-mode involution)
function invertPixels(cv) {
  const ctx = cv.getContext("2d");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "difference";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.restore();
}

export async function buildMarkedSetPdf({ projectName, dark, sheets, shapes, markups, approvals = [], rfis = [], conditions, getPage, loadPdfData, company, clientInfo, credit = null, provenance = null, coverTitle = "Marked Set", units = "imperial" }) {
  // display-unit edge (lib/units contract): quantities arrive as internal feet;
  // metric converts at the drawn string only — legend rows, by-sheet rows, and
  // the per-shape chips. Unicode "m²" (U+00B2, valid WinAnsi cp1252).
  const M = units === "metric";
  const uA = (sf) => (M ? sf * 0.09290304 : sf);
  const uL = (lf) => (M ? lf * 0.3048 : lf);
  const AU = M ? "m²" : "SF", LU = M ? "m" : "LF";
  const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = await import("pdf-lib");
  const condById = Object.fromEntries(conditions.map((c) => [c.id, c]));
  // resolve a linked markup's RFI number for the on-sheet marker (ASCII, WinAnsi-safe)
  const rfiNum = new Map((rfis || []).map((r) => [r.id, r.number]));
  const byKey = (arr) => {
    const m = new Map();
    for (const s of arr) { const a = m.get(s.sheet_id) || []; a.push(s); m.set(s.sheet_id, a); }
    return m;
  };
  const shapesBy = byKey(shapes), marksBy = byKey(markups), apBy = byKey(approvals);
  // an approval seal marks its sheet like any other work — a sheet carrying
  // only a seal (a sheet-point approval before any takeoff) still exports
  const marked = sheets.filter((sh) => (shapesBy.get(sh.key) || []).length || (marksBy.get(sh.key) || []).length || (apBy.get(sh.key) || []).length);
  // a live RFI can outlive its markups, so an RFI-only project still exports
  // (cover + RFI schedule, no per-sheet pages) — only a truly empty set aborts
  if (!marked.length && !rfis?.length) throw new Error(_t("marked_set.nothing_to_export"));
  const markedShapes = marked.flatMap((sh) => shapesBy.get(sh.key) || []);

  const doc = await PDFDocument.create();
  // Provenance on the deliverable itself: a marked set leaves this app and gets
  // emailed around, so it should say what produced it. It also lets the MCP
  // export recognize its own prior output and overwrite that without ceremony,
  // while still refusing to clobber a file it didn't write (mcp/src/safewrite.ts).
  doc.setProducer("OpenTakeoff");
  doc.setCreator("OpenTakeoff");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = dark ? rgb(0.93, 0.92, 0.89) : rgb(0.13, 0.12, 0.1);
  const muted = dark ? rgb(0.63, 0.61, 0.56) : rgb(0.42, 0.4, 0.36);
  const cobalt = dark ? rgb(0.45, 0.56, 1) : rgb(...hex(COBALT));   // brighter on near-black

  // company logo, if any — a corrupt stored dataURL must not kill the export,
  // so embed inside a try and skip silently on failure. embedPng takes the
  // data URI string directly (same as the dark-mode raster's toDataURL below).
  // Drawn as-is in dark mode too: normalized PNGs keep their transparency,
  // no inversion.
  let logoImg = null;
  if (company?.logo) {
    try {
      logoImg = await doc.embedPng(company.logo);
    } catch { logoImg = null; }
  }

  // ── legend cover ───────────────────────────────────────────────────────────
  {
    const pg = doc.addPage([612, 792]);
    // the single choke point for cover text — every string WinAnsi-sanitized
    const draw = (t, opts) => pg.drawText(winAnsiSafe(t), opts);
    if (dark) pg.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(...DARK_BG) });
    // the star is the canvas vertex mark — same 4-point / 0.38-inner geometry
    pg.drawSvgPath(starPath(0, 0, 11), { x: 52, y: 738, color: cobalt });
    // cover wordmark: "OpenTakeoff · Marked Set" in default mode, "Marked Set"
    // when a trade name brands the doc (the branding resolver decides)
    const coverTitleSafe = winAnsiSafe(coverTitle);
    draw(coverTitleSafe, { x: 70, y: 731, size: 17, font: bold, color: ink });
    // the identity column's clamp wall: the title's right edge plus breathing
    // room, so a long company name in the no-logo case can't overprint the title
    const wordmarkRight = 70 + bold.widthOfTextAtSize(coverTitleSafe, 17) + 12;
    // company identity — a right-aligned column ending at x=560, clear of the
    // wordmark and the 22pt project name at x=52: logo top pinned to 748
    // (bottom lands at 700 when full 48pt height), name + address stacked
    // beneath, stopping above the CONDITIONS "waste" column (x=420, y≤630).
    {
      let idY = 731;   // no logo → company name baseline rides the wordmark's
      if (logoImg) {
        const s = Math.min(120 / logoImg.width, 48 / logoImg.height);
        const w = logoImg.width * s, h = logoImg.height * s;
        pg.drawImage(logoImg, { x: 560 - w, y: 748 - h, width: w, height: h });
        idY = 748 - h - 13;
      }
      // right-aligned column, clamped: never cross the wordmark's right edge.
      // Input is sanitized FIRST, so the ellipsis loop slices plain WinAnsi
      // text — it can never bisect an emoji surrogate pair.
      const rightAligned = (t, size, fnt) => {
        let s = winAnsiSafe(t);
        while (s && 560 - fnt.widthOfTextAtSize(s, size) < wordmarkRight) s = s.slice(0, -2).trimEnd() + "…";
        return { text: s, x: 560 - fnt.widthOfTextAtSize(s, size) };
      };
      if (company?.name) {
        const { text, x } = rightAligned(String(company.name), 10, bold);
        draw(text, { x, y: idY, size: 10, font: bold, color: ink });
        idY -= 12;
      }
      for (const raw of String(company?.address || "").split("\n")) {
        const t = raw.trim();
        if (!t || idY < 652) continue;
        const { text, x } = rightAligned(t, 8.5, font);
        draw(text, { x, y: idY, size: 8.5, font, color: muted });
        idY -= 11;
      }
    }
    draw(String(projectName || _t("marked_set.untitled_project")), { x: 52, y: 700, size: 22, font: bold, color: ink });
    // client block (optional) sits under the project name; the meta line and
    // everything below shift down with it — no clientInfo, no shift: every y
    // matches the unbranded cover exactly.
    let metaY = 680;
    {
      const clientLines = [];
      if (clientInfo?.client_name) clientLines.push(`${_t("marked_set.prepared_for")} ${clientInfo.client_name}`);
      for (const raw of String(clientInfo?.client_address || "").split("\n")) { const t = raw.trim(); if (t) clientLines.push(t); }
      if (clientInfo?.reference) clientLines.push(`${_t("marked_set.ref")} ${clientInfo.reference}`);
      if (clientInfo?.date) clientLines.push(`${_t("marked_set.date")} ${clientInfo.date}`);
      if (clientLines.length) {
        let cy = 681;
        // capped: a pasted multi-line address must never push CONDITIONS off
        // the page or walk into the fixed footer at y=48
        for (const t of clientLines.slice(0, 6)) { draw(t, { x: 52, y: cy, size: 9.5, font, color: ink }); cy -= 12; }
        metaY = cy - 4;
      }
    }
    const sheetWord = marked.length === 1 ? _t("marked_set.marked_sheet") : _t("marked_set.marked_sheets");
    const itemWord = markedShapes.length === 1 ? _t("marked_set.takeoff_item") : _t("marked_set.takeoff_items");
    draw(`${marked.length} ${sheetWord} · ${markedShapes.length} ${itemWord} · ${_t("marked_set.quantities_note")}`, { x: 52, y: metaY, size: 9.5, font, color: muted });
    // assignment provenance (0.9.18): where the finish tags came from
    // (schedule-resolved / agent-asserted / withheld) — drawn only when the
    // caller states it, so canvas output stays byte-identical without it
    if (provenance) { metaY -= 12; draw(provenance, { x: 52, y: metaY, size: 9.5, font, color: muted }); }
    // approval-seal tally — the ink/pencil split for the whole exported set:
    // how much a human APPROVED vs what an agent merely marked. Drawn only
    // when seals exist (the provenance-line convention), so a seal-free
    // export stays byte-identical.
    const apCount = approvalTally(marked.flatMap((sh) => apBy.get(sh.key) || []));
    if (apCount.estimator || apCount.agent) {
      metaY -= 12;
      draw(`${_t("marked_set.approval_stamps")}: ${apCount.estimator} ${_t("marked_set.approval_estimator")} · ${apCount.agent} ${_t("marked_set.approval_agent")}`, { x: 52, y: metaY, size: 9.5, font, color: muted });
    }
    let y = metaY - 34;
    const rows = conditionTotals(conditions, markedShapes).filter((r) => r.shape_count > 0);
    draw(_t("markedset.conditions"), { x: 52, y, size: 9, font: bold, color: muted }); y -= 16;
    for (const r of rows) {
      const c = condById[r.id] || {};
      pg.drawRectangle({ x: 52, y: y - 2, width: 14, height: 10, color: rgb(...hex(c.color)), opacity: 0.8, borderColor: rgb(...hex(c.color)), borderWidth: 0.7 });
      draw(`${r.finish_tag}${r.multiplier > 1 ? ` ×${r.multiplier}` : ""}`, { x: 72, y, size: 10.5, font: bold, color: ink });
      // zero-gate on the CONVERTED value — what the page prints (a 0.5 SF
      // sliver reads 0.0 m2 in metric; it must drop, not print "0 m2")
      const qty = [
        shows(uA(r.floor_sf)) ? `${num(uA(r.floor_sf))} ${AU}` : "",         shows(uA(r.wall_sf)) ? `${num(uA(r.wall_sf))} ${AU} ${_t("marked_set.wall_suffix")}` : "",
        shows(uA(r.border_sf)) ? `${num(uA(r.border_sf))} ${AU} ${_t("marked_set.border_suffix")}` : "", shows(uL(r.lf)) ? `${num(uL(r.lf))} ${LU}` : "", shows(r.ea, 0) ? `${num(r.ea, 0)} EA` : "",
      ].filter(Boolean).join(" · ");
      draw(qty || "-", { x: 190, y, size: 10, font, color: ink });
      draw(`${c.hatch && c.hatch !== "solid" ? c.hatch + " · " : ""}${_t("marked_set.waste_label")} ${r.waste_pct}% -> ${num(uA(r.total_sf_net))} ${AU}`, { x: 420, y, size: 8.5, font, color: muted });
      y -= 15;
      if (y < 120) break;
    }
    y -= 10;
    draw(_t("markedset.by_sheet"), { x: 52, y, size: 9, font: bold, color: muted }); y -= 16;
    const bySheet = sheetTotals(conditions, markedShapes);
    const bySheetId = new Map(bySheet.map((gr) => [gr.sheet_id, gr]));
    for (const sh of marked) {
      if (y < 90) break;
      const items = shapesBy.get(sh.key) || [];
      // a stitch has no single source page — the cover names it for what it is
      const where = sh.stitch ? `${_t("marked_set.stitched_composite")} · ${sh.stitch.members.length} ${_t("marked_set.sheets")}` : `${_t("marked_set.page")} ${sh.page}`;
      draw(`${sh.label} · ${where} · ${items.length + (marksBy.get(sh.key) || []).length + (apBy.get(sh.key) || []).length} ${_t("marked_set.item")}`, { x: 52, y, size: 9.5, font: bold, color: ink }); y -= 13;
      for (const r of bySheetId.get(sh.key)?.rows || []) {
        if (y < 92) break;   // stop above the fixed footnote slot at y=60 — rows never collide with it
        const c = condById[r.id] || {};
        pg.drawRectangle({ x: 66, y: y - 1, width: 9, height: 7, color: rgb(...hex(c.color)), opacity: 0.8 });
        const { floor_sf: floor, wall_sf: wall, border_sf: border, lf, ea } = roundSheetRow(r);
        const qty = [shows(uA(floor)) ? `${num(uA(floor))} ${AU}` : "", shows(uA(wall)) ? `${num(uA(wall))} ${AU} ${_t("marked_set.wall_suffix")}` : "", shows(uA(border)) ? `${num(uA(border))} ${AU} ${_t("marked_set.border_suffix")}` : "", shows(uL(lf)) ? `${num(uL(lf))} ${LU}` : "", shows(ea, 0) ? `${num(ea, 0)} EA` : ""].filter(Boolean).join(" · ");
        draw(`${r.finish_tag}${r.multiplier > 1 ? ` ×${r.multiplier}` : ""}  ${qty}`, { x: 82, y, size: 8.5, font, color: ink });
        y -= 11;
      }
      y -= 5;
    }
    // base-quantities footnote: a fixed slot above the footer (like the footer
    // itself at y=48) — a reading of the by-sheet figures depends on it, so it
    // must never be dropped just because the row loops ran the page out
    if (hasMultipliers(bySheet)) {
      draw(_t("markedset.by_sheet_base_note"), { x: 52, y: 60, size: 7.5, font, color: muted });
    }
    draw(_t("marked_set.generated", { date: new Date().toLocaleDateString() }), { x: 52, y: 48, size: 8, font, color: muted });
  }

  // ── RFI schedule page — ONLY when RFIs exist, so an RFI-free export never
  // gains a blank page. Its own draw() choke point WinAnsi-sanitizes every RFI
  // free-text field; subjects are clamped on the SANITIZED string. Dark-aware. ──
  if (rfis?.length) {
    // clamp a string to a max width, measuring the SANITIZED text (mirrors the
    // cover's rightAligned) so the ellipsis can never bisect a surrogate pair
    const clampTo = (raw, size, fnt, maxW) => {
      let s = winAnsiSafe(raw);
      while (s && fnt.widthOfTextAtSize(s, size) > maxW) s = s.slice(0, -2).trimEnd() + "…";
      return s;
    };
    const footText = _t("marked_set.generated", { date: new Date().toLocaleDateString() });
    const BOT = 58;   // content never crosses below this; the footer sits at y=40
    let pg, draw, y;
    const newSchedPage = () => {
      pg = doc.addPage([612, 792]);
      draw = (t, opts) => pg.drawText(winAnsiSafe(t), opts);
      if (dark) pg.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(...DARK_BG) });
      draw(_t("markedset.rfi_schedule"), { x: 52, y: 744, size: 13, font: bold, color: cobalt });
      draw(`${rfis.length} RFI${rfis.length === 1 ? "" : "s"} · ${_t("marked_set.rfi_link_note")}`, { x: 52, y: 728, size: 9, font, color: muted });
      draw(footText, { x: 52, y: 40, size: 8, font, color: muted });   // footer on EVERY schedule page
      y = 704;
      draw(_t("rfi.csv_header.number"), { x: 52, y, size: 8, font: bold, color: muted });
      draw(_t("rfi.csv_header.subject"), { x: 108, y, size: 8, font: bold, color: muted });
      draw(_t("rfi.csv_header.status"), { x: 360, y, size: 8, font: bold, color: muted });
      draw(_t("rfi.csv_header.ball_in_court"), { x: 442, y, size: 8, font: bold, color: muted });
      y -= 5;
      pg.drawLine({ start: { x: 52, y }, end: { x: 560, y }, thickness: 0.6, color: muted });
      y -= 15;
    };
    newSchedPage();
    for (const r of rfis) {
      const st = rfiStatus(r.status);
      const stCol = dark ? ink : rgb(...hex(st.color));
      const links = (markups || []).filter((m) => m.rfi_id === r.id).length;
      const meta = [
        r.priority ? `${_t("marked_set.priority")} ${r.priority}` : "",
        r.cost_impact ? _t("marked_set.cost_impact") : "",
        r.schedule_impact ? _t("marked_set.schedule_impact") : "",
        r.date ? `${_t("marked_set.opened")} ${r.date}` : "",
        r.response_date ? `${_t("marked_set.answered")} ${r.response_date}` : "",
        links ? `${links} ${links === 1 ? _t("marked_set.linked_markup") : _t("marked_set.linked_markups")}` : "",
      ].filter(Boolean).join(" · ");
      // break BEFORE the record so its whole block (row + meta + Q + A) stays above
      // the footer — a record can never overprint it. A full record fits a fresh page.
      const h = 11 + (meta ? 10 : 0) + (r.question ? 10 : 0) + (r.response ? 10 : 0) + 8;
      if (y - h < BOT) newSchedPage();
      draw(String(r.number || ""), { x: 52, y, size: 9, font: bold, color: ink });
      draw(clampTo(r.subject || _t("marked_set.no_subject"), 9, font, 244), { x: 108, y, size: 9, font, color: ink });
      draw(st.label, { x: 360, y, size: 9, font, color: stCol });
      draw(clampTo(r.to || "-", 8.5, font, 112), { x: 442, y, size: 8.5, font, color: muted });
      y -= 11;
      if (meta) { draw(clampTo(meta, 8, font, 452), { x: 108, y, size: 8, font, color: muted }); y -= 10; }
      if (r.question) { draw(clampTo(`Q: ${r.question}`, 8, font, 452), { x: 108, y, size: 8, font, color: ink }); y -= 10; }
      if (r.response) { draw(clampTo(`A: ${r.response}`, 8, font, 452), { x: 108, y, size: 8, font, color: ink }); y -= 10; }
      y -= 8;
    }
  }

  // ── marked sheets ──────────────────────────────────────────────────────────
  const srcDocs = new Map();   // file → PDFDocument (light-mode page copies + stitch member embeds)
  const srcDocFor = async (file) => {
    let src = srcDocs.get(file);
    if (!src) { src = await PDFDocument.load(await loadPdfData(file), { ignoreEncryption: true }); srcDocs.set(file, src); }
    return src;
  };
  for (const sh of marked) {
    let pg, toPage, chipRot = degrees(0), W, H;

    if (sh.stitch) {
      // ── composite stitch page (#200): the stitched surface as ONE page at
      // its composite dimensions — the space the shapes were traced in
      // (verts_norm are normalized to the stitch extent, per lib/stitches).
      // Each member is placed at its stitch offset and clipped to its seam
      // box, so ink never double-draws at the match line — the same rule the
      // canvas paints by. The page exists in no source planset, and says so
      // in its stamp; the alternative (projecting shapes back onto member
      // pages) splits a measured-once room into fragments that read as wrong
      // traces — see the design note in lib/stitches.ts.
      const members = sh.stitch.members;
      const pages = [];
      const dims = {};
      for (const m of members) {
        const page = await getPage(m.file, m.page);
        const vpR = page.getViewport({ scale: RENDER_SCALE });
        dims[m.key] = { w: vpR.width, h: vpR.height };
        pages.push({ m, page, vpR });
      }
      const plan = stitchPagePlan(members, dims);
      W = plan.extent.w; H = plan.extent.h;
      const pageW = W / RENDER_SCALE, pageH = H / RENDER_SCALE;
      if (dark) {
        // one composite raster: members painted seam-clipped onto a white
        // ground (so the gap outside every member inverts to the dark stage),
        // then the whole canvas inverted ONCE — the involution stays exact.
        const s = Math.min(RASTER_MAX / Math.max(pageW, pageH), 4);
        const cv = document.createElement("canvas");
        cv.width = Math.ceil(pageW * s); cv.height = Math.ceil(pageH * s);
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
        const k = s / RENDER_SCALE;   // stitch-local image px → canvas px
        for (let i = 0; i < pages.length; i++) {
          const { page } = pages[i], pm = plan.members[i];
          const vp = page.getViewport({ scale: s });
          const mc = document.createElement("canvas");
          mc.width = Math.ceil(vp.width); mc.height = Math.ceil(vp.height);
          await page.render({ canvasContext: mc.getContext("2d"), viewport: vp }).promise;
          ctx.save();
          ctx.beginPath();
          ctx.rect(pm.clip.x0 * k, pm.clip.y0 * k, (pm.clip.x1 - pm.clip.x0) * k, (pm.clip.y1 - pm.clip.y0) * k);
          ctx.clip();
          // vp(scale s).width === member points × s — exactly the member's
          // footprint on the composite canvas, so the raster draws 1:1
          ctx.drawImage(mc, pm.dx * k, pm.dy * k);
          ctx.restore();
        }
        invertPixels(cv);
        const png = await doc.embedPng(cv.toDataURL("image/png"));
        pg = doc.addPage([pageW, pageH]);
        pg.drawImage(png, { x: 0, y: 0, width: pageW, height: pageH });
      } else {
        // vector: each member's source page embedded as a form XObject whose
        // BBox is the seam box in the member's own user space and whose
        // matrix lands it at its stitch offset on the composite page —
        // rotation and viewBox offsets ride the viewport transform, exactly
        // like the plain-sheet inverse-transform path (lib/stitches
        // memberEmbed holds the math, node-tested).
        pg = doc.addPage([pageW, pageH]);
        for (let i = 0; i < pages.length; i++) {
          const { m, vpR } = pages[i], pm = plan.members[i];
          const src = await srcDocFor(m.file);
          const { bbox, matrix } = memberEmbed(vpR.transform, pm, pageH, RENDER_SCALE);
          const emb = await doc.embedPage(src.getPage(m.page - 1), bbox, matrix);
          pg.drawPage(emb, { x: 0, y: 0 });
        }
      }
      // shapes ride the composite frame directly — no derotation (the stitch
      // page is unrotated by construction, like the dark raster path)
      toPage = (x, y) => [x / RENDER_SCALE, pageH - y / RENDER_SCALE];
    } else {
    const page = await getPage(sh.file, sh.page);
    const vpR = page.getViewport({ scale: RENDER_SCALE });   // the space verts are normalized to
    W = vpR.width; H = vpR.height;

    if (dark) {
      // raster → invert → image page (unrotated by construction)
      const vp1 = page.getViewport({ scale: 1 });
      const s = Math.min(RASTER_MAX / Math.max(vp1.width, vp1.height), 4);
      const vp = page.getViewport({ scale: s });
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
      await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
      invertPixels(cv);
      const png = await doc.embedPng(cv.toDataURL("image/png"));
      pg = doc.addPage([vp1.width, vp1.height]);
      pg.drawImage(png, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      const k = vp1.width / W;   // image px (at RENDER_SCALE) → page points
      toPage = (x, y) => [x * k, vp1.height - y * k];
    } else {
      // vector copy of the source page; image px → PDF user space through the
      // inverse viewport transform (rotation + viewBox offsets included)
      let src = srcDocs.get(sh.file);
      if (!src) { src = await PDFDocument.load(await loadPdfData(sh.file), { ignoreEncryption: true }); srcDocs.set(sh.file, src); }
      const [copied] = await doc.copyPages(src, [sh.page - 1]);
      pg = doc.addPage(copied);
      const [a, b, c, d, e, f] = vpR.transform;
      const det = a * d - b * c;
      toPage = (x, y) => [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
      chipRot = degrees(page.rotate || 0);
    }
    }
    const ptScale = Math.hypot(...(() => { const p0 = toPage(0, 0), p1 = toPage(1, 0); return [p1[0] - p0[0], p1[1] - p0[1]]; })());
    const svgPath = (pts) => pts.map(([x, y], i) => { const [px, py] = toPage(x, y); return `${i ? "L" : "M"}${px},${-py}`; }).join(" ") + " Z";
    const svgOpenPath = (pts) => pts.map(([x, y], i) => { const [px, py] = toPage(x, y); return `${i ? "L" : "M"}${px},${-py}`; }).join(" ");
    const line = (x1, y1, x2, y2, colorRgb, w, opacity = 1, dash) => {
      const [sx, sy] = toPage(x1, y1), [ex, ey] = toPage(x2, y2);
      pg.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: w, color: colorRgb, opacity, ...(dash ? { dashArray: dash } : {}) });
    };
    // both helpers sanitize FIRST — markup text / sheet labels / condition
    // tags can carry CJK/emoji, and chip measures width on the drawn string
    const text = (t, x, y, size, colorRgb, fnt = font) => {
      const [px, py] = toPage(x, y);
      pg.drawText(winAnsiSafe(t), { x: px, y: py, size, font: fnt, color: colorRgb, rotate: chipRot });
    };
    const chip = (raw, x, y, borderRgb) => {
      const t = winAnsiSafe(raw);
      const size = 7.5;
      const w = font.widthOfTextAtSize(t, size) + 8;
      const [px, py] = toPage(x, y);
      pg.drawRectangle({
        x: px - w / 2, y: py - 5.5, width: w, height: 12,
        color: dark ? rgb(0.08, 0.1, 0.12) : rgb(1, 1, 1), opacity: 0.85,
        borderColor: borderRgb, borderWidth: 0.7, rotate: chipRot,
      });
      pg.drawText(t, { x: px - w / 2 + 4, y: py - 2.5, size, font, color: ink, rotate: chipRot });
    };

    const alphaBoost = dark ? 0.22 : 0;   // honest colors, brighter on negative linework
    for (const s of shapesBy.get(sh.key) || []) {
      const cond = condById[s.condition_id];
      const pts = (s.verts_norm || []).map(([nx, ny]) => [nx * W, ny * H]);
      if (!pts.length) continue;
      const isDeduct = s.measure_role === "deduct";
      const col = rgb(...hex(isDeduct ? DEDUCT_RED : cond?.color));
      // line_style governs positive floor_area + linear outlines only: deduct keeps
      // its red (no dash override) and surface_area keeps its solid wall run.
      const borderDash = isDeduct ? undefined : pdfDashFor(cond?.line_style || "solid");
      if (s.measure_role === "floor_area" || isDeduct) {
        const fill = cond?.fill && cond.fill !== "none" && !isDeduct ? rgb(...hex(cond.fill)) : col;
        pg.drawSvgPath(svgPath(pts), { x: 0, y: 0, color: fill, opacity: (isDeduct ? 0.14 : 0.16) + alphaBoost / 2, borderColor: col, borderWidth: 1.1, borderOpacity: 0.95, ...(borderDash ? { borderDashArray: borderDash } : {}) });
        if (!isDeduct && cond?.hatch && cond.hatch !== "solid") {
          const tiled = HATCH_TILES[cond.hatch];
          if (tiled) {
            const { segs, dots } = hatchTiles(pts, tiled);
            for (const [ax, ay, bx, by] of segs) line(ax, ay, bx, by, col, 0.5, 0.55 + alphaBoost);
            for (const [dx, dy] of dots) {
              const [px, py] = toPage(dx, dy);
              pg.drawEllipse({ x: px, y: py, xScale: 1.4, yScale: 1.4, color: col, opacity: 0.55 + alphaBoost });
            }
          } else {
            for (const [ax, ay, bx, by] of hatchLines(pts, cond.hatch)) line(ax, ay, bx, by, col, 0.5, 0.55 + alphaBoost);
          }
        }
        chip(shapeChip(s, cond, M), ...centroid(pts), col);
      } else if (s.measure_role === "linear" || s.measure_role === "surface_area") {
        // shared branch — dash only the linear role; surface_area stays solid
        const segDash = s.measure_role === "linear" ? pdfDashFor(cond?.line_style || "solid") : undefined;
        for (let i = 1; i < pts.length; i++) line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], col, 1.4, 0.95, segDash);
        const mid = pts[Math.floor((pts.length - 1) / 2)];
        chip(shapeChip(s, cond, M), mid[0], mid[1] - 14, col);
      } else if (s.measure_role === "count") {
        const [px, py] = toPage(pts[0][0], pts[0][1]);
        pg.drawEllipse({ x: px, y: py, xScale: 4.5, yScale: 4.5, borderColor: col, borderWidth: 1.2, color: col, opacity: 0.35 });
      }
    }
    // highlights draw FIRST (behind) so their translucent fill never dims the
    // linework of clouds/callouts/text above — same z-order as the canvas.
    const marksHere = [...(marksBy.get(sh.key) || [])].sort((a, b) => (a.type === "highlight" ? 0 : 1) - (b.type === "highlight" ? 0 : 1));
    for (const m of marksHere) {
      // linked RFI number marker (ASCII) — drawn UNCONDITIONALLY, even when the
      // markup has no note (a linked cloud can be textless), so the link always
      // prints. Helvetica can't draw ⬢, so it's the number, not the glyph.
      const rlabel = m.rfi_id && rfiNum.has(m.rfi_id) ? rfiNum.get(m.rfi_id) : "";
      const lbl = (t) => [rlabel, t].filter((s) => s != null && s !== "").join(" ");
      // per-markup color drives the STROKE/FILL and the note text, dark-boosted for
      // the dark sheet — mirroring the canvas fallback exactly (custom color, else
      // the LINKED CONDITION's color, else cobalt when RFI-linked, else amber).
      // Legacy/uncolored markups match the canvas. This precedence must stay in
      // step with TakeoffCanvas's markup layer, or the burned set stops looking
      // like the screen it was reviewed on — the one thing a marked set owes.
      // Linkage still prints via the RFI number prefix (lbl), independent of color.
      const mCond = m.condition_id ? (conditions || []).find((c) => c.id === m.condition_id) : null;
      const mbase = m.color || mCond?.color || (m.rfi_id ? COBALT : "#c47a10");
      const mcol = rgb(...hex(dark ? boostForDark(mbase) : mbase));
      const mdash = pdfDashFor(m.line_style || "solid");
      const mw = clampWeight(m.weight);   // stroke-width multiplier (markups only), default ×1
      if (m.type === "highlight" && (m.pts || []).length >= 2) {
        // freehand highlighter stroke — ink stays its own color in both export
        // modes (a highlight IS its hue); width is stored as a fraction of sheet
        // width → image px → page points. Weight (×) multiplies like the canvas.
        const ipts = m.pts.map(([nx, ny]) => [nx * W, ny * H]);
        const inkCol = rgb(...hex(m.color || "#ffd60a"));
        const wImg = (m.w || 0.01) * W * mw;
        if (m.tip === "chisel") {
          pg.drawSvgPath(svgPath(chiselRibbon(ipts, wImg, 45)), { x: 0, y: 0, color: inkCol, opacity: 0.35 });
        } else {
          pg.drawSvgPath(svgOpenPath(ipts), {
            x: 0, y: 0, borderColor: inkCol, borderWidth: wImg * ptScale, borderOpacity: 0.35,
            ...(LineCapStyle ? { borderLineCap: LineCapStyle.Round } : {}),   // butt caps if the pin drops the export
          });
        }
      } else if (m.type === "highlight" && m.rect) {
        const [[nx0, ny0], [nx1, ny1]] = m.rect;
        const r = [[nx0 * W, ny0 * H], [nx1 * W, ny0 * H], [nx1 * W, ny1 * H], [nx0 * W, ny1 * H]];
        pg.drawSvgPath(svgPath(r), { x: 0, y: 0, color: mcol, opacity: 0.18 + alphaBoost / 2, borderColor: mcol, borderWidth: 1 * mw, borderOpacity: 0.9, ...(mdash ? { borderDashArray: mdash } : {}) });
        const t = lbl(m.text);
        if (t) text(t, Math.min(nx0, nx1) * W, Math.min(ny0, ny1) * H - 10 / ptScale, 8, mcol, bold);
      } else if (m.type === "cloud" && m.rect) {
        const [[nx0, ny0], [nx1, ny1]] = m.rect;
        // real scallops: cloudBezier's CONTROL POINTS survive the affine page
        // transform (SVG arcs don't), so map each through toPage and emit one
        // cubic path. An explicit line_style dashes it; default is a solid scallop.
        const cb = cloudBezier(nx0 * W, ny0 * H, nx1 * W, ny1 * H);
        const P = (p) => { const [px, py] = toPage(p[0], p[1]); return `${px},${-py}`; };
        let d = `M${P(cb.start)}`;
        for (const [c1, c2, end] of cb.segments) d += ` C${P(c1)} ${P(c2)} ${P(end)}`;
        pg.drawSvgPath(d + " Z", { x: 0, y: 0, borderColor: mcol, borderWidth: 1.3 * mw, borderOpacity: 0.95, ...(mdash ? { borderDashArray: mdash } : {}) });
        const t = lbl(m.text);
        if (t) text(t, Math.min(nx0, nx1) * W, Math.min(ny0, ny1) * H - 10 / ptScale, 8, mcol, bold);
        // revision-delta triangle at the top-right corner — clear of the
        // top-left RFI label and the centered note. Absent m.rev → nothing.
        if (Number.isFinite(m.rev) && m.rev > 0) {
          const cxImg = Math.max(nx0, nx1) * W, cyImg = Math.min(ny0, ny1) * H, s = 9 / ptScale;
          const tri = [[cxImg, cyImg - s], [cxImg + s, cyImg + s], [cxImg - s, cyImg + s]];
          // the triangle is always white-filled, so stroke/number it in the un-boosted
          // color (mcol's dark boost would wash out on the white backing).
          const rcol = rgb(...hex(mbase));
          pg.drawSvgPath(tri.map((p, i) => `${i ? "L" : "M"}${P(p)}`).join(" ") + " Z", { x: 0, y: 0, color: rgb(1, 1, 1), opacity: 0.9, borderColor: rcol, borderWidth: 1 });
          text(String(m.rev), cxImg - 3 / ptScale, cyImg + s - 3 / ptScale, 7, rcol, bold);
        }
      } else if (m.type === "arrow" && m.from && m.to) {
        // a directed leader with a filled arrowhead at the `to` end — seam /
        // plank-direction arrows and the north arrow (a stamp of arrow + "N").
        // arrowheadPath negates y like svgPath; the shaft goes through line().
        line(m.from[0] * W, m.from[1] * H, m.to[0] * W, m.to[1] * H, mcol, 1.3 * mw, 0.95, mdash);
        const [pfx, pfy] = toPage(m.from[0] * W, m.from[1] * H);
        const [ptx, pty] = toPage(m.to[0] * W, m.to[1] * H);
        pg.drawSvgPath(arrowheadPath(pfx, -pfy, ptx, -pty, 6 * mw), { x: 0, y: 0, color: mcol, opacity: 0.95 });
        const t = lbl(m.text);
        if (t) text(t, (m.from[0] + m.to[0]) / 2 * W, (m.from[1] + m.to[1]) / 2 * H - 6 / ptScale, 8, mcol, bold);
      } else if (m.type === "dimension" && m.from && m.to) {
        // a dimension line: perpendicular ticks at both ends, the measured
        // length centered beside it. m.len_ft was snapshotted at annotate
        // time from the sheet scale, so this draws with no scale plumbing —
        // and dimLabel is ASCII feet-inches, safe through the WinAnsi funnel.
        const fx = m.from[0] * W, fy = m.from[1] * H, dxq = m.to[0] * W, dyq = m.to[1] * H;
        line(fx, fy, dxq, dyq, mcol, 1.1 * mw, 0.95, mdash);
        const dl = Math.hypot(dxq - fx, dyq - fy) || 1;
        const dnx = -(dyq - fy) / dl, dny = (dxq - fx) / dl;
        const tk = 5 / ptScale;
        line(fx - dnx * tk, fy - dny * tk, fx + dnx * tk, fy + dny * tk, mcol, 1.1 * mw, 0.95);
        line(dxq - dnx * tk, dyq - dny * tk, dxq + dnx * tk, dyq + dny * tk, mcol, 1.1 * mw, 0.95);
        const t = lbl([Number(m.len_ft) > 0 ? dimLabel(m.len_ft, M ? "metric" : "imperial") : "", m.text].filter(Boolean).join(" · "));
        if (t) {
          // centered on the offset midpoint (the bubble's centering), so a
          // vertical dimension's label sits beside the line, not across it
          const size = 8;
          const tw = bold.widthOfTextAtSize(winAnsiSafe(t), size);
          const [pmx, pmy] = toPage((fx + dxq) / 2 + dnx * (14 / ptScale), (fy + dyq) / 2 + dny * (14 / ptScale));
          pg.drawText(winAnsiSafe(t), { x: pmx - tw / 2, y: pmy - size / 2.7, size, font: bold, color: mcol, rotate: chipRot });
        }
      } else if (m.type === "bubble" && m.at) {
        // a circle carrying centered text — detail/section/keynote bubbles and
        // pattern-origin markers. Radius is normalized to sheet WIDTH, so it maps
        // through the page scale like every other length (ptScale: px→pt).
        const cxImg = m.at[0] * W, cyImg = m.at[1] * H;
        const [pcx, pcy] = toPage(cxImg, cyImg);
        const rPt = (Number(m.r) > 0 ? Number(m.r) : 0.02) * W * ptScale;
        pg.drawEllipse({ x: pcx, y: pcy, xScale: rPt, yScale: rPt, borderColor: mcol, borderWidth: 1.2 * mw, borderOpacity: 0.95, color: dark ? rgb(0.08, 0.1, 0.12) : rgb(1, 1, 1), opacity: 0.85 });
        const t = lbl(m.text);
        if (t) {
          const size = 8;
          const tw = bold.widthOfTextAtSize(winAnsiSafe(t), size);
          pg.drawText(winAnsiSafe(t), { x: pcx - tw / 2, y: pcy - size / 2.7, size, font: bold, color: mcol, rotate: chipRot });
        }
      } else if (m.type === "callout" && m.at) {
        if (m.target) {
          line(m.target[0] * W, m.target[1] * H, m.at[0] * W, m.at[1] * H, mcol, 0.9 * mw, 0.9, mdash);
          // arrowhead at the target end, pointing from the label — page coords
          // negate y to match svgPath's convention
          const [pax, pay] = toPage(m.at[0] * W, m.at[1] * H);
          const [ptx, pty] = toPage(m.target[0] * W, m.target[1] * H);
          pg.drawSvgPath(arrowheadPath(pax, -pay, ptx, -pty, 5), { x: 0, y: 0, color: mcol, opacity: 0.9 });
        }
        text(lbl(m.text), m.at[0] * W, m.at[1] * H, 8.5, mcol, bold);
      } else if (m.type === "svg" && m.at && Array.isArray(m.vb) && typeof m.path === "string") {
        // a vector symbol — bake local→page px, NEGATING y like every sibling path
        // (drawSvgPath internally applies scale(1,-1), so toPage output must be
        // negated). Uniform scale off sheet WIDTH keeps it undistorted; the fn is a
        // general affine (toPage carries rotation on rotated sheets), applied
        // pointwise to the bezier controls by transformPath.
        const { s: sx, bw, bh } = svgPlacedBox(m.vb, m.w, W);
        if (sx > 0) {
          const x0 = m.at[0] * W - bw / 2, y0 = m.at[1] * H - bh / 2;
          const d = transformPath(m.path, (lx, ly) => { const [px, py] = toPage(x0 + lx * sx, y0 + ly * sx); return [px, -py]; });
          const fillOn = m.fill && m.fill !== "none";
          if (d) pg.drawSvgPath(d, { x: 0, y: 0, borderColor: mcol, borderWidth: 1.2 * mw, borderOpacity: 0.95, ...(fillOn ? { color: rgb(...hex(dark ? boostForDark(m.fill) : m.fill)), opacity: 0.9 } : {}) });
          const t = lbl(m.text);
          if (t) text(t, m.at[0] * W - bw / 2, y0 - 6 / ptScale, 8, mcol, bold);
        }
      } else if (m.type === "text" && m.at) {
        text(lbl(m.text), m.at[0] * W, m.at[1] * H, 8.5, mcol, bold);
      }
    }
    // approval seals burn in ABOVE the markups, exactly as the canvas layers
    // them: the estimator's APPROVED ring, the agent's AGENT diamond. Radius
    // is normalized to sheet WIDTH (the bubble convention → ptScale), inks are
    // the shared token literals (approvalInk), dark variant included.
    for (const a of apBy.get(sh.key) || []) {
      const isAgent = a.actor === "agent";
      const acol = rgb(...hex(approvalInk(a.actor, dark)));
      const cxImg = a.at[0] * W, cyImg = a.at[1] * H;
      const rImg = APPROVAL_R * W, rPt = rImg * ptScale;
      const [pcx, pcy] = toPage(cxImg, cyImg);
      const backing = dark ? rgb(0.08, 0.1, 0.12) : rgb(1, 1, 1);
      if (isAgent) {
        // diamond through svgPath so rotated sheets transform it correctly
        const dia = (k) => [[cxImg, cyImg - rImg * k], [cxImg + rImg * k, cyImg], [cxImg, cyImg + rImg * k], [cxImg - rImg * k, cyImg]];
        pg.drawSvgPath(svgPath(dia(1)), { x: 0, y: 0, color: backing, opacity: 0.72, borderColor: acol, borderWidth: rPt * 0.07 });
        pg.drawSvgPath(svgPath(dia(0.72)), { x: 0, y: 0, borderColor: acol, borderWidth: rPt * 0.035 });
      } else {
        pg.drawEllipse({ x: pcx, y: pcy, xScale: rPt, yScale: rPt, color: backing, opacity: 0.72, borderColor: acol, borderWidth: rPt * 0.07 });
        pg.drawEllipse({ x: pcx, y: pcy, xScale: rPt * 0.78, yScale: rPt * 0.78, borderColor: acol, borderWidth: rPt * 0.035 });
      }
      // centered label, the bubble-text centering precedent (ASCII, WinAnsi-safe)
      const label = isAgent ? _t("approval.agent") : _t("approval.approved");
      const size = rPt * (isAgent ? 0.3 : 0.26);
      const tw = bold.widthOfTextAtSize(label, size);
      pg.drawText(label, { x: pcx - tw / 2, y: pcy - size / 2.7, size, font: bold, color: acol, rotate: chipRot });
    }
    // sheet stamp, top-left in visual space. A stitch page exists in no source
    // planset, so its stamp says so — the composite is disclosed, not passed
    // off as a drawing the architect issued.
    const stamp = sh.stitch
      ? `${sh.label} · ${_t("marked_set.stitched_composite")} (${sh.stitch.members.map((m) => m.label || m.key).join(" + ")}) · ${_t("marked_set.marked_set")}`
      : `${sh.label} · ${_t("marked_set.marked_set")}`;
    text(stamp, 14, 20, 8, muted);
  }

  // small tool credit on the LAST page only — the subtle parent credit shown in
  // clear-label mode. Default mode passes null: the cover already carries the
  // "OpenTakeoff · " wordmark, so a separate credit would be redundant.
  const allPages = doc.getPages();
  const lastPg = allPages[allPages.length - 1];
  if (lastPg && credit) {
    const cw = font.widthOfTextAtSize(winAnsiSafe(credit), 7);
    lastPg.drawText(winAnsiSafe(credit), { x: (612 - cw) / 2, y: 22, size: 7, font, color: muted });
  }

  const bytes = await doc.save();
  const base = (projectName || "").trim();
  const filename = `${base ? base + " - " : ""}marked set${dark ? " (dark)" : ""}.pdf`;
  return { bytes, filename };
}

export function downloadBytes(filename, bytes, type = "application/pdf") {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
