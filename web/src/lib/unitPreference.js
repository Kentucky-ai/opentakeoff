// Browser-global unit-system preference — persisted in localStorage, read at
// app boot, and consumed by every component that renders dimensions.  All
// canonical / calculation units stay Imperial; this preference controls only
// the display/input edge (lib/units.ts).  Storage errors never throw — the
// app must boot even in environments where localStorage is blocked (private
// browsing on older browsers, sandboxed iframes, etc.).

export const UNIT_SYSTEM_KEY = "opentakeoff.unitSystem";

export const DEFAULT_UNIT_SYSTEM = "imperial";

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

/** Read the persisted unit preference.  Returns the default (Imperial) when
 *  the key is missing, blank, or contains an unrecognised value.  Storage
 *  access is wrapped in try/catch so a quota-exceeded or SecurityError never
 *  propagates to the caller.  An explicitly `null` storage argument bypasses
 *  the global entirely; an omitted argument resolves from
 *  `globalThis.localStorage`, whose getter may itself throw. */
export function readUnitSystem(storage) {
  try {
    const s = resolveStorage(storage);
    return normalizeUnitSystem(s?.getItem(UNIT_SYSTEM_KEY));
  } catch {
    return DEFAULT_UNIT_SYSTEM;
  }
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
    // storage full or blocked — best-effort; next read will return default
  }
  return norm;
}
