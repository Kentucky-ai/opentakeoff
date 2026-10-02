// The main-thread OCR client (#469), with fakes for fetch, Cache Storage and
// the worker. Pins the probe states, the consent gate (no worker until the
// person agrees or the files are already cached), the FIFO read queue, abort,
// recovery after a worker crash or dispose, and the watchdog on a read that
// never answers (#484). Timers are fakes the test fires by hand, not
// mock.timers: the helpers here wait on real setTimeout(0) ticks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcrClient, OcrTimeoutError, readDeadlineMs, type WorkerLike } from "../src/lib/ocr/client.ts";
import * as clientModule from "../src/lib/ocr/client.ts";
import { cacheKey, cacheName, MANIFEST_URL, type OcrManifest } from "../src/lib/ocr/manifest.ts";

const manifest: OcrManifest = {
  rev: "r1+ort-1",
  files: [
    { name: "det", url: "/models/ocr/det.onnx", bytes: 4_000_000, sha256: "a".repeat(64) },
    { name: "rec", url: "/models/ocr/rec.onnx", bytes: 8_000_000, sha256: "b".repeat(64) },
    { name: "dict", url: "/models/ocr/dict.txt", bytes: 1_000, sha256: "c".repeat(64) },
    { name: "ort-wasm", bytes: 24_000_000, sha256: "d".repeat(64) },
  ],
};
const TOTAL = 36_001_000;

function fakeFetch(respond: () => Response | Promise<Response> = () => Response.json(manifest)) {
  const calls: { url: string; method?: string }[] = [];
  const fetchImpl = async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method });
    return respond();
  };
  return { calls, fetchImpl };
}

/** Cache Storage holding `cachedNames` at their manifest length, or at the
 * length `sizes` gives (a truncated write). Entries answer blob() with a
 * size only, so the fixtures don't allocate the real 36 MB. */
function fakeCaches(cachedNames: string[] = [], sizes: Record<string, number> = {}) {
  const bytesByKey = new Map(manifest.files.filter((f) => cachedNames.includes(f.name)).map((f) => [cacheKey(f), sizes[f.name] ?? f.bytes]));
  const opened: string[] = [];
  return {
    opened,
    cacheStorage: {
      async open(name: string) {
        opened.push(name);
        return {
          async match(key: string) {
            const size = name === cacheName(manifest.rev) ? bytesByKey.get(key) : undefined;
            return size === undefined ? undefined : ({ blob: async () => ({ size }) } as unknown as Response);
          },
          async put() {},
        };
      },
    },
  };
}

type Msg = { type: string; id?: number; [k: string]: unknown };
type FakeWorker = WorkerLike & { posted: { msg: Msg; transfer?: Transferable[] }[]; terminated: boolean; reply: (d: unknown) => void; crash: (m: string) => void };

/** A worker that answers init with ready, and holds recognize until told.
 * Once terminated it goes silent, as a real one does: no reply, no init
 * answer, no crash, so a dead worker can't mask a client that still waits on
 * it. A message already in flight is sent with `w.onmessage` directly. */
function fakeWorker(onInit: (w: FakeWorker, msg: Msg) => void = (w) => w.reply({ type: "ready" })): FakeWorker {
  const w = { onmessage: null, onerror: null, posted: [], terminated: false } as unknown as FakeWorker;
  w.postMessage = (msg: unknown, transfer?: Transferable[]) => {
    // Real transfer semantics: a detached buffer throws DataCloneError, and a
    // sent one is detached afterwards, as with a real Worker.
    structuredClone(msg, { transfer: transfer ?? [] });
    w.posted.push({ msg: msg as Msg, transfer });
    if ((msg as Msg).type === "init") queueMicrotask(() => { if (!w.terminated) onInit(w, msg as Msg); });
  };
  w.terminate = () => { w.terminated = true; };
  w.reply = (data) => { if (!w.terminated) w.onmessage?.({ data }); };
  w.crash = (message) => { if (!w.terminated) w.onerror?.({ message }); };
  return w;
}

type FakeTimer = { fn: () => void; ms: number; cleared: boolean };
/** setTimer/clearTimer the test fires by hand. A cleared timer can still be
 * fired (`t.fn()`), so a test can prove a stale callback does nothing on its
 * own, not just that it was cleared. */
function fakeTimers() {
  const all: FakeTimer[] = [];
  return {
    all,
    live: () => all.filter((t) => !t.cleared),
    setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; all.push(t); return t; },
    clearTimer: (h: unknown) => { (h as FakeTimer).cleared = true; },
  };
}

/** A page's clock and visibility, moved by hand: `t` is now(), `hidden`
 * what isHidden() answers, and `flip()` changes it and tells the client. */
function fakePage() {
  const page = {
    t: 0,
    hidden: false,
    listeners: new Set<() => void>(),
    unsubscribed: 0,
    flip(hidden: boolean) { page.hidden = hidden; for (const f of page.listeners) f(); },
  };
  return page;
}

