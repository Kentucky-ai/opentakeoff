// Gallery thumbnails: crisp, cheap, and remembered.
//
// Three rules, each answering a complaint that was live:
//   1. SHARP — raster at THUMB_W × devicePixelRatio (capped at 2×). A 380px
//      raster on a 2× screen was being stretched to 760 device px in the
//      card: every plan looked soft, and soft thumbnails are what make a
//      user squint at the gallery wondering which sheet they're opening.
//   2. OFF THE MAIN THREAD where the platform allows — encoding goes through
//      canvas.toBlob (async, worker-side in Chromium) instead of the
//      synchronous toDataURL that stalled the gallery for every card.
//      WebP is preferred (small AND lossless-looking on linework); a browser
//      that can't encode it silently hands back PNG, which we accept.
//   3. REMEMBERED — the blob (plus the sheet number and plan-noted scale the
//      pump reads off the same page) lands in the meta store keyed by sheet,
//      so reopening a gallery draws every card from IndexedDB without loading
//      a single pdf.js document. Sites that drop a file's bytes (close,
//      remove, revise-by-redrop, clear, restore) call forgetThumbs, so a
//      stale thumbnail can never outlive the PDF it pictured.
//
// Pure-ish helpers (DOM canvas + IndexedDB, no React) so PlanNavigator stays
// a view.
import { metaGet, metaPut, metaDelete, metaDeletePrefix } from "./store.js";

export const THUMB_W = 380;           // CSS px — the card well is 270..~400 wide
const THUMB_VERSION = 2;              // bump to invalidate every persisted thumb
const PREFIX = `thumb:v${THUMB_VERSION}:`;

/** Device px the raster should be wide for a crisp card on this screen. */
export function thumbPixelWidth() {
  const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
  return Math.round(THUMB_W * Math.min(2, Math.max(1, dpr)));
}

const keyOf = (sheetKey) => `${PREFIX}${sheetKey}`;

/** Rasterize `pg` (a pdf.js page) into a Blob `w` device px wide. */
export async function renderThumb(pg, w = thumbPixelWidth()) {
  const vp1 = pg.getViewport({ scale: 1 });
  const vp = pg.getViewport({ scale: w / vp1.width });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext("2d", { alpha: false });
  await pg.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;
  let blob = await new Promise((res) => c.toBlob(res, "image/webp", 0.9));
  if (!blob) blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
  if (!blob) throw new Error("thumbnail encode failed");
  return { blob, w: c.width, h: c.height };
}

/** Persisted record for `sheetKey`, or null when absent / rastered narrower
 *  than this screen now wants (a 1× thumb re-renders on a 2× screen). */
export async function loadThumb(sheetKey, minW = thumbPixelWidth()) {
  try {
    const rec = await metaGet(keyOf(sheetKey));
    if (!rec || !(rec.blob instanceof Blob) || !(rec.w >= minW)) return null;
    return rec;
  } catch { return null; }
}

/** Best-effort persist; a quota failure only costs the next open a re-render. */
export function saveThumb(sheetKey, rec) {
  return metaPut(keyOf(sheetKey), { w: rec.w, h: rec.h, blob: rec.blob, label: rec.label ?? null, det: rec.det ?? null, ts: Date.now() }).catch(() => {});
}

/** Drop every thumb for these FILE names — persisted AND the live object
 *  URLs in `liveMap` (sheetKey → blob URL), which are revoked. */
export async function forgetThumbs(fileNames, liveMap) {
  for (const file of fileNames) {
    if (liveMap) {
      for (const [k, url] of liveMap) {
        if (k === file || k.startsWith(`${file}#`)) { try { URL.revokeObjectURL(url); } catch { /* not ours */ } liveMap.delete(k); }
      }
    }
    // a sheet key is `file` or `file#N`: the exact key, then the `file#` prefix
    // (the `#` bound keeps `plan.pdf` from sweeping `plan.pdf2`'s thumbs)
    try { await metaDelete(keyOf(file)); await metaDeletePrefix(keyOf(`${file}#`)); } catch { /* cache only */ }
  }
}

/** Revoke + clear every live thumb URL (project switch / clear workspace). */
export function releaseThumbs(liveMap) {
  for (const [, url] of liveMap) { try { URL.revokeObjectURL(url); } catch { /* not ours */ } }
  liveMap.clear();
}
