// The values the browser app, the MCP server and the protocol tooling must
// agree on, in ONE place. This module imports nothing and touches no DOM, so
// it runs unchanged in the Vite build, the Node bundle and `node --test`.
// Every consumer imports from here; the parity tests in web/test, mcp/test
// and protocol/test fail when a copy reappears anywhere else.
//
// PALETTE and HATCH_IDS are user data: they are written into saved takeoffs,
// so never re-theme, reorder or remove entries. Append only.

/** Schema id every saved takeoff carries as its first key. */
export const TAKEOFF_SCHEMA = "opentakeoff.takeoff_canvas.v1";
/** Schema id of the computed Report document. */
export const REPORT_SCHEMA = "opentakeoff.report.v1";

/** Render scale for the image frame every tool coordinate lives in:
 *  image px = PDF pt × RENDER_SCALE. */
export const RENDER_SCALE = 2.0;

/** Condition line/fill colors, rotated in mint order. */
export const PALETTE: readonly string[] = Object.freeze([
  "#c96442", "#2f7d54", "#2563eb", "#9333ea", "#b8860b",
  "#0d9488", "#be185d", "#1f2937", "#dc2626", "#0891b2",
]);

/** Hatch ids in the canvas's HATCHES order. The pattern SVGs live with the
 *  React component; the id vocabulary lives here so the server can rotate
 *  through it without importing React. */
export const HATCH_IDS: readonly string[] = Object.freeze([
  "solid", "diag", "diag2", "cross", "diagdense", "horiz", "vert", "grid", "brick",
  "plank", "herring", "basket", "checker", "wave", "dots", "speckle", "iso",
  "honeycomb", "scan", "plus", "circuit", "topo", "woodgrain", "chevron",
  "pinwheel", "harlequin", "hexagon", "penny", "octagondot", "fleur", "concrete",
]);

/** Snap-grid bucket size, raster px. */
export const SNAP_CELL = 24;
/** One-Click vertex-snap tolerance, image px. */
export const SNAP_TOL = 7;

/** The hatch a newly minted condition gets when `conditionCount` conditions
 *  already exist: rotates through every id but "solid" so each new finish
 *  reads distinctly. The one formula both minting paths use. */
export function nextHatchId(conditionCount: number): string {
  return HATCH_IDS[1 + (conditionCount % (HATCH_IDS.length - 1))];
}

/** The palette entry a newly minted condition gets. */
export function nextPaletteColor(conditionCount: number): string {
  return PALETTE[conditionCount % PALETTE.length];
}
