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
test("a byte-range source reaches every worker as its Blob and key, uncopied (#580)", async () => {
  const workers: { sent: [Record<string, unknown>, unknown][] }[] = [];
  class FakeWorker {
    sent: [Record<string, unknown>, unknown][] = [];
    onmessage?: (e: unknown) => void;
    constructor() { workers.push(this); }
    postMessage(m: Record<string, unknown>, transfer?: unknown) { this.sent.push([m, transfer]); }
    terminate() {}
  }
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const pool = createTilePool(3);
  try {
    pool.prewarm(); assert.equal(workers.length, 3, "prewarm starts every worker");
    const blob = new Blob(["%PDF-1.7"]);
    void pool.openSheet("a#7", 7, { blob, key: "hash-a" }).catch(() => {});
    assert.equal(workers.length, 3);
    for (const w of workers) {
      const [m, transfer] = w.sent[0];
      assert.equal(m.data, blob); assert.equal(m.docKey, "hash-a"); assert.equal(m.pageNum, 7);
      assert.equal(transfer, undefined, "nothing is transferred or copied");
    }
    const bytes = new ArrayBuffer(4);
    void pool.openSheet("b", 1, bytes).catch(() => {});
    const copies = workers.map(w => w.sent[1][0].data as ArrayBuffer);
    assert.equal(new Set(copies).size, 3); assert.ok(copies.every(c => c !== bytes && c.byteLength === 4));
    assert.ok(workers.every(w => w.sent[1][0].docKey === undefined));
  } finally { pool.dispose(); globalThis.Worker = previous; }
});
test("text reads go round the workers under their own document key, and settle by request", async () => {
  const workers: { sent: Record<string, unknown>[]; reply(m: Record<string, unknown>): void }[] = [];
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
    const src = { blob: new Blob(["%PDF"]), key: "k" };
    const reads = [1, 2, 3].map(n => pool.requestText(src, n, 2));
    assert.deepEqual(workers.map(w => w.sent.map(m => m.pageNum)), [[1, 3], [2]]);
    assert.ok(workers.every(w => w.sent.every(m => m.type === "pageText" && m.data === src.blob && m.docKey === "text\u0000k")));
    assert.equal(pool.busy(), false, "a text read is not a tile owed");
    const text = { items: [], viewport: { width: 1, height: 1, transform: [1, 0, 0, 1, 0, 0] } };
    workers[1].reply({ type: "pageText", reqId: workers[1].sent[0].reqId, text });
    workers[0].reply({ type: "pageTextError", reqId: workers[0].sent[0].reqId, message: "bad page" });
    assert.equal(await reads[1], text);
    await assert.rejects(reads[0], /bad page/);
    const dropped = assert.rejects(reads[2], /disposed/);
    pool.dispose(); await dropped;
    await assert.rejects(pool.requestText(src, 9, 2), /disposed/);
  } finally { pool.dispose(); globalThis.Worker = previous; }
});
test("a tile goes past a worker that is reading text while another is free", async () => {
  const workers: { sent: Record<string, unknown>[]; reply(m: Record<string, unknown>): void }[] = [];
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
  const pool = createTilePool(3);
  try {
    const src = { blob: new Blob(["%PDF"]), key: "k" };
    const reads = [pool.requestText(src, 1, 2), pool.requestText(src, 2, 2)]; // workers 0 and 1
    for (const r of reads) r.catch(() => {});
    const tile = () => { const t = pool.requestTile({ sheetKey: "a", scale: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, dark: false }); t.promise.catch(() => {}); };
    const tilesOn = () => workers.map(w => w.sent.filter(m => m.type === "renderTile").length);
    tile(); tile(); tile();
    assert.deepEqual(tilesOn(), [0, 0, 3], "all three on the one free worker");
    workers[0].reply({ type: "pageText", reqId: workers[0].sent[0].reqId, text: { items: [], viewport: { width: 1, height: 1, transform: [] } } });
    tile(); tile();
    assert.deepEqual(tilesOn(), [1, 0, 4], "worker 0 is free again and takes its turn");
    workers[1].reply({ type: "pageTextError", reqId: workers[1].sent[0].reqId, message: "x" });
    void pool.requestText(src, 3, 2).catch(() => {}); void pool.requestText(src, 4, 2).catch(() => {}); void pool.requestText(src, 5, 2).catch(() => {});
    const before = tilesOn().reduce((a, b) => a + b);
    tile();
    assert.equal(tilesOn().reduce((a, b) => a + b), before + 1, "every worker reading: the tile still goes out");
  } finally { pool.dispose(); globalThis.Worker = previous; }
});
