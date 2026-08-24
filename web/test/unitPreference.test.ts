// Unit-system localStorage preference — persistence, fallback, and storage-error
// resilience.  Every test uses a plain-object mock so no real localStorage is
// touched (safe in node, safe in browser, deterministic either way).
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { UNIT_SYSTEM_KEY, DEFAULT_UNIT_SYSTEM, normalizeUnitSystem, readUnitSystem, writeUnitSystem } from "../src/lib/unitPreference.js";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Minimal localStorage-shaped object backed by a Map. */
function mockStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    get _map() { return map; },
  };
}

/** Storage that throws on every operation (SecurityError / quota). */
function throwingStorage() {
  return {
    getItem: () => { throw new Error("SecurityError: storage access denied"); },
    setItem: () => { throw new Error("QuotaExceededError: storage full"); },
    removeItem: () => { throw new Error("nope"); },
  };
}

// ── globalThis.localStorage save/restore ────────────────────────────────────
// We swap the real localStorage with a controlled mock for tests that exercise
// the default-parameter path.  The original is restored afterward so sibling
// test files are never affected.

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
  assert.equal(normalizeUnitSystem("imperial"), "imperial");  // explicit valid value still works
});

test("normalizeUnitSystem falls back to 'imperial' for every invalid input", () => {
  for (const v of ["METRIC", "Metric", "", null, undefined, 42, "si", "si SYSTEM"]) {
    assert.equal(normalizeUnitSystem(v), "imperial", `expected imperial for ${JSON.stringify(v)}`);
  }
});

// ── readUnitSystem ──────────────────────────────────────────────────────────

test("readUnitSystem returns 'imperial' when localStorage is empty", () => {
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

test("readUnitSystem returns imperial when storage.getItem returns null (missing key)", () => {
  const store = mockStorage();
  // getItem returns null by default
  assert.equal(readUnitSystem(store), "imperial");
});

test("readUnitSystem returns imperial when storage throws", () => {
  assert.equal(readUnitSystem(throwingStorage()), "imperial");
});

test("readUnitSystem returns imperial when storage is undefined/null (SSR guard)", () => {
  // passing undefined/null as storage — the ?. optional chain should handle it
  assert.equal(readUnitSystem(undefined), "imperial");
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
  // must not propagate
  assert.doesNotThrow(() => writeUnitSystem("metric", throwingStorage()));
});

test("writeUnitSystem is a no-op when storage is undefined/null", () => {
  // must not throw
  assert.doesNotThrow(() => writeUnitSystem("metric", undefined));
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

test("writeUnitSystem returns 'imperial' when storage throws", () => {
  assert.equal(writeUnitSystem("metric", throwingStorage()), "metric");
  assert.equal(writeUnitSystem("si", throwingStorage()), "imperial");
  assert.equal(writeUnitSystem("imperial", throwingStorage()), "imperial");
});

test("writeUnitSystem returns the normalised value when storage is undefined/null", () => {
  assert.equal(writeUnitSystem("metric", undefined), "metric");
  assert.equal(writeUnitSystem("si", null), "imperial");
});

// ── throwing globalThis.localStorage getter ─────────────────────────────────
// These tests exercise the default-parameter path where no explicit `storage`
// argument is passed.  A throwing getter (sandboxed iframes, certain privacy
// modes) must be caught by the try/catch inside each function, not escape
// through the parameter default evaluation.

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
