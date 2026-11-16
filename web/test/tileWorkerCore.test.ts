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

// Shared documents (#580): sheets opened with one docKey read from one document.
function sharedHarness(opts: { idleMs?: number; maxSheets?: number } = {}) {
  const loads: { data: ArrayBuffer | Blob; loading: ReturnType<typeof deferred<{ getPage(n: number): Promise<string> }>>; destroyed: number }[] = [];
  const posts: Record<string, unknown>[] = [];
  const cleaned: string[] = [];
  const renders: { page: string; result: ReturnType<typeof deferred<ImageBitmap>> }[] = [];
  const core = createTileWorkerCore<string>({
    load(data) {
      const load = { data, loading: deferred<{ getPage(n: number): Promise<string> }>(), destroyed: 0 }; loads.push(load);
      return { promise: load.loading.promise, async destroy() { load.destroyed++; } };
    },
    render(page) { const r = { page, result: deferred<ImageBitmap>() }; renders.push(r); return { promise: r.result.promise, cancel() {} }; },
    post(m) { posts.push(m as Record<string, unknown>); },
    cleanup(page) { cleaned.push(page); },
    idleMs: opts.idleMs ?? 1000, maxSheets: opts.maxSheets,
  });
  const blob = new Blob(["%PDF"]);
  const open = (sheetKey: string, pageNum: number, docKey = "hash-a") => core.handle({ type: "openSheet", sheetKey, openId: 1, pageNum, data: blob, docKey });
  const close = (sheetKey: string) => core.handle({ type: "closeSheet", sheetKey });
  const doc = { async getPage(n: number) { return `page${n}`; } };
  return { core, loads, posts, cleaned, renders, open, close, doc, blob };
}
test("sheets with one docKey share one document, handed the Blob itself; another key loads its own", async () => {
  const h = sharedHarness(); h.open("a", 1); h.open("b", 2); h.open("c", 1, "hash-b");
  assert.equal(h.loads.length, 2); assert.equal(h.loads[0].data, h.blob);
  for (const l of h.loads) l.loading.resolve(h.doc);
  await tick();
  assert.equal(h.posts.filter(m => m.type === "sheetReady").length, 3);
  h.close("a"); assert.equal(h.loads[0].destroyed, 0, "b still reads from it");
  h.close("b"); h.close("c");
});
test("a flip keeps the document: closing the last sheet waits, and the next open reuses it", async () => {
  const h = sharedHarness(); h.open("a", 1); h.loads[0].loading.resolve(h.doc); await tick();
  h.close("a"); assert.equal(h.loads[0].destroyed, 0); assert.equal(h.core.docCount, 1);
  h.open("b", 2); await tick();
  assert.equal(h.loads.length, 1, "no second parse");
  assert.deepEqual(h.cleaned, ["page1"], "the page left behind frees what it cached");
  const tile = h.core.handle({ ...request(1), sheetKey: "b" }); await tick();
  assert.equal(h.renders[0].page, "page2");
  h.renders[0].result.resolve({ close() {} } as ImageBitmap); await tile;
  h.close("b");
});
test("an idle shared document is destroyed after idleMs, and at once when not kept", async () => {
  const h = sharedHarness({ idleMs: 5 }); h.open("a", 1); h.loads[0].loading.resolve(h.doc); await tick();
  h.close("a"); assert.equal(h.loads[0].destroyed, 0);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.loads[0].destroyed, 1); assert.equal(h.core.docCount, 0);
  h.open("a", 1); assert.equal(h.loads.length, 2, "a later open loads afresh");
  const now = sharedHarness({ idleMs: 0 }); now.open("a", 1); now.loads[0].loading.resolve(now.doc); await tick();
  now.close("a"); assert.equal(now.loads[0].destroyed, 1);
});
test("a shared document that has opened maxSheets sheets goes at its next last close", async () => {
  const h = sharedHarness({ maxSheets: 2 }); h.open("a", 1); h.loads[0].loading.resolve(h.doc); await tick();
  h.close("a"); assert.equal(h.loads[0].destroyed, 0);
  h.open("b", 2); await tick(); h.close("b");
  assert.equal(h.loads[0].destroyed, 1); assert.equal(h.core.docCount, 0);
  h.open("c", 3); assert.equal(h.loads.length, 2);
});
test("a page two sheets show is cleaned only when the second closes; renders on it run one at a time", async () => {
  const h = sharedHarness(); h.open("a", 1); h.open("ref::a", 1); h.loads[0].loading.resolve(h.doc); await tick();
  const t1 = h.core.handle({ ...request(1), sheetKey: "a" }), t2 = h.core.handle({ ...request(2), sheetKey: "ref::a" }); await tick();
  assert.equal(h.renders.length, 1, "the second waits for the first");
  h.renders[0].result.resolve({ close() {} } as ImageBitmap); await t1; await tick();
  assert.equal(h.renders.length, 2);
  h.renders[1].result.resolve({ close() {} } as ImageBitmap); await t2;
  h.close("a"); assert.deepEqual(h.cleaned, []);
  h.close("ref::a"); assert.deepEqual(h.cleaned, ["page1"]);
});
test("a shared document that can't load errors every sheet on it, is destroyed once, and isn't reused", async () => {
  const h = sharedHarness(); h.open("a", 1); h.open("b", 2);
  h.loads[0].loading.reject(new Error("bad document")); await tick();
  assert.equal(h.posts.filter(m => m.type === "sheetError").length, 2);
  assert.equal(h.loads[0].destroyed, 1); assert.equal(h.core.docCount, 0);
  h.open("a", 1); assert.equal(h.loads.length, 2);
});
test("pageText reads a page from the shared document for its key, with no sheet open, and lets the document go after", async () => {
  const loads: { loading: ReturnType<typeof deferred<{ getPage(n: number): Promise<string> }>>; destroyed: number }[] = [];
  const posts: Record<string, unknown>[] = [];
  const core = createTileWorkerCore<string>({
    load() { const l = { loading: deferred<{ getPage(n: number): Promise<string> }>(), destroyed: 0 }; loads.push(l); return { promise: l.loading.promise, async destroy() { l.destroyed++; } }; },
    render() { throw new Error("no render in this test"); },
    post(m) { posts.push(m as Record<string, unknown>); },
    async text(page, scale) { if (page === "page3") throw new Error("unreadable"); return { page, scale }; },
    idleMs: 1000, maxSheets: 3,
  });
  const blob = new Blob(["%PDF"]);
  const ask = (reqId: number, pageNum: number) => core.handle({ type: "pageText", reqId, pageNum, scale: 2, data: blob, docKey: "text\u0000k" });
  const a = ask(1, 1), b = ask(2, 2);
  assert.equal(loads.length, 1, "two reads, one document");
  loads[0].loading.resolve({ async getPage(n: number) { return `page${n}`; } });
  await a; await b;
  assert.deepEqual(posts, [{ type: "pageText", reqId: 1, text: { page: "page1", scale: 2 } }, { type: "pageText", reqId: 2, text: { page: "page2", scale: 2 } }]);
  assert.equal(loads[0].destroyed, 0, "kept for the next read");
  await ask(3, 3);
  assert.deepEqual(posts[2], { type: "pageTextError", reqId: 3, message: "unreadable" });
  assert.equal(loads[0].destroyed, 1, "three reads in, it is recycled: a whole set's text never gathers in one document");
  void ask(4, 4); assert.equal(loads.length, 2);
});
test("warmDoc loads a document ahead of its sheet, which then opens without a second load", async () => {
  const h = sharedHarness({ maxSheets: 1 });
  const warmed = h.core.handle({ type: "warmDoc", data: h.blob, docKey: "hash-a" });
  assert.equal(h.loads.length, 1);
  h.loads[0].loading.resolve(h.doc); await warmed;
  assert.equal(h.loads[0].destroyed, 0, "kept: warming is not a use toward maxSheets");
  h.open("a", 1); await tick();
  assert.equal(h.loads.length, 1); assert.equal(h.posts.filter(m => m.type === "sheetReady").length, 1);
  h.close("a"); assert.equal(h.loads[0].destroyed, 1);
  const none = sharedHarness({ idleMs: 0 });
  none.core.handle({ type: "warmDoc", data: none.blob, docKey: "hash-a" });
  assert.equal(none.loads.length, 0, "nothing to warm where documents aren't kept");
});
