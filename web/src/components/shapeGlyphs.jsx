// One committed shape's SVG glyph — the fill/stroke logic shared by the
// primary canvas's INTERACTIVE overlay (TakeoffCanvas.jsx, selection +
// vertex handles live beside this) and the reference pane's READ-ONLY
// mirror (ReferencePane.jsx, no selection ever reaches here). Extracted so
// the two renders share one implementation and can't drift: a bug fixed in
// one pane is fixed in both, and a future measure_role can't land in only
// one of them by accident.
//
// Pattern ids: callers pass their OWN `patId(cond)` (already darkMode-baked
// and, for the reference pane, "ref-"-prefixed) — this module never mints an
// id itself, so the two panes' <defs> never collide.
import { flattenCurve } from "../lib/curve.js";
import { dashArrayFor } from "../lib/lineStyles.js";
import { NO_FILL } from "./hatches.jsx";

// Fill for a committed shape. Hatch tiles are 10 stage-units — once the zoom
// puts a tile under ~4 screen px the pattern aliases into subpixel mush
// (worst over the inverted dark sheet), so overview zoom swaps to a solid
// tint and every condition still reads as a clear color block. Dark mode
// gets its legibility from brighter alphas here, NOT a CSS filter over the
// whole overlay (that would re-rasterize it on every sync).
export function shapeFill(cond, { scale, darkMode, patId }) {
  if (!cond) return "none";
  const solid = cond.fill && cond.fill !== NO_FILL ? cond.fill : null;
  if (scale < 0.35) return (solid || cond.color) + (darkMode ? "59" : "40");
  if (cond.hatch && cond.hatch !== "solid") return `url(#${patId(cond)})`;
  return solid ? solid + (darkMode ? "4d" : "33") : "none";
}

// `dn` is the caller's per-panel normalized→pixel mapper ([x,y] in 0..1 →
// image px), so this stays agnostic to which panel/sheet frame it's drawing
// into. `sel` is always false from the reference pane (it has no selection);
// `selection` (DS.selection's {color,width}) is only ever read when `sel` is
// true, so the reference pane can omit it.
export function renderShapeGlyph(s, { dn, cond, sel, z, darkMode, selection = {}, patId }) {
  const pts = dn(s.verts_norm);
  const col = cond?.color || "#888";
  const sw = (sel ? selection.width : 2) / z;
  // Committed-but-unreviewed machine shapes (an imported MCP takeoff) render
  // dashed pencil — same invariant as the ephemeral agent proposals, until
  // Accept flips reviewed.
  const pending = s.origin?.reviewed === false;
  const pDash = `${4 / z} ${3 / z}`;
  const fill = (c) => shapeFill(c, { scale: z, darkMode, patId });

  if (s.measure_role === "count") {
    const [cx, cy] = pts[0], r = 7 / z;
    return <rect key={s.id} x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={2 / z} fill={col + (pending ? "55" : "cc")} stroke={sel ? selection.color : "#fff"} strokeWidth={(sel ? 3 : 1.5) / z} strokeDasharray={pending ? `${3 / z} ${2.5 / z}` : undefined} />;
  }
  if (s.measure_role === "surface_area") {
    return <polyline key={s.id} points={pts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? selection.color : col} strokeOpacity={pending ? 0.85 : undefined} strokeWidth={(sel ? 4.5 : 3.5) / z} strokeDasharray={pending ? pDash : `${10 / z} ${3 / z} ${2 / z} ${3 / z}`} strokeLinecap="round" strokeLinejoin="round" />;
  }
  if (s.measure_role === "linear") {
    // line_style governs linear outlines (surface_area keeps its dash-dot identity above)
    const lpts = s.curved ? flattenCurve(pts) : pts;
    return <polyline key={s.id} points={lpts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? selection.color : col} strokeOpacity={pending ? 0.85 : undefined} strokeWidth={(sel ? 4 : 3) / z} strokeDasharray={pending ? pDash : dashArrayFor(cond?.line_style || "solid", z)} strokeLinecap="round" strokeLinejoin="round" />;
  }
  const ded = s.measure_role === "deduct";
  // #137 — a RECONCILED deduct (cuts_shape_id) renders as a dashed outline
  // only: its geometry is already excised from its parent's fill below
  // (fill-rule evenodd), so a solid overlay here would reintroduce the exact
  // "decal on top" bug the real subtract fixes.
  if (ded && s.cuts_shape_id) {
    return <polygon key={s.id} points={pts.map((q) => q.join(",")).join(" ")} fill="none" stroke={sel ? selection.color : "#b03a26"} strokeWidth={(sel ? 3 : 1.5) / z} strokeDasharray={`${5 / z} ${3 / z}`} />;
  }
  // #137 — a parent carrying real hole ring(s): ONE compound path, outer ring
  // + every hole ring, fill-rule evenodd so the hole is an actual excision
  // from the fill rather than a shape sitting on top of it.
  if (!ded && s.verts_norm_holes?.length) {
    const ringD = (ring) => `M${dn(ring).map((q) => q.join(",")).join("L")}Z`;
    const d = ringD(s.verts_norm) + s.verts_norm_holes.map(ringD).join("");
    return <path key={s.id} d={d} fillRule="evenodd" fill={pending ? col + "14" : fill(cond)} stroke={sel ? selection.color : col} strokeOpacity={pending ? 0.9 : undefined} strokeWidth={sw} strokeDasharray={pending ? pDash : dashArrayFor(cond?.line_style || "solid", z)} />;
  }
  // deduct keeps its danger-red dashing (a safety signal, wins over line_style); positive floor_area follows the condition's line_style
  return <polygon key={s.id} points={pts.map((q) => q.join(",")).join(" ")}
    fill={ded ? (pending ? "rgba(176,58,38,.10)" : "rgba(176,58,38,.28)") : pending ? col + "14" : fill(cond)}
    stroke={ded ? "#b03a26" : (sel ? selection.color : col)} strokeOpacity={pending ? 0.9 : undefined} strokeWidth={sw}
    strokeDasharray={pending ? pDash : ded ? `${6 / z} ${4 / z}` : dashArrayFor(cond?.line_style || "solid", z)} />;
}