function setup(opts: { cached?: string[]; sizes?: Record<string, number>; enabled?: boolean; fetch?: ReturnType<typeof fakeFetch>; worker?: () => FakeWorker; hidden?: boolean } = {}) {
  const fetch = opts.fetch ?? fakeFetch();
  const caches = fakeCaches(opts.cached ?? [], opts.sizes);
  const spawned: FakeWorker[] = [];
  const timers = fakeTimers();
  const page = fakePage();
  page.hidden = opts.hidden ?? false;
  const client = createOcrClient({
    enabled: opts.enabled ?? true,
    fetchImpl: fetch.fetchImpl as never,
    cacheStorage: caches.cacheStorage as never,
    spawnWorker: () => { const w = (opts.worker ?? (() => fakeWorker()))(); spawned.push(w); return w; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => page.t,
    isHidden: () => page.hidden,
    onVisibility: (f) => { page.listeners.add(f); return () => { page.unsubscribed++; page.listeners.delete(f); }; },
  });
  return { client, fetch, caches, spawned, timers, page };
}

const geometry = { rect: { x0: 0, y0: 0, x1: 10, y1: 10 }, zoom: 1 };
const region = () => ({ rgba: new Uint8ClampedArray(4 * 10 * 10), width: 10, height: 10, geometry });
const recognizes = (w: FakeWorker) => w.posted.filter((p) => p.msg.type === "recognize");
const tick = () => new Promise((r) => setTimeout(r, 0));
const initsOf = (w: FakeWorker | undefined) => (w?.posted ?? []).filter((p) => p.msg.type === "init");

/** Wait until `n` inits have reached the first spawned worker, then return
 * it. Polls, rather than trusting one tick to be enough, and fails with a
 * message instead of hanging. */
async function initPosted(spawned: FakeWorker[], n = 1): Promise<FakeWorker> {
  for (let i = 0; i < 200; i++) {
    if (initsOf(spawned[0]).length >= n) return spawned[0];
    await tick();
  }
  throw new Error(`expected ${n} init(s) at the worker, saw ${initsOf(spawned[0]).length}`);
}
const ALL = ["det", "rec", "dict", "ort-wasm"];

async function readyClient(opts: { worker?: () => FakeWorker; hidden?: boolean } = {}) {
  const s = setup({ cached: ALL, ...opts });
  assert.deepEqual(await s.client.ensureReady(), { ok: true });
  return { ...s, w: s.spawned[0] };
}

// ── probe ────────────────────────────────────────────────────────────────────

test("disabled: no fetch and no worker", async () => {
  const s = setup({ enabled: false });
  assert.deepEqual(await s.client.probe(), { state: "disabled" });
  assert.deepEqual(await s.client.ensureReady({ consent: true }), { ok: false, reason: "disabled" });
  assert.equal(s.fetch.calls.length, 0);
  assert.equal(s.spawned.length, 0);
});

test("the probe makes exactly one GET, to the manifest", async () => {
  const s = setup();
  const p = await s.client.probe();
  assert.equal(p.state, "available");
  assert.deepEqual(s.fetch.calls, [{ url: MANIFEST_URL, method: undefined }]);
});

test("a 404 is uninstalled, and remembered", async () => {
  const s = setup({ fetch: fakeFetch(() => new Response("", { status: 404 })) });
  assert.deepEqual(await s.client.probe(), { state: "uninstalled" });
  assert.deepEqual(await s.client.probe(), { state: "uninstalled" });
  assert.equal(s.fetch.calls.length, 1);
});

test("a 200 with text/html (an SPA fallback) is uninstalled, and remembered", async () => {
  const s = setup({ fetch: fakeFetch(() => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) });
  assert.deepEqual(await s.client.probe(), { state: "uninstalled" });
  await s.client.probe();
  assert.equal(s.fetch.calls.length, 1);
});

test("a 5xx is a retryable error: the next probe fetches again", async () => {
  const s = setup({ fetch: fakeFetch(() => new Response("", { status: 503 })) });
  assert.equal((await s.client.probe()).state, "error");
  assert.equal((await s.client.probe()).state, "error");
  assert.equal(s.fetch.calls.length, 2);
});

test("a network failure is a retryable error: the next probe fetches again", async () => {
  const s = setup({ fetch: fakeFetch(() => { throw new TypeError("Failed to fetch"); }) });
  assert.equal((await s.client.probe()).state, "error");
  assert.equal((await s.client.probe()).state, "error");
  assert.equal(s.fetch.calls.length, 2);
});

test("a 200 JSON that isn't a valid manifest is a retryable error, not uninstalled", async () => {
  const offSite = { ...manifest, files: manifest.files.map((f) => (f.name === "det" ? { ...f, url: "https://evil.example/det.onnx" } : f)) };
  const s = setup({ fetch: fakeFetch(() => Response.json(offSite)) });
  assert.equal((await s.client.probe()).state, "error");
  assert.equal((await s.client.probe()).state, "error");
  assert.equal(s.fetch.calls.length, 2, "the next probe fetches again");
});

test("uncached: downloadBytes is the whole manifest, raw", async () => {
  const s = setup();
  assert.deepEqual(await s.client.probe(), { state: "available", manifest, cached: false, downloadBytes: TOTAL });
  assert.deepEqual(s.caches.opened, [cacheName(manifest.rev)]);
});

test("partly cached: downloadBytes counts only the missing files", async () => {
  const s = setup({ cached: ["ort-wasm", "dict"] });
  const p = await s.client.probe();
  assert.equal(p.state === "available" && p.cached, false);
  assert.equal(p.state === "available" && p.downloadBytes, 12_000_000);
});

test("fully cached: cached is true and nothing is left to download", async () => {
  const s = setup({ cached: ALL });
  const p = await s.client.probe();
  assert.equal(p.state === "available" && p.cached, true);
  assert.equal(p.state === "available" && p.downloadBytes, 0);
});

test("a cached file with the wrong length counts as missing, as the worker treats it", async () => {
  const s = setup({ cached: ALL, sizes: { dict: 3 } });
  const p = await s.client.probe();
  assert.equal(p.state === "available" && p.cached, false);
  assert.equal(p.state === "available" && p.downloadBytes, 1_000);
});

test("no Cache Storage: available, not cached", async () => {
  const client = createOcrClient({ enabled: true, fetchImpl: fakeFetch().fetchImpl as never, cacheStorage: undefined, spawnWorker: () => fakeWorker() });
  const p = await client.probe();
  assert.equal(p.state === "available" && p.cached, false);
});

// ── consent ──────────────────────────────────────────────────────────────────

test("available and uncached: ensureReady asks for consent and spawns nothing", async () => {
  const s = setup();
  assert.deepEqual(await s.client.ensureReady(), { ok: false, reason: "consent-required" });
  assert.equal(s.spawned.length, 0);
});

test("available and cached: ensureReady starts the worker without consent, network off", async () => {
  const s = setup({ cached: ALL });
  assert.deepEqual(await s.client.ensureReady(), { ok: true });
  assert.equal(s.spawned.length, 1);
  const init = s.spawned[0].posted[0].msg;
  assert.equal(init.type, "init");
  assert.equal(init.allowNetwork, false);
  assert.deepEqual(init.manifest, manifest);
});

test("consent given: the worker downloads, and byte progress turns into pct", async () => {
  const progress: { pct: number; loaded: number; total: number }[] = [];
  const s = setup({
    worker: () => fakeWorker((w) => {
      w.reply({ type: "progress", loaded: 0, total: TOTAL });
      w.reply({ type: "progress", loaded: TOTAL / 2, total: TOTAL });
      w.reply({ type: "progress", loaded: TOTAL, total: TOTAL });
      w.reply({ type: "ready" });
    }),
  });
  assert.deepEqual(await s.client.ensureReady({ consent: true, onProgress: (p) => progress.push(p) }), { ok: true });
  assert.equal(s.spawned[0].posted[0].msg.allowNetwork, true);
  assert.deepEqual(progress.map((p) => p.pct), [0, 50, 100]);
});

test("the worker's own consent check wins when the cache was evicted after the probe", async () => {
  const s = setup({ cached: ALL, worker: () => fakeWorker((w) => w.reply({ type: "error", code: "consent-required", message: "not cached" })) });
  assert.deepEqual(await s.client.ensureReady(), { ok: false, reason: "consent-required" });
});

test("ensureReady once ready answers at once: no second init, no second worker", async () => {
  const { client, w, spawned } = await readyClient();
  assert.deepEqual(await client.ensureReady(), { ok: true });
  assert.deepEqual(await client.ensureReady({ consent: true }), { ok: true });
  assert.equal(initsOf(w).length, 1);
  assert.equal(spawned.length, 1);
});

test("an init error is reported and the next ensureReady tries again", async () => {
  let n = 0;
  const s = setup({ cached: ALL, worker: () => fakeWorker((w) => w.reply(++n === 1 ? { type: "error", code: "init", message: "boom" } : { type: "ready" })) });
  assert.deepEqual(await s.client.ensureReady(), { ok: false, reason: "error", message: "boom" });
  assert.deepEqual(await s.client.ensureReady(), { ok: true });
});

test("aborting ensureReady resolves at once and cancels the download", async () => {
  const s = setup({ worker: () => fakeWorker(() => {}) });
  const ac = new AbortController();
  const p = s.client.ensureReady({ consent: true, signal: ac.signal });
  const w = await initPosted(s.spawned);
  ac.abort();
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
  assert.ok(w.posted.some((x) => x.msg.type === "cancel"));
});

// ── reads ────────────────────────────────────────────────────────────────────

test("recognize before ensureReady rejects", async () => {
  const s = setup();
  await assert.rejects(s.client.recognize(region()), /not ready/);
});

test("a read transfers its pixels and resolves with the worker's words", async () => {
  const { client, w } = await readyClient();
  const r = region();
  const p = client.recognize(r);
  const sent = recognizes(w)[0];
  assert.deepEqual(sent.transfer, [r.rgba.buffer]);
  w.reply({ type: "result", id: sent.msg.id, words: [{ str: "CPT-1", x: 1, y: 2, w: 3, h: 4 }] });
  assert.deepEqual(await p, [{ str: "CPT-1", x: 1, y: 2, w: 3, h: 4 }]);
});

test("reads queue FIFO and only one is sent to the worker at a time", async () => {
  const { client, w } = await readyClient();
  const order: string[] = [];
  const a = client.recognize(region()).then(() => order.push("a"));
  const b = client.recognize(region()).then(() => order.push("b"));
  const c = client.recognize(region()).then(() => order.push("c"));
  assert.equal(recognizes(w).length, 1);
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  await tick();
  assert.equal(recognizes(w).length, 2);
  w.reply({ type: "result", id: recognizes(w)[1].msg.id, words: [] });
  await tick();
  w.reply({ type: "error", id: recognizes(w)[2].msg.id, code: "recognize", message: "bad pixels" });
  await Promise.allSettled([a, b, c]);
  assert.deepEqual(order, ["a", "b"]);
  await assert.rejects(c, /bad pixels/);
  // a rejected read frees the queue too
  const d = client.recognize(region());
  assert.equal(recognizes(w).length, 4);
  w.reply({ type: "result", id: recognizes(w)[3].msg.id, words: [] });
  await d;
});

test("aborting a queued read removes it: it rejects and is never sent", async () => {
  const { client, w } = await readyClient();
  const first = client.recognize(region());
  const ac = new AbortController();
  const queued = client.recognize(region(), { signal: ac.signal });
  ac.abort();
  await assert.rejects(queued, { name: "AbortError" });
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  await first;
  await tick();
  assert.equal(recognizes(w).length, 1);
});

test("aborting the running read rejects at once; the next waits for the worker, the late result is dropped", async () => {
  const { client, w } = await readyClient();
  const ac = new AbortController();
  const running = client.recognize(region(), { signal: ac.signal });
  const next = client.recognize(region());
  ac.abort();
  await assert.rejects(running, { name: "AbortError" });
  await tick();
  assert.equal(recognizes(w).length, 1, "the worker is still busy with the aborted read");
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [{ str: "LATE", x: 0, y: 0, w: 0, h: 0 }] });
  await tick();
  assert.equal(recognizes(w).length, 2);
  w.reply({ type: "result", id: recognizes(w)[1].msg.id, words: [] });
  assert.deepEqual(await next, []);
});

