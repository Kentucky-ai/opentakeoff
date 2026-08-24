// Global unit-system context — provides the browser-wide unit preference
// (Imperial / SI) to every component that renders dimensions.  The initial
// value comes from the persisted localStorage preference (lib/unitPreference);
// the setter normalises, persists, and re-renders all consumers in one tick.
import { createContext, useContext, useState, useCallback } from "react";
import { readUnitSystem, writeUnitSystem } from "../lib/unitPreference.js";

const UnitSystemContext = createContext(null);

export function UnitSystemProvider({ children }) {
  const [unitSystem, setUnitSystemState] = useState(readUnitSystem);

  const setUnitSystem = useCallback((valueOrFn) => {
    setUnitSystemState((prev) => {
      const next = typeof valueOrFn === "function" ? valueOrFn(prev) : valueOrFn;
      return writeUnitSystem(next);
    });
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
