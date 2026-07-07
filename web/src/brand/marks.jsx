// OpenTakeoff brand marks. Neutral, paper/ink/cobalt — the same token palette as
// the rest of the app. (No relation to any private branding.)

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