test("an already-aborted signal rejects without queueing", async () => {
  const { client, w } = await readyClient();
  await assert.rejects(client.recognize(region(), { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(recognizes(w).length, 0);
});

test("a region whose pixels were already sent rejects, and the next read still goes out", async () => {
  const { client, w } = await readyClient();
  const r = region();
  const first = client.recognize(r);
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  await first;
  // the caller retries with the same raster; its buffer went to the worker
  await assert.rejects(client.recognize(r), /already|detached|DataCloneError/i);
  const fresh = client.recognize(region());
  await tick();
  assert.equal(recognizes(w).length, 2, "the fresh read was posted");
  w.reply({ type: "result", id: recognizes(w)[1].msg.id, words: [] });
  assert.deepEqual(await fresh, []);
});

test("a queued read whose buffer is detached before its turn rejects; the queue keeps moving", async () => {
  const { client, w } = await readyClient();
  const a = client.recognize(region());
  const rb = region();
  const b = client.recognize(rb);
  const c = client.recognize(region());
  // Someone transfers b's pixels elsewhere while a is running.
  structuredClone(rb.rgba.buffer, { transfer: [rb.rgba.buffer] });
  // a's reply pumps b, whose postMessage throws inside onmessage.
  try { w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] }); } catch { /* the fix must not throw here */ }
  await a;
  const bSettled = await Promise.race([b.then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("hung"), 100))]);
  assert.equal(bSettled, "rejected");
  assert.equal(recognizes(w).length, 2, "c was posted after b failed");
  w.reply({ type: "result", id: recognizes(w)[1].msg.id, words: [] });
  assert.deepEqual(await c, []);
});

test("a worker crash rejects every pending read, and the next ensureReady respawns", async () => {
  const { client, w, spawned } = await readyClient();
  const a = client.recognize(region());
  const b = client.recognize(region());
  w.crash("worker script failed");
  await assert.rejects(a, /worker script failed/);
  await assert.rejects(b, /worker script failed/);
  assert.equal(w.terminated, true);
  await assert.rejects(client.recognize(region()), /not ready/);
  assert.deepEqual(await client.ensureReady(), { ok: true });
  assert.equal(spawned.length, 2);
});

test("a crash during init resolves ensureReady with an error", async () => {
  const s = setup({ cached: ALL, worker: () => fakeWorker((w) => w.crash("module failed to load")) });
  assert.deepEqual(await s.client.ensureReady(), { ok: false, reason: "error", message: "module failed to load" });
});

test("dispose rejects every pending read and ends the worker", async () => {
  const { client, w } = await readyClient();
  const a = client.recognize(region());
  const b = client.recognize(region());
  client.dispose();
  await assert.rejects(a, /disposed/);
  await assert.rejects(b, /disposed/);
  assert.equal(w.terminated, true);
  assert.ok(w.posted.some((p) => p.msg.type === "dispose"));
  await assert.rejects(client.recognize(region()), /not ready/);
});

