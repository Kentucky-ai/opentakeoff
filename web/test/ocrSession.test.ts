// The OCR session (#471): the one consent path every on-device read goes
// through. A fake client stands in for probe/ensureReady; the host's
// requestConsent is a fake notice the test answers. Pinned: probe outcomes
// that need no notice, consent only from Download, the cache evicted between
// probe and start, and one shared notice for concurrent callers (Download
// serves them all, one caller's abort leaves only that caller, the last one
// out closes it, Cancel after Download declines them all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcrSession, type ConsentNotice } from "../src/lib/ocr/session.ts";
import { createOcrClient, type OcrProbe, type OcrProgress, type OcrReady, type WorkerLike } from "../src/lib/ocr/client.ts";
import type { OcrManifest } from "../src/lib/ocr/manifest.ts";

const manifest: OcrManifest = { rev: "r1", files: [{ name: "det", url: "/models/ocr/det.onnx", bytes: 36_000_000, sha256: "a".repeat(64) }] };
const available = (cached: boolean, downloadBytes = cached ? 0 : 36_000_000): OcrProbe => ({ state: "available", manifest, cached, downloadBytes });

type EnsureOpts = { consent?: boolean; signal?: AbortSignal; onProgress?: (p: OcrProgress) => void };

/** A client that answers like the real one (client.ts ensureReady):
 * `start` is what its own start-up probe sees. disabled / uninstalled /
 * error answer at once; files missing and no consent answer
 * consent-required at once, starting nothing; once a start has succeeded
 * every call is ok at once. Anything else is a start that goes to the
 * worker: recorded in `ensure`, waiting until the test settles it (or its
 * signal aborts). probe() answers from `probes` in turn (the last repeats).
 * `calls` records every ensureReady call's options. */
