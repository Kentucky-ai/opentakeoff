// Branding mode — how a deliverable presents itself. Two modes:
//   • "default"    — OpenTakeoff-branded, exactly as the parent repo ships. This
//                    is the code default (unset ⇒ default), so an upstream clone
//                    is unchanged.
//   • "clearlabel" — a saved trade-name profile brands the document as the firm
//                    presenting it; OpenTakeoff keeps a subtle plain-text credit
//                    ("Measured with OpenTakeoff"), so the parent is still credited.
//
// resolveBranding() is PURE — given the per-project selection + the global
// profiles list it tells every render point (report masthead, marked-set cover,
// the CSV/MD export titles) what to show. Storage is a separate, swappable edge:
// the selection lives in the per-project meta KV, keyed on the project id so it
// degrades to a single global setting in the browser-only build (folderId "").
import { metaGet, metaPut } from "./store.js";
import { activeProfile } from "./identity.js";
import i18n from "../i18n/index.js";

const _t = (key, opts) => i18n.t(key, { ns: "lib", ...opts });

export const OT_NAME = "OpenTakeoff";
/** Legacy constant — frozen at import time. Prefer otCredit() for current translation. */
export const OT_CREDIT = _t("brand.ot_credit");

/** Resolve OT credit at call time (reflects mid-session language switch). */
export function otCredit() { return _t("brand.ot_credit"); }

/**
 * @param {{mode?: string, profileId?: string|null,
 *   profiles?: Array<{id:string,name?:string,address?:string,logo?:string}>}} [sel]
 * @returns {{clear:boolean, company:{name?:string,address?:string,logo?:string}|null,
 *   brandName:string, credit:string|null, coverTitle:string}}
 */
export function resolveBranding(sel) {
  const profiles = sel?.profiles || [];
  // clear-label only takes effect when a real profile resolves — no profiles, a
  // stale id with none left, or mode off all fall back to OpenTakeoff. A stale
  // id with other profiles present rides the first one. activeProfile() is the
  // ONE place that fallback rule lives (shared with the modal chip highlight) so
  // the deliverable and the UI can never disagree on which profile is selected.
  const profile = sel?.mode === "clearlabel"
    ? activeProfile({ profiles, activeId: sel?.profileId })
    : null;
  const clear = Boolean(profile);
  return {
    clear,
    // full identity for the masthead firm block + cover identity column; null in
    // default mode so every `company?.x` guard degrades to the OpenTakeoff path
    company: clear ? { name: profile.name, address: profile.address, logo: profile.logo } : null,
    // firm text / "Prepared by" cell / export title tag — the trade name when
    // clear-labelling (a logo-only profile has no name → keep OpenTakeoff)
    brandName: (clear && profile.name) ? profile.name : OT_NAME,
    // subtle parent credit — shown only when clear-labelling (default mode is
    // already OpenTakeoff-branded throughout, so a separate credit is redundant)
    credit: clear ? otCredit() : null,
    // marked-set cover wordmark — carries the OpenTakeoff prefix in default mode
    coverTitle: clear ? _t("brand.marked_set") : _t("brand.ot_marked_set"),
  };
}

// ── per-project persistence (browser-only; the meta KV is IndexedDB) ──────────
// Keyed on the project id so cloud/Drive projects each remember their own
// branding; the anonymous browser-only store threads id "" and lands on one key
// — i.e. a single global setting, which is exactly right there.
const selKey = (projectId) => `branding:${projectId || ""}`;

// Both swallow IndexedDB failures (stale-tab VersionError, private mode, quota)
// and degrade — the same resilience loadCompany/saveCompany apply — so a blocked
// DB can never surface as an unhandled rejection at a fire-and-forget call site.
/** @param {string} [projectId] @returns {Promise<{mode:string, profileId:string|null}>} */
export async function loadBrandingSelection(projectId) {
  try {
    const v = await metaGet(selKey(projectId));
    if (v && typeof v === "object") {
      return { mode: v.mode === "clearlabel" ? "clearlabel" : "default", profileId: v.profileId ?? null };
    }
  } catch {
    /* DB blocked/unavailable — fall through to the default (OpenTakeoff) */
  }
  return { mode: "default", profileId: null };
}

/** @param {string} projectId @param {{mode?:string, profileId?:string|null}} sel @returns {Promise<boolean>} saved ok */
export async function saveBrandingSelection(projectId, sel) {
  try {
    await metaPut(selKey(projectId), {
      mode: sel?.mode === "clearlabel" ? "clearlabel" : "default",
      profileId: sel?.profileId ?? null,
    });
    return true;
  } catch {
    return false; // quota / private mode / stale tab — caller decides what to do
  }
}