test("a late reply from an aborted start doesn't settle the next one", async () => {
  // The worker answers nothing on its own; the test replies by hand.
  const s = setup({ cached: ALL, worker: () => fakeWorker(() => {}) });
  const ac = new AbortController();
  const first = s.client.ensureReady({ signal: ac.signal });
  await initPosted(s.spawned);
  ac.abort();
  assert.deepEqual(await first, { ok: false, reason: "aborted" });
  let settled = false;
  const progress: number[] = [];
  const second = s.client.ensureReady({ onProgress: (p) => progress.push(p.pct) }).then((r) => { settled = true; return r; });
  const w = await initPosted(s.spawned, 2);
  const inits = w.posted.filter((p) => p.msg.type === "init").map((p) => p.msg.initId);
  assert.equal(inits.length, 2);
  assert.notEqual(inits[0], inits[1]);
  assert.ok(w.posted.some((p) => p.msg.type === "cancel" && p.msg.initId === inits[0]));
  w.reply({ type: "progress", loaded: 5, total: 10, initId: inits[0] });
  w.reply({ type: "error", code: "aborted", message: "download cancelled", initId: inits[0] });
  await tick();
  assert.equal(settled, false, "the first start's reply is ignored");
  assert.deepEqual(progress, [], "and so is its progress");
  w.reply({ type: "ready", initId: inits[1] });
  assert.deepEqual(await second, { ok: true });
});

// ── concurrent and cancelled starts ─────────────────────────────────────────

/** A manifest fetch that waits until the test releases it. */
function gatedFetch() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  return { release, fetch: fakeFetch(async () => { await gate; return Response.json(manifest); }) };
}

test("an abort then an immediate restart (same tick) starts afresh, not the aborted attempt", async () => {
  const g = gatedFetch();
  const s = setup({ fetch: g.fetch });
  const ac1 = new AbortController();
  const p1 = s.client.ensureReady({ consent: true, signal: ac1.signal });
  ac1.abort();
  const p2 = s.client.ensureReady({ consent: true, signal: new AbortController().signal });
  g.release();
  assert.deepEqual(await p1, { ok: false, reason: "aborted" });
  assert.deepEqual(await p2, { ok: true });
});

test("a caller that brings consent while a consent-less start is probing gets the download", async () => {
  const g = gatedFetch();
  const s = setup({ fetch: g.fetch });
  const background = s.client.ensureReady();
  const clicked = s.client.ensureReady({ consent: true });
  g.release();
  assert.deepEqual(await clicked, { ok: true });
  assert.deepEqual(await background, { ok: true }, "the background caller rides the download");
  assert.equal(s.spawned.length, 1);
  assert.equal(s.spawned[0].posted.find((p) => p.msg.type === "init")?.msg.allowNetwork, true);
});

test("consent that arrives while a cached start is at the worker: an eviction there turns into a download", async () => {
  // Cached at probe time, evicted before the worker reads it. The test replies by hand.
  const s = setup({ cached: ALL, worker: () => fakeWorker(() => {}) });
  const background = s.client.ensureReady();
  const w = await initPosted(s.spawned);
  const inits = () => w.posted.filter((p) => p.msg.type === "init").map((p) => p.msg);
  assert.equal(inits()[0].allowNetwork, false);
  const clicked = s.client.ensureReady({ consent: true });
  w.reply({ type: "error", code: "consent-required", message: "evicted", initId: inits()[0].initId });
  await tick();
  assert.equal(inits().length, 2);
  assert.equal(inits()[1].allowNetwork, true);
  w.reply({ type: "ready", initId: inits()[1].initId });
  assert.deepEqual(await clicked, { ok: true });
  assert.deepEqual(await background, { ok: true });
});

test("every waiting caller gets progress", async () => {
  const s = setup({ worker: () => fakeWorker(() => {}) });
  const a: number[] = [], b: number[] = [];
  const pa = s.client.ensureReady({ consent: true, onProgress: (p) => a.push(p.pct) });
  const pb = s.client.ensureReady({ consent: true, onProgress: (p) => b.push(p.pct) });
  const w = await initPosted(s.spawned);
  const initId = w.posted.find((p) => p.msg.type === "init")?.msg.initId;
  w.reply({ type: "progress", loaded: 5, total: 10, initId });
  w.reply({ type: "ready", initId });
  assert.deepEqual([await pa, await pb], [{ ok: true }, { ok: true }]);
  assert.deepEqual([a, b], [[50], [50]]);
});

test("one caller's abort detaches only that caller; the start goes on for the other", async () => {
  const s = setup({ worker: () => fakeWorker(() => {}) });
  const ac = new AbortController();
  const pa = s.client.ensureReady({ consent: true, signal: ac.signal });
  const pb = s.client.ensureReady({ consent: true });
  const w = await initPosted(s.spawned);
  ac.abort();
  assert.deepEqual(await pa, { ok: false, reason: "aborted" });
  assert.ok(!w.posted.some((p) => p.msg.type === "cancel"), "the other caller still wants it");
  w.reply({ type: "ready", initId: w.posted.find((p) => p.msg.type === "init")?.msg.initId });
  assert.deepEqual(await pb, { ok: true });
});

test("a consent-less caller doesn't keep a download alive once the consenting caller cancels", async () => {
  const s = setup({ worker: () => fakeWorker(() => {}) });
  const ac = new AbortController();
  const clicked = s.client.ensureReady({ consent: true, signal: ac.signal });
  const w = await initPosted(s.spawned);
  const background = s.client.ensureReady();
  ac.abort();
  assert.deepEqual(await clicked, { ok: false, reason: "aborted" });
  assert.deepEqual(await background, { ok: false, reason: "consent-required" });
  const initId = w.posted.find((p) => p.msg.type === "init")?.msg.initId;
  assert.ok(w.posted.some((p) => p.msg.type === "cancel" && p.msg.initId === initId));
});

test("dispose during the probe: no worker is spawned, and the start resolves aborted", async () => {
  const g = gatedFetch();
  const s = setup({ fetch: g.fetch });
  const p = s.client.ensureReady({ consent: true });
  s.client.dispose();
  g.release();
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
  await tick();
  assert.equal(s.spawned.length, 0);
});

test("after dispose, ensureReady resolves aborted and never spawns", async () => {
  const s = setup({ cached: ALL });
  s.client.dispose();
  assert.deepEqual(await s.client.ensureReady({ consent: true }), { ok: false, reason: "aborted" });
  assert.equal(s.spawned.length, 0);
});

// ── the shared engine ───────────────────────────────────────────────────────

test("getOcrClient returns one shared client, created on first call, so features share one worker", () => {
  const mod = clientModule as Record<string, unknown>;
  assert.equal(typeof mod.getOcrClient, "function");
  const get = mod.getOcrClient as () => unknown;
  const a = get();
  assert.equal(get(), a);
  assert.equal(typeof (a as { ensureReady?: unknown }).ensureReady, "function");
});

