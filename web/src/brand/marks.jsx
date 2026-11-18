// OpenTakeoff brand marks: the OT-01 identity shared with OpenTakeoff Premium — the scanline
// OT mark (a plan-view silhouette cut by horizontal scan rows), the "OpenTakeoff" wordmark in
// Inter Tight, and the scan star (the agent's mark). Colours come from tokens: --mark follows
// the theme (patch cyan on dark, a deeper cyan on paper).
import { useId } from "react";
import { scanStarRows } from "../lib/scanStar.js";

// The OT mark's six facets, drawn in a 1300 x 600 space (the same drawing as public/favicon.svg).
const OT_FACETS = [
  "M338 112 540 28V130L338 192Z", "M540 28 748 110V192L540 130Z",
  "M108 345 528 185V540H330V355L108 398Z", "M552 185 978 340V392L758 350V540H552Z",
  "M38 455 292 420V545H38Z", "M790 418 1165 470V545H790Z",
];

// `size` is the mark's height (it is about 2.16x as wide). The scan rows are a 10-unit pitch
// with 64% ink, cut through the facets by a mask so the mark reads as a scanned plan.
export function OtMark({ size = 20, color = "var(--mark, var(--cobalt))", title, style }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": "true" };
  return (
    <svg height={size} width={Math.round(size * 2.16)} viewBox="30 20 1145 530" focusable="false"
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }} {...a11y}>
      <defs>
        <pattern id={`ot-rows-${uid}`} width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="6.4" fill="#fff" /></pattern>
        <mask id={`ot-cut-${uid}`} maskUnits="userSpaceOnUse" x="0" y="0" width="1300" height="600"><rect width="1300" height="600" fill={`url(#ot-rows-${uid})`} /></mask>
      </defs>
      <g fill={color} mask={`url(#ot-cut-${uid})`}>{OT_FACETS.map((d) => <path key={d} d={d} />)}</g>
    </svg>
  );
}

// "OpenTakeoff" set in the body face, semibold, tight — the product name everywhere in the chrome.
export function OtWordmark({ size = 15, color = "var(--ink)", style }) {
  return (
    <span style={{ fontFamily: "var(--f-body)", fontWeight: 600, fontSize: size, lineHeight: 1, letterSpacing: "-0.01em",
      color, whiteSpace: "nowrap", ...style }}>OpenTakeoff</span>
  );
}

// Mark + wordmark, the header lockup. `working` swaps nothing in; the agent's state shows on the scan star.
export function OtLockup({ size = 15, style }) {
  return (
    <span className="ot-lockup" style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.5), ...style }}>
      <OtMark size={Math.round(size * 0.95)} />
      <OtWordmark size={size} />
    </span>
  );
}

export function Wordmark({ size = 96, color = "var(--ink)", weight = 800, letterSpacing = "-0.03em" }) {
  return (
    <span
      style={{
        fontFamily: "var(--f-display)",
        fontWeight: weight,
        fontSize: size,
        lineHeight: 0.9,
        letterSpacing,
        color,
        display: "inline-flex",
        alignItems: "baseline",
        gap: "0.12em",
        fontOpticalSizing: "auto",
      }}
    >
      open<span style={{ fontStyle: "italic", color: "var(--cobalt)" }}>takeoff</span>
    </span>
  );
}

export function Pip({ size = 7, color = "var(--cobalt)" }) {
  return <span style={{ display: "inline-block", width: size, height: size, background: color, verticalAlign: "middle" }} />;
}

// Square mark: an ink tile with a measured corner notch + cobalt vertex pips —
// reads as "trace a room from a corner."
export function Mark({ size = 100, ink = "var(--ink)", paper = "var(--paper-cream)", accent = "var(--cobalt)", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
      <rect width="100" height="100" fill={paper} />
      <path d="M22 26 H66 L78 38 V74 H22 Z" fill="none" stroke={ink} strokeWidth="3" />
      <circle cx="22" cy="26" r="4" fill={accent} />
      <circle cx="66" cy="26" r="4" fill={accent} />
      <circle cx="78" cy="74" r="4" fill={accent} />
      <circle cx="22" cy="74" r="4" fill={accent} />
    </svg>
  );
}

// The scan star — the agent's mark (geometry in lib/scanStar.js, shared with the PDF watermark).
// `size` is the star's height; it is `reach` times as wide. `working` ripples the rows out from
// the centre line (the agent is running).
export function ScanStar({ size = 24, rows, reach = 1, working = false, color = "currentColor", title, style }) {
  const n = rows || (size <= 24 ? 7 : size <= 56 ? 11 : 23);
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": "true" };
  return (
    <svg className={`ot-scan-star${working ? " is-working" : ""}`} width={Math.round(size * reach)} height={size}
      viewBox={`${-reach} -1 ${2 * reach} 2`} style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }} focusable="false" {...a11y}>
      {scanStarRows(n, reach).map((r) => (
        <rect key={r.y} x={r.x} y={r.y} width={r.w} height={r.h} fill={color} style={{ "--ring": r.ring }} />
      ))}
    </svg>
  );
}
