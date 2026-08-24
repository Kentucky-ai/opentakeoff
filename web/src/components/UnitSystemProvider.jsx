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
// Legacy migration runs exactly once — guarded by a module-level flag so it
// never re-executes on render or StrictMode re-mount.
import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { readUnitSystem, writeUnitSystem, migrateLegacyUnit } from "../lib/unitPreference.js";

const UnitSystemContext = createContext(null);

// Module-level guard: migrateLegacyUnit runs at most once across the entire
// app lifetime, even under StrictMode double-invocation or concurrent features.
let _migrated = false;

export function UnitSystemProvider({ children }) {
  // One-time migration: runs before the first useState initializer so the
  // initial read picks up the promoted legacy value.
  if (!_migrated) {
    _migrated = true;
    migrateLegacyUnit();
  }

  const [unitSystem, setUnitSystemState] = useState(readUnitSystem);
  // Always-current mirror for functional updaters (avoids stale closure).
  const unitSystemRef = useRef(unitSystem);
  useEffect(() => { unitSystemRef.current = unitSystem; }, [unitSystem]);

  const setUnitSystem = useCallback((valueOrFn) => {
    // Resolve the next value — support functional updater for backward compat.
    const next = typeof valueOrFn === "function"
      ? valueOrFn(unitSystemRef.current)
      : valueOrFn;
    const norm = writeUnitSystem(next);
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
