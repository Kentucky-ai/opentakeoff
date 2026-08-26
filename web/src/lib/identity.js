// Company identity for branded output — per-user, cross-project, so it lives
// in localStorage (annotations/IndexedDB hold per-project data). The logo is
// normalized to PNG at capture: pdf-lib embeds only PNG/JPEG, and users will
// drop WebP/SVG/HEIC. localStorage quota is effectively ours alone (projects
// live in IndexedDB), but the logo is still capped.
const KEY = "opentakeoff_company";

import i18n from "../i18n/index.js";
import { markDanger } from "./danger.js";

const _t = (key, opts) => i18n.t(key, { ns: "lib", ...opts });

// dataURL length cap (~145KB binary once base64 overhead comes off)
export const LOGO_LIMIT = 200_000;

// { name, address, logo } | {} — logo is a data:image/png;base64 URL.
// try/catch (private mode / SSR), non-object JSON → {} — mirrors
// reportColumns.loadColPrefs. String VALUES only (keys stay arbitrary): a
// hand-edited record must not put an object where the report masthead
// renders a React child — the same filter TakeoffCanvas applies to
// client_info on hydrate.
export function loadCompany() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string"));
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

// ── trade-name profiles ───────────────────────────────────────────────────────
// A firm can operate under more than one trade name (e.g. 345 Flooring / Fin
// Workspaces) — same tool, different masthead identity. Profiles are the list of
// saved trade names; the ACTIVE one is mirrored to the legacy `opentakeoff_company`
// key so loadCompany() and every masthead/marked-set consumer keep working
// unchanged (they always render the active trade name).
//
//   state = { profiles: [{ id, name, address, logo }], activeId }
const PKEY = "opentakeoff_company_profiles";

// keep only the four known string fields (drops empties, non-strings, and any
// injected keys) — the same gate loadCompany applies, plus a required id
function cleanProfile(p) {
  const out = {};
  for (const k of ["id", "name", "address", "logo"]) {
    // trim + drop empty-after-trim, so the profile can't hold a blank-looking
    // value that saveCompany() would drop from the mirrored legacy company
    const v = typeof p?.[k] === "string" ? p[k].trim() : "";
    if (v) out[k] = v;
  }
  return out;
}

let idSeq = 0;
function newId() {
  // app runtime only (Date.now available); seq disambiguates same-ms calls
  return "tp_" + Date.now().toString(36) + "_" + (idSeq++).toString(36);
}

// The active profile object, or null. Falls back to the first profile when the
// stored activeId doesn't resolve (deleted/corrupt).
export function activeProfile(state) {
  const profiles = state?.profiles || [];
  return profiles.find((p) => p.id === state?.activeId) || profiles[0] || null;
}

// Read the profiles state; migrates a legacy single-company record into one
// profile so nobody loses their saved identity on upgrade.
export function loadProfiles() {
  try {
    const raw = JSON.parse(localStorage.getItem(PKEY) || "null");
    if (raw && Array.isArray(raw.profiles)) {
      const profiles = raw.profiles.map(cleanProfile).filter((p) => p.id);
      if (profiles.length) {
        const activeId = profiles.some((p) => p.id === raw.activeId) ? raw.activeId : profiles[0].id;
        return { profiles, activeId };
      }
    }
  } catch {
    /* fall through to legacy migration */
  }
  const legacy = loadCompany();
  if (legacy.name || legacy.address || legacy.logo) {
    const p = cleanProfile({ id: newId(), ...legacy });
    return { profiles: [p], activeId: p.id };
  }
  return { profiles: [], activeId: null };
}

// Persist the state AND mirror the active profile to the legacy company key, so
// loadCompany() reflects the selected trade name with no consumer changes.
export function saveProfiles(state) {
  try {
    const profiles = (state?.profiles || []).map(cleanProfile).filter((p) => p.id);
    const activeId = profiles.some((p) => p.id === state?.activeId) ? state.activeId : (profiles[0]?.id ?? null);
    if (profiles.length) localStorage.setItem(PKEY, JSON.stringify({ profiles, activeId }));
    else localStorage.removeItem(PKEY);
    const act = activeProfile({ profiles, activeId });
    saveCompany(act ? { name: act.name, address: act.address, logo: act.logo } : {});
    return true;
  } catch {
    return false; // quota / private mode
  }
}

// ── pure reducers (state in → state out) ──────────────────────────────────────
export function addProfile(state, fields = {}) {
  const id = newId();
  const profiles = [...(state?.profiles || []), cleanProfile({ id, ...fields })];
  return { state: { profiles, activeId: id }, id };
}

export function setActiveProfile(state, id) {
  const profiles = state?.profiles || [];
  return profiles.some((p) => p.id === id) ? { profiles, activeId: id } : state;
}

export function updateActiveProfile(state, fields) {
  const activeId = state?.activeId;
  const profiles = (state?.profiles || []).map((p) =>
    p.id === activeId ? cleanProfile({ ...p, ...fields, id: p.id }) : p);
  return { profiles, activeId };
}

export function removeProfile(state, id) {
  const profiles = (state?.profiles || []).filter((p) => p.id !== id);
  const activeId = state?.activeId === id ? (profiles[0]?.id ?? null) : (state?.activeId ?? null);
  return { profiles, activeId };
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
  throw new Error(markDanger(_t("id.logo_too_large")));
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
    throw new Error(markDanger(_t("id.read_image_error")));
  }
}
