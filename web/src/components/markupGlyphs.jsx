// One markup's SVG ink — the render for every markup family (cloud, callout,
// text note, dimension, arrow, highlight, bubble, image capture, vector stamp)
// in ONE panel's local px frame. Shared byte-for-byte between the primary
// canvas's INTERACTIVE markup layer (TakeoffCanvas.jsx, where selection halos
// and click hit-testing live beside this) and the reference pane's READ-ONLY
// mirror (ReferencePane.jsx) — the same discipline shapeGlyphs.jsx applies to
// measurement shapes: one implementation, two callers, no drift. Everything
// here is a pure function of (markup, panel geometry, zoom, theme), so the
// mirror is live by construction: it re-renders from the same `markups` array
// the primary committed to, and a deletion disappears in both panes.
//
// Callers own the FRAME: the primary wraps each panel's group in
// `translate(xOffset,0)` inside one stage-wide <svg>, the reference pane draws
// each sheet in its own <svg> at that sheet's panel <img> dims. So `img` here
// carries only the panel's image px dims (`{w,h}`), never xOffset.
//
// `selected` is the caller's selection truth: the primary passes
// `m.id === selectedMarkupId`; the reference pane passes `false` for every
// markup, which is what makes the mirror read-only — no halo, and no handle
// geometry is ever produced on that path. `premiumInk` is the caller's
// AnnotationWorkbench renderer (the `annotation_style` family), invoked as
// `(markup, panel, zoom)` and returning a node or null: the primary passes the
// workbench's own `render` (so its multi-select halos keep working), the
// reference pane passes `readOnlyPremiumInk` below, which can never select.
import { resolveMarkup, FIELD_WARN_INK, FIELD_WARN_INK_DARK } from "../lib/noteFields.ts";
import { cloudPath, strokePathD, chiselRibbon, arrowheadPath } from "../lib/geometry.js";
import { NOTE_PT, LABEL_PT, NOTE_FONT_FAMILY, inkPx, layoutNote, noteBox, lineBaseline, canvasMeasure } from "../lib/markupText.js";
import { dashArrayFor, boostForDark, clampWeight } from "../lib/lineStyles.js";
import { imagePlacedBox, pickEmbedFormat, sourceCaption } from "../lib/markupImage.ts";
import { transformPath, svgPlacedBox } from "../lib/svgpath.js";
import { isStitchKey } from "../lib/stitches.ts";
import { parseSheetKey } from "../lib/sheets.ts";
import { dimLabel } from "../lib/units.ts";
import { AnnotationInk, premiumSupported } from "./AnnotationWorkbench.jsx";

// The reference pane's premium ink: same <AnnotationInk> scene the primary
// draws, with `selected` pinned false so a mirror can never mint the workbench's
// selection handles. Stroke floors follow the MIRROR pane's own zoom, so premium
// ink stays a constant screen weight under this pane's independent transform.
export const readOnlyPremiumInk = (m, panel, z) =>
  m.annotation_style && premiumSupported(m) ? <AnnotationInk markup={m} panel={panel} zoom={z} /> : null;

