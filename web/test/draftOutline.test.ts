// draftOutline — persistence for the opt-in "outline area while drawing"
// preference. Mirrors drawStyles.js's persistence section / theme.js exactly:
// localStorage guarded on `typeof localStorage` (not `typeof window` — the
// stubbed-localStorage idiom below depends on it), event dispatch guarded on
// `typeof window`, cross-tab sync via `storage` (which never fires in the
// setting tab, so no double-apply). No canvas changes in this module.
//
// Plain `node --test` has neither `window` nor `StorageEvent` as globals (only
// `CustomEvent`/`Event`/`EventTarget` are). The event-dispatch and init tests
// below stub `globalThis.window` with a real `EventTarget` — bare `window`
// references inside draftOutline.js resolve to it via normal global lookup —
// and simulate a cross-tab write with `new Event("storage")` plus the
// `key`/`newValue` properties a real StorageEvent would carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getDraftOutline, setDraftOutline, onDraftOutlineChange, initDraftOutline,
} from "../src/lib/draftOutline.js";

const KEY = "opentakeoff_draft_outline";
const EVT = "opentakeoff:draftoutline";

// ── stubbed globalThis.localStorage (drawStyles.test.ts / identity.test.ts idiom)
function stubStore() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}
const unstub = () => { delete (globalThis as { localStorage?: unknown }).localStorage; };

// ── stubbed globalThis.window (a real EventTarget) — see file banner ────────
function stubWindow() {
  const win = new EventTarget();
  (globalThis as unknown as { window: unknown }).window = win;
  return win;
}
const unstubWindow = () => { delete (globalThis as { window?: unknown }).window; };

test("getDraftOutline: default is false with no stored value", () => {
  const store = stubStore();
  try {
    assert.equal(store.has(KEY), false);
    assert.equal(getDraftOutline(), false);
  } finally { unstub(); }
});

test("getDraftOutline: no localStorage at all reads as false (node test env)", () => {
  assert.equal(typeof globalThis.localStorage, "undefined");
  assert.equal(getDraftOutline(), false);
});

test("setDraftOutline: round-trips true and false through the stubbed store", () => {
  const store = stubStore();
  try {
    setDraftOutline(true);
    assert.equal(getDraftOutline(), true);
    setDraftOutline(false);
    assert.equal(getDraftOutline(), false);
    // storage encoding is an explicit "1"/"0" string, not the JS booleans
    setDraftOutline(true);
    assert.equal(store.get(KEY), "1");
    setDraftOutline(false);
    assert.equal(store.get(KEY), "0");
  } finally { unstub(); }
});

test("getDraftOutline: garbage or unrecognized stored values fall back to false", () => {
  const store = stubStore();
  try {
    for (const bad of ["true", "yes", "on", "2", "", "banana"]) {
      store.set(KEY, bad);
      assert.equal(getDraftOutline(), false, `garbage value ${JSON.stringify(bad)} reads as false`);
    }
  } finally { unstub(); }
});

test("persistence never throws: quota setItem, throwing getItem, no localStorage at all", () => {
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => {},
  };
  try {
    assert.doesNotThrow(() => setDraftOutline(true));
    assert.equal(getDraftOutline(), false, "a throwing getItem reads as the default");
  } finally { unstub(); }
  assert.equal(typeof globalThis.localStorage, "undefined"); // node test env
  assert.equal(getDraftOutline(), false);
  assert.doesNotThrow(() => setDraftOutline(true));
});

// ── event dispatch (setDraftOutline / onDraftOutlineChange) ─────────────────
test("setDraftOutline dispatches opentakeoff:draftoutline with the boolean detail", () => {
  const store = stubStore();
  const win = stubWindow();
  try {
    const seen: unknown[] = [];
    const h = (e: Event) => seen.push((e as CustomEvent).detail);
    win.addEventListener(EVT, h);
    setDraftOutline(true);
    setDraftOutline(false);
    assert.deepEqual(seen, [true, false]);
    assert.equal(typeof seen[0], "boolean", "detail is a real boolean, not a string");
  } finally { unstub(); unstubWindow(); }
});

test("onDraftOutlineChange: subscribes and the returned fn unsubscribes", () => {
  const store = stubStore();
  stubWindow();
  try {
    const seen: unknown[] = [];
    const unsub = onDraftOutlineChange((v: boolean) => seen.push(v));
    setDraftOutline(true);
    assert.deepEqual(seen, [true]);
    unsub();
    setDraftOutline(false);
    assert.deepEqual(seen, [true], "no further calls after unsubscribe");
  } finally { unstub(); unstubWindow(); }
});

// ── initDraftOutline: cross-tab storage sync, no double-apply in the setting tab
test("initDraftOutline: a storage event from another tab re-broadcasts as the local event", () => {
  const store = stubStore();
  const win = stubWindow();
  try {
    initDraftOutline();
    const seen: unknown[] = [];
    const unsub = onDraftOutlineChange((v: boolean) => seen.push(v));
    try {
      // Simulate another tab writing "1" and firing a native `storage` event
      // (no StorageEvent global under plain node — a base Event carrying the
      // same key/newValue fields models it; `storage` never fires in the tab
      // that called setItem, so this models cross-tab sync, not a local echo).
      store.set(KEY, "1");
      const se = Object.assign(new Event("storage"), { key: KEY, newValue: "1", oldValue: "0" });
      win.dispatchEvent(se);
      assert.deepEqual(seen, [true], "storage event from another tab re-broadcasts as a local change");
    } finally { unsub(); }
  } finally { unstub(); unstubWindow(); }
});

test("initDraftOutline: storage events for unrelated keys are ignored", () => {
  const store = stubStore();
  const win = stubWindow();
  try {
    initDraftOutline();
    const seen: unknown[] = [];
    const unsub = onDraftOutlineChange((v: boolean) => seen.push(v));
    try {
      const se = Object.assign(new Event("storage"), { key: "some_other_key", newValue: "1", oldValue: null });
      win.dispatchEvent(se);
      assert.deepEqual(seen, [], "unrelated key never re-broadcasts");
    } finally { unsub(); }
  } finally { unstub(); unstubWindow(); }
});

test("initDraftOutline: setDraftOutline in THIS tab does not double-apply via storage", () => {
  const store = stubStore();
  stubWindow();
  try {
    initDraftOutline();
    const seen: unknown[] = [];
    const unsub = onDraftOutlineChange((v: boolean) => seen.push(v));
    try {
      // Plain node (like a real browser tab) never fires a native `storage`
      // event from a local setItem — setDraftOutline's own CustomEvent
      // dispatch is the only thing that should land, exactly once.
      setDraftOutline(true);
      assert.deepEqual(seen, [true], "exactly one apply from the local set, no storage echo");
    } finally { unsub(); }
  } finally { unstub(); unstubWindow(); }
});

test("initDraftOutline: a garbage newValue from another tab is ignored, not coerced to true", () => {
  const store = stubStore();
  const win = stubWindow();
  try {
    initDraftOutline();
    const seen: unknown[] = [];
    const unsub = onDraftOutlineChange((v: boolean) => seen.push(v));
    try {
      const se = Object.assign(new Event("storage"), { key: KEY, newValue: "banana", oldValue: "0" });
      win.dispatchEvent(se);
      assert.deepEqual(seen, [], "garbage newValue never broadcasts a change");
    } finally { unsub(); }
  } finally { unstub(); unstubWindow(); }
});
