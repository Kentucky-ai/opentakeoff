// UI constants — the JS mirror of styles/tokens.css for the inline-style world.
// tokens.css stays the single source of truth for anything CSS can resolve;
// this module exists for the two places CSS variables can't reach:
//   1. numeric zIndex values (the Z ladder)
//   2. SVG presentation attributes, which don't resolve var() (AGENTS.md)
// plus spreadable style fragments so a thousand inline objects converge on
// one vocabulary without a class-name migration.

/* Z ladder — every zIndex in the app comes from here. Replaces the ad-hoc
   1..70 (+9000) spread. Grid-shell areas (topbar/rail/props/status) don't
   stack at all and need no entry. */
export const Z = {
  stage: 0,      // canvas bitmap + SVG overlay
  canvasUi: 10,  // crosshair, live readout, accept pill, voice chip, hint pill
  popover: 20,   // menus, tooltips, tool flyouts
  drawer: 30,    // docked/sliding panels (Takeoffs, Report, Layers…)
  scrim: 40,
  modal: 50,     // dialogs incl. the in-app guide
  toast: 60,     // status toasts, banners that must beat modals
  dragGhost: 70, // drag previews — always on top
};

/* Sanctioned SVG literals — CSS vars don't resolve in SVG presentation
   attributes, so these are real hex values, centralized. Light values match
   --cobalt / --c-danger / --c-positive; the DARK set matches the HUD theme.
   Pick with svgAccent(isDark) at the callsite when the overlay is theme-aware. */
export const SVG = {
  cobalt: "#1f3fc7",
  danger: "#b03a26",
  positive: "#1f6b4a",
  dark: {
    cobalt: "#3f8cff",
    danger: "#ff6b57",
    positive: "#35d48f",
  },
};

export function svgAccent(isDark) {
  return isDark ? SVG.dark : SVG;
}

/* Spreadable style fragments — inline-style vocabulary. All values are
   var() strings so themes keep working. Usage:
     style={{ ...S.chip, marginLeft: "auto" }}                          */
export const S = {
  /* mono chip: calibration chip, scale chip, small pill controls */
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontFamily: "var(--f-mono)",
    fontSize: "var(--fs-xs)",
    fontVariantNumeric: "tabular-nums",
    background: "var(--surface-pop)",
    border: "1px solid var(--ink-faint)",
    borderRadius: "var(--r-1)",
    padding: "3px 9px",
    color: "var(--ink)",
  },

  /* tool-rail face */
  toolTile: {
    width: "var(--ctl-l)",
    height: "var(--ctl-l)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--r-1)",
    border: "1px solid transparent",
    background: "none",
    color: "var(--ink)",
    cursor: "pointer",
  },

  /* uppercase mono micro-label (rail group headers, panel section heads) */
  monoLabel: {
    fontFamily: "var(--f-mono)",
    fontSize: "var(--fs-2xs)",
    letterSpacing: ".1em",
    textTransform: "uppercase",
    color: "var(--ink-muted)",
    userSelect: "none",
  },

  /* numeric readout — always tabular */
  monoReadout: {
    fontFamily: "var(--f-mono)",
    fontVariantNumeric: "tabular-nums",
    fontSize: "var(--fs-s)",
    color: "var(--ink)",
  },

  /* key/value row in the props panel */
  kvRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--sp-1) 0",
  },

  /* panel section block */
  panelSection: {
    padding: "var(--sp-4)",
    borderBottom: "1px solid var(--ink-faint)",
  },

  /* ink tooltip chip */
  tooltip: {
    background: "var(--ink)",
    color: "var(--paper-bright)",
    fontFamily: "var(--f-mono)",
    fontSize: "var(--fs-xs)",
    padding: "4px 8px",
    borderRadius: "var(--r-1)",
    whiteSpace: "nowrap",
    boxShadow: "var(--shadow-2)",
    zIndex: Z.popover,
  },
};
