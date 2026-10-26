import { test } from "node:test";
import assert from "node:assert/strict";
import { createTilePool } from "../src/lib/tilePool.ts";
test("pool ignores queued old-generation readiness/error after same-key reopen", async () => {
  const workers: FakeWorker[] = [];
  class FakeWorker {
    sent: Record<string, unknown>[] = [];
    onmessage?: (e: unknown) => void;
    constructor() { workers.push(this); }
    postMessage(m: Record<string, unknown>) { this.sent.push(m); }
    terminate() {}
    reply(m: Record<string, unknown>) { this.onmessage?.({ data: m }); }
  }
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const pool = createTilePool(2);
  try {
    const old = pool.openSheet("a", 1, new ArrayBuffer(1));
    const rejected = assert.rejects(old, /sheet closed/);
    pool.closeSheet("a"); await rejected;
    let settled = false;
    const current = pool.openSheet("a", 1, new ArrayBuffer(1)).then(() => { settled = true; });
    const oldId = workers[0].sent[0].openId, newId = workers[0].sent[2].openId;
    assert.notEqual(oldId, newId);
    for (const w of workers) w.reply({ type: "sheetReady", sheetKey: "a", openId: oldId });
    workers[0].reply({ type: "sheetError", sheetKey: "a", openId: oldId, message: "old failure" });
    await Promise.resolve(); assert.equal(settled, false);
    for (const w of workers) w.reply({ type: "sheetReady", sheetKey: "a", openId: newId });
    await current; assert.equal(settled, true);
    let closed = 0;
    workers[0].reply({ type: "tile", reqId: 999, bitmap: { close() { closed++; } } });
    assert.equal(closed, 1, "unclaimed transferred bitmaps are released");
  } finally { pool.dispose(); globalThis.Worker = previous; }
});
