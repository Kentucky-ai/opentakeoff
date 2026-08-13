// Condition appearance primitives — shared by the canvas (shape fills, the
// compact strip) and the TakeoffsPanel (row swatches, the hatch picker).
// TakeoffCanvas already imports TakeoffsPanel, so a TakeoffsPanel -> TakeoffCanvas
// import back would be a cycle; living here instead gives the shared SVG
// primitives a neutral home both files can import without one.

import React from "react";

// Architectural / flooring hatch templates. Each condition gets a line color, a
// fill color (or No Fill), and one hatch style — rendered as an SVG <pattern> so
// finishes read like a real drawing.
export const HATCHES = [
  { id: "solid", label: "Solid" },
  { id: "diag", label: "Diagonal" },
  { id: "diag2", label: "Diagonal reverse" },
  { id: "cross", label: "Crosshatch" },
  { id: "diagdense", label: "Diagonal dense" },
  { id: "horiz", label: "Horizontal" },
  { id: "vert", label: "Vertical" },
  { id: "grid", label: "Square / tile" },
  { id: "brick", label: "Brick / running bond" },
  { id: "plank", label: "Plank / wood" },
  { id: "herring", label: "Herringbone" },
  { id: "basket", label: "Basketweave" },
  { id: "checker", label: "Checker" },
  { id: "wave", label: "Wave / scallop" },
  { id: "dots", label: "Sand / dots" },
  { id: "speckle", label: "Terrazzo / speckle" },
  { id: "iso", label: "Isometric grid" },
  { id: "honeycomb", label: "Honeycomb" },
  { id: "scan", label: "Scanline" },
  { id: "plus", label: "Plus grid" },
  { id: "circuit", label: "Circuit / traces" },
  { id: "topo", label: "Contour / topo" },
  // ── flooring set (2026-08, ported from the Spline sibling): real installed
  // patterns an estimator recognizes on a finish plan. APPEND ONLY — hatch ids
  // are user data riding saved conditions.
  { id: "woodgrain", label: "Wood grain" },
  { id: "chevron", label: "Chevron" },
  { id: "pinwheel", label: "Pinwheel / hopscotch" },
  { id: "harlequin", label: "Harlequin / diamond" },
  { id: "hexagon", label: "Hex tile" },
  { id: "penny", label: "Penny round" },
  { id: "octagondot", label: "Octagon & dot" },
  { id: "fleur", label: "Fleur-de-lis" },
  { id: "concrete", label: "Concrete / stipple" },
];
export const PALETTE = ["#c96442", "#2f7d54", "#2563eb", "#9333ea", "#b8860b", "#0d9488", "#be185d", "#1f2937", "#dc2626", "#0891b2"];
export const NO_FILL = "none";

