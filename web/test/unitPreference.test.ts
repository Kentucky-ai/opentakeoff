// Unit-system localStorage preference — persistence, fallback, and storage-error
// resilience.  Every test uses a plain-object mock so no real localStorage is
// touched (safe in node, safe in browser, deterministic either way).
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { UNIT_SYSTEM_KEY, DEFAULT_UNIT_SYSTEM, normalizeUnitSystem, readUnitSystem, writeUnitSystem, migrateLegacyUnit, LEGACY_UNIT_KEY } from "../src/lib/unitPreference.js";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Minimal localStorage-shaped object backed by a Map. */
function mockStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string): string | null => map.has(k) ? map.get(k)! : null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    get _map() { return map; },
  };
}

/** Storage that throws on every operation (SecurityError / quota). */
function throwingStorage() {
  return {
    getItem: (_k: string): string | null => { throw new Error("SecurityError: storage access denied"); },
    setItem: (_k: string, _v: string) => { throw new Error("QuotaExceededError: storage full"); },
    removeItem: (_k: string) => { throw new Error("nope"); },
  };
}

// ── globalThis.localStorage save/restore ────────────────────────────────────
// We swap the real localStorage with a controlled mock for tests that exercise
// the no-argument / undefined (global-storage) path.  The original is restored
// afterward so sibling test files are never affected.

let _origLS: PropertyDescriptor | undefined;

beforeEach(() => {
  _origLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
});

afterEach(() => {
  if (_origLS === undefined) {
    delete (globalThis as any).localStorage;
  } else {
    Object.defineProperty(globalThis, "localStorage", _origLS);
  }
  _origLS = undefined;
});

/** Install a deterministic mock on globalThis.localStorage and return it so
 *  callers can inspect its contents.  afterEach restores the original. */
function installMockGlobal(): ReturnType<typeof mockStorage> {
  const store = mockStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: store,
    configurable: true,
  });
  return store;
}

// ── constants ───────────────────────────────────────────────────────────────

test("UNIT_SYSTEM_KEY and DEFAULT_UNIT_SYSTEM are the expected strings", () => {
  assert.equal(UNIT_SYSTEM_KEY, "opentakeoff.unitSystem");
  assert.equal(DEFAULT_UNIT_SYSTEM, "imperial");
});

// ── normalizeUnitSystem ─────────────────────────────────────────────────────

test("normalizeUnitSystem returns 'metric' only for the exact string 'metric'", () => {
  assert.equal(normalizeUnitSystem("metric"), "metric");
  assert.equal(normalizeUnitSystem("imperial"), "imperial");
});

test("normalizeUnitSystem falls back to 'imperial' for every invalid input", () => {
  for (const v of ["METRIC", "Metric", "", null, undefined, 42, "si", "si SYSTEM"]) {
    assert.equal(normalizeUnitSystem(v), "imperial", `expected imperial for ${JSON.stringify(v)}`);
  }
});

// ── readUnitSystem (explicit storage argument) ──────────────────────────────

test("readUnitSystem returns 'imperial' when storage has no persisted key", () => {
  assert.equal(readUnitSystem(mockStorage()), "imperial");
});

test("readUnitSystem returns the persisted value when valid", () => {
  const store = mockStorage();
  store.setItem(UNIT_SYSTEM_KEY, "metric");
  assert.equal(readUnitSystem(store), "metric");
});

test("readUnitSystem normalises an invalid persisted value to imperial", () => {
  const store = mockStorage();
  store.setItem(UNIT_SYSTEM_KEY, "si");
  assert.equal(readUnitSystem(store), "imperial");
});

test("readUnitSystem returns imperial when storage throws", () => {
  assert.equal(readUnitSystem(throwingStorage()), "imperial");
});

// ── writeUnitSystem (explicit storage argument) ─────────────────────────────

test("writeUnitSystem persists 'metric' as-is", () => {
  const store = mockStorage();
  writeUnitSystem("metric", store);
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "metric");
});

test("writeUnitSystem normalises invalid values before persisting", () => {
  const store = mockStorage();
  writeUnitSystem("si", store);
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "imperial");
  writeUnitSystem("", store);
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "imperial");
  writeUnitSystem("METRIC", store);
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "imperial");
});

test("writeUnitSystem does not throw when storage.setItem throws", () => {
  assert.doesNotThrow(() => writeUnitSystem("metric", throwingStorage()));
});

// ── round-trip: write then read (explicit storage) ──────────────────────────

test("write then read round-trips to 'metric'", () => {
  const store = mockStorage();
  writeUnitSystem("metric", store);
  assert.equal(readUnitSystem(store), "metric");
});

test("write then read round-trips to 'imperial'", () => {
  const store = mockStorage();
  writeUnitSystem("imperial", store);
  assert.equal(readUnitSystem(store), "imperial");
});

test("write invalid then read defaults to imperial", () => {
  const store = mockStorage();
  writeUnitSystem("garbage", store);
  assert.equal(readUnitSystem(store), "imperial");
});

