// Company identity for branded output — per-user, cross-project, so it lives
// in localStorage (annotations/IndexedDB hold per-project data). The logo is
// normalized to PNG at capture: pdf-lib embeds only PNG/JPEG, and users will
// drop WebP/SVG/HEIC. localStorage quota is effectively ours alone (projects
// live in IndexedDB), but the logo is still capped.
const KEY = "opentakeoff_company";

// dataURL length cap (~145KB binary once base64 overhead comes off)
export const LOGO_LIMIT = 200_000;

// { name, address, logo } | {} — logo is a data:image/png;base64 URL.
// try/catch (private mode / SSR), non-object JSON → {} — mirrors
// reportColumns.loadColPrefs.
export function loadCompany() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // private mode / SSR / corrupt JSON
  }
}

// Write {name, address, logo} dropping empty fields; nothing left → removeItem.
// Quota errors are swallowed; returns true/false so the UI can report failure.
export function saveCompany(c) {
  try {
    const out = {};
    for (const k of ["name", "address", "logo"]) {
      const v = c?.[k];
      if (v && String(v).trim()) out[k] = v;
    }
    if (Object.keys(out).length) localStorage.setItem(KEY, JSON.stringify(out));
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false; // quota / private mode — the UI reports it
  }
}

// File/Blob → PNG dataURL, ready for pdf-lib's embedPng. Downscales to fit
// 600×300 CSS px (logos print ~1in tall; bigger is waste) and retries smaller
// until it fits LOGO_LIMIT. Browser-only (canvas + image decode).
export async function normalizeLogoToPng(file) {
  const { source, width, height, close } = await decodeImage(file);
  const fit = Math.min(600 / width, 300 / height, 1);
  let w = Math.max(1, Math.round(width * fit));
  let h = Math.max(1, Math.round(height * fit));
  try {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(source, 0, 0, w, h);
      const url = canvas.toDataURL("image/png");
      if (url.length <= LOGO_LIMIT) return url;
      w = Math.max(1, Math.round(w * 0.7));
      h = Math.max(1, Math.round(h * 0.7));
    }
  } finally {
    close();
  }
  throw new Error("Logo too large — use a simpler image");
}

// createImageBitmap first (fast path), <img> + objectURL fallback — some
// browsers refuse SVG blobs in createImageBitmap but decode them fine in <img>.
async function decodeImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    /* fall through to the <img> path */
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("decode failed"));
      img.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("no pixels");
    return { source: img, width: img.naturalWidth, height: img.naturalHeight,
             close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("Couldn't read that image — PNG, JPEG, WebP or SVG please");
  }
}

// data:*;base64,… → Uint8Array (atob); null on malformed input — markedset
// feeds this straight into embedPng.
export function dataUrlToBytes(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null; // not valid base64
  }
}
