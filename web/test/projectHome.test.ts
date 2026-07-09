// Project-home core: the Projects-root folder listing and the browser-local
// recents list, tested with fake collaborators (a plain-object drive, a
// plain-object Web Storage) — no network, no DOM, no real localStorage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectHomeFolderId, listProjectFolders, createRecents, browserStorage } from "../src/lib/projectHome.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

test("projectHomeFolderId is empty (feature off) when import.meta.env is absent", () => {
  // Under node, import.meta.env is undefined — the guarded read must not throw.
  assert.equal(projectHomeFolderId(), "");
});

test("listProjectFolders asks Drive for folders only (server-side filter) and returns name-sorted {id, name}", async () => {
  // Recording fake drive: the mimeType option MUST reach listChildren — the
  // real client injects it into the q query, so filtering happens server-side.
  const calls: any[] = [];
  const drive = {
    async listChildren(folderId: string, opts: any) {
      calls.push([folderId, opts]);
      return [
        { id: "f2", name: "Zephyr Tower", mimeType: FOLDER_MIME, modifiedTime: "t" },
        { id: "f1", name: "Acme HQ", mimeType: FOLDER_MIME, modifiedTime: "t" },
      ];
    },
  };
  const folders = await listProjectFolders(drive as any, "root123");
  assert.deepEqual(calls, [["root123", { mimeType: FOLDER_MIME }]]);
  // sorted by name, and stripped to just {id, name}
  assert.deepEqual(folders, [
    { id: "f1", name: "Acme HQ" },
    { id: "f2", name: "Zephyr Tower" },
  ]);
});

// Web-Storage-like fake over a Map — just getItem/setItem, which is all the
// recents store may use (prod passes window.localStorage).
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    _map: map,
    getItem(key: string) { return map.has(key) ? map.get(key)! : null; },
    setItem(key: string, value: string) { map.set(key, String(value)); },
  };
}

test("recents: fresh storage lists empty", () => {
  const recents = createRecents(fakeStorage());
  assert.deepEqual(recents.list(), []);
});

test("recents: remember persists the entry under the shared key and list returns it", () => {
  const storage = fakeStorage();
  createRecents(storage).remember({ id: "p1", name: "Acme HQ" });
  // a NEW instance over the same storage sees it — proof it went through
  // storage (under the stable key) and not module memory
  assert.deepEqual(createRecents(storage).list(), [{ id: "p1", name: "Acme HQ" }]);
  assert.deepEqual(JSON.parse(storage._map.get("opentakeoff_recent_projects")!), [{ id: "p1", name: "Acme HQ" }]);
});

test("recents: list is most-recent-first", () => {
  const recents = createRecents(fakeStorage());
  recents.remember({ id: "p1", name: "First" });
  recents.remember({ id: "p2", name: "Second" });
  recents.remember({ id: "p3", name: "Third" });
  assert.deepEqual(recents.list().map((r) => r.id), ["p3", "p2", "p1"]);
});

test("recents: re-remembering an id moves it to the front (no duplicate) and takes the new name", () => {
  const recents = createRecents(fakeStorage());
  recents.remember({ id: "p1", name: "Old Name" });
  recents.remember({ id: "p2", name: "Other" });
  recents.remember({ id: "p1", name: "Renamed" }); // folder renamed in Drive
  assert.deepEqual(recents.list(), [
    { id: "p1", name: "Renamed" },
    { id: "p2", name: "Other" },
  ]);
});

test("recents: capped at 12, oldest dropped", () => {
  const recents = createRecents(fakeStorage());
  for (let i = 1; i <= 13; i++) recents.remember({ id: `p${i}`, name: `Project ${i}` });
  const ids = recents.list().map((r) => r.id);
  assert.equal(ids.length, 12);
  assert.equal(ids[0], "p13");        // newest kept, at the front
  assert.ok(!ids.includes("p1"));     // oldest fell off
});

test("recents: corrupt JSON reads as empty and the next remember overwrites it cleanly", () => {
  const storage = fakeStorage({ opentakeoff_recent_projects: "{not json" });
  const recents = createRecents(storage);
  assert.deepEqual(recents.list(), []);
  recents.remember({ id: "p1", name: "Fresh" });
  assert.deepEqual(recents.list(), [{ id: "p1", name: "Fresh" }]);
});

test("recents: storage that throws (Safari private mode) — list is [] and remember doesn't throw", () => {
  const recents = createRecents({
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("QuotaExceededError"); },
  });
  assert.deepEqual(recents.list(), []);
  recents.remember({ id: "p1", name: "Acme HQ" }); // must not throw
  assert.deepEqual(recents.list(), []);            // best-effort: nothing stuck
});

test("recents: malformed entries in the stored array are filtered out of list", () => {
  const stored = [
    { id: "p1", name: "Good" },
    { name: "no id" },                 // missing id
    { id: 7, name: "numeric id" },     // non-string id
    { id: "p2" },                      // missing name
    { id: "p3", name: 3 },             // non-string name
    null,                              // not even an object
    "junk",
    { id: "p4", name: "Also good" },
  ];
  const recents = createRecents(fakeStorage({ opentakeoff_recent_projects: JSON.stringify(stored) }));
  assert.deepEqual(recents.list(), [
    { id: "p1", name: "Good" },
    { id: "p4", name: "Also good" },
  ]);
  // a top-level non-array (someone else's data under our key) reads as empty
  assert.deepEqual(createRecents(fakeStorage({ opentakeoff_recent_projects: '{"id":"x"}' })).list(), []);
});

test("browserStorage: without a usable localStorage it degrades to an inert storage — recents list empty, remember a no-op", () => {
  // Under node there is no window.localStorage; in a browser with site data
  // blocked, even ACCESSING window.localStorage throws. Both must degrade to
  // the same inert storage instead of crashing the home screen's render.
  const storage = browserStorage();
  const recents = createRecents(storage);
  assert.deepEqual(recents.list(), []);
  assert.doesNotThrow(() => recents.remember({ id: "p1", name: "Job" }));
  assert.deepEqual(recents.list(), []);
});
