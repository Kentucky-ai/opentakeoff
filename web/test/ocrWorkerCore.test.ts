// The OCR worker's core (#469), driven with fakes: fetch, Cache Storage, the
// ORT runtime and the ppu service. The real engine runs only in a browser;
// here we pin what the core owns: the download (progress, integrity, cache,
// consent, abort), the order the runtime is configured in, init retry, and
// one read at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createOcrCore, type OcrCoreDeps } from "../src/lib/ocr/workerCore.ts";
import { cacheKey, cacheName, MANIFEST_URL, type OcrManifest } from "../src/lib/ocr/manifest.ts";
import { SCAN_MAX_DIM } from "../src/lib/scheduleScan.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const BYTES: Record<string, Uint8Array> = {
  det: enc("detection model bytes ".repeat(10)),
  rec: enc("recognition model bytes ".repeat(20)),
  dict: enc("\n0\n1\nA\n"),
  "ort-wasm": enc("runtime wasm ".repeat(30)),
};
const URLS: Record<string, string> = { det: "/models/ocr/det.onnx", rec: "/models/ocr/rec.onnx", dict: "/models/ocr/dict.txt" };
const WASM_URL = "/assets/ort-wasm-simd-threaded.asyncify-HASH.wasm";
const MJS_URL = "/assets/ort-wasm-simd-threaded.asyncify-HASH.mjs";
const manifest: OcrManifest = {
  rev: "test-rev",
  files: Object.entries(BYTES).map(([name, b]) => ({ name, ...(URLS[name] ? { url: URLS[name] } : {}), bytes: b.length, sha256: sha(b) })),
};
const TOTAL = Object.values(BYTES).reduce((s, b) => s + b.length, 0);
const urlToName: Record<string, string> = { ...Object.fromEntries(Object.entries(URLS).map(([n, u]) => [u, n])), [WASM_URL]: "ort-wasm" };

// ── fakes ────────────────────────────────────────────────────────────────────

/** fetch that streams each body in `chunk`-byte pieces, with no Content-Length.
 * The manifest URL answers with `serverManifest` (this test's manifest by
 * default) and is recorded apart from the file fetches. */
function fakeFetch(opts: { chunk?: number; override?: Record<string, Uint8Array>; hang?: string; serverManifest?: unknown; manifestThrows?: boolean } = {}) {
  const calls: { url: string; signal?: AbortSignal }[] = [];
  const manifestCalls: { cache?: string }[] = [];
  const fetchImpl = async (url: string, init?: { signal?: AbortSignal; cache?: string }) => {
    if (url === MANIFEST_URL) {
      manifestCalls.push({ cache: init?.cache });
      if (opts.manifestThrows) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(opts.serverManifest ?? manifest), { status: 200 });
    }
    calls.push({ url, signal: init?.signal });
    const name = urlToName[url];
    const body = opts.override?.[name] ?? BYTES[name];
    if (!body) return new Response("missing", { status: 404 });
    const chunk = opts.chunk ?? 7;
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (opts.hang === name && i >= chunk) {
          // stall until aborted
          await new Promise<void>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
        }
        if (i >= body.length) return ctrl.close();
        ctrl.enqueue(body.slice(i, i + chunk));
        i += chunk;
      },
    });
    return new Response(stream, { status: 200 });
  };
  return { calls, manifestCalls, fetchImpl };
}

function fakeCaches(opts: { openThrows?: boolean; putThrows?: boolean; keysThrows?: boolean; deleteThrows?: boolean } = {}) {
  const stores = new Map<string, Map<string, ArrayBuffer>>();
  const puts: string[] = [];
  const cacheStorage = {
    async keys() {
      if (opts.keysThrows) throw new Error("SecurityError");
      return [...stores.keys()];
    },
    async delete(name: string) {
      if (opts.deleteThrows) throw new Error("SecurityError");
      return stores.delete(name);
    },
    async open(name: string) {
      if (opts.openThrows) throw new Error("SecurityError: caches unavailable");
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return {
        async match(key: string) {
          const b = m.get(key);
          return b ? new Response(b.slice(0)) : undefined;
        },
        async put(key: string, res: Response) {
          if (opts.putThrows) throw new Error("QuotaExceededError");
          puts.push(key);
          m.set(key, await res.arrayBuffer());
        },
      };
    },
  };
  return { stores, puts, cacheStorage };
}

type Posted = { type: string; [k: string]: unknown };

