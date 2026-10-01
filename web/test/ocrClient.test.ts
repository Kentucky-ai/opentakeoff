// The main-thread OCR client (#469), with fakes for fetch, Cache Storage and
// the worker. Pins the probe states, the consent gate (no worker until the
// person agrees or the files are already cached), the FIFO read queue, abort,
// and recovery after a worker crash or dispose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcrClient, type WorkerLike } from "../src/lib/ocr/client.ts";
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

/** A worker that answers init with ready, and holds recognize until told. */
function fakeWorker(onInit: (w: FakeWorker, msg: Msg) => void = (w) => w.reply({ type: "ready" })): FakeWorker {
  const w = { onmessage: null, onerror: null, posted: [], terminated: false } as unknown as FakeWorker;
  w.postMessage = (msg: unknown, transfer?: Transferable[]) => {
    // Real transfer semantics: a detached buffer throws DataCloneError, and a
    // sent one is detached afterwards, as with a real Worker.
    structuredClone(msg, { transfer: transfer ?? [] });
    w.posted.push({ msg: msg as Msg, transfer });
    if ((msg as Msg).type === "init") queueMicrotask(() => onInit(w, msg as Msg));
  };
  w.terminate = () => { w.terminated = true; };
  w.reply = (data) => w.onmessage?.({ data });
  w.crash = (message) => w.onerror?.({ message });
  return w;
}

function setup(opts: { cached?: string[]; sizes?: Record<string, number>; enabled?: boolean; fetch?: ReturnType<typeof fakeFetch>; worker?: () => FakeWorker } = {}) {
  const fetch = opts.fetch ?? fakeFetch();
  const caches = fakeCaches(opts.cached ?? [], opts.sizes);
  const spawned: FakeWorker[] = [];
  const client = createOcrClient({
    enabled: opts.enabled ?? true,
    fetchImpl: fetch.fetchImpl as never,
    cacheStorage: caches.cacheStorage as never,
    spawnWorker: () => { const w = (opts.worker ?? (() => fakeWorker()))(); spawned.push(w); return w; },
  });
  return { client, fetch, caches, spawned };
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

async function readyClient() {
  const s = setup({ cached: ALL });
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
