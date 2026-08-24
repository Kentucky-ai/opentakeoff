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
 *  propagates to the caller.  The global localStorage getter itself may throw
 *  (sandboxed iframes, certain privacy modes) — the catch covers that too
 *  because we resolve the default *inside* the try block. */
export function readUnitSystem(storage) {
  try {
    const s = storage ?? globalThis.localStorage;
    return normalizeUnitSystem(s?.getItem(UNIT_SYSTEM_KEY));
  } catch {
    return DEFAULT_UNIT_SYSTEM;
  }
}

/** Persist the unit preference.  No-op (silently swallows) on storage errors
 *  so the app never crashes during a toggle.  Always returns the normalised
 *  value so callers can retain in-memory state even when storage is
 *  unavailable. */
export function writeUnitSystem(value, storage) {
  const norm = normalizeUnitSystem(value);
  try {
    const s = storage ?? globalThis.localStorage;
    s?.setItem(UNIT_SYSTEM_KEY, norm);
  } catch {
    // storage full or blocked — best-effort; next read will return default
  }
  return norm;
}
