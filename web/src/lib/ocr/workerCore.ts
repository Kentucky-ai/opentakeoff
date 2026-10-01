// The on-device OCR worker's logic (#469), with every browser dependency
// injected so Node can test it. src/ocr.worker.ts is the thin shell that
// wires in the real fetch, Cache Storage, onnxruntime-web and ppu-paddle-ocr.
//
// The worker fetches everything itself (models, dictionary and the ORT
// runtime wasm) from this site, checks each file's length and sha256 against
// the manifest, and keeps it in Cache Storage, so a second visit starts from
// the cache with no network. Cache Storage is optional: without it, the
// buffers live in worker memory for the session. Once an engine is ready,
// the worker deletes the other OCR revs' caches, but only if the server's
// manifest still names this engine's rev: a tab that probed before a deploy
// must not delete the new rev's cache another tab is filling.
//
// Protocol:
//   in : { type: "init", manifest, allowNetwork, initId }
//        { type: "cancel", initId }                 aborts that init's download
//        { type: "recognize", id, rgba, width, height, geometry }
//        { type: "dispose" }
//   out: { type: "progress", loaded, total, initId } bytes, monotonic
//        { type: "ready", initId }
//        { type: "result", id, words }
//        { type: "error", id?, initId?, code, message }   a read error has id,
//                                                         an init error initId
//
// Inits run one after another: a second init waits for the first to settle,
// so two engines are never built at once, and every init reply carries its
// initId so the client can ignore a reply to a start it already abandoned.
// A cancel reaches an init whether it is running or still queued; a queued
// one settles aborted when its turn comes, without downloading. An init
// cancelled after the engine got built still says ready, because it is.
//
// Error codes: consent-required (a file isn't cached and the network wasn't
// allowed), integrity (length or sha256 mismatch, or a file URL that doesn't
// resolve to this site's origin), aborted, network, init, not-ready, busy,
// recognize.
import { asManifest, CACHE_PREFIX, cacheKey, cacheName, MANIFEST_URL, type ManifestEntry, type OcrManifest } from "./manifest";
import { cropBoxToWord, OCR_DETECTION_PADDING, unpadCropBox, type RenderGeometry } from "./raster";
// The engine options live in a leaf module (no imports) so the OCR page
// cache can key on them without importing this file.
import { OCR_ENGINE_OPTIONS, type EngineOptions } from "./engineOptions";
export { OCR_ENGINE_OPTIONS, type EngineOptions };
import type { OcrWord } from "./types";

/** The slice of Cache Storage the core uses. keys and delete are optional:
 * without them, old revs' caches are left for the browser to evict. */
export interface CacheStorageLike {
  open(name: string): Promise<{
    match(key: string): Promise<Response | undefined>;
    put(key: string, res: Response): Promise<void>;
  }>;
  keys?(): Promise<string[]>;
  delete?(name: string): Promise<boolean>;
}

/** The slice of onnxruntime-web's module the core configures. */
export interface OrtLike { env: { wasm: Record<string, unknown> } }

/** The slice of ppu-paddle-ocr's PaddleOcrService the core uses. */
export interface OcrServiceLike {
  recognize(canvas: unknown, opts: { flatten: false; noCache: true }): Promise<unknown>;
  destroy(): Promise<void>;
}

export interface EngineBuffers {
  detection: ArrayBuffer;
  recognition: ArrayBuffer;
  charactersDictionary: ArrayBuffer;
}

export interface OcrCoreDeps {
  fetchImpl: (url: string, init?: { signal?: AbortSignal; cache?: RequestCache }) => Promise<Response>;
  /** `caches` in a browser; undefined where it doesn't exist */
  cacheStorage?: CacheStorageLike;
  /** served URLs of the ORT asyncify runtime (Vite `?url` imports) */
  ortWasmUrl: string;
  ortMjsUrl: string;
  /** import("onnxruntime-web/webgpu") */
  loadRuntime: () => Promise<OrtLike>;
  /** import ppu, construct the service from the buffers and detection
   * options, await initialize() */
  loadService: (buffers: EngineBuffers, options: EngineOptions) => Promise<OcrServiceLike>;
  /** RGBA → a canvas ppu can read (an OffscreenCanvas in the worker) */
  makeCanvas: (rgba: Uint8ClampedArray, width: number, height: number) => unknown;
  /** this site's origin (self.location.origin); every file URL must
   * resolve to it */
  origin?: string;
  post: (msg: unknown) => void;
  /** sha256 hex; defaults to crypto.subtle */
  digest?: (buf: ArrayBuffer) => Promise<string>;
  close?: () => void;
}