test("disposing the shared client ends it for good, and the next getOcrClient makes a fresh one", async () => {
  const { getOcrClient } = clientModule;
  const a = getOcrClient();
  a.dispose();
  const b = getOcrClient();
  assert.notEqual(b, a, "a disposed shared client isn't handed out again");
  assert.equal(getOcrClient(), b);
  assert.deepEqual(await a.ensureReady({ consent: true }), { ok: false, reason: "aborted" }, "dispose is final for that instance");
  // Disposing the stale instance again leaves the new one shared.
  a.dispose();
  assert.equal(getOcrClient(), b);
  b.dispose();
});

// ── whenIdle: nothing running or queued (#471: page reads never overlap) ────

/** Has `p` settled within a couple of ticks? */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  await tick(); await tick();
  return done;
}

test("whenIdle resolves at once with nothing running, even before the engine starts", async () => {
  const s = setup();
  assert.equal(await settled(s.client.whenIdle()), true);
  const { client } = await readyClient();
  assert.equal(await settled(client.whenIdle()), true);
});

test("whenIdle waits for the running read and everything queued", async () => {
  const { client, w } = await readyClient();
  const a = client.recognize(region());
  const b = client.recognize(region());
  const idle = client.whenIdle();
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  await a;
  assert.equal(await settled(idle), false, "b is still to run");
  w.reply({ type: "result", id: recognizes(w)[1].msg.id, words: [] });
  await b;
  assert.equal(await settled(idle), true);
});

test("whenIdle after an abort waits for the worker's late reply", async () => {
  const { client, w } = await readyClient();
  const ac = new AbortController();
  const running = client.recognize(region(), { signal: ac.signal });
  ac.abort();
  await assert.rejects(running, { name: "AbortError" });
  const idle = client.whenIdle();
  assert.equal(await settled(idle), false, "the worker is still on the aborted tile");
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  assert.equal(await settled(idle), true);
});

test("whenIdle resolves when a queued read is aborted and nothing else is left", async () => {
  const { client, w } = await readyClient();
  const first = client.recognize(region());
  const ac = new AbortController();
  const queued = client.recognize(region(), { signal: ac.signal });
  const idle = client.whenIdle();
  ac.abort();
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(await settled(idle), false);
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  await first;
  assert.equal(await settled(idle), true);
});

test("whenIdle resolves when a crash or dispose empties the queue", async () => {
  const { client, w } = await readyClient();
  const a = client.recognize(region());
  const idle = client.whenIdle();
  w.crash("gone");
  await assert.rejects(a, /gone/);
  assert.equal(await settled(idle), true);
  const r = await readyClient();
  const b = r.client.recognize(region());
  const idle2 = r.client.whenIdle();
  r.client.dispose();
  await assert.rejects(b, /disposed/);
  assert.equal(await settled(idle2), true);
});

// ── the watchdog: a read that never answers (#484) ──────────────────────────

const mpOf = (r: { width: number; height: number }) => (r.width * r.height) / 1e6;

test("readDeadlineMs: 20× the envelope before calibration, 10× after, never under 120 s", () => {
  assert.equal(readDeadlineMs(16), 350_000, "20 × (1.5 s + 16 × 1.0 s)");
  assert.equal(readDeadlineMs(16, 1), 175_000, "10 × 17.5 s once calibrated");
  assert.equal(readDeadlineMs(16, 2), 350_000, "a device twice as slow gets twice as long");
  assert.equal(readDeadlineMs(1), 120_000, "the floor");
  assert.equal(readDeadlineMs(0.0001), 120_000);
});

test("a read's deadline is armed once it is posted, and its reply clears it", async () => {
  const { client, w, timers } = await readyClient();
  assert.equal(timers.live().length, 0, "nothing armed before a read");
  const r = region();
  const p = client.recognize(r);
  assert.equal(recognizes(w).length, 1);
  assert.equal(timers.live().length, 1);
  assert.equal(timers.live()[0].ms, readDeadlineMs(mpOf(r)));
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  await p;
  assert.equal(timers.live().length, 0, "the reply cleared it");
});

test("a queued read arms nothing until it is posted", async () => {
  const { client, w, timers } = await readyClient();
  const a = client.recognize(region());
  const b = client.recognize(region());
  assert.equal(timers.all.length, 1, "only the posted read is timed");
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  await a;
  assert.equal(timers.live().length, 1, "b is timed once it is posted");
  w.reply({ type: "result", id: recognizes(w)[1].msg.id, words: [] });
  await b;
  assert.equal(timers.live().length, 0);
});

test("a read that never answers times out: it rejects OcrTimeoutError, the worker is ended, and nothing waits forever", async () => {
  const { client, w, timers, spawned } = await readyClient();
  const a = client.recognize(region());
  const idle = client.whenIdle();
  assert.equal(await settled(idle), false);
  timers.live()[0].fn();
  await assert.rejects(a, (e: Error) => e instanceof OcrTimeoutError && e.name === "OcrTimeoutError" && e.message === "The on-device reader stopped responding.");
  assert.equal(w.terminated, true);
  assert.equal(await settled(idle), true, "whenIdle can't hang on a hung worker");
  assert.equal(timers.live().length, 0);
  assert.equal(spawned.length, 2, "a fresh worker, started from the cache");
  assert.deepEqual(await client.ensureReady(), { ok: true });
});

test("an aborted read that then hangs still times out, and whenIdle resolves", async () => {
  const { client, w, timers } = await readyClient();
  const ac = new AbortController();
  const running = client.recognize(region(), { signal: ac.signal });
  ac.abort();
  await assert.rejects(running, { name: "AbortError" });
  const idle = client.whenIdle();
  assert.equal(await settled(idle), false, "the worker is still on the aborted read");
  assert.equal(timers.live().length, 1, "the abort doesn't stop the watchdog");
  timers.live()[0].fn();
  assert.equal(w.terminated, true);
  assert.equal(await settled(idle), true);
});

test("a read whose post throws arms no timer", async () => {
  const { client, w, timers } = await readyClient();
  const a = client.recognize(region());
  const rb = region();
  const b = client.recognize(rb);
  const c = client.recognize(region());
  structuredClone(rb.rgba.buffer, { transfer: [rb.rgba.buffer] });
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  await a;
  await assert.rejects(b);
  assert.equal(timers.all.length, 2, "a and c, not b");
  assert.equal(timers.live().length, 1);
  w.reply({ type: "result", id: recognizes(w)[1].msg.id, words: [] });
  await c;
  assert.equal(timers.live().length, 0);
});

test("dispose and a crash clear the running read's timer", async () => {
  const one = await readyClient();
  const a = one.client.recognize(region());
  one.client.dispose();
  await assert.rejects(a, /disposed/);
  assert.equal(one.timers.live().length, 0);
  const two = await readyClient();
  const b = two.client.recognize(region());
  two.w.crash("gone");
  await assert.rejects(b, /gone/);
  assert.equal(two.timers.live().length, 0);
});

