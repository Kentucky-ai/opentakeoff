// The door-detector worker's logic, with every browser dependency injected so
// Node can test it. src/doorDetect.worker.ts is the thin shell that wires in
// the real fetch, Cache Storage and onnxruntime-web.
//
// The model is one ONNX file (about 117 MB) on Hugging Face. The worker
// downloads it once, checks its length and sha256 against the pinned values
// in doorDetectSettings.json, and keeps it in Cache Storage, so every later
// visit starts from the cache with no network. Nothing is uploaded: the
// worker's only request is that download.
//
// Protocol:
//   in : { type: "init", allowNetwork }      load the model (download only if allowed)
//        { type: "cancel" }                  abort a download in progress
//        { type: "tile", id, px, x, y }      one 640 px gray tile at page-render offset x, y
//        { type: "dispose" }
//   out: { type: "progress", loaded, total } download bytes
//        { type: "ready", cached, provider } cached: no download was needed
//        { type: "boxes", id, boxes }        boxes in page-render pixels
//        { type: "error", id?, code, message }
// Error codes: consent-required (not cached, network not allowed), no-webgpu,
// integrity, network, aborted, init, not-ready, run.
import { decodeTile, tileTensor, type DetectParams } from "./tiles.ts";
import type { DetBox } from "./geom.ts";

export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys?(): Promise<string[]>;
  delete?(name: string): Promise<boolean>;
}
export interface SessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number>; dims: readonly number[] }>>;
  release?(): Promise<void>;
}
export interface ModelSpec { url: string; bytes: number; sha256: string; nClasses: number }
export interface DetectCoreDeps {
  fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  cacheStorage?: CacheStorageLike;
  /** true when this worker can get a WebGPU adapter */
  hasWebGpu: () => Promise<boolean>;
  /** build an inference session on WebGPU from the model bytes */
  createSession: (model: ArrayBuffer) => Promise<SessionLike>;
  /** wrap a float32 NCHW array as the runtime's tensor */
  makeTensor: (data: Float32Array, dims: number[]) => unknown;
  post: (msg: unknown) => void;
  digest?: (buf: ArrayBuffer) => Promise<string>;
  close?: () => void;
}
export type DetectInMsg =
  | { type: "init"; allowNetwork: boolean }
  | { type: "cancel" }
  | { type: "tile"; id: number; px: Uint8Array; x: number; y: number }
  | { type: "dispose" };

export const CACHE_PREFIX = "opentakeoff-door-detector-";
export const cacheNameFor = (sha256: string) => `${CACHE_PREFIX}${sha256.slice(0, 16)}`;
export const CACHE_KEY = "/door-detector/model.onnx";

class CoreError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const subtleDigest = async (buf: ArrayBuffer): Promise<string> => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
};

