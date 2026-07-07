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

import { conditionTotals, sheetTotals, round2 } from "./totals.js";
import { pointInPoly, starPath } from "./geometry.js";
import { dataUrlToBytes } from "./identity.js";
import { RENDER_SCALE } from "./sheets";

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

const hex = (h) => {
  const s = String(h || "#888").replace("#", "");
  const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.padEnd(6, "0");
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
};
const num = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d });

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

function shapeChip(shape, cond) {
  const cp = shape.computed || {};
  const tag = cond?.finish_tag || "";
  switch (shape.measure_role) {
    case "floor_area": return `${tag} · ${num(cp.area_sf || 0)} SF`;
    case "deduct": return `-${num(cp.area_sf || 0)} SF deduct`;
    case "surface_area": return `${tag} · ${num(cp.area_sf || 0)} SF wall`;
    case "linear": return `${tag} · ${num(cp.perimeter_lf || 0)} LF`;
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

export async function buildMarkedSetPdf({ projectName, dark, sheets, shapes, markups, conditions, getPage, loadPdfData, company, clientInfo }) {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import("pdf-lib");
  const condById = Object.fromEntries(conditions.map((c) => [c.id, c]));
  const byKey = (arr) => {
    const m = new Map();
    for (const s of arr) { const a = m.get(s.sheet_id) || []; a.push(s); m.set(s.sheet_id, a); }
    return m;
  };
  const shapesBy = byKey(shapes), marksBy = byKey(markups);
  const marked = sheets.filter((sh) => (shapesBy.get(sh.key) || []).length || (marksBy.get(sh.key) || []).length);
  if (!marked.length) throw new Error("Nothing to export — no sheet carries takeoffs or markups.");
  const markedShapes = marked.flatMap((sh) => shapesBy.get(sh.key) || []);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = dark ? rgb(0.93, 0.92, 0.89) : rgb(0.13, 0.12, 0.1);
  const muted = dark ? rgb(0.63, 0.61, 0.56) : rgb(0.42, 0.4, 0.36);
  const cobalt = dark ? rgb(0.45, 0.56, 1) : rgb(...hex(COBALT));   // brighter on near-black

  // company logo, if any — a corrupt stored dataURL must not kill the export,
  // so decode + embed inside a try and skip silently on failure. Drawn as-is
  // in dark mode too: normalized PNGs keep their transparency, no inversion.
  let logoImg = null;
  if (company?.logo) {
    try {
      const logoBytes = dataUrlToBytes(company.logo);
      if (logoBytes) logoImg = await doc.embedPng(logoBytes);
    } catch { logoImg = null; }
  }

  // ── legend cover ───────────────────────────────────────────────────────────
  {
    const pg = doc.addPage([612, 792]);
    if (dark) pg.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(...DARK_BG) });
    // the star is the canvas vertex mark — same 4-point / 0.38-inner geometry
    pg.drawSvgPath(starPath(0, 0, 11), { x: 52, y: 738, color: cobalt });
    pg.drawText("OpenTakeoff", { x: 70, y: 731, size: 17, font: bold, color: cobalt });
    pg.drawText("marked set", { x: 70 + bold.widthOfTextAtSize("OpenTakeoff", 17) + 8, y: 731, size: 17, font, color: muted });
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
      // right-aligned column, clamped: never cross x=230 into the wordmark
      const rightAligned = (t, size, fnt) => {
        let s = t;
        while (s && 560 - fnt.widthOfTextAtSize(s, size) < 230) s = s.slice(0, -2).trimEnd() + "…";
        return { text: s, x: 560 - fnt.widthOfTextAtSize(s, size) };
      };
      if (company?.name) {
        const { text, x } = rightAligned(String(company.name), 10, bold);
        pg.drawText(text, { x, y: idY, size: 10, font: bold, color: ink });
        idY -= 12;
      }
      for (const raw of String(company?.address || "").split("\n")) {
        const t = raw.trim();
        if (!t || idY < 652) continue;
        const { text, x } = rightAligned(t, 8.5, font);
        pg.drawText(text, { x, y: idY, size: 8.5, font, color: muted });
        idY -= 11;
      }
    }
    pg.drawText(String(projectName || "Untitled project"), { x: 52, y: 700, size: 22, font: bold, color: ink });
    // client block (optional) sits under the project name; the meta line and
    // everything below shift down with it — no clientInfo, no shift: every y
    // matches the unbranded cover exactly.
    let metaY = 680;
    {
      const clientLines = [];
      if (clientInfo?.client_name) clientLines.push(`Prepared for ${clientInfo.client_name}`);
      for (const raw of String(clientInfo?.client_address || "").split("\n")) { const t = raw.trim(); if (t) clientLines.push(t); }
      if (clientInfo?.reference) clientLines.push(`Ref ${clientInfo.reference}`);
      if (clientInfo?.date) clientLines.push(`Date ${clientInfo.date}`);
      if (clientLines.length) {
        let cy = 681;
        // capped: a pasted multi-line address must never push CONDITIONS off
        // the page or walk into the fixed footer at y=48
        for (const t of clientLines.slice(0, 6)) { pg.drawText(t, { x: 52, y: cy, size: 9.5, font, color: ink }); cy -= 12; }
        metaY = cy - 4;
      }
    }
    pg.drawText(`${marked.length} marked sheet${marked.length === 1 ? "" : "s"} · ${markedShapes.length} takeoff item${markedShapes.length === 1 ? "" : "s"} · quantities net of deducts, waste-adjusted where noted`, { x: 52, y: metaY, size: 9.5, font, color: muted });
    let y = metaY - 34;
    const rows = conditionTotals(conditions, markedShapes).filter((r) => r.shape_count > 0);
    pg.drawText("CONDITIONS", { x: 52, y, size: 9, font: bold, color: muted }); y -= 16;
    for (const r of rows) {
      const c = condById[r.id] || {};
      pg.drawRectangle({ x: 52, y: y - 2, width: 14, height: 10, color: rgb(...hex(c.color)), opacity: 0.8, borderColor: rgb(...hex(c.color)), borderWidth: 0.7 });
      pg.drawText(`${r.finish_tag}${r.multiplier > 1 ? ` ×${r.multiplier}` : ""}`, { x: 72, y, size: 10.5, font: bold, color: ink });
      const qty = [
        r.floor_sf ? `${num(r.floor_sf)} SF` : "", r.wall_sf ? `${num(r.wall_sf)} SF wall` : "",
        r.border_sf ? `${num(r.border_sf)} SF border` : "", r.lf ? `${num(r.lf)} LF` : "", r.ea ? `${num(r.ea, 0)} EA` : "",
      ].filter(Boolean).join(" · ");
      pg.drawText(qty || "-", { x: 190, y, size: 10, font, color: ink });
      pg.drawText(`${c.hatch && c.hatch !== "solid" ? c.hatch + " · " : ""}waste ${r.waste_pct}% -> ${num(r.total_sf_net)} SF`, { x: 420, y, size: 8.5, font, color: muted });
      y -= 15;
      if (y < 120) break;
    }
    y -= 10;
    pg.drawText("BY SHEET", { x: 52, y, size: 9, font: bold, color: muted }); y -= 16;
    const bySheet = sheetTotals(conditions, markedShapes);
    const bySheetId = new Map(bySheet.map((gr) => [gr.sheet_id, gr]));
    for (const sh of marked) {
      if (y < 90) break;
      const items = shapesBy.get(sh.key) || [];
      pg.drawText(`${sh.label} · page ${sh.page} · ${items.length + (marksBy.get(sh.key) || []).length} item(s)`, { x: 52, y, size: 9.5, font: bold, color: ink }); y -= 13;
      for (const r of bySheetId.get(sh.key)?.rows || []) {
        const c = condById[r.id] || {};
        pg.drawRectangle({ x: 66, y: y - 1, width: 9, height: 7, color: rgb(...hex(c.color)), opacity: 0.8 });
        const floor = round2(r.floor_sf), wall = round2(r.wall_sf), border = round2(r.border_sf), lf = round2(r.lf), ea = r.ea;
        const qty = [floor ? `${num(floor)} SF` : "", wall ? `${num(wall)} SF wall` : "", border ? `${num(border)} SF border` : "", lf ? `${num(lf)} LF` : "", ea ? `${num(ea, 0)} EA` : ""].filter(Boolean).join(" · ");
        pg.drawText(`${r.finish_tag}${r.multiplier > 1 ? ` ×${r.multiplier}` : ""}  ${qty}`, { x: 82, y, size: 8.5, font, color: ink });
        y -= 11;
        if (y < 80) break;
      }
      y -= 5;
    }
    if (y >= 80 && bySheet.some((gr) => gr.rows.some((r) => r.multiplier > 1))) {
      pg.drawText("by-sheet figures are measured base quantities; xN applies at condition level", { x: 52, y, size: 7.5, font, color: muted });
      y -= 11;
    }
    pg.drawText(`generated by OpenTakeoff · opentakeoff.netlify.app · ${new Date().toLocaleDateString()}`, { x: 52, y: 48, size: 8, font, color: muted });
  }

  // ── marked sheets ──────────────────────────────────────────────────────────
  const srcDocs = new Map();   // file → PDFDocument (light-mode page copies)
  for (const sh of marked) {
    const page = await getPage(sh.file, sh.page);
    const vpR = page.getViewport({ scale: RENDER_SCALE });   // the space verts are normalized to
    const W = vpR.width, H = vpR.height;
    let pg, toPage, chipRot = degrees(0);

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
    const ptScale = Math.hypot(...(() => { const p0 = toPage(0, 0), p1 = toPage(1, 0); return [p1[0] - p0[0], p1[1] - p0[1]]; })());
    const svgPath = (pts) => pts.map(([x, y], i) => { const [px, py] = toPage(x, y); return `${i ? "L" : "M"}${px},${-py}`; }).join(" ") + " Z";
    const line = (x1, y1, x2, y2, colorRgb, w, opacity = 1, dash) => {
      const [sx, sy] = toPage(x1, y1), [ex, ey] = toPage(x2, y2);
      pg.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: w, color: colorRgb, opacity, ...(dash ? { dashArray: dash } : {}) });
    };
    const text = (t, x, y, size, colorRgb, fnt = font) => {
      const [px, py] = toPage(x, y);
      pg.drawText(t, { x: px, y: py, size, font: fnt, color: colorRgb, rotate: chipRot });
    };
    const chip = (t, x, y, borderRgb) => {
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
      if (s.measure_role === "floor_area" || isDeduct) {
        const fill = cond?.fill && cond.fill !== "none" && !isDeduct ? rgb(...hex(cond.fill)) : col;
        pg.drawSvgPath(svgPath(pts), { x: 0, y: 0, color: fill, opacity: (isDeduct ? 0.14 : 0.16) + alphaBoost / 2, borderColor: col, borderWidth: 1.1, borderOpacity: 0.95 });
        if (!isDeduct && cond?.hatch && cond.hatch !== "solid") {
          for (const [ax, ay, bx, by] of hatchLines(pts, cond.hatch)) line(ax, ay, bx, by, col, 0.5, 0.55 + alphaBoost);
        }
        chip(shapeChip(s, cond), ...centroid(pts), col);
      } else if (s.measure_role === "linear" || s.measure_role === "surface_area") {
        for (let i = 1; i < pts.length; i++) line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], col, 1.4, 0.95);
        const mid = pts[Math.floor((pts.length - 1) / 2)];
        chip(shapeChip(s, cond), mid[0], mid[1] - 14, col);
      } else if (s.measure_role === "count") {
        const [px, py] = toPage(pts[0][0], pts[0][1]);
        pg.drawEllipse({ x: px, y: py, xScale: 4.5, yScale: 4.5, borderColor: col, borderWidth: 1.2, color: col, opacity: 0.35 });
      }
    }
    for (const m of marksBy.get(sh.key) || []) {
      if (m.type === "cloud" && m.rect) {
        const [[nx0, ny0], [nx1, ny1]] = m.rect;
        // scalloped read approximated by a dashed border — arcs don't survive
        // arbitrary page transforms; the note text carries the meaning
        const r = [[nx0 * W, ny0 * H], [nx1 * W, ny0 * H], [nx1 * W, ny1 * H], [nx0 * W, ny1 * H]];
        pg.drawSvgPath(svgPath(r), { x: 0, y: 0, borderColor: cobalt, borderWidth: 1.3, borderOpacity: 0.95, borderDashArray: [4, 3] });
        if (m.text) text(m.text, Math.min(nx0, nx1) * W, Math.min(ny0, ny1) * H - 10 / ptScale, 8, cobalt, bold);
      } else if (m.type === "callout" && m.at) {
        if (m.target) line(m.target[0] * W, m.target[1] * H, m.at[0] * W, m.at[1] * H, cobalt, 0.9, 0.9);
        text(m.text || "", m.at[0] * W, m.at[1] * H, 8.5, cobalt, bold);
      } else if (m.type === "text" && m.at) {
        text(m.text || "", m.at[0] * W, m.at[1] * H, 8.5, cobalt, bold);
      }
    }
    // sheet stamp, top-left in visual space
    text(`${sh.label} · marked set`, 14, 20, 8, muted);
  }

  const bytes = await doc.save();
  const filename = `${(projectName || "OpenTakeoff").trim()} - marked set${dark ? " (dark)" : ""}.pdf`;
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
