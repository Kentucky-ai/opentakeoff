// Unit-system localStorage preference — persistence, fallback, and storage-error
// resilience.  Every test uses a plain-object mock so no real localStorage is
// touched (safe in node, safe in browser, deterministic either way).
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { UNIT_SYSTEM_KEY, DEFAULT_UNIT_SYSTEM, normalizeUnitSystem, readUnitSystem, writeUnitSystem } from "../src/lib/unitPreference.js";

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
// the no-argument (global-storage) path.  The original is restored afterward
// so sibling test files are never affected.

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

// ── readUnitSystem ──────────────────────────────────────────────────────────

test("readUnitSystem returns 'imperial' when storage has no persisted key", () => {
  const store = mockStorage();
  assert.equal(readUnitSystem(store), "imperial");
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

test("readUnitSystem uses globalThis.localStorage when storage is undefined (omitted)", () => {
  assert.equal(readUnitSystem(undefined), "imperial");
});

test("readUnitSystem returns imperial when storage is explicitly null", () => {
  assert.equal(readUnitSystem(null), "imperial");
});

// ── writeUnitSystem ─────────────────────────────────────────────────────────

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

test("writeUnitSystem does not throw when storage is undefined (omitted)", () => {
  assert.doesNotThrow(() => writeUnitSystem("metric", undefined));
});

test("writeUnitSystem does not throw when storage is explicitly null", () => {
  assert.doesNotThrow(() => writeUnitSystem("metric", null));
});

// ── round-trip: write then read ─────────────────────────────────────────────

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
  const store = mockStorage();
  assert.equal(writeUnitSystem("metric", store), "metric");
});

test("writeUnitSystem returns 'imperial' for valid imperial input", () => {
  const store = mockStorage();
  assert.equal(writeUnitSystem("imperial", store), "imperial");
});

test("writeUnitSystem returns normalised value when storage throws", () => {
  assert.equal(writeUnitSystem("metric", throwingStorage()), "metric");
  assert.equal(writeUnitSystem("si", throwingStorage()), "imperial");
  assert.equal(writeUnitSystem("imperial", throwingStorage()), "imperial");
});

test("writeUnitSystem returns normalised value when storage is undefined", () => {
  assert.equal(writeUnitSystem("metric", undefined), "metric");
});

test("writeUnitSystem returns normalised value when storage is explicitly null", () => {
  assert.equal(writeUnitSystem("metric", null), "metric");
  assert.equal(writeUnitSystem("si", null), "imperial");
});

// ── explicit null storage: skips global, never touches it ───────────────────

test("readUnitSystem(null) returns imperial without touching globalThis.localStorage", () => {
  const store = mockStorage();
  store.setItem(UNIT_SYSTEM_KEY, "metric");
  Object.defineProperty(globalThis, "localStorage", {
    value: store,
    configurable: true,
  });
  // null means "skip storage entirely" — should return imperial, not the
  // value persisted in the global mock
  assert.equal(readUnitSystem(null), "imperial");
});

test("writeUnitSystem(value, null) does not write to globalThis.localStorage", () => {
  const store = mockStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: store,
    configurable: true,
  });
  writeUnitSystem("metric", null);
  // The global mock must remain empty — null storage skips it
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), null);
});

// ── throwing globalThis.localStorage getter ─────────────────────────────────
// These tests exercise the no-argument path where storage is resolved from
// globalThis.localStorage.  A throwing getter (sandboxed iframes, certain
// privacy modes) must be caught by the try/catch inside each function.

test("readUnitSystem falls back to imperial when globalThis.localStorage getter throws", () => {
  Object.defineProperty(globalThis, "localStorage", {
    get() { throw new Error("SecurityError: localStorage is not accessible"); },
    configurable: true,
  });
  assert.equal(readUnitSystem(), "imperial");
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

test("readUnitSystem uses globalThis.localStorage when no argument is passed", () => {
  const store = mockStorage();
  store.setItem(UNIT_SYSTEM_KEY, "metric");
  Object.defineProperty(globalThis, "localStorage", {
    value: store,
    configurable: true,
  });
  assert.equal(readUnitSystem(), "metric");
});

test("writeUnitSystem writes to globalThis.localStorage when no argument is passed", () => {
  const store = mockStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: store,
    configurable: true,
  });
  writeUnitSystem("metric");
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "metric");
  assert.equal(readUnitSystem(store), "metric");
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
