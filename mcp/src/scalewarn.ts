// Mixed-scale honesty (#153): an enlarged plan measured at the sheet scale is
// silently ~4x wrong on area — the exact error class the scale gate exists to
// prevent. This module answers ONE question, purely: does the measured region
// carry a scale note that disagrees with the scale the quantities were figured
// at? It reuses detectScale — the sheet-level detector — on a region-filtered
// text set, so a "note" here is exactly what set_scale would have suggested,
// never a second regex's opinion. Warn, don't block: the region might BE at
// the sheet scale with a detail's note merely nearby, and one_click's no-scale
// posture (px + warning) is the house style for honest uncertainty.
import { detectScale } from "../../web/src/lib/sheets.ts";
import type { TextContentLike, ViewportLike } from "./pdf.ts";

/** How far past the measured bbox to look: enlarged-plan scale notes sit BELOW
 * their viewport ("1/2" = 1'-0"" under the blown-up toilet room), so the reach
 * extends further down than out. Fractions of the bbox's own size. */
export const SCALE_NOTE_MARGIN_XY = 0.10;
export const SCALE_NOTE_MARGIN_BELOW = 0.35;
/** upp disagreement below this is label-formatting noise, not a mixed scale. */
export const UPP_TOLERANCE = 0.05;

export function expandForScaleNotes(b: { x0: number; y0: number; x1: number; y1: number }) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  return {
    x0: b.x0 - w * SCALE_NOTE_MARGIN_XY,
    y0: b.y0 - h * SCALE_NOTE_MARGIN_XY,
    x1: b.x1 + w * SCALE_NOTE_MARGIN_XY,
    y1: b.y1 + h * SCALE_NOTE_MARGIN_BELOW,
  };
}

/** undefined = no disagreement found (no note, an agreeing note, or no adopted
 * scale to disagree with). A string = the warning to ride the reply. */
export function mixedScaleWarning(
  regionText: TextContentLike,
  viewport: ViewportLike,
  adoptedUpp: number | null,
  adoptedLabel: string | undefined,
): string | undefined {
  if (adoptedUpp == null) return undefined;   // the no-scale path has its own warning
  const hit = detectScale(regionText as never, viewport as never);
  if (!hit) return undefined;
  if (Math.abs(hit.upp - adoptedUpp) / adoptedUpp <= UPP_TOLERANCE) return undefined;
  return `Scale note ${JSON.stringify(hit.label)} sits in or just below this region, but quantities were figured at ${adoptedLabel ? JSON.stringify(adoptedLabel) : `upp ${adoptedUpp}`} — if this is an enlarged plan or detail viewport, these numbers are wrong. Verify with view_sheet grid, or set_scale/calibrate for the right value before trusting them.`;
}