// ── writeUnitSystem return value ────────────────────────────────────────────

test("writeUnitSystem returns 'metric' for valid metric input", () => {
  assert.equal(writeUnitSystem("metric", mockStorage()), "metric");
});

test("writeUnitSystem returns 'imperial' for valid imperial input", () => {
  assert.equal(writeUnitSystem("imperial", mockStorage()), "imperial");
});

test("writeUnitSystem returns normalised value when storage throws", () => {
  assert.equal(writeUnitSystem("metric", throwingStorage()), "metric");
  assert.equal(writeUnitSystem("si", throwingStorage()), "imperial");
  assert.equal(writeUnitSystem("imperial", throwingStorage()), "imperial");
});

// ── omitted / undefined storage → falls through to globalThis.localStorage ──
// A deterministic mock global is installed so these tests never read or write
// real browser storage.  The beforeEach/afterEach save/restore cycle ensures
// the original descriptor is put back after every test.

test("readUnitSystem(undefined) reads from the mocked globalThis.localStorage", () => {
  const store = installMockGlobal();
  store.setItem(UNIT_SYSTEM_KEY, "metric");
  assert.equal(readUnitSystem(undefined), "metric");
});

test("readUnitSystem() with no argument reads from the mocked globalThis.localStorage", () => {
  const store = installMockGlobal();
  store.setItem(UNIT_SYSTEM_KEY, "metric");
  assert.equal(readUnitSystem(), "metric");
});

test("writeUnitSystem(undefined) writes to the mocked globalThis.localStorage", () => {
  const store = installMockGlobal();
  writeUnitSystem("metric", undefined);
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "metric");
  assert.equal(readUnitSystem(store), "metric");
});

test("writeUnitSystem() with no argument writes to the mocked globalThis.localStorage", () => {
  const store = installMockGlobal();
  writeUnitSystem("metric");
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "metric");
  assert.equal(readUnitSystem(store), "metric");
});

test("writeUnitSystem returns normalised value when writing to the mocked global", () => {
  installMockGlobal();
  assert.equal(writeUnitSystem("metric", undefined), "metric");
  assert.equal(writeUnitSystem("si", undefined), "imperial");
  assert.equal(writeUnitSystem("imperial", undefined), "imperial");
});

test("readUnitSystem returns imperial when the mocked global has no persisted key", () => {
  installMockGlobal();
  assert.equal(readUnitSystem(undefined), "imperial");
  assert.equal(readUnitSystem(), "imperial");
});

// ── explicit null storage: bypasses global entirely ─────────────────────────

test("readUnitSystem(null) returns imperial even when the mocked global holds a value", () => {
  const store = installMockGlobal();
  store.setItem(UNIT_SYSTEM_KEY, "metric");
  // null means "skip storage entirely" — must not read from the global mock
  assert.equal(readUnitSystem(null), "imperial");
});

test("writeUnitSystem(value, null) does not write to the mocked global", () => {
  const store = installMockGlobal();
  writeUnitSystem("metric", null);
  // The global mock must remain empty — null storage skips it
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), null);
});

test("writeUnitSystem returns normalised value with null storage", () => {
  installMockGlobal();
  assert.equal(writeUnitSystem("metric", null), "metric");
  assert.equal(writeUnitSystem("si", null), "imperial");
});

// ── throwing globalThis.localStorage getter ─────────────────────────────────
// A throwing getter (sandboxed iframes, certain privacy modes) must be caught
// by the try/catch inside each function, not escape to the caller.

test("readUnitSystem falls back to imperial when globalThis.localStorage getter throws", () => {
  Object.defineProperty(globalThis, "localStorage", {
    get() { throw new Error("SecurityError: localStorage is not accessible"); },
    configurable: true,
  });
  assert.equal(readUnitSystem(), "imperial");
  assert.equal(readUnitSystem(undefined), "imperial");
});

test("writeUnitSystem returns normalised value when globalThis.localStorage getter throws", () => {
  Object.defineProperty(globalThis, "localStorage", {
    get() { throw new Error("SecurityError: localStorage is not accessible"); },
    configurable: true,
  });
  assert.equal(writeUnitSystem("metric"), "metric");
  assert.equal(writeUnitSystem("si"), "imperial");
  assert.equal(writeUnitSystem("imperial"), "imperial");
});

test("readUnitSystem falls back to imperial when globalThis.localStorage.getItem throws", () => {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem() { throw new Error("QuotaExceededError"); },
      setItem() {},
    },
    configurable: true,
  });
  assert.equal(readUnitSystem(), "imperial");
});

test("writeUnitSystem returns normalised value when globalThis.localStorage.setItem throws", () => {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: () => null,
      setItem() { throw new Error("QuotaExceededError: storage full"); },
    },
    configurable: true,
  });
  assert.equal(writeUnitSystem("metric"), "metric");
  assert.equal(writeUnitSystem("garbage"), "imperial");
});

