// OpenTakeoff brand marks. Neutral, paper/ink/cobalt — the same token palette as
// the rest of the app. (No relation to any private branding.)
import { scanStarRows } from "../lib/scanStar.js";

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
