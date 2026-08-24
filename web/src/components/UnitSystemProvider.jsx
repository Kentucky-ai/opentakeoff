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
// and bumps state so consumers see the migrated value before paint.  The ref
// is per-instance so unmount+remount (HMR, route transitions) naturally
// re-runs migration if needed, and StrictMode double-invocations reuse the
// same ref so migration only fires once per mount cycle.
import { createContext, useContext, useState, useCallback, useRef, useLayoutEffect } from "react";
import { readUnitSystem, writeUnitSystem, migrateLegacyUnit } from "../lib/unitPreference.js";

const UnitSystemContext = createContext(null);

export function UnitSystemProvider({ children }) {
  // Clean read — no migration side-effect during render.
  const [unitSystem, setUnitSystemState] = useState(readUnitSystem);

  // Per-instance ref: layout effect runs migration at most once per mount.
  const migratedRef = useRef(false);

  // Migrate legacy key on first mount (StrictMode-safe: ref persists across
  // double-invocations within a single mount cycle).  useLayoutEffect runs
  // synchronously after state commit, before the browser paints, so the
  // migrated value is visible in the same frame as the initial render.
  // If the canonical key is already valid (no legacy to promote), the effect
  // is a fast no-op read.
  useLayoutEffect(() => {
    if (!migratedRef.current) {
      migratedRef.current = true;
      migrateLegacyUnit();
      // Re-read after migration so state reflects the promoted value.
      setUnitSystemState(readUnitSystem());
    }
  }, []);

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
