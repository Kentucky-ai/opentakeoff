// Main-thread client for the on-device OCR worker (#469). Owns the worker's
// life cycle; callers never touch the worker. Nothing loads until a caller
// asks: probe() is one small same-origin GET, and the worker starts only once
// the files are cached or the person has agreed to download them.
//
// Consent isn't stored. The client checks Cache Storage instead: if every
// file is cached, the engine starts without asking; if the browser evicted
// the cache, the download notice comes back. The worker enforces the same
// rule, so a cache evicted between the probe and the start still asks.
//
// Reads queue first in, first out, and the worker runs one at a time, so two
// features can share one engine. App code must use that one shared engine,
// getOcrClient(), never a client of its own: two clients would build two
// engines, each holding its own models. createOcrClient is for tests.
//
// Starts are shared, answers are per call. Callers that ask while a start is
// running wait on that same start, each with its own signal, progress and
// consent. Aborting detaches only that caller; the worker's download is
// cancelled once no caller wants it any more. Only a caller that passed
// consent keeps a network download going: when the last one leaves, the rest
// hear consent-required. A caller without consent that joins a download
// waits for it like anyone else. And if a caller brings consent to a start
// that would end consent-required, the start goes on with the download.
//
// A read the worker never answers would hold the queue, and whenIdle, for
// good (#484). Each posted read has a deadline, readDeadlineMs: generous,
// since a false timeout costs a read and a hang costs everything after it.
// When it passes, the read rejects OcrTimeoutError, the worker is ended and
// the reads queued behind it reject too, so nothing waits forever; the next
// ensureReady starts a fresh worker.
//
// dispose() is final: pending and later ensureReady calls resolve aborted,
// and no worker is started again.
import { ocrEnabled } from "../gate.js";
import { asManifest, cacheKey, cacheName, MANIFEST_URL, type OcrManifest } from "./manifest";
import type { CacheStorageLike } from "./workerCore";
import type { RenderGeometry } from "./raster";
import type { OcrWord } from "./types";

export type OcrProbe =
  | { state: "disabled" }                  // VITE_OCR=off on this build
  | { state: "uninstalled" }               // no models staged on this site
  | { state: "error"; message: string }    // retryable
  | { state: "available"; manifest: OcrManifest; cached: boolean; downloadBytes: number };

export type OcrReady =
  | { ok: true }
  | { ok: false; reason: "disabled" | "uninstalled" | "consent-required" | "aborted" }
  | { ok: false; reason: "error"; message: string };

export interface OcrProgress { loaded: number; total: number; pct: number }

export interface OcrRegion { rgba: Uint8ClampedArray; width: number; height: number; geometry: RenderGeometry }

/** The Worker surface the client uses; a test injects a fake. */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