test("a message from an ended worker is ignored: its late ready doesn't settle the next start", async () => {
  let n = 0;
  // The first worker answers init; the second waits for the test.
  const s = setup({ cached: ALL, worker: () => fakeWorker(++n === 1 ? (w) => w.reply({ type: "ready" }) : () => {}) });
  assert.deepEqual(await s.client.ensureReady(), { ok: true });
  const old = s.spawned[0];
  const a = s.client.recognize(region());
  old.crash("gone");
  await assert.rejects(a, /gone/);
  let settledStart = false;
  const restart = s.client.ensureReady().then((r) => { settledStart = true; return r; });
  for (let i = 0; i < 200 && initsOf(s.spawned[1]).length === 0; i++) await tick();
  // A ready the ended worker had already sent arrives now.
  old.onmessage?.({ data: { type: "ready" } });
  await tick();
  assert.equal(settledStart, false, "the old worker's ready isn't the new one's");
  await assert.rejects(s.client.recognize(region()), /not ready/);
  s.spawned[1].reply({ type: "ready", initId: initsOf(s.spawned[1])[0].msg.initId });
  assert.deepEqual(await restart, { ok: true });
});

test("a stale timer leaves a respawned worker alone", async () => {
  const { client, w, timers, spawned } = await readyClient();
  const a = client.recognize(region());
  const stale = timers.live()[0];
  w.crash("gone");
  await assert.rejects(a, /gone/);
  assert.deepEqual(await client.ensureReady(), { ok: true });
  const w2 = spawned[1];
  const b = client.recognize(region());
  stale.fn(); // fires anyway, as a timer already queued would
  assert.equal(w2.terminated, false);
  assert.equal(await settled(b), false, "b is still running");
  w2.reply({ type: "result", id: recognizes(w2)[0].msg.id, words: [] });
  assert.deepEqual(await b, []);
});

test("with no timer deps the client builds under node, and a read round-trips on the default timers", async () => {
  createOcrClient(); // no deps at all: no document, no Worker until asked
  const w = fakeWorker();
  const client = createOcrClient({ enabled: true, fetchImpl: fakeFetch().fetchImpl as never, cacheStorage: fakeCaches(ALL).cacheStorage as never, spawnWorker: () => w });
  assert.deepEqual(await client.ensureReady(), { ok: true });
  const p = client.recognize(region());
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  assert.deepEqual(await p, []);
  // A read left unanswered must not hold node open for its 120 s deadline
  // (the default timer is unref'd); dispose ends it either way.
  const hung = client.recognize(region());
  client.dispose();
  await assert.rejects(hung, /disposed/);
});


test("a hung read whose deadline is unref'd doesn't keep node alive", async () => {
  const w = fakeWorker();
  const client = createOcrClient({ enabled: true, fetchImpl: fakeFetch().fetchImpl as never, cacheStorage: fakeCaches(ALL).cacheStorage as never, spawnWorker: () => w });
  assert.deepEqual(await client.ensureReady(), { ok: true });
  const handles = new Set<unknown>();
  const real = globalThis.setTimeout;
  // Watch which timers the client makes, without changing them.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { const h = real(fn, ms); handles.add(h); return h; }) as typeof setTimeout;
  try {
    let hung: Promise<unknown>;
    try { hung = client.recognize(region()); } finally { globalThis.setTimeout = real; }
    void hung.catch(() => {});
    const armed = [...handles] as NodeJS.Timeout[];
    assert.equal(armed.length, 1, "the read armed one default timer");
    assert.equal(armed[0].hasRef(), false, "unref'd");
  } finally {
    client.dispose(); // a failed assertion mustn't leave a ref'd timer holding node open
  }
});

// ── the watchdog's restart: the queue survives a hung read ──────────────────

/** A ready client whose first worker answers init; later workers (restarts)
 * answer as `later` says, by default not at all, so the test replies. */
async function hungClient(later: (w: FakeWorker, msg: Msg) => void = () => {}) {
  let n = 0;
  const s = await readyClient({ worker: () => fakeWorker(++n === 1 ? (w) => w.reply({ type: "ready" }) : later) });
  return s;
}
/** Wait until spawned[i] has `n` inits. */
async function initAt(spawned: FakeWorker[], i: number, n = 1): Promise<FakeWorker> {
  for (let k = 0; k < 200; k++) {
    if (initsOf(spawned[i]).length >= n) return spawned[i];
    await tick();
  }
  throw new Error(`expected ${n} init(s) at worker ${i}, saw ${initsOf(spawned[i]).length}`);
}
const readyAt = (w: FakeWorker) => w.reply({ type: "ready", initId: initsOf(w).at(-1)?.msg.initId });

test("a timeout restarts the engine from the cache; the reads queued behind wait for it and go to the new worker", async () => {
  const { client, w, timers, spawned } = await hungClient();
  const a = client.recognize(region());
  const b = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  assert.equal(w.terminated, true);
  const w2 = await initAt(spawned, 1);
  assert.equal(initsOf(w2)[0].msg.allowNetwork, false, "cache only");
  const c = client.recognize(region()); // during the restart: queued, not "not ready"
  await tick();
  assert.equal(recognizes(w2).length, 0, "nothing is sent until the new engine is ready");
  assert.equal(await settled(b), false, "b waits for the restart");
  const idle = client.whenIdle();
  readyAt(w2);
  await tick();
  assert.equal(recognizes(w2).length, 1);
  w2.reply({ type: "result", id: recognizes(w2)[0].msg.id, words: [] });
  assert.deepEqual(await b, []);
  w2.reply({ type: "result", id: recognizes(w2)[1].msg.id, words: [] });
  assert.deepEqual(await c, []);
  assert.equal(await settled(idle), true);
});

test("whenIdle waits for a restart, with nothing queued, after a hung read (aborted or not)", async () => {
  for (const abort of [false, true]) {
    const { client, timers, spawned } = await hungClient();
    const ac = new AbortController();
    const a = client.recognize(region(), { signal: ac.signal });
    if (abort) { ac.abort(); await assert.rejects(a, { name: "AbortError" }); }
    timers.live()[0].fn();
    if (!abort) await assert.rejects(a, OcrTimeoutError);
    const idle = client.whenIdle();
    const w2 = await initAt(spawned, 1);
    assert.equal(await settled(idle), false, "restarting isn't idle");
    readyAt(w2);
    assert.equal(await settled(idle), true);
  }
});

