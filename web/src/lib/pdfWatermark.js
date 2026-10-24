// The OpenTakeoff watermark on every PDF the app writes — the bid proposal and
// the marked set, in every branding mode. Clear-label puts the firm's name on
// a document; it never removes this. Two marks per page:
//   • a faint diagonal "OpenTakeoff" across the middle, sized to the page;
//   • OT_WATERMARK ("Prepared with OpenTakeoff · …") along the bottom right.
// The diagonal is light enough that linework and quantity chips under it stay
// readable; WATERMARK_OPACITY is the one knob.
//
// pdf-lib is passed in (the callers already hold its lazily imported module),
// so this file stays import-light and runs under node for the tests.

import { OT_NAME, OT_WATERMARK } from "./branding.js";

export const WATERMARK_OPACITY = 0.07;

/**
 * @param {any} page a pdf-lib PDFPage
 * @param {{ font: any, rgb: Function, degrees: Function, dark?: boolean }} lib
 */
export function stampWatermark(page, { font, rgb, degrees, dark = false }) {
  const { width: W, height: H } = page.getSize();
  // Lay out in the page as DISPLAYED (/Rotate applied), then map back to user
  // space — a plan sheet saved with /Rotate 90 still gets its footer along the
  // bottom edge the reader sees and the diagonal running corner to corner.
  const rot = (((page.getRotation?.().angle || 0) % 360) + 360) % 360;
  const side = rot === 90 || rot === 270;
  const width = side ? H : W, height = side ? W : H;
  const toUser = (u, v) => (rot === 90 ? [W - v, u] : rot === 180 ? [W - u, H - v] : rot === 270 ? [v, H - u] : [u, v]);
  const text = (t, u, v, opts, displayDeg = 0) => {
    const [x, y] = toUser(u, v);
    page.drawText(t, { ...opts, x, y, rotate: degrees(displayDeg + rot) });
  };
  const ink = dark ? rgb(1, 1, 1) : rgb(0, 0, 0);
  // diagonal: the word spans ~55% of the page diagonal, centered on it
  const diag = Math.hypot(width, height);
  const angle = Math.atan2(height, width);
  const size = Math.max(24, (diag * 0.55) / Math.max(1, font.widthOfTextAtSize(OT_NAME, 1)));
  const w = font.widthOfTextAtSize(OT_NAME, size);
  const cx = width / 2, cy = height / 2;
  // drawText rotates about the text origin: start half the word back along the
  // diagonal and half the cap height down across it, so the word is centered
  const capH = size * 0.7;
  const u = cx - (w / 2) * Math.cos(angle) + (capH / 2) * Math.sin(angle);
  const v = cy - (w / 2) * Math.sin(angle) - (capH / 2) * Math.cos(angle);
  text(OT_NAME, u, v, { size, font, color: ink, opacity: WATERMARK_OPACITY }, (angle * 180) / Math.PI);
  // footer line, bottom right, scaled up a little on big plan sheets
  const fs = Math.max(6.5, Math.min(14, width / 90));
  const fw = font.widthOfTextAtSize(OT_WATERMARK, fs);
  text(OT_WATERMARK, Math.max(4, width - fw - 12), Math.max(4, fs * 0.9), { size: fs, font, color: dark ? rgb(0.75, 0.78, 0.8) : rgb(0.45, 0.47, 0.5) });
}