export type OcrInMsg =
  | { type: "init"; manifest: OcrManifest; allowNetwork: boolean; initId?: number }
  | { type: "cancel"; initId?: number }
  | { type: "recognize"; id: number; rgba: Uint8ClampedArray; width: number; height: number; geometry: RenderGeometry }
  | { type: "dispose" };

/** An error that carries a protocol code. */
export class OcrCoreError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const subtleDigest = async (buf: ArrayBuffer): Promise<string> => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
};

const ENGINE_FILES = { detection: "det", recognition: "rec", charactersDictionary: "dict" } as const;

type Cell = { text?: string; box?: { x: number; y: number; width: number; height: number }; confidence?: number };

export function createOcrCore(deps: OcrCoreDeps) {
  const digest = deps.digest ?? subtleDigest;
  let service: OcrServiceLike | null = null;
  let controller: { id: number | undefined; ctrl: AbortController } | null = null;
  let initChain: Promise<void> = Promise.resolve();
  // Init ids waiting behind initChain, and the ones cancelled while waiting.
  const queued = new Set<number>();
  const cancelled = new Set<number>();
  let busy = false;

  async function openCache(rev: string) {
    try {
      return deps.cacheStorage ? await deps.cacheStorage.open(cacheName(rev)) : null;
    } catch {
      return null; // private mode, blocked storage: keep going without a cache
    }
  }

  /** Fetch or read from cache every manifest file, verified. */
  async function download(manifest: OcrManifest, { allowNetwork, signal, initId }: { allowNetwork: boolean; signal?: AbortSignal; initId?: number }) {
    const cache = await openCache(manifest.rev);
    const total = manifest.files.reduce((s, f) => s + f.bytes, 0);
    let loaded = 0;
    const progress = (n: number) => {
      const next = Math.min(total, Math.max(loaded, n));
      if (next === loaded && n !== total) return;
      loaded = next;
      deps.post({ type: "progress", loaded, total, initId });
    };

    const out: Record<string, ArrayBuffer> = {};
    const missing: ManifestEntry[] = [];
    for (const f of manifest.files) {
      let hit: ArrayBuffer | null = null;
      try {
        const res = await cache?.match(cacheKey(f));
        if (res) hit = await res.arrayBuffer();
      } catch { /* an unreadable entry is a miss */ }
      // Cached entries were checked when written; a wrong length means a
      // truncated write, so treat it as a miss.
      if (hit && hit.byteLength === f.bytes) out[f.name] = hit;
      else missing.push(f);
    }
    if (missing.length && !allowNetwork) {
      throw new OcrCoreError("consent-required", `${missing.length} OCR file(s) are not cached`);
    }
    progress(total - missing.reduce((s, f) => s + f.bytes, 0));

    for (const f of missing) {
      if (signal?.aborted) throw new OcrCoreError("aborted", "download cancelled");
      const url = f.url ?? (f.name === "ort-wasm" ? deps.ortWasmUrl : undefined);
      if (!url) throw new OcrCoreError("integrity", `manifest entry ${f.name} has no url`);
      assertSameOrigin(url);
      const base = loaded;
      let res: Response;
      try {
        res = await deps.fetchImpl(url, { signal });
      } catch (err) {
        if (signal?.aborted) throw new OcrCoreError("aborted", "download cancelled");
        throw new OcrCoreError("network", `couldn't fetch ${url}: ${err instanceof Error ? err.message : err}`);
      }
      if (!res.ok) throw new OcrCoreError("network", `${res.status} fetching ${url}`);
      const buf = await readBody(res, f.bytes, signal, (n) => progress(base + Math.min(n, f.bytes)));
      if (buf.byteLength !== f.bytes) {
        throw new OcrCoreError("integrity", `${f.name}: expected ${f.bytes} bytes, got ${buf.byteLength}`);
      }
      const got = await digest(buf);
      if (got !== f.sha256) throw new OcrCoreError("integrity", `${f.name}: sha256 mismatch`);
      try {
        // No slice(0): constructing a Response from a BufferSource copies
        // its bytes (Fetch, "extract a body"), so buf stays ours.
        await cache?.put(cacheKey(f), new Response(buf));
      } catch { /* quota or blocked storage: this session still has the bytes */ }
      out[f.name] = buf;
    }
    progress(total);
    return out;
  }

  /** Files come from this site only. The client's manifest parser already
   * limits model URLs to /models/ocr/; this also covers the runtime's
   * `?url`, and a manifest that reached the worker some other way. */
  function assertSameOrigin(url: string) {
    const origin = deps.origin ?? globalThis.location?.origin;
    let resolved: string | null = null;
    try { resolved = origin ? new URL(url, origin).origin : null; } catch { /* unparseable */ }
    if (!origin || resolved !== origin) throw new OcrCoreError("integrity", `${url} is not on this site (${origin ?? "unknown origin"})`);
  }

  /** Read a body into one exact-length ArrayBuffer, reporting bytes so far. */
  async function readBody(res: Response, expected: number, signal: AbortSignal | undefined, onBytes: (n: number) => void): Promise<ArrayBuffer> {
    if (!res.body) {
      const b = await res.arrayBuffer();
      onBytes(b.byteLength);
      return b;
    }
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    try {
      for (;;) {
        if (signal?.aborted) throw new OcrCoreError("aborted", "download cancelled");
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        n += value.byteLength;
        // A body far past its manifest size is wrong; stop reading it, and
        // cancel so the rest isn't downloaded. The length check then fails.
        if (n > expected * 2 + 1024) {
          reader.cancel().catch(() => {});
          break;
        }
        onBytes(n);
      }
    } catch (err) {
      reader.cancel().catch(() => {});
      if (signal?.aborted || (err as { name?: string })?.name === "AbortError") throw new OcrCoreError("aborted", "download cancelled");
      throw err instanceof OcrCoreError ? err : new OcrCoreError("network", String(err));
    }
    const buf = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { buf.set(p, at); at += p.byteLength; }
    return buf.buffer;
  }

  /** Configure the runtime, then build the service. Refuses anything but
   * exact-length ArrayBuffers: ppu checks `instanceof ArrayBuffer`, and any
   * other value makes it fetch its default models from Hugging Face. */
  async function startEngine(manifest: OcrManifest, buffers: Record<string, unknown>): Promise<OcrServiceLike> {
    const sizes = Object.fromEntries(manifest.files.map((f) => [f.name, f.bytes]));
    const need = (name: string): ArrayBuffer => {
      const b = buffers[name];
      if (b === undefined) throw new OcrCoreError("init", `missing ${name} buffer`);
      if (!(b instanceof ArrayBuffer)) throw new OcrCoreError("init", `${name} is not an ArrayBuffer`);
      if (b.byteLength !== sizes[name]) throw new OcrCoreError("init", `${name} ArrayBuffer is ${b.byteLength} bytes, expected ${sizes[name]}`);
      return b;
    };
    const wasmBinary = need("ort-wasm");
    const engine = {
      detection: need(ENGINE_FILES.detection),
      recognition: need(ENGINE_FILES.recognition),
      charactersDictionary: need(ENGINE_FILES.charactersDictionary),
    };
    const ort = await deps.loadRuntime();
    // Order matters: ppu points wasmPaths at a CDN when it loads unless it is
    // already set, and ORT fetches no wasm when wasmBinary is given. Only the
    // small .mjs glue loads by URL, same-origin. One thread: this site sends
    // no COOP/COEP, so there is no SharedArrayBuffer for threads anyway.
    ort.env.wasm.wasmPaths = { mjs: deps.ortMjsUrl };
    ort.env.wasm.wasmBinary = wasmBinary;
    ort.env.wasm.numThreads = 1;
    let svc: OcrServiceLike;
    try {
      svc = await deps.loadService(engine, OCR_ENGINE_OPTIONS);
    } finally {
      // ORT compiles the wasm once, while the service builds; after that
      // this 23.6 MB copy is dead weight in the worker, built or not.
      ort.env.wasm.wasmBinary = undefined;
    }
    // ppu sets a CDN wasmPaths on load unless one is set; if it (or anything
    // else) replaced or edited ours, a later session could reach off-site.
    const paths = ort.env.wasm.wasmPaths as Record<string, unknown> | undefined;
    const intact = !!paths && typeof paths === "object" && Object.keys(paths).length === 1 && paths.mjs === deps.ortMjsUrl;
    if (!intact) {
      try { await svc.destroy(); } catch { /* failing anyway */ }
      throw new OcrCoreError("init", `ort.env.wasm.wasmPaths changed during engine start: ${JSON.stringify(paths)}`);
    }
    return svc;
  }

  /** Delete every OCR cache but this rev's: a model or ORT bump would
   * otherwise leave the old ~36 MB in the browser for good. Only when the
   * server's manifest, fetched past the HTTP cache, is this rev: an engine
   * started from a manifest probed before a deploy is itself the old rev,
   * and deleting "the others" would wipe the new rev's cache that a tab on
   * the new manifest may be filling. Any doubt leaves them. Best effort. */
  async function dropOldCaches(rev: string) {
    const cs = deps.cacheStorage;
    if (!cs?.keys || !cs.delete) return;
    try {
      const res = await deps.fetchImpl(MANIFEST_URL, { cache: "no-store" });
      if (!res.ok || asManifest(await res.json())?.rev !== rev) return;
      const keep = cacheName(rev);
      for (const name of await cs.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== keep) {
          try { await cs.delete(name); } catch { /* blocked storage: leave it */ }
        }
      }
    } catch { /* manifest unreachable or unreadable, or keys() unavailable: leave them */ }
  }

  function init(manifest: OcrManifest, allowNetwork: boolean, initId?: number): Promise<void> {
    if (initId !== undefined) queued.add(initId);
    const run = initChain.then(() => {
      if (initId !== undefined) queued.delete(initId);
      if (initId !== undefined && cancelled.delete(initId) && !service) {
        deps.post({ type: "error", initId, code: "aborted", message: "start cancelled" });
        return;
      }
      return initOnce(manifest, allowNetwork, initId);
    });
    initChain = run.catch(() => {});
    return run;
  }

  async function initOnce(manifest: OcrManifest, allowNetwork: boolean, initId?: number) {
    if (service) { deps.post({ type: "ready", initId }); return; }
    const mine = { id: initId, ctrl: new AbortController() };
    controller = mine;
    const { signal } = mine.ctrl;
    try {
      const buffers = await download(manifest, { allowNetwork, signal, initId });
      if (signal.aborted) throw new OcrCoreError("aborted", "download cancelled");
      // Assign only once the service is fully built: a failed init leaves
      // nothing behind, and the next init starts from scratch. A service
      // that finishes building after a cancel is kept, and reported ready so
      // the client knows the engine is up.
      service = await startEngine(manifest, buffers);
      deps.post({ type: "ready", initId });
      // After ready, so a slow Cache Storage can't hold up the start.
      await dropOldCaches(manifest.rev);
    } catch (err) {
      const code = err instanceof OcrCoreError ? err.code : "init";
      deps.post({ type: "error", initId, code, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (controller === mine) controller = null;
    }
  }

  async function recognize(msg: Extract<OcrInMsg, { type: "recognize" }>) {
    if (!service) {
      deps.post({ type: "error", id: msg.id, code: "not-ready", message: "the OCR engine isn't loaded" });
      return;
    }
    if (busy) {
      deps.post({ type: "error", id: msg.id, code: "busy", message: "another read is running" });
      return;
    }
    busy = true;
    try {
      const canvas = deps.makeCanvas(msg.rgba, msg.width, msg.height);
      // noCache: ppu's image cache keys on a 4 KB sample, so two similar
      // tiles can collide and return each other's text.
      const res = (await service.recognize(canvas, { flatten: false, noCache: true })) as { lines?: Cell[][] };
      const words: OcrWord[] = [];
      for (const line of res?.lines ?? []) {
        for (const cell of line ?? []) {
          const str = (cell.text ?? "").trim();
          if (!str || !cell.box) continue;
          const { x, y, width, height } = cell.box;
          // ppu returns the padded box it cropped for recognition; take the
          // padding off so x, y and h describe the text itself.
          const ink = unpadCropBox({ x0: x, y0: y, x1: x + width, y1: y + height }, msg, OCR_DETECTION_PADDING);
          words.push(cropBoxToWord(str, ink, msg.geometry, cell.confidence));
        }
      }
      deps.post({ type: "result", id: msg.id, words });
    } catch (err) {
      deps.post({ type: "error", id: msg.id, code: "recognize", message: err instanceof Error ? err.message : String(err) });
    } finally {
      busy = false;
    }
  }

  async function handle(msg: OcrInMsg) {
    if (msg.type === "init") return init(msg.manifest, msg.allowNetwork, msg.initId);
    if (msg.type === "cancel") {
      if (controller && (msg.initId === undefined || msg.initId === controller.id)) controller.ctrl.abort();
      if (msg.initId === undefined) for (const id of queued) cancelled.add(id);
      else if (queued.has(msg.initId)) cancelled.add(msg.initId);
      return;
    }
    if (msg.type === "recognize") return recognize(msg);
    if (msg.type === "dispose") {
      controller?.ctrl.abort();
      try { await service?.destroy(); } catch { /* closing anyway */ }
      service = null;
      deps.close?.();
    }
  }

  return { handle, download, startEngine };
}