export function renderMarkupGlyph(m0, { img, z, darkMode, condById, rfis, selected, noteQtyLabels, sheetBaseLabel, premiumInk }) {
  // fields resolve before anything reads the text, Premium ink included;
  // an unresolved field leaves the literal in place and tints the note
  const { m, unresolved: mUnres } = resolveMarkup(m0, noteQtyLabels);
  const premium = premiumInk(m, { img }, z);
  if (premium) {
    const at = m.at || m.from || m.rect?.[0] || m.pts?.[0] || m.quads?.[0]?.[0];
    const linked = rfis.find((r) => r.id === m.rfi_id);
    return <g key={m.id}>{premium}{m.rfi_id && at && <text x={at[0] * img.w} y={at[1] * img.h - 14 / z} fill="#1f3fc7" fontSize={12 / z} fontWeight="700">RFI {linked?.number || ''}</text>}</g>;
  }
  // Colour precedence: an explicit per-markup colour always wins (the user
  // picked it), then the LINKED CONDITION's colour so an annotation reads as
  // part of that scope at a glance, then RFI blue, then the unattached default.
  const mCond = m.condition_id ? condById[m.condition_id] : null;
  const base = m.color || mCond?.color || (m.rfi_id ? "#1f3fc7" : "#c47a10");
  const mk = darkMode ? boostForDark(base) : base;   // literal — SVG attrs don't resolve CSS vars
  // a note quoting a field that can't resolve reads in the danger ink;
  // note blocks sit on a white backing in both themes, labels on the sheet
  const labelInk = mUnres.length ? (darkMode ? FIELD_WARN_INK_DARK : FIELD_WARN_INK) : mk;
  const noteInk = mUnres.length ? FIELD_WARN_INK : "#0e1a2e";
  const dash = dashArrayFor(m.line_style || "solid", z);
  const w = clampWeight(m.weight);   // stroke-width multiplier over each element's base, default ×1
  const selM = !!selected;
  // linkage badge — unconditional for any linked markup (a note-less recolored
  // cloud still reads as linked); kept in cobalt for legibility regardless of
  // the user's color, pinned clear of the halo.
  const linked = m.rfi_id ? rfis.find((r) => r.id === m.rfi_id) : null;
  const badgeCol = darkMode ? boostForDark("#1f3fc7") : "#1f3fc7";
  const badge = (bx, by) => (m.rfi_id ? (
    <text x={bx} y={by} fill={badgeCol} fontSize={12 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{"⬢"}{linked && linked.number != null && linked.number !== "" ? " " + linked.number : ""}</text>
  ) : null);
  // revision-delta △n — a small numbered triangle at a cloud corner, clear of
  // the halo, the top-left RFI badge, and the centered note. Absent/zero m.rev
  // → nothing (legacy clouds render unchanged). The triangle backing is ALWAYS
  // white, so stroke/number it in the UN-boosted color (mk's dark boost is
  // tuned to contrast the dark canvas, and would wash out on white).
  const revTri = (rx, ry) => (Number.isFinite(m.rev) && m.rev > 0 ? (
    <g style={{ pointerEvents: "none" }}>
      <path d={`M${rx},${ry - 9 / z} L${rx + 8 / z},${ry + 6 / z} L${rx - 8 / z},${ry + 6 / z} Z`} fill="#fff" stroke={base} strokeWidth={1.4 / z} />
      <text x={rx} y={ry + 2.5 / z} fill={base} fontSize={9 / z} fontWeight="700" textAnchor="middle" dominantBaseline="central">{m.rev}</text>
    </g>
  ) : null);
  // halo ring widths scale with weight so a heavy stroke never overruns them
  const halo = (x0, y0, x1, y1) => (selM ? (
    <>
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="none" stroke="#fff" strokeWidth={(5 * w) / z} />
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="none" stroke="#1f3fc7" strokeWidth={(2 * w) / z} />
    </>
  ) : null);
  if (m.type === "highlight" && Array.isArray(m.pts)) {
    // freehand highlighter stroke — the ink keeps its OWN hue (a highlight IS
    // its color; dark legibility comes from the higher opacity, not a boost).
    // Weight (×) multiplies the stored width like every markup.
    const ip = m.pts.map(([nx, ny]) => [nx * img.w, ny * img.h]);
    if (ip.length < 2) return null;
    const sw = (m.w || 0.01) * img.w * w, o = darkMode ? 0.42 : 0.32;
    const ink = m.tip === "chisel"
      ? <path d={"M" + chiselRibbon(ip, sw, 45).map((q) => q.join(",")).join(" L") + " Z"} fill={m.color || "#ffd60a"} fillOpacity={o} />
      : <path d={strokePathD(ip)} fill="none" stroke={m.color || "#ffd60a"} strokeOpacity={o} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
    return (
      <g key={m.id}>
        {/* selection halo follows the stroke's spine (white outer + cobalt
            inner, the selected-markup convention adapted to an open path) */}
        {selM && (
          <>
            <path d={strokePathD(ip)} fill="none" stroke="#fff" strokeWidth={sw + 8 / z} strokeLinecap="round" strokeLinejoin="round" />
            <path d={strokePathD(ip)} fill="none" stroke="#1f3fc7" strokeOpacity={0.55} strokeWidth={sw + 4 / z} strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {ink}
        {badge(ip[0][0], ip[0][1] - 9 / z)}
      </g>
    );
  }
  if (m.type === "highlight") {
    const [c0, c1] = m.rect;
    const hx0 = Math.min(c0[0], c1[0]) * img.w, hy0 = Math.min(c0[1], c1[1]) * img.h;
    const hx1 = Math.max(c0[0], c1[0]) * img.w, hy1 = Math.max(c0[1], c1[1]) * img.h;
    const pad = (5 * w) / z;
    return (
      <g key={m.id}>
        {halo(hx0 - pad, hy0 - pad, hx1 + pad, hy1 + pad)}
        <rect x={hx0} y={hy0} width={hx1 - hx0} height={hy1 - hy0} fill={mk} fillOpacity={0.18} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
        {m.text && <text x={(hx0 + hx1) / 2} y={(hy0 + hy1) / 2} fill={labelInk} fontSize={inkPx(LABEL_PT, z)} fontWeight="700" fontFamily={NOTE_FONT_FAMILY} textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
        {badge(hx0, hy0 - pad - 9 / z)}
      </g>
    );
  }
  if (m.type === "cloud") {
    const [c0, c1] = m.rect;
    const pad = (5 * w) / z;
    const bx0 = Math.min(c0[0], c1[0]) * img.w - pad, by0 = Math.min(c0[1], c1[1]) * img.h - pad;
    const bx1 = Math.max(c0[0], c1[0]) * img.w + pad, by1 = Math.max(c0[1], c1[1]) * img.h + pad;
    return (
      <g key={m.id}>
        {halo(bx0, by0, bx1, by1)}
        <path d={cloudPath(c0[0] * img.w, c0[1] * img.h, c1[0] * img.w, c1[1] * img.h)} fill="none" stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
        {m.text && <text x={(c0[0] + c1[0]) / 2 * img.w} y={(c0[1] + c1[1]) / 2 * img.h} fill={labelInk} fontSize={inkPx(LABEL_PT, z)} fontWeight="700" fontFamily={NOTE_FONT_FAMILY} textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
        {badge(bx0, by0 - 9 / z)}
        {revTri(bx1, by0 - 9 / z)}
      </g>
    );
  }
  if (m.type === "callout") {
    // the note is INK: page-point size (× zoom on screen, floored for
    // legibility), wrapped at three inches into a block anchored at
    // baseline-left — the same layout the Marked Set burns and hitMarkup tests
    const [tx, ty] = m.target, [ax, ay] = m.at;
    const AX = ax * img.w, AY = ay * img.h;
    const fs = inkPx(NOTE_PT, z);
    const L = layoutNote({ text: m.text, fontPx: fs, measure: canvasMeasure(fs) });
    const b = noteBox(AX, AY, L);
    return (
      <g key={m.id}>
        {halo(b.x0 - 2 / z, b.y0 - 2 / z, b.x1 + 2 / z, b.y1 + 2 / z)}
        <line x1={tx * img.w} y1={ty * img.h} x2={AX} y2={AY} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
        {/* arrowhead at the target end — replaces the old vertex star */}
        <path d={arrowheadPath(AX, AY, tx * img.w, ty * img.h, 9 / z)} fill={mk} />
        {L.lines.length > 0 && <rect x={b.x0} y={b.y0} width={L.w} height={L.h} fill="rgba(255,255,255,.92)" stroke={mk} strokeWidth={(1 * w) / z} strokeDasharray={dash} />}
        {L.lines.length > 0 && (
          <text fill={noteInk} fontSize={fs} fontWeight="600" fontFamily={NOTE_FONT_FAMILY} style={{ pointerEvents: "none" }}>
            {L.lines.map((ln, i) => <tspan key={i} x={AX} y={lineBaseline(AY, L, i)}>{ln || "\u00a0"}</tspan>)}
          </text>
        )}
        {badge(AX, b.y0 - 8 / z)}
      </g>
    );
  }
  if (m.type === "arrow") {
    const [fx, fy] = [m.from[0] * img.w, m.from[1] * img.h];
    const [tx, ty] = [m.to[0] * img.w, m.to[1] * img.h];
    const midx = (fx + tx) / 2, midy = (fy + ty) / 2;
    const hx0 = Math.min(fx, tx), hy0 = Math.min(fy, ty), hx1 = Math.max(fx, tx), hy1 = Math.max(fy, ty);
    const pad = (6 * w) / z;
    return (
      <g key={m.id}>
        {halo(hx0 - pad, hy0 - pad, hx1 + pad, hy1 + pad)}
        <line x1={fx} y1={fy} x2={tx} y2={ty} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} strokeLinecap="round" />
        {/* filled arrowhead at the `to` end */}
        <path d={arrowheadPath(fx, fy, tx, ty, 11 / z)} fill={mk} />
        {m.text && <text x={midx} y={midy - inkPx(LABEL_PT, z) * 0.6} fill={labelInk} fontSize={inkPx(LABEL_PT, z)} fontWeight="700" fontFamily={NOTE_FONT_FAMILY} textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
        {badge(hx0, hy0 - pad - 9 / z)}
      </g>
    );
  }
  if (m.type === "dimension" && m.from && m.to) {
    // a dimension line: perpendicular ticks at both ends and the measured
    // length (m.len_ft, snapshotted at annotate time from the sheet scale)
    // centered beside the line — a note ABOUT a distance, never a takeoff
    // quantity
    const [fx, fy] = [m.from[0] * img.w, m.from[1] * img.h];
    const [tx, ty] = [m.to[0] * img.w, m.to[1] * img.h];
    const dl = Math.hypot(tx - fx, ty - fy) || 1;
    const dnx = -(ty - fy) / dl, dny = (tx - fx) / dl;   // unit normal
    const tick = 7 / z;
    const dimText = [Number(m.len_ft) > 0 ? dimLabel(m.len_ft) : "", m.text].filter(Boolean).join(" · ");
    const hx0 = Math.min(fx, tx), hy0 = Math.min(fy, ty), hx1 = Math.max(fx, tx), hy1 = Math.max(fy, ty);
    const pad = (6 * w) / z;
    return (
      <g key={m.id}>
        {halo(hx0 - pad, hy0 - pad, hx1 + pad, hy1 + pad)}
        <line x1={fx} y1={fy} x2={tx} y2={ty} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
        <line x1={fx - dnx * tick} y1={fy - dny * tick} x2={fx + dnx * tick} y2={fy + dny * tick} stroke={mk} strokeWidth={(2 * w) / z} />
        <line x1={tx - dnx * tick} y1={ty - dny * tick} x2={tx + dnx * tick} y2={ty + dny * tick} stroke={mk} strokeWidth={(2 * w) / z} />
        {dimText && <text x={(fx + tx) / 2 + dnx * (inkPx(LABEL_PT, z) * 0.9)} y={(fy + ty) / 2 + dny * (inkPx(LABEL_PT, z) * 0.9)} fill={labelInk} fontSize={inkPx(LABEL_PT, z)} fontWeight="700" fontFamily={NOTE_FONT_FAMILY} textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{dimText}</text>}
        {badge(hx0, hy0 - pad - 9 / z)}
      </g>
    );
  }
  if (m.type === "bubble") {
    const cx = m.at[0] * img.w, cy = m.at[1] * img.h;
    const rad = (Number(m.r) > 0 ? Number(m.r) : 0.02) * img.w;
    const pad = (5 * w) / z;
    return (
      <g key={m.id}>
        {halo(cx - rad - pad, cy - rad - pad, cx + rad + pad, cy + rad + pad)}
        <circle cx={cx} cy={cy} r={rad} fill={darkMode ? "rgba(12,15,20,.85)" : "rgba(255,255,255,.85)"} stroke={mk} strokeWidth={(2 * w) / z} strokeDasharray={dash} />
        {m.text && <text x={cx} y={cy} fill={labelInk} fontSize={Math.min(13, rad * z * 0.9) / z} fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>{m.text}</text>}
        {badge(cx + rad, cy - rad - 4 / z)}
      </g>
    );
  }
  if (m.type === "image") {
    // a raster image markup (screenshot capture or upload). Width-anchored
    // like svg but off `m.w` alone (imagePlacedBox), rendered as-is (no
    // dark-mode invert — a screenshot is captured from the light PDF).
    // Self-contained: a guard-fail returns null, never falling through to
    // the text renderer below (which would paint a phantom note box).
    const { bw, bh } = imagePlacedBox(m.w, m.aspect, img.w);
    // only a PNG/JPEG DATA url renders (matches the marked-set export
    // invariant) — an imported record with an http(s):// src must never make
    // <image href> fetch remote content.
    if (!(m.src && pickEmbedFormat(m.src) && Array.isArray(m.at) && bw > 0 && bh > 0)) return null;
    const x0 = m.at[0] * img.w - bw / 2, y0 = m.at[1] * img.h - bh / 2;
    // Source caption (captures only) — the origin sheet NAME, read from the
    // frozen src_label (resolved at capture time; the marked-set PDF reads the
    // SAME stored string, so screen and PDF can't diverge). Legacy captures
    // without src_label fall back to the live sheet label. A stitch origin has
    // no page number, so drop the "· p.N" for it. "" (upload or no
    // src_sheet_id) ⇒ render nothing.
    const capText = m.source === "capture" && m.source_label && m.src_sheet_id
      ? sourceCaption(m.src_label ?? sheetBaseLabel(m.src_sheet_id), isStitchKey(m.src_sheet_id) ? 0 : parseSheetKey(m.src_sheet_id).page)
      : "";
    return (
      <g key={m.id}>
        {halo(x0, y0, x0 + bw, y0 + bh)}
        <image href={m.src} x={x0} y={y0} width={bw} height={bh} preserveAspectRatio="none" style={{ pointerEvents: "none" }} />
        {/* PERMANENT frame — a placed screenshot overlays its own source and is
            invisible without it; the halo is selection-only. White + slate double
            stroke reads on both canvas themes (the image itself is never inverted). */}
        <rect x={x0} y={y0} width={bw} height={bh} fill="none" stroke="#fff" strokeWidth={2.5 / z} style={{ pointerEvents: "none" }} />
        <rect x={x0} y={y0} width={bw} height={bh} fill="none" stroke="#2a3550" strokeWidth={1 / z} style={{ pointerEvents: "none" }} />
        {selM && <rect x={x0 + bw - 4 / z} y={y0 + bh - 4 / z} width={8 / z} height={8 / z} fill="#1f3fc7" stroke="#fff" strokeWidth={1.5 / z} style={{ pointerEvents: "none" }} />}
        {capText && (() => {
          // Frame-hugging chip on the TOP edge, centered on the box width so it
          // never collides with the top-LEFT link badge (badge(x0, y0-9/z) is
          // centered ON x0). Explicit light fill + dark ink — NOT theme tokens
          // (the image render never dark-mode-inverts, so a chip that flipped
          // with the app theme would read backwards against it). Fixed screen
          // size (every dimension /z): on a very small capture it can overrun
          // the frame width, which is fine — it stays on the top edge, clear of
          // the bottom-right resize handle.
          const capCx = x0 + bw / 2, capCy = y0 - 9 / z;
          const capH = 15 / z, capW = (capText.length * 5.6 + 14) / z;
          return (
            <g style={{ pointerEvents: "none" }}>
              <rect x={capCx - capW / 2} y={capCy - capH / 2} width={capW} height={capH} rx={3 / z}
                fill="rgba(255,247,237,.95)" stroke="#0e1a2e" strokeWidth={1 / z} />
              <text x={capCx} y={capCy} fill="#0e1a2e" fontSize={10 / z} fontWeight="600" textAnchor="middle" dominantBaseline="central">{capText}</text>
            </g>
          );
        })()}
        {badge(x0, y0 - 9 / z)}
      </g>
    );
  }
  if (m.type === "svg" && m.path && Array.isArray(m.vb)) {
    // a vector symbol (imported .svg or saved-as-stamp art). The path is baked
    // local→image px through a uniform scale off the LONGER viewBox extent so
    // it never distorts and a one-axis symbol can't blow up; stroke/fill are
    // the symbol's OWN color (dark-boosted), not the linkage tint.
    const { s: sx, bw, bh } = svgPlacedBox(m.vb, m.w, img.w);
    if (!(sx > 0)) return null;
    const x0 = m.at[0] * img.w - bw / 2, y0 = m.at[1] * img.h - bh / 2;
    const d = transformPath(m.path, (lx, ly) => [x0 + lx * sx, y0 + ly * sx]);
    const fillOn = m.fill && m.fill !== "none";
    const fcol = fillOn ? (darkMode ? boostForDark(m.fill) : m.fill) : "none";
    return (
      <g key={m.id}>
        {halo(x0, y0, x0 + bw, y0 + bh)}
        <path d={d} fill={fcol} fillOpacity={fillOn ? 0.9 : undefined} stroke={mk} strokeWidth={(1.6 * w) / z} strokeLinejoin="round" style={{ pointerEvents: "none" }} />
        {badge(x0, y0 - 9 / z)}
      </g>
    );
  }
  // a text note — ink on the sheet, laid out exactly like a callout's block
  const [x, y] = m.at;
  const AX = x * img.w, AY = y * img.h;
  const fs = inkPx(NOTE_PT, z);
  const L = layoutNote({ text: m.text, fontPx: fs, measure: canvasMeasure(fs) });
  const b = noteBox(AX, AY, L);
  return (
    <g key={m.id}>
      {halo(b.x0 - 2 / z, b.y0 - 2 / z, b.x1 + 2 / z, b.y1 + 2 / z)}
      {L.lines.length > 0 && <rect x={b.x0} y={b.y0} width={L.w} height={L.h} fill="rgba(255,247,237,.92)" stroke={mk} strokeWidth={(1 * w) / z} strokeDasharray={dash} />}
      {L.lines.length > 0 && (
        <text fill={noteInk} fontSize={fs} fontWeight="600" fontFamily={NOTE_FONT_FAMILY} style={{ pointerEvents: "none" }}>
          {L.lines.map((ln, i) => <tspan key={i} x={AX} y={lineBaseline(AY, L, i)}>{ln || "\u00a0"}</tspan>)}
        </text>
      )}
      {badge(AX, b.y0 - 8 / z)}
    </g>
  );
}
