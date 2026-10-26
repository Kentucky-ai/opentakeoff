import { test } from "node:test";
import assert from "node:assert/strict";
import { createTileWorkerCore, type TileRender } from "../src/lib/tileWorkerCore.ts";
const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (reqId: number): TileRender => ({ type: "renderTile", reqId, sheetKey: "same", scale: 2, rect: { x: 3, y: 4, w: 5, h: 6 }, dark: false });
function harness() {
  const loads: { loading: ReturnType<typeof deferred<{ getPage(n: number): Promise<string> }>>; destroyed: number; destroyError: boolean }[] = [];
  const posts: Record<string, unknown>[] = [];
  const renders: { page: string; request: TileRender; cancelled: number; result: ReturnType<typeof deferred<ImageBitmap>> }[] = [];
  const core = createTileWorkerCore({
    load() {
      const load = { loading: deferred<{ getPage(n: number): Promise<string> }>(), destroyed: 0, destroyError: false }; loads.push(load);
      return { promise: load.loading.promise, async destroy() { load.destroyed++; if (load.destroyError) throw new Error("destroy failed"); } };
    },
    render(page: string, req) {
      const r = { page, request: req, cancelled: 0, result: deferred<ImageBitmap>() }; renders.push(r);
      return { promise: r.result.promise, cancel() { r.cancelled++; } };
    },
    post(m) { posts.push(m as Record<string, unknown>); },
  });
  const open = (openId: number) => core.handle({ type: "openSheet", sheetKey: "same", openId, pageNum: 1, data: new ArrayBuffer(1) });
  const close = () => core.handle({ type: "closeSheet", sheetKey: "same" });
  const doc = (page: string) => ({ async getPage() { return page; } });
  return { core, loads, posts, renders, open, close, doc };
}
for (const late of ["resolve", "reject", "never settles"] as const) {
  test(`close/reopen owns ready/error and drains queued tiles when old load ${late}`, async () => {
    const h = harness(); h.open(1);
    const oldTile = h.core.handle(request(1));
    h.close(); h.open(2);
    if (late === "resolve") h.loads[0].loading.resolve(h.doc("old"));
    if (late === "reject") h.loads[0].loading.reject(new Error("Loading aborted"));
    await oldTile;
    assert.equal(h.core.pendingCount, 0);
    h.loads[1].loading.resolve(h.doc("new")); await tick();
    const next = h.core.handle(request(2)); await tick();
    assert.equal(h.renders[0].page, "new");
    const bitmap = { close() {} } as ImageBitmap;
    h.renders[0].result.resolve(bitmap); await next;
    assert.deepEqual(h.posts.filter(m => m.type === "sheetReady"), [{ type: "sheetReady", sheetKey: "same", openId: 2 }]);
    assert.equal(h.posts.filter(m => m.type === "sheetError").length, 0);
    assert.equal(h.posts.filter(m => m.type === "tile").length, 1);
    assert.equal(h.loads[0].destroyed, 1); assert.equal(h.loads[1].destroyed, 0);
    h.close(); h.close(); assert.equal(h.loads[1].destroyed, 1);
    assert.equal(h.core.pendingCount, 0);
  });
}
test("late getPage success/failure cannot publish or delete reopened entry", async () => {
  for (const fail of [false, true]) {
    const h = harness(); const page = deferred<string>();
    h.open(1); h.loads[0].loading.resolve({ getPage: () => page.promise }); await tick();
    h.close(); h.open(2); h.loads[1].loading.resolve(h.doc("new"));
    if (fail) page.reject(new Error("old page failed")); else page.resolve("old");
    await tick();
    assert.deepEqual(h.posts, [{ type: "sheetReady", sheetKey: "same", openId: 2 }]);
    assert.equal(h.loads[0].destroyed, 1);
  }
});
test("load/page failures destroy resources once and permit retry, even when destroy rejects", async () => {
  for (const failure of ["load", "page"]) {
    const h = harness(); h.open(1); h.loads[0].destroyError = true;
    if (failure === "load") h.loads[0].loading.reject(new Error("bad document"));
    else h.loads[0].loading.resolve({ async getPage() { throw new Error("bad page"); } });
    await tick(); h.close(); h.open(2); await tick();
    assert.equal(h.loads[0].destroyed, 1); assert.equal(h.loads.length, 2);
    assert.equal(h.posts.filter(m => m.type === "sheetError").length, 1);
  }
});
test("closing drains active and queued renders even if pdf.js cancellation never settles", async () => {
  const h = harness(); h.open(1); h.loads[0].loading.resolve(h.doc("old")); await tick();
  const a = h.core.handle(request(1)), b = h.core.handle(request(2)); await tick();
  h.close(); await Promise.all([a, b]);
  assert.equal(h.renders[0].cancelled, 1); assert.equal(h.core.pendingCount, 0);
  assert.equal(h.posts.filter(m => m.type === "tileError").length, 2);
  let closed = 0;
  h.renders[0].result.resolve({ close() { closed++; } } as ImageBitmap); await tick();
  assert.equal(closed, 1); assert.equal(h.posts.filter(m => m.type === "tile").length, 0);
});
test("individual cancellation drains a waiter on a never-settling sheet", async () => {
  const h = harness(); h.open(1); const tile = h.core.handle(request(1)); await tick();
  h.core.handle({ type: "cancel", reqId: 1 }); await tile;
  assert.equal(h.core.pendingCount, 0); assert.deepEqual(h.posts, []); h.close();
});
test("duplicate open is idempotent and ordinary tiles keep their request geometry", async () => {
  const h = harness(); h.open(1); h.open(1); assert.equal(h.loads.length, 1);
  h.loads[0].loading.resolve(h.doc("page")); await tick();
  const tile = h.core.handle(request(1)); await tick();
  assert.deepEqual(h.renders[0].request, request(1));
  h.renders[0].result.resolve({ close() {} } as ImageBitmap); await tile;
  assert.equal(h.core.pendingCount, 0); h.close();
});