// ── LEGACY MIGRATION ────────────────────────────────────────────────────────

test("migrateLegacyUnit promotes legacy 'metric' to canonical key when canonical is absent", () => {
  const store = mockStorage();
  store.setItem(LEGACY_UNIT_KEY, "metric");
  const ok = migrateLegacyUnit(store);
  assert.equal(ok, true, "should return true on success");
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "metric");
  assert.equal(store.getItem(LEGACY_UNIT_KEY), null, "legacy key should be removed after migration");
});

test("migrateLegacyUnit promotes legacy 'imperial' to canonical key when canonical is absent", () => {
  const store = mockStorage();
  store.setItem(LEGACY_UNIT_KEY, "imperial");
  const ok = migrateLegacyUnit(store);
  assert.equal(ok, true, "should return true on success");
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "imperial");
  assert.equal(store.getItem(LEGACY_UNIT_KEY), null, "legacy key should be removed after migration");
});

test("migrateLegacyUnit does NOT overwrite a valid canonical value", () => {
  const store = mockStorage();
  store.setItem(UNIT_SYSTEM_KEY, "metric");
  store.setItem(LEGACY_UNIT_KEY, "imperial");
  const ok = migrateLegacyUnit(store);
  assert.equal(ok, true, "should return true (no migration needed, cleanup succeeded)");
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "metric", "canonical must not be overwritten");
  assert.equal(store.getItem(LEGACY_UNIT_KEY), null, "legacy key should still be cleaned up");
});

test("migrateLegacyUnit ignores an invalid legacy value", () => {
  const store = mockStorage();
  store.setItem(LEGACY_UNIT_KEY, "si");
  const ok = migrateLegacyUnit(store);
  assert.equal(ok, true, "should return true (cleanup succeeded even with invalid legacy)");
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), null, "canonical must not be set from invalid legacy");
  assert.equal(store.getItem(LEGACY_UNIT_KEY), null, "legacy key should still be cleaned up");
});

test("migrateLegacyUnit is a no-op when neither key exists", () => {
  const store = mockStorage();
  const ok = migrateLegacyUnit(store);
  assert.equal(ok, true, "should return true when nothing to do");
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), null);
});

test("migrateLegacyUnit is a no-op with null storage (bypass)", () => {
  const store = installMockGlobal();
  store.setItem(LEGACY_UNIT_KEY, "metric");
  const ok = migrateLegacyUnit(null);
  assert.equal(ok, true, "null storage means nothing to do — considered complete");
  // null storage skips everything — global mock must be untouched
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), null);
  assert.equal(store.getItem(LEGACY_UNIT_KEY), "metric");
});

test("migrateLegacyUnit does not throw when storage throws", () => {
  assert.doesNotThrow(() => migrateLegacyUnit(throwingStorage()));
});

test("migrateLegacyUnit returns false when storage throws", () => {
  const ok = migrateLegacyUnit(throwingStorage());
  assert.equal(ok, false, "should return false to signal storage failure");
});

test("LEGACY_UNIT_KEY is the expected legacy string", () => {
  assert.equal(LEGACY_UNIT_KEY, "opentakeoff_units");
});

// ── fail-then-recover: proves legacy metric is eventually promoted ──────────
// Simulates a temporary storage failure followed by recovery.  The caller
// (UnitSystemProvider) would invoke migrateLegacyUnit in a loop; this test
// proves the retry contract: first call returns false (storage broken),
// second call returns true (storage recovered), and the legacy key is promoted.

test("migrateLegacyUnit fail-then-recover: legacy metric promoted after storage recovers", () => {
  const map = new Map<string, string>();
  let shouldFail = true;

  const recoverableStore = {
    getItem: (k: string): string | null => {
      if (shouldFail) throw new Error("transient storage failure");
      return map.has(k) ? map.get(k)! : null;
    },
    setItem: (k: string, v: string) => {
      if (shouldFail) throw new Error("transient storage failure");
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      if (shouldFail) throw new Error("transient storage failure");
      map.delete(k);
    },
  };

  // Seed the legacy key while storage is healthy, then break it
  shouldFail = false;
  map.set(LEGACY_UNIT_KEY, "metric");
  shouldFail = true;

  // First attempt — storage is broken, returns false, legacy key untouched
  const first = migrateLegacyUnit(recoverableStore);
  assert.equal(first, false, "first attempt should return false (storage failure)");
  assert.equal(map.get(LEGACY_UNIT_KEY), "metric", "legacy key must survive the failure");

  // Storage recovers
  shouldFail = false;

  // Second attempt — storage works, returns true, legacy promoted to canonical
  const second = migrateLegacyUnit(recoverableStore);
  assert.equal(second, true, "second attempt should return true (storage recovered)");
  assert.equal(map.get(UNIT_SYSTEM_KEY), "metric", "canonical key should be set after recovery");
  assert.ok(!map.has(LEGACY_UNIT_KEY), "legacy key should be cleaned up after recovery");
});
