// Company setup: estimating defaults + proposal text (lib/companySetup.js) and
// the contact fields on trade-name profiles (lib/identity.js). The dialog itself
// is exercised in the app (web/scripts/verify-company-setup.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeEstimatingDefaults, loadEstimatingDefaults, saveEstimatingDefaults, hasEstimatingDefaults, TEXT_LIMIT, DEFAULT_VALID_DAYS } from "../src/lib/companySetup.js";
import { loadProfiles, saveProfiles, addProfile, loadCompany } from "../src/lib/identity.js";

function stubStore() {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}
const unstub = () => { delete (globalThis as any).localStorage; };

test("an empty setup is all zeros, markup, 30 days and no text — nothing seeded", () => {
  assert.deepEqual(sanitizeEstimatingDefaults(undefined), {
    tax_pct: 0, overhead_pct: 0, profit_pct: 0, profit_mode: "markup",
    valid_days: DEFAULT_VALID_DAYS, inclusions: "", exclusions: "", terms: "",
  });
  assert.equal(hasEstimatingDefaults({}), false);
});

test("bad numbers and modes fall back; text is capped, never coerced from non-strings", () => {
  const d = sanitizeEstimatingDefaults({
    tax_pct: "6.5", overhead_pct: -3, profit_pct: "abc", profit_mode: "gross",
    valid_days: 2.5, inclusions: 42, exclusions: "x".repeat(TEXT_LIMIT + 10), terms: "Net 30", extra: "dropped",
  });
  assert.equal(d.tax_pct, 6.5);
  assert.equal(d.overhead_pct, 0);
  assert.equal(d.profit_pct, 0);
  assert.equal(d.profit_mode, "markup");
  assert.equal(d.valid_days, DEFAULT_VALID_DAYS);
  assert.equal(d.inclusions, "");
  assert.equal(d.exclusions.length, TEXT_LIMIT);
  assert.equal(d.terms, "Net 30");
  assert.equal("extra" in d, false);
  assert.equal(sanitizeEstimatingDefaults({ valid_days: 400 }).valid_days, DEFAULT_VALID_DAYS);
  assert.equal(sanitizeEstimatingDefaults({ valid_days: 45 }).valid_days, 45);
});

test("any entered number or text counts as a setup worth carrying in a profile", () => {
  assert.equal(hasEstimatingDefaults({ overhead_pct: 10 }), true);
  assert.equal(hasEstimatingDefaults({ profit_mode: "margin" }), true);
  assert.equal(hasEstimatingDefaults({ valid_days: 60 }), true);
  assert.equal(hasEstimatingDefaults({ terms: "  " }), false);
  assert.equal(hasEstimatingDefaults({ terms: "Net 30" }), true);
});

test("save → load round-trips through the sanitizer", () => {
  stubStore();
  try {
    assert.equal(saveEstimatingDefaults({ overhead_pct: 10, profit_pct: 100 / 3, profit_mode: "margin", terms: "Net 30", junk: 1 }), true);
    const d = loadEstimatingDefaults();
    assert.equal(d.overhead_pct, 10);
    assert.equal(d.profit_mode, "margin");
    assert.equal(d.terms, "Net 30");
    assert.equal("junk" in d, false);
  } finally { unstub(); }
});

test("load survives corrupt JSON and a missing localStorage; save reports failure", () => {
  const store = stubStore();
  try {
    store.set("opentakeoff_estimating_defaults", "{not json");
    assert.equal(loadEstimatingDefaults().profit_mode, "markup");
  } finally { unstub(); }
  assert.equal(loadEstimatingDefaults().tax_pct, 0);
  assert.equal(saveEstimatingDefaults({ tax_pct: 5 }), false);
});

test("trade-name profiles keep phone, email and license; the legacy mirror stays name/address/logo", () => {
  stubStore();
  try {
    const { state } = addProfile({ profiles: [], activeId: null }, {
      name: "Sample Floors", address: "1 Main St", phone: " 555-0100 ", email: "bids@example.com", license: "LIC-1", injected: "x",
    });
    assert.equal(saveProfiles(state), true);
    const p = loadProfiles().profiles[0];
    assert.equal(p.phone, "555-0100");
    assert.equal(p.email, "bids@example.com");
    assert.equal(p.license, "LIC-1");
    assert.equal("injected" in p, false);
    assert.deepEqual(loadCompany(), { name: "Sample Floors", address: "1 Main St" });
  } finally { unstub(); }
});
