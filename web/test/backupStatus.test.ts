// Backup reminder rule + the one-time persist request (lib/backupStatus.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_STATE_KEY, REMIND_AFTER_MS, readBackupState, requestPersistentStorage, markBackupDone,
  dismissBackupReminder, backupReminder,
} from "../src/lib/backupStatus.js";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}
const NOW = new Date("2026-11-19T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

test("reminder: nothing to lose, nothing shown", () => {
  assert.equal(backupReminder({}, { hasData: false, now: NOW }), null);
});

test("reminder: not persisted and never backed up → not-persisted; persisted and never → stale", () => {
  assert.equal(backupReminder({}, { hasData: true, now: NOW }), "not-persisted");
  assert.equal(backupReminder({ persist: { granted: false } }, { hasData: true, now: NOW }), "not-persisted");
  assert.equal(backupReminder({ persist: { granted: true } }, { hasData: true, now: NOW }), "stale");
});

test("reminder: a backup within 14 days quiets it; older than 14 days brings it back", () => {
  assert.equal(backupReminder({ persist: { granted: true }, last_backup: ago(3) }, { hasData: true, now: NOW }), null);
  assert.equal(backupReminder({ persist: { granted: false }, last_backup: ago(13.9) }, { hasData: true, now: NOW }), null);
  assert.equal(backupReminder({ persist: { granted: true }, last_backup: ago(14.1) }, { hasData: true, now: NOW }), "stale");
  assert.equal(backupReminder({ persist: { granted: false }, last_backup: ago(30) }, { hasData: true, now: NOW }), "not-persisted");
  assert.equal(backupReminder({ last_backup: "garbage" }, { hasData: true, now: NOW }), "not-persisted");
});

test("reminder: Not now quiets it for 14 days", () => {
  assert.equal(backupReminder({ dismissed: ago(1) }, { hasData: true, now: NOW }), null);
  assert.equal(backupReminder({ dismissed: ago(15) }, { hasData: true, now: NOW }), "not-persisted");
  assert.equal(REMIND_AFTER_MS, 14 * 86_400_000);
});

test("state: mark done and dismiss round-trip through storage; a bad record reads as empty", () => {
  const s = new MemStorage();
  assert.deepEqual(readBackupState(s), {});
  dismissBackupReminder(s, NOW);
  assert.equal(readBackupState(s).dismissed, NOW.toISOString());
  markBackupDone(s, NOW);
  assert.equal(readBackupState(s).last_backup, NOW.toISOString());
  assert.equal(readBackupState(s).dismissed, null);
  s.setItem(BACKUP_STATE_KEY, "{not json");
  assert.deepEqual(readBackupState(s), {});
  const blocked = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); } };
  assert.deepEqual(readBackupState(blocked as any), {});
  assert.doesNotThrow(() => markBackupDone(blocked as any, NOW));
});

test("persist: asks once when not yet persisted and records the answer", async () => {
  const s = new MemStorage();
  let asked = 0;
  const nav = { storage: { persisted: async () => false, persist: async () => { asked++; return true; } } };
  const r = await requestPersistentStorage({ nav, storage: s, now: () => NOW });
  assert.deepEqual(r, { granted: true, supported: true, checked: NOW.toISOString() });
  assert.equal(asked, 1);
  assert.equal(readBackupState(s).persist.granted, true);
});

test("persist: already persisted is only read; denial, errors and no API are recorded, never thrown", async () => {
  const s = new MemStorage();
  let asked = 0;
  await requestPersistentStorage({ nav: { storage: { persisted: async () => true, persist: async () => { asked++; return true; } } }, storage: s, now: () => NOW });
  assert.equal(asked, 0);
  assert.equal((await requestPersistentStorage({ nav: { storage: { persisted: async () => false, persist: async () => false } }, storage: s, now: () => NOW })).granted, false);
  assert.equal((await requestPersistentStorage({ nav: { storage: { persist: async () => { throw new Error("nope"); } } }, storage: s, now: () => NOW })).granted, false);
  const none = await requestPersistentStorage({ nav: {}, storage: s, now: () => NOW });
  assert.deepEqual(none, { granted: false, supported: false, checked: NOW.toISOString() });
});