function fakeClient(start: OcrProbe, probes: OcrProbe[] = [start]) {
  const ensure: { opts: EnsureOpts; settle: (r: OcrReady) => void; settled: boolean }[] = [];
  const calls: EnsureOpts[] = [];
  let probeCalls = 0, ready = false;
  return {
    ensure,
    calls,
    consented: () => calls.filter((o) => o.consent === true).length,
    probeCalls: () => probeCalls,
    client: {
      async probe(): Promise<OcrProbe> { return probes[Math.min(probeCalls++, probes.length - 1)]; },
      ensureReady(opts: EnsureOpts = {}): Promise<OcrReady> {
        calls.push(opts);
        if (opts.signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
        if (ready) return Promise.resolve({ ok: true });
        if (start.state === "error") return Promise.resolve({ ok: false, reason: "error", message: start.message });
        if (start.state !== "available") return Promise.resolve({ ok: false, reason: start.state });
        if (!start.cached && opts.consent !== true) return Promise.resolve({ ok: false, reason: "consent-required" });
        return new Promise((resolve) => {
          const e = { opts, settled: false, settle: (r: OcrReady) => { if (!e.settled) { e.settled = true; if (r.ok) ready = true; resolve(r); } } };
          ensure.push(e);
          opts.signal?.addEventListener("abort", () => e.settle({ ok: false, reason: "aborted" }), { once: true });
        });
      },
    },
  };
}

/** A host that records each notice it's asked to show and lets the test
 * press its buttons. It never resolves on its own. */
function fakeHost() {
  const shown: { bytes: number; notice: ConsentNotice; answer: (d: "download" | "cancel") => void; progress: OcrProgress[] }[] = [];
  const requestConsent = (bytes: number, notice: ConsentNotice) => new Promise<"download" | "cancel">((resolve) => {
    const entry = { bytes, notice, answer: resolve, progress: [] as OcrProgress[] };
    notice.onProgress((p) => entry.progress.push(p));
    shown.push(entry);
  });
  return { shown, requestConsent };
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

/** A task that records that it ran and the signal it got. */
function task(value = "text") {
  const calls: (AbortSignal | undefined)[] = [];
  return { calls, fn: async (signal?: AbortSignal) => { calls.push(signal); return value; } };
}

for (const [probe, expected] of [
  [{ state: "disabled" }, { ok: false, reason: "disabled" }],
  [{ state: "uninstalled" }, { ok: false, reason: "uninstalled" }],
  [{ state: "error", message: "manifest request failed (503)" }, { ok: false, reason: "error", message: "manifest request failed (503)" }],
] as [OcrProbe, unknown][]) {
  test(`probe ${probe.state}: a typed result, no notice, no start, no task`, async () => {
    const c = fakeClient(probe), host = fakeHost(), t = task();
    const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
    assert.deepEqual(await s.run(t.fn), expected);
    assert.equal(host.shown.length, 0);
    assert.equal(c.ensure.length, 0);
    assert.equal(c.consented(), 0);
    assert.equal(t.calls.length, 0);
  });
}

test("not cached: asks first, starts nothing until Download, then downloads with consent and runs the task", async () => {
  const c = fakeClient(available(false, 12_345)), host = fakeHost(), t = task("words");
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const ac = new AbortController();
  const p = s.run(t.fn, { signal: ac.signal });
  await flush();
  assert.equal(host.shown.length, 1);
  assert.equal(host.shown[0].bytes, 12_345);
  assert.equal(c.ensure.length, 0, "nothing starts before Download");
  assert.equal(c.consented(), 0, "no ensureReady with consent before Download");
  assert.ok(c.calls.length >= 1 && c.calls.every((o) => o.consent !== true), "asked the client without consent first");
  host.shown[0].answer("download");
  await flush();
  assert.equal(c.ensure.length, 1);
  assert.equal(c.ensure[0].opts.consent, true);
  assert.equal(c.consented(), 1);
  c.ensure[0].opts.onProgress?.({ loaded: 5, total: 10, pct: 50 });
  assert.deepEqual(host.shown[0].progress, [{ loaded: 5, total: 10, pct: 50 }], "progress reaches the notice");
  assert.equal(host.shown[0].notice.signal.aborted, false, "the notice stays up while downloading");
  assert.equal(t.calls.length, 0);
  c.ensure[0].settle({ ok: true });
  assert.deepEqual(await p, { ok: true, value: "words" });
  assert.deepEqual(t.calls, [ac.signal], "the task gets the caller's signal");
  assert.equal(host.shown[0].notice.signal.aborted, true, "the notice closes when the download is done");
});

test("not cached, Cancel: declined, nothing started, the task never runs", async () => {
  const c = fakeClient(available(false)), host = fakeHost(), t = task();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const p = s.run(t.fn);
  await flush();
  host.shown[0].answer("cancel");
  // Checked before awaiting: a Cancel taken for Download would start a
  // download that never settles here, and the await would just hang.
  await flush();
  assert.equal(c.consented(), 0, "Cancel never reaches ensureReady with consent");
  assert.equal(c.ensure.length, 0);
  assert.deepEqual(await p, { ok: false, reason: "declined" });
  assert.equal(t.calls.length, 0);
});

test("cached: starts without asking and without consent", async () => {
  const c = fakeClient(available(true)), host = fakeHost(), t = task();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const p = s.run(t.fn);
  await flush();
  assert.equal(c.ensure.length, 1);
  assert.equal(c.consented(), 0);
  c.ensure[0].settle({ ok: true });
  assert.deepEqual(await p, { ok: true, value: "text" });
  assert.equal(host.shown.length, 0);
});

test("cached, but the cache was evicted before the start: asks, with the bytes probed again, and waits for Download", async () => {
  const c = fakeClient(available(true), [available(false, 777)]), host = fakeHost(), t = task();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const p = s.run(t.fn);
  await flush();
  c.ensure[0].settle({ ok: false, reason: "consent-required" });
  await flush();
  assert.equal(host.shown.length, 1);
  assert.equal(host.shown[0].bytes, 777, "the notice says what will download, not 0");
  assert.equal(c.ensure.length, 1);
  assert.equal(c.consented(), 0, "no consented start before Download");
  assert.equal(t.calls.length, 0);
  host.shown[0].answer("download");
  await flush();
  assert.equal(c.ensure.length, 2);
  assert.equal(c.ensure[1].opts.consent, true);
  c.ensure[1].settle({ ok: true });
  assert.deepEqual(await p, { ok: true, value: "text" });
  assert.equal(t.calls.length, 1);
});

test("a start that fails is a typed error; the task never runs", async () => {
  const c = fakeClient(available(true)), host = fakeHost(), t = task();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const p = s.run(t.fn);
  await flush();
  c.ensure[0].settle({ ok: false, reason: "error", message: "wasm failed" });
  assert.deepEqual(await p, { ok: false, reason: "error", message: "wasm failed" });
  assert.equal(t.calls.length, 0);
});

test("two callers share one notice; Download serves both with one start", async () => {
  const c = fakeClient(available(false)), host = fakeHost(), a = task("a"), b = task("b");
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const pa = s.run(a.fn), pb = s.run(b.fn);
  await flush();
  assert.equal(host.shown.length, 1, "one notice");
  host.shown[0].answer("download");
  await flush();
  assert.equal(c.ensure.length, 1, "one start");
  c.ensure[0].settle({ ok: true });
  assert.deepEqual(await pa, { ok: true, value: "a" });
  assert.deepEqual(await pb, { ok: true, value: "b" });
});

test("a caller who arrives during the download waits for it instead of asking again", async () => {
  const c = fakeClient(available(false)), host = fakeHost(), a = task("a"), b = task("b");
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const pa = s.run(a.fn);
  await flush();
  host.shown[0].answer("download");
  await flush();
  const pb = s.run(b.fn);
  await flush();
  assert.equal(host.shown.length, 1);
  assert.equal(c.ensure.length, 1);
  c.ensure[0].settle({ ok: true });
  assert.deepEqual([await pa, await pb], [{ ok: true, value: "a" }, { ok: true, value: "b" }]);
});

test("one caller aborts: only it resolves aborted, its task never runs, the notice stays up for the other", async () => {
  const c = fakeClient(available(false)), host = fakeHost(), a = task("a"), b = task("b");
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const acA = new AbortController();
  const pa = s.run(a.fn, { signal: acA.signal }), pb = s.run(b.fn);
  await flush();
  acA.abort();
  assert.deepEqual(await pa, { ok: false, reason: "aborted" });
  assert.equal(host.shown[0].notice.signal.aborted, false, "B still waits: the notice stays");
  host.shown[0].answer("download");
  await flush();
  c.ensure[0].settle({ ok: true });
  assert.deepEqual(await pb, { ok: true, value: "b" });
  assert.equal(a.calls.length, 0, "A's task never ran");
  assert.equal(b.calls.length, 1);
});

test("the last waiter out closes the notice, and the next read asks afresh", async () => {
  const c = fakeClient(available(false)), host = fakeHost();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const acA = new AbortController(), acB = new AbortController();
  const pa = s.run(task().fn, { signal: acA.signal }), pb = s.run(task().fn, { signal: acB.signal });
  await flush();
  acA.abort();
  await pa;
  assert.equal(host.shown[0].notice.signal.aborted, false);
  acB.abort();
  assert.deepEqual(await pb, { ok: false, reason: "aborted" });
  assert.equal(host.shown[0].notice.signal.aborted, true, "the host is told to close the notice");
  // the host never answered the closed notice; a new read still gets one
  const t = task();
  const pc = s.run(t.fn);
  await flush();
  assert.equal(host.shown.length, 2);
  host.shown[1].answer("download");
  await flush();
  c.ensure.at(-1)!.settle({ ok: true });
  assert.deepEqual(await pc, { ok: true, value: "text" });
  // a late answer on the closed notice starts nothing
  host.shown[0].answer("download");
  await flush();
  assert.equal(c.consented(), 1);
});

test("the last waiter leaving mid-download cancels the download", async () => {
  const c = fakeClient(available(false)), host = fakeHost();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const ac = new AbortController();
  const p = s.run(task().fn, { signal: ac.signal });
  await flush();
  host.shown[0].answer("download");
  await flush();
  ac.abort();
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
  assert.equal(c.ensure[0].opts.signal?.aborted, true, "the start's signal is aborted");
  assert.equal(host.shown[0].notice.signal.aborted, true);
});

test("Cancel on the notice after Download: every waiter is declined and the download stops", async () => {
  const c = fakeClient(available(false)), host = fakeHost(), a = task(), b = task();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const pa = s.run(a.fn), pb = s.run(b.fn);
  await flush();
  host.shown[0].answer("download");
  await flush();
  host.shown[0].notice.cancel();
  assert.deepEqual([await pa, await pb], [{ ok: false, reason: "declined" }, { ok: false, reason: "declined" }]);
  assert.equal(c.ensure[0].opts.signal?.aborted, true);
  assert.equal(host.shown[0].notice.signal.aborted, true);
  assert.equal(a.calls.length + b.calls.length, 0);
});

test("an already-aborted caller gets aborted without a probe", async () => {
  const c = fakeClient(available(false)), host = fakeHost(), t = task();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await s.run(t.fn, { signal: ac.signal }), { ok: false, reason: "aborted" });
  assert.equal(c.probeCalls(), 0);
  assert.equal(c.calls.length, 0);
  assert.equal(t.calls.length, 0);
});

test("a caller aborted while the engine starts never runs its task", async () => {
  const c = fakeClient(available(true)), host = fakeHost(), t = task();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const ac = new AbortController();
  const p = s.run(t.fn, { signal: ac.signal });
  await flush();
  ac.abort();
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
  assert.equal(t.calls.length, 0);
});

test("availability() is the probe alone: no notice, no start", async () => {
  const c = fakeClient(available(false, 99)), host = fakeHost();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  assert.deepEqual(await s.availability(), available(false, 99));
  assert.equal(host.shown.length, 0);
  assert.equal(c.ensure.length, 0);
});

test("a host that throws while showing the notice gives a typed error, not a hang", async () => {
  const c = fakeClient(available(false)), t = task();
  const s = createOcrSession({ client: c.client, requestConsent: () => { throw new Error("no notice host mounted"); } });
  assert.deepEqual(await s.run(t.fn), { ok: false, reason: "error", message: "no notice host mounted" });
  assert.equal(c.ensure.length, 0);
  assert.equal(t.calls.length, 0);
});

// ── the engine already running ──────────────────────────────────────────────

test("once the engine is running, later reads never ask again, even when the probe can't see the cache", async () => {
  // The probe reads Cache Storage only; without one (or after an eviction)
  // it says "not cached" while the worker holds the engine. Asking again
  // there would show the 36 MB notice for an engine already loaded.
  const c = fakeClient(available(false)), host = fakeHost();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const p1 = s.run(task("1").fn);
  await flush();
  host.shown[0].answer("download");
  await flush();
  c.ensure[0].settle({ ok: true });
  assert.deepEqual(await p1, { ok: true, value: "1" });
  assert.deepEqual(await s.run(task("2").fn), { ok: true, value: "2" });
  assert.deepEqual(await s.run(task("3").fn), { ok: true, value: "3" });
  assert.equal(host.shown.length, 1, "one notice");
  assert.equal(c.consented(), 1);
});

// The reviewer's repro, with the real client: no Cache Storage, a fake
// worker that answers init with ready.
const realManifest: OcrManifest = {
  rev: "r1+ort-1",
  files: [
    { name: "det", url: "/models/ocr/det.onnx", bytes: 4_000_000, sha256: "a".repeat(64) },
    { name: "rec", url: "/models/ocr/rec.onnx", bytes: 8_000_000, sha256: "b".repeat(64) },
    { name: "dict", url: "/models/ocr/dict.txt", bytes: 1_000, sha256: "c".repeat(64) },
    { name: "ort-wasm", bytes: 24_000_000, sha256: "d".repeat(64) },
  ],
};
function readyWorker(): WorkerLike {
  const w: WorkerLike = {
    onmessage: null, onerror: null, terminate() {},
    postMessage(m: unknown) {
      const msg = m as { type: string; initId?: number };
      if (msg.type === "init") queueMicrotask(() => w.onmessage?.({ data: { type: "ready", initId: msg.initId } }));
    },
  };
  return w;
}

test("real client, no Cache Storage: two reads show one notice", async () => {
  let fetches = 0;
  const client = createOcrClient({
    enabled: true, cacheStorage: undefined, spawnWorker: readyWorker,
    fetchImpl: (async () => { fetches++; return Response.json(realManifest); }) as never,
  });
  const shown: number[] = [];
  const s = createOcrSession({ client, requestConsent: async (b) => { shown.push(b); return "download"; } });
  assert.deepEqual(await s.run(async () => 1), { ok: true, value: 1 });
  assert.deepEqual(await s.run(async () => 2), { ok: true, value: 2 });
  assert.deepEqual(shown, [36_001_000]);
  assert.equal(fetches, 1, "the manifest is fetched once");
  client.dispose();
});

test("a read that arrives while the notice is up joins it without asking the client", async () => {
  const c = fakeClient(available(false)), host = fakeHost();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const pa = s.run(task("a").fn);
  await flush();
  const before = c.calls.length;
  const pb = s.run(task("b").fn);
  await flush();
  assert.equal(c.calls.length, before, "joined the notice");
  host.shown[0].answer("download");
  await flush();
  c.ensure[0].settle({ ok: true });
  assert.deepEqual([await pa, await pb], [{ ok: true, value: "a" }, { ok: true, value: "b" }]);
});

// ── run never rejects ───────────────────────────────────────────────────────

test("a task's AbortError with the caller's signal not aborted is `failed`, message intact (the page was closed)", async () => {
  const c = fakeClient(available(true)), host = fakeHost();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const closed = new DOMException("The page was closed during the read.", "AbortError");
  const p = s.run(async () => { throw closed; }, { signal: new AbortController().signal });
  await flush();
  c.ensure[0].settle({ ok: true });
  const r = await p;
  assert.equal(!r.ok && r.reason, "failed");
  assert.equal(!r.ok && r.reason === "failed" && r.error, closed);
  assert.equal(closed.message, "The page was closed during the read.");
});

test("a task's AbortError after the caller aborted is aborted", async () => {
  const c = fakeClient(available(true)), host = fakeHost();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const ac = new AbortController();
  const p = s.run(async () => { ac.abort(); throw new DOMException("The OCR read was cancelled.", "AbortError"); }, { signal: ac.signal });
  await flush();
  c.ensure[0].settle({ ok: true });
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
});

test("a task that fails after its caller aborted is aborted, whatever it threw", async () => {
  const c = fakeClient(available(true)), host = fakeHost();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const ac = new AbortController();
  const p = s.run(async () => { ac.abort(); throw new Error("render failed"); }, { signal: ac.signal });
  await flush();
  c.ensure[0].settle({ ok: true });
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
});

test("a task's own error is `failed` with the error, distinct from a start's `error`", async () => {
  const c = fakeClient(available(true)), host = fakeHost();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const boom = new Error("OCR read failed");
  const p = s.run(async () => { throw boom; });
  await flush();
  c.ensure[0].settle({ ok: true });
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "failed");
  assert.equal(!r.ok && r.reason === "failed" && r.error, boom);
});

