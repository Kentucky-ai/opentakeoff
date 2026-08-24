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

/** Read the persisted unit preference.  Returns the default (Imperial) when
 *  the key is missing, blank, or contains an unrecognised value.  Storage
 *  access is wrapped in try/catch so a quota-exceeded or SecurityError never
 *  propagates to the caller. */
export function readUnitSystem(storage = globalThis.localStorage) {
  try {
    return normalizeUnitSystem(storage?.getItem(UNIT_SYSTEM_KEY));
  } catch {
    return DEFAULT_UNIT_SYSTEM;
  }
}

/** Persist the unit preference.  No-op (silently swallows) on storage errors
 *  so the app never crashes during a toggle. */
export function writeUnitSystem(value, storage = globalThis.localStorage) {
  try {
    storage?.setItem(UNIT_SYSTEM_KEY, normalizeUnitSystem(value));
  } catch {
    // storage full or blocked — best-effort; next read will return default
  }
}