export function createDetectCore(deps: DetectCoreDeps, model: ModelSpec, P: DetectParams) {
  const digest = deps.digest ?? subtleDigest;
  let session: SessionLike | null = null;
  let starting: Promise<void> | null = null;
  let ctrl: AbortController | null = null;
  let chain: Promise<void> = Promise.resolve();

  async function openCache(): Promise<CacheLike | null> {
    try { return deps.cacheStorage ? await deps.cacheStorage.open(cacheNameFor(model.sha256)) : null; } catch { return null; }
  }

  async function modelBytes(allowNetwork: boolean): Promise<{ buf: ArrayBuffer; cached: boolean }> {
    const cache = await openCache();
    try {
      const hit = await cache?.match(CACHE_KEY);
      if (hit) {
        const buf = await hit.arrayBuffer();
        // checked when written; a wrong length means a truncated write
        if (buf.byteLength === model.bytes) return { buf, cached: true };
      }
    } catch { /* an unreadable entry is a miss */ }
    if (!allowNetwork) throw new CoreError("consent-required", "the door detector model is not downloaded yet");
    ctrl = new AbortController();
    const signal = ctrl.signal;
    let res: Response;
    try { res = await deps.fetchImpl(model.url, { signal }); }
    catch (err) {
      if (signal.aborted) throw new CoreError("aborted", "download cancelled");
      throw new CoreError("network", `couldn't fetch the model: ${err instanceof Error ? err.message : err}`);
    }
    if (!res.ok) throw new CoreError("network", `${res.status} fetching the model`);
    const out = new Uint8Array(model.bytes);
    let n = 0;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (n + value.byteLength > model.bytes) { reader.cancel().catch(() => {}); throw new CoreError("integrity", "the model file is longer than expected"); }
          out.set(value, n);
          n += value.byteLength;
          deps.post({ type: "progress", loaded: n, total: model.bytes });
        }
      } catch (err) {
        if (err instanceof CoreError) throw err;
        if (signal.aborted) throw new CoreError("aborted", "download cancelled");
        throw new CoreError("network", String(err));
      }
    } else {
      const b = new Uint8Array(await res.arrayBuffer());
      if (b.byteLength > model.bytes) throw new CoreError("integrity", "the model file is longer than expected");
      out.set(b); n = b.byteLength;
      deps.post({ type: "progress", loaded: n, total: model.bytes });
    }
    if (n !== model.bytes) throw new CoreError("integrity", `expected ${model.bytes} bytes, got ${n}`);
    if ((await digest(out.buffer)) !== model.sha256) throw new CoreError("integrity", "the model file's sha256 does not match");
    try { await cache?.put(CACHE_KEY, new Response(out.buffer.slice(0))); } catch { /* quota or blocked storage: this session still has the bytes */ }
    void dropOldCaches();
    return { buf: out.buffer, cached: false };
  }

  /** Delete caches of other model files (an older pinned sha256). Best effort. */
  async function dropOldCaches() {
    const cs = deps.cacheStorage;
    if (!cs?.keys || !cs.delete) return;
    try {
      const keep = cacheNameFor(model.sha256);
      for (const name of await cs.keys()) if (name.startsWith(CACHE_PREFIX) && name !== keep) await cs.delete(name);
    } catch { /* leave them */ }
  }

  async function init(allowNetwork: boolean) {
    if (session) { deps.post({ type: "ready", cached: true, provider: "webgpu" }); return; }
    if (!starting) {
      starting = (async () => {
        if (!(await deps.hasWebGpu())) throw new CoreError("no-webgpu", "this browser has no WebGPU");
        const { buf, cached } = await modelBytes(allowNetwork);
        try { session = await deps.createSession(buf); }
        catch (err) { throw new CoreError("init", `couldn't start the model: ${err instanceof Error ? err.message : err}`); }
        deps.post({ type: "ready", cached, provider: "webgpu" });
      })();
    }
    try { await starting; }
    catch (err) {
      const e = err instanceof CoreError ? err : new CoreError("init", String(err));
      deps.post({ type: "error", code: e.code, message: e.message });
    } finally { starting = null; ctrl = null; }
  }

  async function tile(id: number, px: Uint8Array, x: number, y: number) {
    if (!session) { deps.post({ type: "error", id, code: "not-ready", message: "the model is not loaded" }); return; }
    try {
      const input = tileTensor(px, P.tile, P.input);
      const out = await session.run({ input: deps.makeTensor(input, [1, 3, P.input, P.input]) });
      const dets = out.dets, labels = out.labels;
      const cols = labels.dims[labels.dims.length - 1];
      const boxes: DetBox[] = decodeTile(dets.data, labels.data, cols, model.nClasses, P.tile, P.floor, P.top_k).map((b) => [b[0] + x, b[1] + y, b[2] + x, b[3] + y, b[4], b[5]]);
      deps.post({ type: "boxes", id, boxes });
    } catch (err) {
      deps.post({ type: "error", id, code: "run", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handle(msg: DetectInMsg): Promise<void> {
    if (msg.type === "cancel") { ctrl?.abort(); return Promise.resolve(); }
    // one thing at a time: a tile never runs while the model is still loading
    chain = chain.then(async () => {
      if (msg.type === "init") await init(msg.allowNetwork);
      else if (msg.type === "tile") await tile(msg.id, msg.px, msg.x, msg.y);
      else if (msg.type === "dispose") { try { await session?.release?.(); } catch { /* closing anyway */ } session = null; deps.close?.(); }
    });
    return chain;
  }

  return { handle };
}
