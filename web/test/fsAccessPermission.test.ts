// Folder-sync permission query (#316): the boot gate asks the browser whether
// a persisted folder handle is still allowed. That query can stay pending
// forever, which left the app on a blank page. These tests pin the bound.
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryFolderPermission, PERMISSION_QUERY_TIMEOUT_MS } from "../src/lib/fs/fsAccess.js";

const handleThat = (queryPermission: () => Promise<string>) => ({ queryPermission }) as any;

test("a query the browser answers passes straight through", async () => {
  for (const state of ["granted", "prompt", "denied"]) {
    assert.equal(await queryFolderPermission(handleThat(async () => state)), state);
  }
});

test("a query that throws reads as denied", async () => {
  assert.equal(await queryFolderPermission(handleThat(async () => { throw new Error("gone"); })), "denied");
});

test("a query that never answers resolves as unresponsive after the timeout", async () => {
  const started = Date.now();
  const result = await queryFolderPermission(handleThat(() => new Promise(() => {})), { timeoutMs: 40 });
  assert.equal(result, "unresponsive");
  assert.ok(Date.now() - started < 1000, "must not wait on the hung query");
});

test("an answered query does not leave the timer running", async () => {
  // If the timer were left armed, node:test would hold the process open for
  // the full default wait; a fast answer must clear it.
  const started = Date.now();
  await queryFolderPermission(handleThat(async () => "granted"));
  assert.ok(Date.now() - started < PERMISSION_QUERY_TIMEOUT_MS / 2);
});