export interface OcrClientDeps {
  enabled?: boolean;
  fetchImpl?: (url: string, init?: { method?: string }) => Promise<Response>;
  cacheStorage?: CacheStorageLike;
  spawnWorker?: () => WorkerLike;
  /** The watchdog's clock; setTimeout / clearTimeout by default (unref'd
   * where the host has it, so an unanswered read can't hold node open). A
   * test injects timers it fires by hand. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** A read the worker never answered within its deadline. */
export class OcrTimeoutError extends Error {
  constructor() {
    super("The on-device reader stopped responding.");
    // Not AbortError: that reads as "page closed" and would hide this.
    this.name = "OcrTimeoutError";
  }
}

// How long one read may take, from the measured fits (#484 g3-timing and
// timing.json, per-line and per-box): 0.21 s + 0.79 s/MP up to
// 1.33 s + 0.88 s/MP, worst read 1.74–1.96× its fit. The envelope rounds
// over all of them; k is the margin on top. A hang never ends, so a long
// bound costs little; a false timeout costs a read.
const ENVELOPE_BASE_MS = 1_500;
const ENVELOPE_PER_MP_MS = 1_000;
const DEADLINE_FLOOR_MS = 120_000;
const K_UNCALIBRATED = 20;
const K_CALIBRATED = 10;

/** The deadline for a read of `mp` megapixels: max(120 s, k × envelope).
 * Without `slowdown` (no read measured on this device yet) k is 20; with it,
 * 10 × slowdown, where slowdown ≥ 1 is how much slower than the envelope
 * this device has read. A 16 MP tile: 350 s, then 175 s at slowdown 1. */
export function readDeadlineMs(mp: number, slowdown?: number): number {
  const scale = slowdown === undefined ? K_UNCALIBRATED : K_CALIBRATED * Math.max(1, slowdown);
  return Math.max(DEADLINE_FLOOR_MS, Math.round(scale * (ENVELOPE_BASE_MS + ENVELOPE_PER_MP_MS * mp)));
}

type WorkerMsg = { type: string; id?: number; initId?: number; code?: string; message?: string; loaded?: number; total?: number; words?: OcrWord[] };
type Waiter = { consent: boolean; onProgress?: (p: OcrProgress) => void; settle: (r: OcrReady) => void };
/** One shared start. `done` is set once it settles or is cancelled; `initId`
 * and `resolveInit` are set while an init is out at the worker. */
type Attempt = { waiters: Set<Waiter>; done: boolean; network: boolean; initId: number | null; resolveInit: ((r: OcrReady) => void) | null };
const ABORTED: OcrReady = { ok: false, reason: "aborted" };
const CONSENT_REQUIRED: OcrReady = { ok: false, reason: "consent-required" };

/** `cleanup` drops the abort listener; `timer` is the deadline, armed once
 * the read is posted. An abort runs cleanup only: the worker is still busy
 * with the read, so its deadline still stands. */
type Job = { id: number; region: OcrRegion; resolve: (w: OcrWord[]) => void; reject: (e: Error) => void; aborted: boolean; cleanup: () => void; timer: unknown };

const abortError = () => new DOMException("The OCR read was cancelled.", "AbortError");

const defaultSpawn = (): WorkerLike =>
  new Worker(new URL("../../ocr.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
  const h = setTimeout(fn, ms) as unknown as { unref?: () => void };
  h.unref?.();
  return h;
};
const defaultClearTimer = (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>);

export function createOcrClient(deps: OcrClientDeps = {}) {
  const enabled = deps.enabled ?? ocrEnabled();
  const fetchImpl = deps.fetchImpl ?? ((url: string, init?: { method?: string }) => fetch(url, init));
  const cacheStorage = "cacheStorage" in deps ? deps.cacheStorage : (typeof caches === "undefined" ? undefined : caches);
  const spawnWorker = deps.spawnWorker ?? defaultSpawn;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? defaultClearTimer;

  let uninstalled = false;
  let manifest: OcrManifest | null = null;
  let worker: WorkerLike | null = null;
  let ready = false;
  let disposed = false;
  // The start in progress, if any. Each init posted to the worker gets an id
  // the worker echoes, so a reply to a start everyone abandoned can't settle
  // the next one.
  let attempt: Attempt | null = null;
  let initSeq = 0;
  let seq = 0;
  const queue: Job[] = [];
  let running: Job | null = null;
  // whenIdle's callers, answered once nothing is running or queued.
  let idleWaiters: (() => void)[] = [];
  function checkIdle() {
    if (running || queue.length || !idleWaiters.length) return;
    const ws = idleWaiters;
    idleWaiters = [];
    for (const w of ws) w();
  }

  async function missingFiles(m: OcrManifest) {
    try {
      if (!cacheStorage) return m.files;
      const cache = await cacheStorage.open(cacheName(m.rev));
      const out = [];
      for (const f of m.files) {
        // A wrong length is a truncated write; the worker refetches it, so
        // it counts toward the download. Only the size is needed, so blob(),
        // not arrayBuffer().
        const hit = await cache.match(cacheKey(f));
        if (!hit || (await hit.blob()).size !== f.bytes) out.push(f);
      }
      return out;
    } catch {
      return m.files;
    }
  }

  /** Is OCR on this site, and what would starting it download? One GET. */
  async function probe(): Promise<OcrProbe> {
    if (!enabled) return { state: "disabled" };
    if (uninstalled) return { state: "uninstalled" };
    if (!manifest) {
      let res: Response;
      try {
        res = await fetchImpl(MANIFEST_URL);
      } catch (err) {
        return { state: "error", message: err instanceof Error ? err.message : String(err) };
      }
      if (res.status >= 500) return { state: "error", message: `manifest request failed (${res.status})` };
      // SPA-fallback hosts answer a missing file with 200 + index.html.
      if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) {
        uninstalled = true;
        return { state: "uninstalled" };
      }
      let parsed: OcrManifest | null = null;
      try { parsed = asManifest(await res.json()); } catch { /* not JSON */ }
      if (!parsed) return { state: "error", message: "the OCR manifest isn't valid" };
      manifest = parsed;
    }
    const missing = await missingFiles(manifest);
    return { state: "available", manifest, cached: missing.length === 0, downloadBytes: missing.reduce((s, f) => s + f.bytes, 0) };
  }

  /** Settle every caller still waiting on `att`, once. */
  function finish(att: Attempt, r: OcrReady) {
    if (att.done) return;
    att.done = true;
    if (attempt === att) attempt = null;
    const init = att.resolveInit;
    att.resolveInit = null;
    init?.(r);
    const ws = [...att.waiters];
    att.waiters.clear();
    for (const w of ws) w.settle(r);
  }

  /** Nobody (or nobody who consented) wants `att` any more: stop it. */
  function cancelAttempt(att: Attempt, forRest: OcrReady) {
    if (att.done) return;
    if (att.initId != null && att.resolveInit) {
      try { worker?.postMessage({ type: "cancel", initId: att.initId }); } catch { /* gone */ }
    }
    finish(att, forRest);
  }

  function detach(att: Attempt, w: Waiter) {
    if (!att.waiters.delete(w)) return;
    const consented = [...att.waiters].some((x) => x.consent);
    if (att.network && !consented) cancelAttempt(att, CONSENT_REQUIRED);
    else if (att.waiters.size === 0) cancelAttempt(att, ABORTED);
  }

  /** Post one init and wait for its reply (or for the attempt to end). */
  function postInit(att: Attempt, m: OcrManifest, network: boolean): Promise<OcrReady> {
    if (att.done || disposed) return Promise.resolve(ABORTED);
    if (!worker) { worker = spawnWorker(); attach(worker); }
    const initId = ++initSeq;
    att.initId = initId;
    att.network = network;
    return new Promise<OcrReady>((resolve) => {
      att.resolveInit = (r) => { att.resolveInit = null; resolve(r); };
      worker!.postMessage({ type: "init", manifest: m, allowNetwork: network, initId });
    });
  }

  async function start(att: Attempt): Promise<OcrReady> {
    const p = await probe();
    if (att.done || disposed) return ABORTED;
    if (p.state === "error") return { ok: false, reason: "error", message: p.message };
    if (p.state !== "available") return { ok: false, reason: p.state };
    const anyConsent = () => [...att.waiters].some((w) => w.consent);
    let network = anyConsent();
    if (!p.cached && !network) return CONSENT_REQUIRED;
    for (;;) {
      const r = await postInit(att, p.manifest, network);
      // The cache went missing under a consent-less init, and someone has
      // since agreed: download for them.
      if (!r.ok && r.reason === "consent-required" && !network && !att.done && anyConsent()) {
        network = true;
        continue;
      }
      return r;
    }
  }

  /** A job is done with: drop its abort listener and its deadline. */
  function settled(j: Job) {
    if (j.timer != null) clearTimer(j.timer);
    j.timer = null;
    j.cleanup();
  }

  function rejectAll(err: Error) {
    const jobs = running ? [running, ...queue] : [...queue];
    queue.length = 0;
    running = null;
    for (const j of jobs) {
      settled(j);
      if (!j.aborted) j.reject(err);
    }
    checkIdle();
  }

  function discardWorker(err: Error) {
    const w = worker;
    worker = null;
    ready = false;
    rejectAll(err);
    attempt?.resolveInit?.({ ok: false, reason: "error", message: err.message });
    try { w?.terminate(); } catch { /* already gone */ }
  }

  /** The running read's deadline passed: answer its caller, end the worker
   * and every read queued behind it. */
  function timeOut(job: Job) {
    // A timer that fired anyway after its job settled (or the worker
    // changed) touches nothing: the job is no longer the running one.
    if (running !== job) return;
    discardWorker(new OcrTimeoutError());
  }

  function attach(w: WorkerLike) {
    w.onmessage = (e) => {
      // An ended worker's messages, already on their way, are ignored: its
      // ready isn't the new worker's, and its replies answer nothing.
      if (worker !== w) return;
      const m = e.data as WorkerMsg;
      if (m.id == null) {
        // An init reply. One for an abandoned start is ignored, except that
        // its ready still means the engine is built.
        if (m.type === "ready") ready = true;
        const att = attempt;
        const live = att?.resolveInit && (m.initId === undefined || m.initId === att.initId);
        if (!live) return;
        if (m.type === "progress") {
          const total = m.total ?? 0, loaded = m.loaded ?? 0;
          const p = { loaded, total, pct: total ? Math.round((100 * loaded) / total) : 0 };
          for (const w of att.waiters) w.onProgress?.(p);
        } else if (m.type === "ready") {
          att.resolveInit!({ ok: true });
        } else if (m.type === "error") {
          if (m.code === "consent-required") att.resolveInit!(CONSENT_REQUIRED);
          else if (m.code === "aborted") att.resolveInit!(ABORTED);
          else att.resolveInit!({ ok: false, reason: "error", message: m.message ?? "OCR failed to start" });
        }
        return;
      }
      if (m.type === "result" || m.type === "error") {
        const job = running;
        if (!job || job.id !== m.id) return; // unknown or stale id
        running = null;
        settled(job);
        // An aborted job's caller already got AbortError; drop the late reply.
        if (!job.aborted) {
          if (m.type === "result") job.resolve(m.words ?? []);
          else job.reject(new Error(m.message ?? "OCR read failed"));
        }
        pump();
      }
    };
    // A worker that fails to load or throws fires an error event, never a
    // message. Without this, everything waiting on it would hang.
    w.onerror = (e) => {
      if (worker !== w) return;
      discardWorker(new Error((e as { message?: string })?.message || "the OCR worker failed"));
    };
  }

  /** Start the engine. Resolves `consent-required` without starting a worker
   * unless every file is cached or `consent: true` is passed for this call.
   * Pass `consent: true` only from the person pressing the notice's Download
   * (OcrDownloadNotice's onDownload), never on their behalf: it is what lets
   * the download start. Calls made while a start is running share it; see
   * the header. */
  function ensureReady(opts: { consent?: boolean; signal?: AbortSignal; onProgress?: (p: OcrProgress) => void } = {}): Promise<OcrReady> {
    if (disposed) return Promise.resolve(ABORTED);
    if (ready && worker) return Promise.resolve({ ok: true });
    const { signal } = opts;
    if (signal?.aborted) return Promise.resolve(ABORTED);
    return new Promise<OcrReady>((resolve) => {
      let att = attempt;
      const fresh = !att;
      if (!att) att = attempt = { waiters: new Set(), done: false, network: false, initId: null, resolveInit: null };
      const joined = att;
      const onAbort = () => { detach(joined, waiter); resolve(ABORTED); };
      const waiter: Waiter = {
        consent: opts.consent === true,
        onProgress: opts.onProgress,
        settle: (r) => { signal?.removeEventListener("abort", onAbort); resolve(r); },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      joined.waiters.add(waiter);
      if (fresh) void start(joined).then((r) => finish(joined, r), (err) => finish(joined, { ok: false, reason: "error", message: String(err) }));
    });
  }

  function pump() {
    while (!running && worker) {
      const job = queue.shift();
      if (!job) break;
      running = job;
      const { rgba, width, height, geometry } = job.region;
      try {
        worker.postMessage({ type: "recognize", id: job.id, rgba, width, height, geometry }, [rgba.buffer]);
      } catch (err) {
        // A buffer detached after the job was queued (sent elsewhere) throws
        // DataCloneError. Fail that read and move on; left running, it would
        // hold every later read forever.
        running = null;
        job.cleanup();
        if (!job.aborted) job.reject(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      // Armed only once the read is at the worker; every path that settles
      // the job (settled()) clears it.
      job.timer = setTimer(() => timeOut(job), readDeadlineMs((width * height) / 1e6));
    }
    checkIdle();
  }

  /** Read a rendered region; words come back in the region's sheet coords.
   * The pixel buffer is transferred to the worker, so don't reuse it. */
  function recognize(region: OcrRegion, opts: { signal?: AbortSignal } = {}): Promise<OcrWord[]> {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(abortError());
      if (!worker || !ready) return reject(new Error("OCR engine not ready"));
      // A zero-length buffer was already transferred (to the worker, by an
      // earlier read of the same region): its pixels are gone.
      if (region.rgba.buffer.byteLength === 0) return reject(new Error("OCR region pixels were already sent; render the region again"));
      const signal = opts.signal;
      const job: Job = { id: ++seq, region, resolve, reject, aborted: false, cleanup: () => {}, timer: null };
      const onAbort = () => {
        job.aborted = true;
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        // A running job stays "running" until the worker replies, so the next
        // read isn't sent while the worker is still busy with this one.
        job.cleanup();
        reject(abortError());
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        job.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      queue.push(job);
      pump();
    });
  }

  /** Resolves once no read is running at the worker or queued for it: an
   * aborted read counts as running until the worker's late reply (its
   * caller was answered at the abort) or its deadline, whichever comes
   * first; a hung worker is ended then. A page read waits on this before its
   * first raster, so reads never overlap in the worker. Never rejects. */
  function whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
      checkIdle();
    });
  }

  /** End the worker for good: reject pending reads, resolve pending starts
   * aborted. Later ensureReady calls resolve aborted without a worker. */
  function dispose() {
    disposed = true;
    if (attempt) cancelAttempt(attempt, ABORTED);
    const w = worker;
    try { w?.postMessage({ type: "dispose" }); } catch { /* already gone */ }
    discardWorker(new Error("OCR client disposed"));
  }

  return { probe, ensureReady, recognize, whenIdle, dispose };
}

export type OcrClient = ReturnType<typeof createOcrClient>;

let shared: OcrClient | null = null;

/** The app's one OCR client, created on first use. Every feature that reads
 * text on-device goes through it, so they share one worker and one engine.
 * Features cancel their own work with signals. dispose() is final for that
 * instance (its pending work ends and later calls on it resolve aborted),
 * and it stops being the shared client: the next getOcrClient() makes a
 * fresh one. */
export function getOcrClient(): OcrClient {
  if (!shared) {
    const client = createOcrClient();
    const { dispose } = client;
    client.dispose = () => {
      if (shared === client) shared = null;
      dispose();
    };
    shared = client;
  }
  return shared;
}