function harness(over: Partial<OcrCoreDeps> & { fetch?: ReturnType<typeof fakeFetch>; caches?: ReturnType<typeof fakeCaches> | null } = {}) {
  const posted: Posted[] = [];
  const fetch = over.fetch ?? fakeFetch();
  const caches = over.caches === undefined ? fakeCaches() : over.caches;
  const ort = { env: { wasm: {} as Record<string, unknown> } };
  const serviceCalls: { buffers: Record<string, unknown>; env: Record<string, unknown>; options?: unknown }[] = [];
  const recognizeCalls: { canvas: unknown; opts: unknown }[] = [];
  const service = {
    async recognize(canvas: unknown, opts: unknown) {
      recognizeCalls.push({ canvas, opts });
      // A padded box as ppu returns it: ink 30 px tall at (42, 72), padded
      // 12 px above and below and 18 px either side.
      return { lines: [[{ text: " CPT-1 ", box: { x: 24, y: 60, width: 96, height: 54 }, confidence: 0.98 }], [{ text: "  ", box: { x: 0, y: 0, width: 1, height: 1 } }]] };
    },
    async destroy() {},
  };
  const deps: OcrCoreDeps = {
    fetchImpl: fetch.fetchImpl as OcrCoreDeps["fetchImpl"],
    cacheStorage: caches?.cacheStorage as OcrCoreDeps["cacheStorage"],
    ortWasmUrl: WASM_URL,
    ortMjsUrl: MJS_URL,
    loadRuntime: async () => ort,
    loadService: async (buffers, options) => {
      serviceCalls.push({ buffers: { ...buffers }, env: { ...ort.env.wasm }, options });
      return service;
    },
    origin: "https://ot.test",
    makeCanvas: (rgba, width, height) => ({ rgba, width, height }),
    post: (m) => posted.push(m as Posted),
    ...over,
  };
  const core = createOcrCore(deps);
  return { core, posted, fetch, caches, ort, serviceCalls, recognizeCalls };
}

const init = (allowNetwork = true) => ({ type: "init" as const, manifest, allowNetwork });
const recognizeMsg = (id: number) => ({
  type: "recognize" as const, id, rgba: new Uint8ClampedArray(4 * 450 * 450), width: 450, height: 450,
  geometry: { rect: { x0: 100, y0: 200, x1: 400, y1: 500 }, zoom: 1.5 },
});
const last = (p: Posted[]) => p[p.length - 1];

// ── download ─────────────────────────────────────────────────────────────────

test("progress is monotonic across files, clamped to the total, without Content-Length", async () => {
  const h = harness();
  await h.core.handle(init());
  const progress = h.posted.filter((m) => m.type === "progress");
  assert.ok(progress.length > 4, "streams in pieces");
  let prev = -1;
  for (const p of progress) {
    assert.equal(p.total, TOTAL);
    assert.ok((p.loaded as number) >= prev, "never goes backwards");
    assert.ok((p.loaded as number) <= TOTAL, "clamped");
    prev = p.loaded as number;
  }
  assert.equal(prev, TOTAL);
  assert.equal(last(h.posted).type, "ready");
});

test("a runtime wasm is fetched from the ?url the worker was built with", async () => {
  const h = harness();
  await h.core.handle(init());
  assert.deepEqual(h.fetch.calls.map((c) => c.url).sort(), [...Object.values(URLS), WASM_URL].sort());
});

test("downloaded files are cached under their synthetic keys; cached files aren't fetched", async () => {
  const caches = fakeCaches();
  const first = harness({ caches });
  await first.core.handle(init());
  assert.deepEqual(caches.puts.sort(), manifest.files.map(cacheKey).sort());
  const second = harness({ caches });
  await second.core.handle(init(false));
  assert.equal(second.fetch.calls.length, 0);
  assert.equal(last(second.posted).type, "ready");
});

test("a truncated cached file is fetched again, and the fresh copy replaces it", async () => {
  const caches = fakeCaches();
  await harness({ caches }).core.handle(init());
  const dict = manifest.files.find((f) => f.name === "dict")!;
  const store = caches.stores.get(cacheName(manifest.rev))!;
  store.set(cacheKey(dict), BYTES.dict.slice(0, 2).buffer);
  const h = harness({ caches });
  await h.core.handle(init());
  assert.deepEqual(h.fetch.calls.map((c) => c.url), [URLS.dict]);
  assert.equal(last(h.posted).type, "ready");
  assert.equal(store.get(cacheKey(dict))!.byteLength, BYTES.dict.length);
});