// SVG <pattern> for a condition (userSpaceOnUse → scales with the plan, CAD-style).
export function HatchPattern({ id, type, line, fill, dark }) {
  const sw = 1.1;
  // dark mode legibility comes from brighter alphas baked into the pattern —
  // never a CSS filter over the shape overlay (that re-rasterizes the whole
  // layer on every sync)
  const s = (d, w) => <path d={d} stroke={line} strokeWidth={w || sw} fill="none" />;
  const SW2 = 0.8;   // lighter weight for dual/dense patterns so none shouts
  const wrap = (kids, w = 10, h = 10) => (
    <pattern id={id} patternUnits="userSpaceOnUse" width={w} height={h}>
      {fill && fill !== NO_FILL ? <rect width={w} height={h} fill={fill} opacity={dark ? 0.32 : 0.18} /> : null}
      {kids}
    </pattern>
  );
  switch (type) {
    case "diag": return wrap(s("M0,10 L10,0 M-3,3 L3,-3 M7,13 L13,7"));
    case "diag2": return wrap(s("M0,0 L10,10 M-3,7 L3,13 M7,-3 L13,3"));
    case "cross": return wrap(<>{s("M0,10 L10,0 M-3,3 L3,-3 M7,13 L13,7")}{s("M0,0 L10,10 M-3,7 L3,13 M7,-3 L13,3")}</>);
    case "diagdense": return wrap(s("M0,5 L5,0 M0,10 L10,0 M5,10 L10,5 M-2.5,2.5 L2.5,-2.5 M7.5,12.5 L12.5,7.5"));
    case "horiz": return wrap(s("M0,3 L10,3 M0,7 L10,7"));
    case "vert": return wrap(s("M3,0 L3,10 M7,0 L7,10"));
    case "grid": return wrap(s("M0,3 L10,3 M0,7 L10,7 M3,0 L3,10 M7,0 L7,10"));
    case "brick": return wrap(<>{s("M0,3 L10,3 M0,7 L10,7")}{s("M5,0 L5,3 M0,3 L0,7 M10,3 L10,7 M5,7 L5,10")}</>);
    case "plank": return wrap(<>{s("M0,0 L10,0 M0,5 L10,5 M0,10 L10,10")}{s("M3,0 L3,5 M7,5 L7,10")}</>);
    case "herring": return wrap(<>{s("M0,5 L5,0 L10,5")}{s("M0,10 L5,5 L10,10")}</>);
    case "basket": return wrap(<>{s("M0,2 L5,2 M0,4 L5,4")}{s("M7,0 L7,5 M9,0 L9,5")}{s("M2,5 L2,10 M4,5 L4,10")}{s("M5,7 L10,7 M5,9 L10,9")}</>);
    case "checker": return wrap(<>{<rect x={0} y={0} width={5} height={5} fill={line} opacity={0.4} />}{<rect x={5} y={5} width={5} height={5} fill={line} opacity={0.4} />}</>);
    case "wave": return wrap(<>{s("M0,4 Q2.5,1 5,4 T10,4")}{s("M0,8 Q2.5,5 5,8 T10,8")}</>);
    case "dots": return wrap(<>{[2, 6].map((y) => [2, 6].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.1} fill={line} />))}</>);
    case "speckle": return wrap(<>{[[1.5, 2, 1.3], [6, 1.5, 0.8], [3.5, 5, 1], [8, 5.5, 1.4], [1.5, 8, 0.9], [6.5, 8.5, 1.2]].map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r} fill={line} />)}</>);
    // ── signal set (2026-07): trade-agnostic, engineering-read patterns ──
    case "iso": return wrap(s("M-1.73,9 L15.59,-1 M-1.73,-1 L15.59,9 M6.93,0 L6.93,8"), 13.86, 8);
    case "honeycomb": {
      // Flat-top hex lattice, side 4: tile 12 × 4√3. Center hex + the four
      // corner hexes (clipped quarters) keep the lattice seamless.
      const H = 6.9282, hx = (cx, cy) =>
        s(`M${cx - 4},${cy} L${cx - 2},${cy - 3.4641} L${cx + 2},${cy - 3.4641} L${cx + 4},${cy} L${cx + 2},${cy + 3.4641} L${cx - 2},${cy + 3.4641} Z`);
      return wrap(<>{hx(0, 0)}{hx(12, 0)}{hx(0, H)}{hx(12, H)}{hx(6, H / 2)}</>, 12, H);
    }
    case "scan": return wrap(s("M0,2 L10,2 M8,6 L16,6 M0,6 L2,6"), 16, 8);
    case "plus": return wrap(s("M6,3.5 L6,8.5 M3.5,6 L8.5,6 M0,0 L0,2.5 M0,9.5 L0,12 M12,0 L12,2.5 M12,9.5 L12,12 M0,0 L2.5,0 M9.5,0 L12,0 M0,12 L2.5,12 M9.5,12 L12,12"), 12, 12);
    case "circuit": return wrap(<>
      {s("M2,2 L10,2 L10,10")}{s("M14,18 L14,13 L18,13")}
      {[[2, 2], [10, 10], [14, 18], [18, 13]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r={1.2} fill={line} />)}
    </>, 20, 20);
    case "topo": return wrap(<>
      <ellipse cx={12} cy={12} rx={8} ry={5} fill="none" stroke={line} strokeWidth={sw} transform="rotate(-18 12 12)" />
      <ellipse cx={12} cy={12} rx={4.6} ry={2.6} fill="none" stroke={line} strokeWidth={sw} transform="rotate(-18 12 12)" />
    </>, 24, 24);
    // ── flooring set (2026-08, ported from the Spline sibling) ──
    case "chevron": return wrap(s("M0,6 L4,2 L8,6 L12,2 L16,6"), 16, 8);
    case "hexagon": {
      // Flat-top hex, side 5 (larger read than honeycomb's side 4): tile 15 × 5√3.
      const H = 8.6603, hx = (cx, cy) =>
        s(`M${cx - 5},${cy} L${cx - 2.5},${cy - 4.3301} L${cx + 2.5},${cy - 4.3301} L${cx + 5},${cy} L${cx + 2.5},${cy + 4.3301} L${cx - 2.5},${cy + 4.3301} Z`, SW2);
      return wrap(<>{hx(0, 0)}{hx(15, 0)}{hx(0, H)}{hx(15, H)}{hx(7.5, H / 2)}</>, 15, H);
    }
    case "penny": return wrap(<>{[[3.5, 3], [10.5, 3], [0, 9], [7, 9], [14, 9]].map(([x, y], i) =>
      <circle key={i} cx={x} cy={y} r={3.2} fill="none" stroke={line} strokeWidth={SW2} />)}</>, 14, 12);
    case "octagondot": return wrap(<>
      {s("M4.5,0 L9.5,0 L14,4.5 L14,9.5 L9.5,14 L4.5,14 L0,9.5 L0,4.5 Z", SW2)}
      {[[0, 0], [14, 0], [0, 14], [14, 14]].map(([x, y], i) =>
        <path key={i} d={`M${x},${y - 1.8} L${x + 1.8},${y} L${x},${y + 1.8} L${x - 1.8},${y} Z`} fill={line} stroke="none" />)}
    </>, 14, 14);
    case "pinwheel": return wrap(s("M0,0 L16,0 M0,0 L0,16 M0,6 L10,6 M6,10 L16,10 M10,0 L10,10 M6,6 L6,16", SW2), 16, 16);
    case "harlequin": return wrap(s("M5,0 L10,8 L5,16 L0,8 Z"), 10, 16);
    case "woodgrain": return wrap(<>
      {s("M0,4 C6,7 18,1 24,4", SW2)}{s("M0,9 C6,6.5 18,11.5 24,9", SW2)}{s("M0,14 C6,17 18,11 24,14", SW2)}
      <ellipse cx={12} cy={9} rx={2.2} ry={1.2} fill="none" stroke={line} strokeWidth={SW2} />
    </>, 24, 18);
    case "concrete": return wrap(<>
      {[[3, 4], [9, 2], [15, 6], [6, 10], [17, 13], [11, 16], [2, 15]].map(([x, y], i) =>
        <circle key={i} cx={x} cy={y} r={0.9} fill={line} />)}
      {s("M12,6.8 L13.6,9.4 L10.4,9.4 Z", SW2)}{s("M4,16.8 L5.7,19.4 L2.3,19.4 Z", SW2)}
    </>, 20, 20);
    case "fleur": return wrap(
      <g fill={line} stroke="none">
        <path d="M8 2.2 C6.7 4 6.7 6.2 8 8.2 C9.3 6.2 9.3 4 8 2.2 Z" />
        <path d="M4.6 4.8 C3 5.9 2.9 8.2 4.9 8.7 C4.6 7.4 4.7 6 4.6 4.8 Z" />
        <path d="M11.4 4.8 C13 5.9 13.1 8.2 11.1 8.7 C11.4 7.4 11.3 6 11.4 4.8 Z" />
        <rect x="5.4" y="9.3" width="5.2" height="1.2" />
        <path d="M8 10.9 C7.1 11.9 7.1 12.9 8 13.8 C8.9 12.9 8.9 11.9 8 10.9 Z" />
      </g>, 16, 16);
    default: return wrap(null);  // solid: only the fill bg
  }
}

// Preview swatch — renders the ACTUAL pattern so the picker always matches the draw.
export function HatchSwatch({ type, line, fill }) {
  const fc = fill && fill !== NO_FILL ? fill : null;
  const pid = `sw-${type}-${String(line).replace("#", "")}-${String(fill).replace("#", "")}`;
  return (
    <svg width="26" height="18" style={{ display: "block", overflow: "hidden" }}>
      {type !== "solid" && <defs><HatchPattern id={pid} type={type} line={line} fill={fill} /></defs>}
      <rect x="0.5" y="0.5" width="25" height="17" stroke="#a39e8d"
        fill={type === "solid" ? (fc || "#fff") : `url(#${pid})`}
        fillOpacity={type === "solid" ? (fc ? 0.45 : 1) : 1} />
    </svg>
  );
}
