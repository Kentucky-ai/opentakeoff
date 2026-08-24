// Global unit-system context — provides the browser-wide unit preference
// (Imperial / SI) to every component that renders dimensions.  The initial
// value comes from the persisted localStorage preference (lib/unitPreference);
// the setter normalises, persists, and re-renders all consumers in one tick.
//
// The setter is pure with respect to the React state updater: it computes the
// normalised value, writes to localStorage, and THEN calls setState — never
// inside the updater callback.  This avoids duplicate storage writes under
// StrictMode / concurrent replay.
//
// Legacy migration runs once per mounted provider instance via a layout effect
// with a ref guard.  The initial render always reads the canonical key (clean
// read); if the legacy key still holds a value, the layout effect promotes it
// and bumps state so consumers see the migrated value before paint.  If
// migrateLegacyUnit returns false (storage failure), the effect retries on
// the next render up to MAX_MIGRATION_RETRIES times — bounded so there is
// no infinite loop.  The ref is per-instance so unmount+remount (HMR, route
// transitions) naturally re-runs migration from scratch.
import { createContext, useContext, useState, useCallback, useRef, useLayoutEffect } from "react";
import { readUnitSystem, writeUnitSystem, migrateLegacyUnit } from "../lib/unitPreference.js";

const UnitSystemContext = createContext(null);

/** Maximum number of migration attempts per mount cycle.  The effect only
 *  re-runs when state changes, so this bounds the retry loop without causing
 *  churn when migration is already complete. */
const MAX_MIGRATION_RETRIES = 3;

export function UnitSystemProvider({ children }) {
  // Clean read — no migration side-effect during render.
  const [unitSystem, setUnitSystemState] = useState(readUnitSystem);

  // Per-instance ref: migration completed (true) or not yet (false).
  // Reset to false on unmount+remount so a fresh mount can retry.
  const migratedRef = useRef(false);

  // Retry counter: increments on failed migration to trigger a re-render
  // where the effect re-runs.  Bounded by MAX_MIGRATION_RETRIES.
  const [retryCount, setRetryCount] = useState(0);

  // Migrate legacy key on mount (StrictMode-safe: ref persists across
  // double-invocations within a single mount cycle).  useLayoutEffect runs
  // synchronously after state commit, before the browser paints.
  useLayoutEffect(() => {
    if (migratedRef.current) return; // already succeeded this mount
    if (retryCount >= MAX_MIGRATION_RETRIES) return; // give up after retries exhausted
    const ok = migrateLegacyUnit();
    if (ok) {
      migratedRef.current = true;
      // Re-read after migration so state reflects the promoted value.
      setUnitSystemState(readUnitSystem());
    } else {
      // Storage failure — bump retryCount so the next render re-runs this
      // effect (the ref is still false, so the guard passes).
      setRetryCount((n) => n + 1);
    }
  }, [retryCount]);

  // Always-current mirror for functional updaters (avoids stale closure).
  // Updated synchronously inside the setter so two sequential functional
  // updates both observe the latest value.
  const unitSystemRef = useRef(unitSystem);

  const setUnitSystem = useCallback((valueOrFn) => {
    const next = typeof valueOrFn === "function"
      ? valueOrFn(unitSystemRef.current)
      : valueOrFn;
    const norm = writeUnitSystem(next);
    // Sync ref BEFORE (or with) setState so a second functional update
    // in the same microtask/batch sees this value.
    unitSystemRef.current = norm;
    setUnitSystemState(norm);
  }, []);

  return (
    <UnitSystemContext.Provider value={{ unitSystem, setUnitSystem }}>
      {children}
    </UnitSystemContext.Provider>
  );
}

/** Read / write the global unit system.  Throws if used outside the provider. */
export function useUnitSystem() {
  const ctx = useContext(UnitSystemContext);
  if (!ctx) throw new Error("useUnitSystem must be used within a UnitSystemProvider");
  return ctx;
}