test("a byte-length mismatch rejects, caches nothing for that file, and builds no service", async () => {
  const bad = new Uint8Array(BYTES.rec.length + 3);
  const h = harness({ fetch: fakeFetch({ override: { rec: bad } }) });
  await h.core.handle(init());
  const err = last(h.posted);
  assert.equal(err.type, "error");
  assert.equal(err.code, "integrity");
  assert.equal(h.serviceCalls.length, 0);
  assert.ok(!h.caches!.puts.includes(cacheKey(manifest.files.find((f) => f.name === "rec")!)));
});

test("a body far past its manifest size stops being read, and its stream is cancelled", async () => {
  let cancelled = false, pulls = 0;
  const base = fakeFetch();
  const fetchImpl = async (url: string, init?: { signal?: AbortSignal }) => {
    if (url !== URLS.rec) return base.fetchImpl(url, init);
    // an endless body, as a misconfigured host might serve
    return new Response(new ReadableStream<Uint8Array>({
      pull(ctrl) { pulls++; ctrl.enqueue(new Uint8Array(64)); },
      cancel() { cancelled = true; },
    }), { status: 200 });
  };
  const h = harness({ fetchImpl });
  await h.core.handle(init());
  assert.equal(last(h.posted).code, "integrity");
  assert.ok(pulls < 100, `stopped early (${pulls} pulls)`);
  assert.equal(cancelled, true, "the reader was cancelled, so the connection is released");
});

test("a sha256 mismatch at the right length rejects and caches nothing for that file", async () => {
  const bad = new Uint8Array(BYTES.det.length).fill(65);
  const h = harness({ fetch: fakeFetch({ override: { det: bad } }) });
  await h.core.handle(init());
  assert.equal(last(h.posted).code, "integrity");
  assert.ok(!h.caches!.puts.includes(cacheKey(manifest.files.find((f) => f.name === "det")!)));
  assert.equal(h.serviceCalls.length, 0);
});

test("a file URL that resolves off this site is refused before any fetch", async () => {
  const offSite: OcrManifest = { ...manifest, files: manifest.files.map((f) => (f.name === "det" ? { ...f, url: "https://evil.example/det.onnx" } : f)) };
  const h = harness();
  await h.core.handle({ type: "init", manifest: offSite, allowNetwork: true });
  assert.deepEqual([last(h.posted).type, last(h.posted).code], ["error", "integrity"]);
  assert.ok(!h.fetch.calls.some((c) => c.url.includes("evil.example")));
  assert.equal(h.serviceCalls.length, 0);

  const cdn = harness({ ortWasmUrl: "https://cdn.example/ort-wasm-simd-threaded.asyncify.wasm" });
  await cdn.core.handle(init());
  assert.deepEqual([last(cdn.posted).type, last(cdn.posted).code], ["error", "integrity"]);
  assert.ok(!cdn.fetch.calls.some((c) => c.url.includes("cdn.example")));
});

test("without allowNetwork a cache miss is consent-required and nothing is fetched", async () => {
  // The probe saw a full cache, then the browser evicted it before the worker ran.
  const h = harness();
  await h.core.handle(init(false));
  assert.equal(last(h.posted).type, "error");
  assert.equal(last(h.posted).code, "consent-required");
  assert.equal(h.fetch.calls.length, 0);
});

