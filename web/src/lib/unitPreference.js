// Browser-global unit-system preference — persisted in localStorage, read at
// app boot, and consumed by every component that renders dimensions.  All
// canonical / calculation units stay Imperial; this preference controls only
// the display/input edge (lib/units.ts).  Storage errors never throw — the
// app must boot even in environments where localStorage is blocked (private
// browsing on older browsers, sandboxed iframes, etc.).

export const UNIT_SYSTEM_KEY = "opentakeoff.unitSystem";

/** Legacy key from the pre-provider era (per-project units toggle).
 *  Migrated once: if the canonical key is absent/invalid and the legacy key
 *  holds a valid value, it is promoted to the canonical key. */
export const LEGACY_UNIT_KEY = "opentakeoff_units";

export const DEFAULT_UNIT_SYSTEM = "imperial";

/** Language-aware default: pt-BR users get metric; everything else gets the
 *  canonical DEFAULT_UNIT_SYSTEM (imperial).  Called when no valid preference
 *  is stored.  Handles both i18next-normalized "pt-br" and raw browser
 *  variants like "pt-BR" or "pt_BR". */
export function languageDefault(lng) {
  if (!lng) return DEFAULT_UNIT_SYSTEM;
  const lc = lng.toLowerCase().replace("_", "-");
  // Match "pt-br" and sub-tags like "pt-br-u-nu-metric"
  return lc === "pt-br" || lc.startsWith("pt-br-") ? "metric" : DEFAULT_UNIT_SYSTEM;
}

/** Returns true when the storage holds a valid (metric|imperial) preference
 *  that was explicitly persisted by the user.  Returns false when the key is
 *  absent, blank, or contains an unrecognised value — meaning the language-
 *  aware default should be used. */
export function hasExplicitPreference(storage) {
  try {
    const s = resolveStorage(storage);
    const raw = s?.getItem(UNIT_SYSTEM_KEY);
    return raw === "metric" || raw === "imperial";
  } catch {
    return false;
  }
}

/** Normalise an arbitrary value to a valid UnitSystem.  Anything other than
 *  the literal string "metric" collapses to "imperial". */
export function normalizeUnitSystem(value) {
  return value === "metric" ? "metric" : "imperial";
}

/** Resolve the storage argument to an actual Storage object or null.
 *  - explicitly `null` → "skip storage entirely" (null, no global fallback)
 *  - `undefined` (omitted) → use the browser global `globalThis.localStorage`
 *  - an object → use it as-is (test-injected mock / real Storage) */
function resolveStorage(storage) {
  return storage === null ? null : (storage ?? globalThis.localStorage);
}

/** Migrate the legacy `opentakeoff_units` key to the canonical
 *  `opentakeoff.unitSystem` key when:
 *    1. The canonical key is absent or invalid.
 *    2. The legacy key holds a valid value ("metric" or "imperial").
 *
 *  After migration the legacy key is deleted so subsequent reads are clean.
 *  Returns `true` when migration completed or no migration was needed (legacy
 *  key absent, canonical already valid, or null storage bypass).  Returns
 *  `false` when storage access failed — callers should retry later.  Storage
 *  errors are silently swallowed so the caller sees a boolean, not a throw. */
export function migrateLegacyUnit(storage) {
  try {
    const s = resolveStorage(storage);
    if (!s) return true; // null storage — nothing to do, considered complete
    const canonical = s.getItem(UNIT_SYSTEM_KEY);
    // If canonical is NOT yet valid, try to promote from legacy
    if (canonical !== "imperial" && canonical !== "metric") {
      const legacy = s.getItem(LEGACY_UNIT_KEY);
      if (legacy === "imperial" || legacy === "metric") {
        s.setItem(UNIT_SYSTEM_KEY, legacy);
      }
    }
    // Always clean up the legacy key if present
    if (s.getItem(LEGACY_UNIT_KEY) != null) {
      s.removeItem(LEGACY_UNIT_KEY);
    }
    return true; // succeeded or nothing to do
  } catch {
    // storage full or blocked — caller should retry when storage recovers.
    return false;
  }
}

/** Read the persisted unit preference.  Returns a language-aware default when
 *  the key is missing, blank, or contains an unrecognised value.  Storage
 *  access is wrapped in try/catch so a quota-exceeded or SecurityError never
 *  propagates to the caller.  An explicitly `null` storage argument bypasses
 *  the global entirely; an omitted argument resolves from
 *  `globalThis.localStorage`, whose getter may itself throw.
 *
 *  @param {object|null|undefined} [storage] - localStorage-like object, null
 *    to skip storage entirely, or omitted/undefined to use
 *    globalThis.localStorage.
 *  @param {object} [options] - optional config.
 *  @param {string} [options.lng] - active i18next language code.  When the
 *    language is pt-BR and no valid preference is stored, the resolved system
 *    is "metric" instead of the imperial default. */
export function readUnitSystem(storage, options) {
  const lng = options?.lng;
  const fallback = languageDefault(lng);
  try {
    const s = resolveStorage(storage);
    const raw = s?.getItem(UNIT_SYSTEM_KEY);
    if (raw === "metric" || raw === "imperial") return raw;
    return fallback;
  } catch {
    return fallback;
  }
}

/** Pure decision function: given the current in-memory unit, whether storage
 *  holds a valid preference, whether the user explicitly chose in-session,
 *  and the new language code, return the unit system to adopt.
 *
 *  - If storage holds a valid value OR the user explicitly chose a unit via
 *    the UI (explicitMemory flag), the current unit is preserved — language
 *    changes never override an explicit preference.
 *  - Otherwise the language-aware default is returned so pt-BR → metric and
 *    en → imperial on every switch.
 *
 *  @param {object} params
 *  @param {string} params.currentUnit - unit system currently in memory
 *  @param {boolean} params.hasExplicitStorage - storage holds metric|imperial
 *  @param {boolean} params.explicitMemory - user chose via setUnitSystem
 *  @param {string} params.newLng - i18next language code after switch
 *  @returns {string} the unit system to adopt */
export function resolveAfterLanguageChange({ currentUnit, hasExplicitStorage, explicitMemory, newLng }) {
  if (hasExplicitStorage || explicitMemory) return currentUnit;
  return languageDefault(newLng);
}

/** Persist the unit preference.  No-op (silently swallows) on storage errors
 *  so the app never crashes during a toggle.  Always returns the normalised
 *  value so callers can retain in-memory state even when storage is
 *  unavailable.  An explicitly `null` storage argument skips the global
 *  entirely; an omitted argument resolves from `globalThis.localStorage`. */
export function writeUnitSystem(value, storage) {
  const norm = normalizeUnitSystem(value);
  try {
    const s = resolveStorage(storage);
    s?.setItem(UNIT_SYSTEM_KEY, norm);
  } catch {
    // storage full or blocked — best-effort; the normalised value is still
    // returned so callers can keep in-memory state, but any previously
    // persisted value may remain unchanged on disk.
  }
  return norm;
}