// ── availability ────────────────────────────────────────────────────────────

test("availability(): 20 concurrent calls on a 503 make one request, and the error isn't kept", async () => {
  let fetches = 0;
  const client = createOcrClient({
    enabled: true, cacheStorage: undefined, spawnWorker: readyWorker,
    fetchImpl: (async () => { fetches++; return new Response("x", { status: 503 }); }) as never,
  });
  const s = createOcrSession({ client, requestConsent: async () => "cancel" });
  const all = await Promise.all(Array.from({ length: 20 }, () => s.availability()));
  assert.equal(fetches, 1);
  assert.ok(all.every((a) => a.state === "error"));
  await s.availability();
  assert.equal(fetches, 2, "an error is asked again next time");
});

test("availability(): a settled answer is kept", async () => {
  for (const probe of [{ state: "disabled" }, { state: "uninstalled" }, available(false, 5)] as OcrProbe[]) {
    const c = fakeClient(probe);
    const s = createOcrSession({ client: c.client, requestConsent: fakeHost().requestConsent });
    assert.deepEqual(await s.availability(), probe);
    assert.deepEqual(await s.availability(), probe);
    assert.equal(c.probeCalls(), 1, probe.state);
  }
});

// ── abort races ─────────────────────────────────────────────────────────────

test("a caller that aborts while the missing bytes are probed opens no notice", async () => {
  // Otherwise a notice would open with nobody waiting on it, so nothing
  // would ever close it, and its Download would start a download for no one.
  const c = fakeClient(available(false)), host = fakeHost(), t = task();
  const ac = new AbortController();
  const client = { ...c.client, probe: async () => { ac.abort(); return c.client.probe(); } };
  const s = createOcrSession({ client, requestConsent: host.requestConsent });
  assert.deepEqual(await s.run(t.fn, { signal: ac.signal }), { ok: false, reason: "aborted" });
  await flush();
  assert.equal(host.shown.length, 0);
  assert.equal(t.calls.length, 0);
});

test("a caller that aborts just as the engine is ready never runs its task", async () => {
  // The start answered ok, and the abort lands before run() resumes.
  const c = fakeClient(available(true)), host = fakeHost(), t = task();
  const s = createOcrSession({ client: c.client, requestConsent: host.requestConsent });
  const ac = new AbortController();
  const p = s.run(t.fn, { signal: ac.signal });
  await flush();
  c.ensure[0].settle({ ok: true });
  ac.abort();
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
  assert.equal(t.calls.length, 0);
});