test("abort stops the download: the fetch signal fires and no service is built", async () => {
  const h = harness({ fetch: fakeFetch({ hang: "rec" }) });
  const running = h.core.handle(init());
  // wait until the rec download has started, then cancel
  for (let i = 0; i < 500 && !h.fetch.calls.some((c) => c.url === URLS.rec); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(h.fetch.calls.some((c) => c.url === URLS.rec), "the rec download started");
  await h.core.handle({ type: "cancel" });
  await running;
  assert.equal(last(h.posted).code, "aborted");
  assert.ok(h.fetch.calls.find((c) => c.url === URLS.rec)!.signal!.aborted);
  assert.equal(h.serviceCalls.length, 0);
});

// ── Cache Storage is optional ────────────────────────────────────────────────

test("no Cache Storage at all: the buffers stay in memory and the engine still starts", async () => {
  const h = harness({ caches: null });
  await h.core.handle(init());
  assert.equal(last(h.posted).type, "ready");
});

test("caches.open throwing is not fatal", async () => {
  const h = harness({ caches: fakeCaches({ openThrows: true }) });
  await h.core.handle(init());
  assert.equal(last(h.posted).type, "ready");
});

test("cache.put throwing (quota) is not fatal", async () => {
  const h = harness({ caches: fakeCaches({ putThrows: true }) });
  await h.core.handle(init());
  assert.equal(last(h.posted).type, "ready");
});

test("after a ready, caches from other OCR revs are deleted; this rev's and other apps' stay", async () => {
  const caches = fakeCaches();
  caches.stores.set("opentakeoff-ocr-ppocrv5-mobile-en-0+ort-1.0", new Map());
  caches.stores.set("transformers-cache", new Map());
  const h = harness({ caches });
  await h.core.handle(init());
  assert.equal(last(h.posted).type, "ready");
  assert.deepEqual([...caches.stores.keys()].sort(), [cacheName(manifest.rev), "transformers-cache"].sort());
});

// A tab that probed the manifest before a deploy still holds the old rev. If
// it deleted "every other rev", it would wipe the new rev's cache that a tab
// on the new manifest is filling. So old caches go only when the server's
// manifest, fetched past the HTTP cache, names this engine's rev.
test("old OCR caches go only when the server's manifest is this engine's rev", async () => {
  const fetch = fakeFetch();
  const caches = fakeCaches();
  caches.stores.set("opentakeoff-ocr-old", new Map());
  const h = harness({ caches, fetch });
  await h.core.handle(init());
  assert.deepEqual(fetch.manifestCalls, [{ cache: "no-store" }]);
  assert.equal(caches.stores.has("opentakeoff-ocr-old"), false);
});

test("an engine on an older rev than the server's deletes no OCR cache", async () => {
  const caches = fakeCaches();
  caches.stores.set("opentakeoff-ocr-newer-rev", new Map());
  const h = harness({ caches, fetch: fakeFetch({ serverManifest: { ...manifest, rev: "newer-rev" } }) });
  await h.core.handle(init());
  assert.equal(last(h.posted).type, "ready");
  assert.ok(caches.stores.has("opentakeoff-ocr-newer-rev"));
});

test("no readable server manifest, no deletion", async () => {
  for (const f of [fakeFetch({ manifestThrows: true }), fakeFetch({ serverManifest: { rev: manifest.rev } })]) {
    const caches = fakeCaches();
    caches.stores.set("opentakeoff-ocr-other", new Map());
    const h = harness({ caches, fetch: f });
    await h.core.handle(init());
    assert.equal(last(h.posted).type, "ready");
    assert.ok(caches.stores.has("opentakeoff-ocr-other"));
  }
});

test("an init that fails deletes no old cache", async () => {
  const caches = fakeCaches();
  caches.stores.set("opentakeoff-ocr-old", new Map());
  const h = harness({ caches, fetch: fakeFetch({ override: { rec: new Uint8Array(3) } }) });
  await h.core.handle(init());
  assert.equal(last(h.posted).code, "integrity");
  assert.ok(caches.stores.has("opentakeoff-ocr-old"));
});

test("caches.keys or caches.delete throwing doesn't spoil the ready", async () => {
  for (const opt of [{ keysThrows: true }, { deleteThrows: true }]) {
    const caches = fakeCaches(opt);
    caches.stores.set("opentakeoff-ocr-old", new Map());
    const h = harness({ caches });
    await h.core.handle(init());
    assert.equal(last(h.posted).type, "ready", JSON.stringify(opt));
  }
});

// ── engine start ─────────────────────────────────────────────────────────────

test("the runtime is configured before the service loads: mjs path, wasm bytes, one thread", async () => {
  const h = harness();
  await h.core.handle(init());
  assert.equal(h.serviceCalls.length, 1);
  const env = h.serviceCalls[0].env;
  assert.deepEqual(env.wasmPaths, { mjs: MJS_URL });
  assert.ok(env.wasmBinary instanceof ArrayBuffer);
  assert.equal((env.wasmBinary as ArrayBuffer).byteLength, BYTES["ort-wasm"].length);
  assert.equal(env.numThreads, 1);
});

test("once the service is built, the core drops its hold on the runtime wasm bytes", async () => {
  const h = harness();
  await h.core.handle(init());
  assert.equal(last(h.posted).type, "ready");
  assert.ok(h.serviceCalls[0].env.wasmBinary instanceof ArrayBuffer, "set while the service loads");
  assert.equal(h.ort.env.wasm.wasmBinary, undefined, "released after");
});

test("a failed service build releases the runtime wasm bytes too", async () => {
  const ort = { env: { wasm: {} as Record<string, unknown> } };
  const h = harness({ loadRuntime: async () => ort, loadService: async () => { throw new Error("wasm compile failed"); } });
  await h.core.handle(init());
  assert.equal(last(h.posted).code, "init");
  assert.equal(ort.env.wasm.wasmBinary, undefined);
});

test("a service build that repoints wasmPaths fails init and the service is destroyed", async () => {
  const cases: [string, (env: Record<string, unknown>) => void][] = [
    ["replaced with a CDN", (env) => { env.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/"; }],
    ["changed in place", (env) => { (env.wasmPaths as Record<string, string>).wasm = "https://cdn.example/ort.wasm"; }],
  ];
  for (const [what, tamper] of cases) {
    const ort = { env: { wasm: {} as Record<string, unknown> } };
    let destroyed = 0;
    const h = harness({
      loadRuntime: async () => ort,
      loadService: async () => {
        tamper(ort.env.wasm);
        return { recognize: async () => ({ lines: [] }), destroy: async () => { destroyed++; } };
      },
    });
    await h.core.handle(init());
    assert.deepEqual([last(h.posted).type, last(h.posted).code], ["error", "init"], what);
    assert.equal(destroyed, 1, what);
    await h.core.handle(recognizeMsg(1));
    assert.equal(last(h.posted).code, "not-ready", what);
  }
});

test("the service is told the detection padding the word map undoes", async () => {
  const h = harness();
  await h.core.handle(init());
  assert.deepEqual((h.serviceCalls[0].options as { detection: unknown }).detection, { paddingVertical: 0.4, paddingHorizontal: 0.6, maxSideLength: SCAN_MAX_DIM });
});

test("the service gets exact-length ArrayBuffers, never views", async () => {
  const h = harness();
  await h.core.handle(init());
  const b = h.serviceCalls[0].buffers;
  for (const [k, name] of [["detection", "det"], ["recognition", "rec"], ["charactersDictionary", "dict"]] as const) {
    assert.ok(b[k] instanceof ArrayBuffer, `${k} is an ArrayBuffer`);
    assert.equal((b[k] as ArrayBuffer).byteLength, BYTES[name].length);
  }
});

test("a missing or non-ArrayBuffer buffer means the service is never built", async () => {
  const h = harness();
  const good = Object.fromEntries(Object.entries(BYTES).map(([k, v]) => [k, v.slice().buffer]));
  await assert.rejects(h.core.startEngine(manifest, { ...good, rec: BYTES.rec }), /ArrayBuffer/);
  const { dict: _dict, ...noDict } = good;
  await assert.rejects(h.core.startEngine(manifest, noDict), /dict/);
  assert.equal(h.serviceCalls.length, 0);
});

test("an init failure leaves no service, and the next init loads it again", async () => {
  let n = 0;
  const h = harness({
    loadService: async () => {
      n++;
      if (n === 1) throw new Error("wasm compile failed");
      return { recognize: async () => ({ lines: [] }), destroy: async () => {} };
    },
  });
  await h.core.handle(init());
  assert.equal(last(h.posted).code, "init");
  await h.core.handle(recognizeMsg(1));
  assert.equal(last(h.posted).code, "not-ready");
  await h.core.handle(init());
  assert.equal(n, 2);
  assert.equal(last(h.posted).type, "ready");
});

// ── recognize ────────────────────────────────────────────────────────────────

test("recognize maps cells to sheet words and never uses ppu's result cache", async () => {
  const h = harness();
  await h.core.handle(init());
  await h.core.handle(recognizeMsg(7));
  // a neutral tile: recognition reads the same canvas detection does
  assert.deepEqual(h.recognizeCalls[0].opts, { flatten: false, noCache: true, recognitionCanvas: h.recognizeCalls[0].canvas });
  const res = last(h.posted);
  assert.equal(res.type, "result");
  assert.equal(res.id, 7);
  // ppu's padding comes off before the crop → sheet map: ink (42..102, 72..102)
  // at zoom 1.5 from (100, 200).
  assert.deepEqual(res.words, [{ str: "CPT-1", x: 128, y: 268, w: 40, h: 20, confidence: 0.98 }]);
});

// A 2 × 2 tile of red ink (220, 30, 30), opaque.
test("code disagreement travels only on a requested schedule read, including an empty second read", async () => {
  const seen: unknown[] = [];
  const h = harness({ loadService: async () => ({
    recognize: async (_canvas, opts) => {
      seen.push(opts.verifyCodes);
      return { lines: [[{ text: "S-2", box: { x: 24, y: 60, width: 96, height: 54 }, confidence: 0.999, codeAlternate: "" }]] };
    }, destroy: async () => {},
  }) });
  await h.core.handle(init());
  await h.core.handle({ ...recognizeMsg(1), verifyCodes: true });
  assert.deepEqual(last(h.posted).words, [{ str: "S-2", x: 128, y: 268, w: 40, h: 20, confidence: 0.999, codeAlternate: "" }]);
  await h.core.handle(recognizeMsg(2));
  assert.deepEqual(last(h.posted).words, [{ str: "S-2", x: 128, y: 268, w: 40, h: 20, confidence: 0.999 }]);
  assert.deepEqual(seen, [true, undefined]);
});

const redMsg = (id: number) => {
  const rgba = new Uint8ClampedArray(4 * 2 * 2);
  for (let p = 0; p < rgba.length; p += 4) rgba.set([220, 30, 30, 255], p);
  return { ...recognizeMsg(id), rgba, width: 2, height: 2 };
};

/** makeCanvas that snapshots the bytes it is handed at call time and returns
 * a distinct canvas per call. */
function snapshotCanvases() {
  const seen: number[][] = [];
  const made: { canvas: number }[] = [];
  const makeCanvas = (rgba: Uint8ClampedArray) => {
    seen.push([...rgba]);
    const c = { canvas: made.length };
    made.push(c);
    return c;
  };
  return { seen, made, makeCanvas };
}

test("recognize: detection gets the tile as rendered, recognition a copy with red ink (220, 30, 30) as luma 87 (#481)", async () => {
  // ppu's recognition reads only the R byte, so red ink read as paper; its
  // detection reads R, G and B and is given the tile untouched.
  const s = snapshotCanvases();
  const h = harness({ makeCanvas: s.makeCanvas });
  await h.core.handle(init());
  await h.core.handle(redMsg(1));
  assert.deepEqual(s.seen, [
    [220, 30, 30, 255, 220, 30, 30, 255, 220, 30, 30, 255, 220, 30, 30, 255],
    [87, 87, 87, 255, 87, 87, 87, 255, 87, 87, 87, 255, 87, 87, 87, 255],
  ]);
  assert.equal(h.recognizeCalls.length, 1);
  assert.equal(h.recognizeCalls[0].canvas, s.made[0]);
  assert.deepEqual(h.recognizeCalls[0].opts, { flatten: false, noCache: true, recognitionCanvas: s.made[1] });
  assert.equal((h.recognizeCalls[0].opts as { recognitionCanvas: unknown }).recognitionCanvas, s.made[1]);
  assert.equal(last(h.posted).type, "result");
});

test("recognize: the grayed copy keeps near-neutral pixels byte-identical: paper (250, 245, 242) stays, red beside it turns gray (#481)", async () => {
  const s = snapshotCanvases();
  const h = harness({ makeCanvas: s.makeCanvas });
  await h.core.handle(init());
  const msg = redMsg(1);
  msg.rgba.set([250, 245, 242, 255], 4);
  msg.rgba.set([100, 104, 96, 200], 8);
  await h.core.handle(msg);
  assert.deepEqual(s.seen, [
    [220, 30, 30, 255, 250, 245, 242, 255, 100, 104, 96, 200, 220, 30, 30, 255],
    [87, 87, 87, 255, 250, 245, 242, 255, 100, 104, 96, 200, 87, 87, 87, 255],
  ]);
});

test("recognize: a tile with no colored pixel makes one canvas, read by both detection and recognition (#481)", async () => {
  const s = snapshotCanvases();
  const h = harness({ makeCanvas: s.makeCanvas });
  await h.core.handle(init());
  const msg = redMsg(1);
  for (let p = 0; p < msg.rgba.length; p += 4) msg.rgba.set([250, 245, 242, 255], p);
  await h.core.handle(msg);
  assert.equal(s.made.length, 1);
  assert.equal(h.recognizeCalls[0].canvas, s.made[0]);
  assert.equal((h.recognizeCalls[0].opts as { recognitionCanvas: unknown }).recognitionCanvas, s.made[0]);
});

test("a recognize before the engine is ready leaves the tile's bytes alone", async () => {
  const h = harness();
  const msg = redMsg(1);
  await h.core.handle(msg);
  assert.equal(last(h.posted).code, "not-ready");
  assert.deepEqual([...msg.rgba.subarray(0, 4)], [220, 30, 30, 255]);
});

test("a read that throws in the engine replies with a recognize error, and the next read runs", async () => {
  let n = 0;
  const h = harness({
    loadService: async () => ({
      recognize: async () => { if (++n === 1) throw new Error("bad tensor"); return { lines: [] }; },
      destroy: async () => {},
    }),
  });
  await h.core.handle(init());
  await h.core.handle(recognizeMsg(1));
  assert.deepEqual(last(h.posted), { type: "error", id: 1, code: "recognize", message: "bad tensor" });
  await h.core.handle(recognizeMsg(2));
  assert.deepEqual(last(h.posted), { type: "result", id: 2, words: [] });
});

test("dispose destroys the service, closes the worker, and later reads are not-ready", async () => {
  let destroyed = 0, closed = 0;
  const h = harness({
    loadService: async () => ({ recognize: async () => ({ lines: [] }), destroy: async () => { destroyed++; } }),
    close: () => { closed++; },
  });
  await h.core.handle(init());
  await h.core.handle({ type: "dispose" });
  assert.equal(destroyed, 1);
  assert.equal(closed, 1);
  await h.core.handle(recognizeMsg(3));
  assert.equal(last(h.posted).code, "not-ready");
});

test("dispose during a download aborts it", { timeout: 2000 }, async () => {
  const h = harness({ fetch: fakeFetch({ hang: "rec" }), close: () => {} });
  const running = h.core.handle(init());
  for (let i = 0; i < 500 && !h.fetch.calls.some((c) => c.url === URLS.rec); i++) await new Promise((r) => setTimeout(r, 1));
  await h.core.handle({ type: "dispose" });
  await running;
  assert.ok(h.fetch.calls.find((c) => c.url === URLS.rec)!.signal!.aborted);
  assert.equal(last(h.posted).code, "aborted");
  assert.equal(h.serviceCalls.length, 0);
});

test("one read at a time: a second recognize in flight gets busy", async () => {
  let release!: () => void;
  const h = harness({
    loadService: async () => ({
      recognize: () => new Promise((r) => { release = () => r({ lines: [] }); }),
      destroy: async () => {},
    }),
  });
  await h.core.handle(init());
  const first = h.core.handle(recognizeMsg(1));
  await h.core.handle(recognizeMsg(2));
  assert.deepEqual(last(h.posted), { type: "error", id: 2, code: "busy", message: "another read is running" });
  release();
  await first;
  assert.deepEqual(last(h.posted), { type: "result", id: 1, words: [] });
});

test("a recognize that arrives busy gets the busy error and its tile's bytes are left alone", async () => {
  let release!: () => void;
  const h = harness({
    loadService: async () => ({
      recognize: () => new Promise((r) => { release = () => r({ lines: [] }); }),
      destroy: async () => {},
    }),
  });
  await h.core.handle(init());
  const first = h.core.handle(redMsg(1));
  const second = redMsg(2);
  await h.core.handle(second);
  assert.deepEqual(last(h.posted), { type: "error", id: 2, code: "busy", message: "another read is running" });
  assert.deepEqual([...second.rgba], [220, 30, 30, 255, 220, 30, 30, 255, 220, 30, 30, 255, 220, 30, 30, 255]);
  release();
  await first;
  assert.deepEqual(last(h.posted), { type: "result", id: 1, words: [] });
});

test("a cancel during engine start, then a second init: one service, one ready, replies tagged by init id", async () => {
  let n = 0;
  const releases: (() => void)[] = [];
  const release = () => releases.forEach((r) => r());
  const h = harness({
    loadService: async () => {
      n++;
      await new Promise<void>((r) => { releases.push(r); });
      return { recognize: async () => ({ lines: [] }), destroy: async () => {} };
    },
  });
  const first = h.core.handle({ ...init(), initId: 1 });
  for (let i = 0; i < 500 && n === 0; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(n, 1, "the first init reached loadService");
  await h.core.handle({ type: "cancel", initId: 1 });
  const second = h.core.handle({ ...init(), initId: 2 });
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
  release();
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
  release();
  await Promise.all([first, second]);
  assert.equal(n, 1, "the second init waits for the first and reuses its service");
  // The first init's service got built despite the cancel, so it says ready:
  // the client ignores that start's settle but learns the engine is up.
  const settles = h.posted.filter((m) => m.type !== "progress");
  assert.deepEqual(settles.map((m) => [m.type, m.code, m.initId]), [["ready", undefined, 1], ["ready", undefined, 2]]);
  const progress = h.posted.filter((m) => m.type === "progress");
  assert.ok(progress.length > 0, "the first init downloaded, with progress");
  assert.deepEqual([...new Set(progress.map((m) => m.initId))], [1], "every progress message is tagged init 1");
});

test("a cancel for an older init doesn't abort the current one", async () => {
  const h = harness();
  const running = h.core.handle({ ...init(), initId: 5 });
  await h.core.handle({ type: "cancel", initId: 4 });
  await running;
  assert.deepEqual([last(h.posted).type, last(h.posted).initId], ["ready", 5]);
});

test("a cancel for an init still queued behind another: it settles aborted and downloads nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let builds = 0;
  const h = harness({
    loadService: async () => {
      builds++;
      await gate;
      throw new Error("build failed");
    },
  });
  const first = h.core.handle({ ...init(), initId: 1 });
  for (let i = 0; i < 500 && builds === 0; i++) await new Promise((r) => setTimeout(r, 1));
  await h.core.handle({ type: "cancel", initId: 1 });
  const second = h.core.handle({ ...init(), initId: 2 });
  await h.core.handle({ type: "cancel", initId: 2 });
  const fetchedBefore = h.fetch.calls.length;
  release();
  await Promise.all([first, second]);
  assert.equal(h.fetch.calls.length, fetchedBefore, "the cancelled init fetched nothing");
  assert.equal(builds, 1, "and built nothing");
  const settles = h.posted.filter((m) => m.type !== "progress" && m.initId === 2);
  assert.deepEqual(settles.map((m) => [m.type, m.code]), [["error", "aborted"]]);
  assert.ok(!h.posted.some((m) => m.type === "progress" && m.initId === 2));
});

test("a cancel between files (while one is being hashed): no further fetch starts", async () => {
  let h!: ReturnType<typeof harness>;
  let hashed = 0;
  h = harness({
    digest: async (buf) => {
      if (++hashed === 1) await h.core.handle({ type: "cancel", initId: 1 });
      return createHash("sha256").update(new Uint8Array(buf)).digest("hex");
    },
  });
  await h.core.handle({ ...init(), initId: 1 });
  assert.equal(h.fetch.calls.length, 1);
  assert.deepEqual([last(h.posted).type, last(h.posted).code], ["error", "aborted"]);
});

// Measured in headless Chromium on Apple silicon, on the demo schedule as an
// image-only page rendered to 4096 × 2607 px (#469 PR): ppu's defaults
// (detection resized to 1920 px, recognition crops from a 2000 px copy)
// found 22/28 tags in about 6.6 s; both at SCAN_MAX_DIM found 28/28, none
// wrong, in about 10.4 to 11.6 s. logSeverityLevel 3 silences ORT's 27
// "Removing initializer" warnings per start with identical words. The
// execution provider is pinned to "cpu" (wasm), the one every browser run
// used (ppu logged `Using user-provided executionProviders: ["cpu"]`):
// forcing WebGPU hung engine start in Chrome, with no speed gain measured.
// Each box is recognized on its own, one crop at a time (#484): ppu's
// per-line default merged a row's boxes into one crop, and its batches of 6
// garbled short lines (engineOptions.ts has the numbers; the real-engine
// check is ocrEngineStrategy.test.ts).
test("the service reads at full raster size, box by box, on the CPU (wasm) provider and keeps ORT's warnings out of the console", async () => {
  const h = harness();
  await h.core.handle(init());
  const o = h.serviceCalls[0].options as { recognition: unknown; session: unknown };
  assert.deepEqual(o.recognition, { maxCropSourceSideLength: SCAN_MAX_DIM, strategy: "per-box", recBatchSize: 1 });
  assert.deepEqual(o.session, { logSeverityLevel: 3, executionProviders: ["cpu"] });
});
