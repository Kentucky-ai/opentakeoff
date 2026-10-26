// Company setup — the estimating defaults and proposal text a firm sets once.
// Per-user, cross-project (like the company identity in identity.js), so it
// lives in localStorage and travels in the .otprofile (lib/profile.js).
//
//   { tax_pct, overhead_pct, profit_pct, profit_mode,   ← lib/estimate.js settings
//     valid_days,                                       ← how long a proposal holds
//     inclusions, exclusions, terms }                   ← proposal text, plain
//
// These are DEFAULTS: a project copies them when its estimate is first opened,
// and editing a project's markups never writes back here. Nothing is seeded —
// an empty setup prices with 0% markups and prints no terms; the estimator
// supplies every number and every word.

import { sanitizeEstimateSettings } from "./estimate.js";

const KEY = "opentakeoff_estimating_defaults";
export const TEXT_FIELDS = ["inclusions", "exclusions", "terms"];
export const TEXT_LIMIT = 8000;   // per field; a proposal page, not a contract archive
export const DEFAULT_VALID_DAYS = 30;

/**
 * @param {any} raw
 * @returns {{tax_pct: number, overhead_pct: number, profit_pct: number, profit_mode: string,
 *   valid_days: number, inclusions: string, exclusions: string, terms: string}}
 */
export function sanitizeEstimatingDefaults(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const days = Number(src.valid_days);
  const out = {
    ...sanitizeEstimateSettings(src),
    valid_days: Number.isInteger(days) && days > 0 && days <= 365 ? days : DEFAULT_VALID_DAYS,
  };
  for (const k of TEXT_FIELDS) out[k] = typeof src[k] === "string" ? src[k].slice(0, TEXT_LIMIT) : "";
  return out;
}

export function loadEstimatingDefaults() {
  try {
    return sanitizeEstimatingDefaults(JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch {
    return sanitizeEstimatingDefaults({}); // private mode / SSR / corrupt JSON
  }
}

// Returns true/false so the UI can report a failed save (quota / private mode).
export function saveEstimatingDefaults(d) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitizeEstimatingDefaults(d)));
    return true;
  } catch {
    return false;
  }
}

// True when the estimator has started a setup worth carrying in a profile:
// any non-default number or any proposal text.
export function hasEstimatingDefaults(d) {
  const s = sanitizeEstimatingDefaults(d);
  return s.tax_pct > 0 || s.overhead_pct > 0 || s.profit_pct > 0 || s.profit_mode !== "markup"
    || s.valid_days !== DEFAULT_VALID_DAYS || TEXT_FIELDS.some((k) => s[k].trim());
}
