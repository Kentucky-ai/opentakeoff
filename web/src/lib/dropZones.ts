// Pure hit-testing for the 5-zone tab-drop overlay. Edge thirds pick a split
// direction; the middle joins the pane's existing group (center). When the
// canvas is already split (only two panes allowed), edges are disabled and
// every drop resolves to center.
export type Zone = "left" | "right" | "top" | "bottom" | "center";
export const SHEET_TAB_DND_MIME = "application/x-opentakeoff-tab";

export const dropZoneAt = (
  rect: { w: number; h: number },
  x: number,
  y: number,
  opts: { edgesDisabled?: boolean } = {},
): Zone => {
  if (opts.edgesDisabled) return "center";
  const fx = x / rect.w, fy = y / rect.h;
  const inMidX = fx > 1 / 3 && fx < 2 / 3;
  const inMidY = fy > 1 / 3 && fy < 2 / 3;
  if (inMidX && inMidY) return "center";
  // distance (normalized) to the nearest of the four edges; smallest wins so a
  // corner picks one edge, never two.
  const dl = fx, dr = 1 - fx, dt = fy, db = 1 - fy;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return "left";
  if (m === dr) return "right";
  if (m === dt) return "top";
  return "bottom";
};

export const zoneToOrientation = (z: Zone): "v" | "h" | null =>
  z === "left" || z === "right" ? "v" : z === "top" || z === "bottom" ? "h" : null;