test("a restart that doesn't come up in 120 s is ended; its late ready is ignored and the queue rejects", async () => {
  const { client, timers, spawned } = await hungClient();
  const a = client.recognize(region());
  const b = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  const w2 = await initAt(spawned, 1);
  const restartTimer = timers.live().find((t) => t.ms === 120_000);
  assert.ok(restartTimer, "the restart is timed");
  const idle = client.whenIdle();
  restartTimer.fn();
  await assert.rejects(b, OcrTimeoutError);
  assert.equal(w2.terminated, true);
  w2.onmessage?.({ data: { type: "ready", initId: initsOf(w2)[0].msg.initId } });
  await assert.rejects(client.recognize(region()), /not ready/);
  assert.equal(spawned.length, 2);
  assert.equal(await settled(idle), true);
  assert.equal(timers.live().length, 0);
  // The next ensureReady starts afresh, with a fresh allowance: the next
  // hang restarts rather than giving up at once.
  const again = client.ensureReady();
  const w3 = await initAt(spawned, 2);
  readyAt(w3);
  assert.deepEqual(await again, { ok: true });
  const c = client.recognize(region());
  const d = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(c, OcrTimeoutError);
  const w4 = await initAt(spawned, 3);
  readyAt(w4);
  await tick();
  w4.reply({ type: "result", id: recognizes(w4)[0].msg.id, words: [] });
  assert.deepEqual(await d, []);
});

test("an ensureReady caller who joins a restart and aborts doesn't cancel it", async () => {
  const { client, timers, spawned } = await hungClient();
  const a = client.recognize(region());
  const b = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  const w2 = await initAt(spawned, 1);
  const ac = new AbortController();
  const joined = client.ensureReady({ signal: ac.signal });
  ac.abort();
  assert.deepEqual(await joined, { ok: false, reason: "aborted" });
  assert.ok(!w2.posted.some((p) => p.msg.type === "cancel"), "the restart goes on");
  readyAt(w2);
  await tick();
  w2.reply({ type: "result", id: recognizes(w2)[0].msg.id, words: [] });
  assert.deepEqual(await b, []);
});

test("ensureReady during a restart joins it: one init, and it answers with the restart", async () => {
  const { client, timers, spawned } = await hungClient();
  const a = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  const w2 = await initAt(spawned, 1);
  const joined = client.ensureReady();
  await tick();
  assert.equal(initsOf(w2).length, 1);
  readyAt(w2);
  assert.deepEqual(await joined, { ok: true });
  assert.equal(initsOf(w2).length, 1);
  assert.equal(spawned.length, 2);
});

test("a restart never downloads: with the cache evicted it ends consent-required, even for a joiner who consents", async () => {
  const { client, timers, spawned } = await hungClient((w) => w.reply({ type: "error", code: "consent-required", message: "evicted", initId: initsOf(w).at(-1)?.msg.initId }));
  const a = client.recognize(region());
  const b = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  const clicked = client.ensureReady({ consent: true });
  assert.deepEqual(await clicked, { ok: false, reason: "consent-required" });
  await assert.rejects(b, /not ready/);
  const w2 = spawned[1];
  assert.ok(initsOf(w2).length >= 1);
  assert.ok(initsOf(w2).every((p) => p.msg.allowNetwork === false), "no init allowed the network");
  assert.equal(spawned.length, 2);
  await assert.rejects(client.recognize(region()), /not ready/);
  assert.equal(await settled(client.whenIdle()), true);
});

test("a completed read between two timeouts: the second one restarts again", async () => {
  const { client, timers, spawned } = await hungClient((w) => w.reply({ type: "ready", initId: initsOf(w).at(-1)?.msg.initId }));
  const a = client.recognize(region());
  const b = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  const w2 = await initAt(spawned, 1);
  await tick();
  w2.reply({ type: "result", id: recognizes(w2)[0].msg.id, words: [] });
  assert.deepEqual(await b, []);
  const c = client.recognize(region());
  const d = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(c, OcrTimeoutError);
  const w3 = await initAt(spawned, 2);
  await tick();
  w3.reply({ type: "result", id: recognizes(w3)[0].msg.id, words: [] });
  assert.deepEqual(await d, []);
});

test("two timeouts with no completed read between them reject the queue and stop restarting", async () => {
  const { client, timers, spawned } = await hungClient((w) => w.reply({ type: "ready", initId: initsOf(w).at(-1)?.msg.initId }));
  const a = client.recognize(region());
  const b = client.recognize(region());
  const c = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  const w2 = await initAt(spawned, 1);
  await tick();
  assert.equal(recognizes(w2).length, 1, "b went to the new worker");
  const idle = client.whenIdle();
  timers.live()[0].fn(); // b hangs too
  await assert.rejects(b, OcrTimeoutError);
  await assert.rejects(c, OcrTimeoutError);
  assert.equal(w2.terminated, true);
  await tick();
  assert.equal(spawned.length, 2, "no third worker");
  assert.equal(await settled(idle), true);
  await assert.rejects(client.recognize(region()), /not ready/);
  // A fresh ensureReady starts over, with a fresh allowance: the next hang
  // restarts again rather than giving up at once.
  assert.deepEqual(await client.ensureReady(), { ok: true });
  assert.equal(spawned.length, 3);
  const d = client.recognize(region());
  const e = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(d, OcrTimeoutError);
  const w4 = await initAt(spawned, 3);
  await tick();
  w4.reply({ type: "result", id: recognizes(w4)[0].msg.id, words: [] });
  assert.deepEqual(await e, []);
});

test("dispose during a restart clears its timer, rejects the queue and resolves whenIdle", async () => {
  const { client, timers, spawned } = await hungClient();
  const a = client.recognize(region());
  const b = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  const w2 = await initAt(spawned, 1);
  const idle = client.whenIdle();
  client.dispose();
  await assert.rejects(b, /disposed/);
  assert.equal(timers.live().length, 0);
  assert.equal(w2.terminated, true);
  assert.equal(await settled(idle), true);
  assert.deepEqual(await client.ensureReady(), { ok: false, reason: "aborted" });
});

// ── the watchdog counts only time the page is visible ──────────────────────

test("a hidden page pauses a read's deadline; shown again, it resumes with the time left", async () => {
  const { client, w, timers, page } = await readyClient();
  const r = region();
  const a = client.recognize(r);
  const full = readDeadlineMs(mpOf(r));
  assert.equal(timers.live()[0].ms, full);
  page.t = 50_000;
  page.flip(true);
  assert.equal(timers.live().length, 0, "paused while hidden");
  page.t = 10_000_000; // a night in a background tab
  page.flip(false);
  assert.equal(timers.live().length, 1);
  assert.equal(timers.live()[0].ms, full - 50_000, "the remaining time, not a fresh deadline");
  timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  assert.equal(w.terminated, true);
});

test("a read posted while the page is hidden starts paused", async () => {
  const { client, w, timers, page } = await readyClient({ hidden: true });
  const r = region();
  const a = client.recognize(r);
  assert.equal(recognizes(w).length, 1, "the read is sent; only its clock waits");
  assert.equal(timers.live().length, 0);
  page.t = 5_000;
  page.flip(false);
  assert.equal(timers.live()[0].ms, readDeadlineMs(mpOf(r)));
  w.reply({ type: "result", id: recognizes(w)[0].msg.id, words: [] });
  await a;
  assert.equal(timers.live().length, 0);
  page.flip(true);
  page.flip(false);
  assert.equal(timers.live().length, 0, "a settled read's deadline doesn't come back");
});

test("a hidden page pauses the restart's deadline too", async () => {
  const { client, timers, spawned, page } = await hungClient();
  const a = client.recognize(region());
  timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  await initAt(spawned, 1);
  assert.equal(timers.live()[0].ms, 120_000);
  page.t = 30_000;
  page.flip(true);
  assert.equal(timers.live().length, 0);
  page.t = 900_000;
  page.flip(false);
  assert.equal(timers.live()[0].ms, 90_000);
});

test("dispose removes the visibility listener", async () => {
  const { client, page } = await readyClient();
  assert.equal(page.listeners.size, 1);
  client.dispose();
  assert.equal(page.listeners.size, 0);
  assert.equal(page.unsubscribed, 1);
});

// ── calibration: this device's own speed sets the margin ────────────────────

/** A w×h raster: 1000×1000 is 1 MP (an envelope of 2.5 s), 4000×4000 16 MP. */
const sized = (width: number, height: number) => ({ rgba: new Uint8ClampedArray(4 * width * height), width, height, geometry });
const MP16 = () => sized(4000, 4000);

/** Read `r`, answering it `ms` of page time after it was posted. */
async function timedRead(s: { client: ReturnType<typeof createOcrClient>; w: FakeWorker; page: ReturnType<typeof fakePage> }, r: ReturnType<typeof sized>, ms: number) {
  const p = s.client.recognize(r);
  s.page.t += ms;
  s.w.reply({ type: "result", id: recognizes(s.w).at(-1)!.msg.id, words: [] });
  await p;
}
/** The deadline the next 16 MP read gets. */
async function nextDeadline(s: { client: ReturnType<typeof createOcrClient>; w: FakeWorker; timers: ReturnType<typeof fakeTimers> }) {
  const p = s.client.recognize(MP16());
  const ms = s.timers.live()[0].ms;
  s.w.reply({ type: "result", id: recognizes(s.w).at(-1)!.msg.id, words: [] });
  await p;
  return ms;
}

test("before any read the 16 MP deadline is 20× the envelope", async () => {
  const s = await readyClient();
  assert.equal(await nextDeadline(s), 350_000);
});

test("a completed read of 1 MP or more calibrates: a fast device gets 10×", async () => {
  const s = await readyClient();
  await timedRead(s, sized(1000, 1000), 1_000); // under the 2.5 s envelope
  assert.equal(await nextDeadline(s), readDeadlineMs(16, 1));
  assert.equal(readDeadlineMs(16, 1), 175_000);
});

test("a slow device's deadline stretches by its slowdown, and a later fast read doesn't shrink it", async () => {
  const s = await readyClient();
  await timedRead(s, sized(1000, 1000), 7_500); // 3× the 2.5 s envelope
  assert.equal(await nextDeadline(s), 525_000);
  await timedRead(s, sized(1000, 1000), 500);
  assert.equal(await nextDeadline(s), 525_000, "the slowest seen holds");
});

test("small patches don't calibrate: fixed overhead dominates them", async () => {
  const s = await readyClient();
  await timedRead(s, sized(500, 500), 60_000); // 0.25 MP
  assert.equal(await nextDeadline(s), 350_000, "still uncalibrated");
});

test("engine start-up time doesn't count toward a read", async () => {
  const s = setup({ cached: ALL, worker: () => fakeWorker(() => {}) });
  const started = s.client.ensureReady();
  const w = await initPosted(s.spawned);
  s.page.t += 600_000; // a slow start
  readyAt(w);
  assert.deepEqual(await started, { ok: true });
  const t = { ...s, w };
  await timedRead(t, sized(1000, 1000), 1_000);
  assert.equal(await nextDeadline(t), 175_000);
});

test("time hidden doesn't count toward a read's measured speed", async () => {
  const s = await readyClient();
  const p = s.client.recognize(sized(1000, 1000));
  s.page.t = 2_000;
  s.page.flip(true);
  s.page.t = 5_000_000;
  s.page.flip(false);
  s.page.t += 2_000;
  s.w.reply({ type: "result", id: recognizes(s.w).at(-1)!.msg.id, words: [] });
  await p;
  // 4 s visible over both stretches = 1.6× the 2.5 s envelope.
  assert.equal(await nextDeadline(s), readDeadlineMs(16, 1.6));
  assert.equal(readDeadlineMs(16, 1.6), 280_000);
});

test("a timeout while a newer start is still under way doesn't restart beside it: the queue rejects", async () => {
  // An abandoned start's late ready lets reads run while a newer start waits
  // at the same worker. A restart then would race that start for the worker.
  const s = setup({ cached: ALL, worker: () => fakeWorker(() => {}) });
  const ac = new AbortController();
  const first = s.client.ensureReady({ signal: ac.signal });
  const w = await initPosted(s.spawned);
  ac.abort();
  assert.deepEqual(await first, { ok: false, reason: "aborted" });
  const second = s.client.ensureReady();
  await initPosted(s.spawned, 2);
  const inits = initsOf(w).map((p) => p.msg.initId);
  w.reply({ type: "ready", initId: inits[0] }); // the abandoned start's ready
  const a = s.client.recognize(region());
  const b = s.client.recognize(region());
  assert.equal(recognizes(w).length, 1);
  s.timers.live()[0].fn();
  await assert.rejects(a, OcrTimeoutError);
  await assert.rejects(b, OcrTimeoutError);
  const r = await second;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "error");
  await tick();
  assert.equal(s.spawned.length, 1, "no restart");
  await assert.rejects(s.client.recognize(region()), /not ready/);
  assert.equal(await settled(s.client.whenIdle()), true);
});

test("calibration is capped: one very slow read can't stretch the deadline past 8× slowdown", async () => {
  const s = await readyClient();
  await timedRead(s, sized(1000, 1000), 119_000); // ≈ 48× the 2.5 s envelope
  assert.equal(await nextDeadline(s), readDeadlineMs(16, 8));
  assert.equal(readDeadlineMs(16, 8), 1_400_000, "10 × 8 × 17.5 s");
  assert.equal(readDeadlineMs(16, 48), 1_400_000, "readDeadlineMs caps it too");
});

test("a read answered while the page is hidden counts only its visible time", async () => {
  const s = await readyClient();
  const p = s.client.recognize(sized(1000, 1000));
  s.page.t = 2_000;
  s.page.flip(true);
  s.page.t = 5_000_000; // answered in the background
  s.w.reply({ type: "result", id: recognizes(s.w).at(-1)!.msg.id, words: [] });
  await p;
  s.page.flip(false);
  assert.equal(await nextDeadline(s), 175_000, "2 s visible, under the envelope");
});
