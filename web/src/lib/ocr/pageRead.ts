// Reading a whole text-less page on-device (#471): the one path the canvas's
// Read page text and the gallery's card Read go through.
//
//   readPageText   one read: the page cache first (a hit opens no page and
//                  asks no consent), else the page is opened (a page past
//                  the tile cap is refused here, before consent), then
//                  session.run → readRegionText over the full page at rs,
//                  stored in the cache under the hash of the document the
//                  page came from when the model rev is known. Every outcome
//                  is one typed result the UI can say.
//   createPageReader   the controller over it: one read per page at a time
//                  (a second request joins the running one), and one engine
//                  read at a time across all pages: each waits for the one
//                  before it to settle and for the worker to be idle (an
//                  aborted read's tile runs on until its late reply), so reads
//                  never overlap in the worker. A status per
//                  sheet key the UI renders and subscribes to, Cancel
//                  (Stopping… until the read settles), cache-only lookups for
//                  silent indexing, and dropFile for a file whose bytes are
//                  leaving or changing (evictDoc): its reads are aborted and
//                  anything that lands afterwards is dropped, so a revised
//                  sheet (same keys, new bytes) never gets the old text.
//   readBox        the copy tool's read of a box on a page: the same turn
//                  as page reads (never alongside one in the worker) and the
//                  same consent, but no cache, no status and no index (a
//                  box's lines would replace a vector sheet's text entry).
//   lines          a finished read's (or cache hit's) lines, synchronously,
//                  so Copy text on a read page copies inside the click.
//   pageReadView / progressText   what the Read control shows.
//
// A cancelled read settles as soon as the session answers: regionRead's
// in-worker recognize rejects at the abort (the client drops the worker's
// late reply). Its status stays "Stopping…" until then AND until the worker
// is idle (deps.idle: the client's whenIdle), and the next read's first
// raster waits for the same. A hung (not dead) worker is bounded by the
// client's per-read deadline: when it passes, the client ends the worker, so
// "Stopping…" ends and the reads queued behind it fail rather than wait.
//
// Pure: the session, cache, region reader and page are injected. The
// default region reader imports regionRead.ts on first use, so the page that
// imports this carries no rasterizer or seam code until a read starts.
import type { OcrSession, OcrRunResult } from "./session";
import type { CachedLine, PageCacheHit } from "./pageCache";
import type { RegionReadResult } from "./regionRead";
import type { Rect, SeamLine, SeamProgress } from "./seams";

/** The pdf.js page surface a read needs (readRegionText's PageLike). */
export interface PageLike { getViewport(o: { scale: number }): { width: number; height: number } }

/** readRegionText's shape, injectable. */
export type ReadRegion = (
  page: PageLike,
  rs: number,
  rect: Rect,
  opts?: { signal?: AbortSignal; onProgress?: (p: SeamProgress) => void },
) => Promise<RegionReadResult>;

const defaultReadRegion: ReadRegion = async (page, rs, rect, opts) =>
  (await import("./regionRead")).readRegionText(page, rs, rect, opts);

/** Whether a read of `rect` would pass the tile cap (regionRead's check). */
export type TooLarge = (rect: Rect, rs: number) => boolean | Promise<boolean>;
const defaultTooLarge: TooLarge = async (rect, rs) => (await import("./regionRead")).readTooLarge(rect, rs);
const TOO_LARGE = "This page is too large for the on-device text reader (OCR).";

/** Why a read gave no text. page-closed: the document went away mid-read
 * (the file was closed or revised). too-large: past the tile cap. */
export type ReadFailure = "declined" | "aborted" | "page-closed" | "failed" | "disabled" | "uninstalled" | "error" | "too-large";

export type PageReadResult =
  /** rev: the model rev that read it, when known; saved: false when the
   * cache refused to keep it */
  | { ok: true; lines: CachedLine[]; ms: number; rasters: number; source: "ocr"; stale: boolean; cached: boolean; rev: string | null; saved?: false }
  | { ok: false; status: ReadFailure; message?: string };

/** One sheet's read state, for the UI. No status: never read or looked up
 * this session (or dropped since). */
export type PageReadStatus =
  | { state: "checking" }
  | { state: "reading"; progress: SeamProgress | null }
  | { state: "stopping" }
  | { state: "done"; ms: number; rasters: number; stale: boolean; cached: boolean }
  | { state: ReadFailure; message?: string };

/** The cache surface a read uses (pageCache.ts). */
export interface ReadCache {
  get(hash: string | null | undefined, page: number, o: { rs: number; rev?: string | null }): Promise<PageCacheHit | null>;
  put(hash: string | null | undefined, page: number, read: { rev: string; rs: number; lines: CachedLine[]; ms: number; rasters: number }): Promise<void>;
}

export type ReadSession = Pick<OcrSession, "run" | "availability">;

export interface ReadPageArgs {
  /** 1-based page number in its PDF */
  page: number;
  /** render scale the lines come back in (the canvas's RENDER_SCALE) */
  rs: number;
  /** opened only on a cache miss, before consent (its size is checked) */
  getPage: () => Promise<PageLike>;
  /** the PDF's sha256 for the lookup, or null when it can't be had (then no
   * cache) */
  pdfHash: () => Promise<string | null>;
  /** asked after getPage: the hash of the document the page came from. The
   * read is stored under it (null: not stored), and looked up under it too
   * when it isn't pdfHash's. Without it, pdfHash's stands. */
  pageHash?: () => Promise<string | null>;
  session: ReadSession;
  cache: ReadCache;
  readRegion?: ReadRegion;
  tooLarge?: TooLarge;
  /** skip the cache lookup (Read again) */
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: SeamProgress) => void;
  /** awaited inside session.run, after consent (the page is already open
   * and size-checked): the controller's turn (the read before it settled,
   * the worker idle). Rejects on abort. */
  before?: (signal?: AbortSignal) => Promise<void>;
}

/** The model rev the probe knows, or null (not probed yet, offline, off). */
async function revOf(session: ReadSession): Promise<string | null> {
  try {
    const a = await session.availability();
    return a.state === "available" ? a.manifest.rev : null;
  } catch {
    return null;
  }
}

async function hashOf(pdfHash: () => Promise<string | null>): Promise<string | null> {
  try { return (await pdfHash()) ?? null; } catch { return null; }
}

async function cacheGet(cache: ReadCache, hash: string, page: number, rs: number, rev: string | null): Promise<PageCacheHit | null> {
  try { return await cache.get(hash, page, { rs, rev }); } catch { return null; }
}

/** A seam line as the cache stores it: the OcrWord fields and the clipped
 * flag, nothing else. */
function toCached(l: SeamLine): CachedLine {
  const out: CachedLine = { str: l.str, x: l.x, y: l.y, w: l.w, h: l.h };
  if (l.confidence !== undefined) out.confidence = l.confidence;
  if (l.clipped) out.clipped = true;
  return out;
}

const messageOf = (e: unknown): string => (e instanceof Error || e instanceof DOMException ? e.message : String(e));

/** A failed session run as a read failure. A task error that is an
 * AbortError the caller didn't ask for is the page going away. */
function failureOf(r: Exclude<OcrRunResult<unknown>, { ok: true }>): Extract<PageReadResult, { ok: false }> {
  if (r.reason === "failed") return thrownFailure(r.error);
  if (r.reason === "error") return { ok: false, status: "error", message: r.message };
  return { ok: false, status: r.reason };
}

/** A task's (or getPage's) error as a read failure. */
function thrownFailure(error: unknown): Extract<PageReadResult, { ok: false }> {
  const name = (error as { name?: string } | null)?.name;
  if (name === "PageTooLargeError") return { ok: false, status: "too-large", message: TOO_LARGE };
  return { ok: false, status: name === "AbortError" ? "page-closed" : "failed", message: messageOf(error) };
}

/** The size check: a refusal or failure as a read failure, else null. A
 * check that throws (the reader's code didn't load) is a failed read. */
async function checkSize(tooLarge: TooLarge | undefined, rect: Rect, rs: number): Promise<Extract<PageReadResult, { ok: false }> | null> {
  try {
    return (await (tooLarge ?? defaultTooLarge)(rect, rs)) ? { ok: false, status: "too-large", message: TOO_LARGE } : null;
  } catch (e) {
    return { ok: false, status: "failed", message: messageOf(e) };
  }
}

const ABORTED: PageReadResult = { ok: false, status: "aborted" };
const ABORTED_BOX: BoxReadResult = { ok: false, status: "aborted" };

const hitResult = (h: PageCacheHit): PageReadResult =>
  ({ ok: true, lines: h.lines, ms: h.ms, rasters: h.rasters, source: "ocr", stale: h.stale, cached: true, rev: h.rev });

/** Read one page: the cache, else the engine. Never rejects. */
export async function readPageText(a: ReadPageArgs): Promise<PageReadResult> {
  const { page, rs, session, cache, signal } = a;
  const readRegion = a.readRegion ?? defaultReadRegion;
  if (signal?.aborted) return ABORTED;
  const hash = await hashOf(a.pdfHash);
  if (signal?.aborted) return ABORTED;
  const lookUp = async (h: string | null) => (h && !a.force ? cacheGet(cache, h, page, rs, await revOf(session)) : null);
  let hit = await lookUp(hash);
  if (signal?.aborted) return ABORTED;
  if (hit) return hitResult(hit);
  let pg: PageLike;
  try { pg = await a.getPage(); } catch (e) { return signal?.aborted ? ABORTED : thrownFailure(e); }
  if (signal?.aborted) return ABORTED;
  // A cloud re-drop can replace the bytes under an open document: the read
  // belongs to the document the page came from.
  const putHash = a.pageHash ? await hashOf(a.pageHash) : hash;
  if (putHash !== hash) {
    hit = await lookUp(putHash);
    if (signal?.aborted) return ABORTED;
    if (hit) return hitResult(hit);
  }
  const vp = pg.getViewport({ scale: rs });
  const rect = { x0: 0, y0: 0, x1: vp.width, y1: vp.height };
  const big = await checkSize(a.tooLarge, rect, rs);
  if (big) return big;
  const r = await session.run(async (sig) => {
    await a.before?.(sig);
    return readRegion(pg, rs, rect, { signal: sig, onProgress: a.onProgress });
  }, { signal });
  if (!r.ok) return failureOf(r);
  const lines = r.value.lines.map(toCached);
  const { ms, rasters } = r.value;
  // The engine just started, so the probe has its manifest; without a rev an
  // entry couldn't be told stale later, so none is written.
  const rev = await revOf(session);
  const out: PageReadResult = { ok: true, lines, ms, rasters, source: "ocr", stale: false, cached: false, rev };
  if (putHash && rev) {
    try { await cache.put(putHash, page, { rev, rs, lines, ms, rasters }); } catch (e) {
      // the read still stands; it just won't be there after a reload
      console.warn("OCR cache: couldn't save page read", e);
      out.saved = false;
    }
  }
  return out;
}

/** A sheet to read or look up: `key` its sheet key, `file` the PDF it's in. */
export interface PageReadRequest {
  key: string;
  file: string;
  page: number;
  rs: number;
  getPage: () => Promise<PageLike>;
  pdfHash: () => Promise<string | null>;
  /** readPageText's pageHash */
  pageHash?: () => Promise<string | null>;
  /** the hash only if the store has it without fetching or reading bytes
   * (lookup's `known` option); null when it doesn't */
  pdfHashIfKnown?: () => Promise<string | null> | string | null;
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: SeamProgress) => void;
}

export interface PageReaderDeps {
  session: ReadSession;
  cache: ReadCache;
  readRegion?: ReadRegion;
  tooLarge?: TooLarge;
  /** a read's (or a cache hit's) lines, for the search index */
  onLines: (key: string, lines: CachedLine[]) => void;
  /** resolves when the OCR worker has nothing running or queued (the
   * client's whenIdle); by default at once */
  idle?: () => Promise<void>;
}

/** A box on a page for the copy tool (readBox). */
export interface BoxReadRequest {
  file: string;
  rs: number;
  /** image px at rs */
  rect: Rect;
  getPage: () => Promise<PageLike>;
  signal?: AbortSignal;
  /** after consent: "waiting" for the engine's turn, then "reading" */
  onPhase?: (phase: "waiting" | "reading") => void;
}

export type BoxReadResult =
  | { ok: true; lines: SeamLine[]; ms: number; rasters: number }
  | { ok: false; status: ReadFailure; message?: string };

/** A read's status that shows a Cancel (or Stopping…) row. */
export interface ActiveRead { key: string; status: Extract<PageReadStatus, { state: "reading" | "stopping" }> }

export interface PageReader {
  /** Read a sheet (cache first unless force). A read of a sheet already
   * being read returns that read's promise; its own signal, onProgress and
   * force are not used. Never rejects. */
  read(req: PageReadRequest): Promise<PageReadResult>;
  /** The cache alone: a hit goes to onLines and shows done. Asked once per
   * sheet until its file is dropped (a finished read is the answer from
   * then on, without asking the store); null while a read of it runs.
   * Never rejects. With `known`, only a hash the store already has is used
   * (pdfHashIfKnown: a background lookup must never download a file); with
   * none it's a quiet miss: no status, no notify, and nothing remembered, so
   * a later full lookup (or Read, which looks the cache up first) still
   * finds a saved read. */
  lookup(req: Omit<PageReadRequest, "getPage" | "force" | "signal" | "onProgress">, opts?: { known?: boolean }): Promise<PageCacheHit | null>;
  /** Read a box on a page (the copy tool): its turn like a page read, then
   * session.run over the rect. Not cached, no status, nothing indexed.
   * Never rejects. */
  readBox(req: BoxReadRequest): Promise<BoxReadResult>;
  /** A finished read's (or cache hit's) lines, or undefined; gone once its
   * file is dropped. */
  lines(key: string): CachedLine[] | undefined;
  /** Stop a sheet's read: Stopping… until it settles, then aborted. */
  cancel(key: string): void;
  status(key: string): PageReadStatus | undefined;
  /** Reads reading or stopping, in the order they began. */
  active(): ActiveRead[];
  /** Called after every status change. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** evictDoc: abort the file's reads, forget its statuses and lookups, and
   * drop whatever of them lands later. */
  dropFile(file: string): void;
  /** Abort every read (the page unmounts). */
  dispose(): void;
}

interface Running { file: string; ac: AbortController; promise: Promise<PageReadResult> }

const abortError = () => new DOMException("The OCR read was cancelled.", "AbortError");
/** `p`, or a rejection as soon as `signal` aborts. */
function orAbort(p: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(() => { signal?.removeEventListener("abort", onAbort); resolve(); });
  });
}

export function createPageReader(deps: PageReaderDeps): PageReader {
  const { session, cache, onLines } = deps;
  const idle = deps.idle ?? (() => Promise.resolve());
  // Engine reads, one at a time: each read's turn comes once every read that
  // began before it has settled.
  let turn: Promise<void> = Promise.resolve();
  const running = new Map<string, Running>();
  const statuses = new Map<string, { file: string; status: PageReadStatus }>();
  const lookups = new Map<string, { file: string; p: Promise<PageCacheHit | null> }>();
  const linesOf = new Map<string, { file: string; lines: CachedLine[] }>();
  // One hash per file, shared by every page's lookup and read: a store's
  // pdfHash can load the whole PDF to answer. Only a hash is kept (a null or
  // a failure is asked again); dropFile forgets it (the bytes may change).
  const hashes = new Map<string, Promise<string | null>>();
  function hashFor(file: string, pdfHash: () => Promise<string | null>): Promise<string | null> {
    const had = hashes.get(file);
    if (had) return had;
    const p = Promise.resolve().then(pdfHash);
    hashes.set(file, p);
    const drop = () => { if (hashes.get(file) === p) hashes.delete(file); };
    p.then((h) => { if (!h) drop(); }, drop);
    return p;
  }
  const boxes = new Set<{ file: string; ac: AbortController }>();
  const readRegion = deps.readRegion ?? defaultReadRegion;
  /** A place in the engine queue: `before` resolves when every read that
   * began earlier has settled and the worker is idle; call settled() when
   * this one is done. */
  function takeTurn() {
    const prev = turn;
    let settled!: () => void;
    const mine = new Promise<void>((r) => { settled = r; });
    turn = prev.then(() => mine);
    const before = async (sig?: AbortSignal) => { await orAbort(prev, sig); await orAbort(idle(), sig); };
    return { before, settled };
  }
  const gotLines = (key: string, file: string, lines: CachedLine[]) => {
    linesOf.set(key, { file, lines });
    onLines(key, lines);
  };
  const gens = new Map<string, number>();
  const listeners = new Set<() => void>();
  const genOf = (file: string) => gens.get(file) ?? 0;

  const notify = () => { for (const fn of [...listeners]) fn(); };
  function setStatus(key: string, file: string, status: PageReadStatus | undefined) {
    if (status) statuses.set(key, { file, status }); else statuses.delete(key);
    notify();
  }

  function read(req: PageReadRequest): Promise<PageReadResult> {
    const { key, file } = req;
    const cur = running.get(key);
    if (cur) return cur.promise;
    const gen = genOf(file);
    const live = () => genOf(file) === gen;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) ac.abort();
    const { before, settled } = takeTurn();
    setStatus(key, file, { state: "reading", progress: null });
    const promise = readPageText({
      page: req.page, rs: req.rs, getPage: req.getPage, pdfHash: () => hashFor(file, req.pdfHash), pageHash: req.pageHash,
      session, cache, readRegion: deps.readRegion, tooLarge: deps.tooLarge, force: req.force, signal: ac.signal,
      before,
      onProgress: (p) => {
        if (live() && running.get(key)?.ac === ac && !ac.signal.aborted) setStatus(key, file, { state: "reading", progress: p });
        req.onProgress?.(p);
      },
    // a rejection must still end the read and free its turn, or every later
    // read waits behind it
    }).catch((e): PageReadResult => ({ ok: false, status: "failed", message: messageOf(e) })).then((r) => {
      settled();
      req.signal?.removeEventListener("abort", onAbort);
      if (running.get(key)?.ac === ac) running.delete(key);
      if (!live()) return r;
      if (r.ok) {
        lookups.set(key, { file, p: Promise.resolve({ rev: r.rev ?? "", rs: req.rs, lines: r.lines, ms: r.ms, rasters: r.rasters, at: Date.now(), stale: r.stale }) });
        gotLines(key, file, r.lines);
        setStatus(key, file, { state: "done", ms: r.ms, rasters: r.rasters, stale: r.stale, cached: r.cached });
        return r;
      }
      const final: PageReadStatus = r.message !== undefined ? { state: r.status, message: r.message } : { state: r.status };
      const shown = statuses.get(key);
      if (shown?.status.state !== "stopping") { setStatus(key, file, final); return r; }
      // Cancelled: Stopping… until the worker is idle too (its tile runs on).
      void idle().then(() => {
        if (live() && statuses.get(key) === shown) setStatus(key, file, final);
      });
      return r;
    });
    running.set(key, { file, ac, promise });
    return promise;
  }

  function lookup(req: Omit<PageReadRequest, "getPage" | "force" | "signal" | "onProgress">, opts: { known?: boolean } = {}): Promise<PageCacheHit | null> {
    const { key, file } = req;
    if (running.has(key)) return Promise.resolve(null);
    const memo = lookups.get(key);
    if (memo) return memo.p;
    if (opts.known && !hashes.has(file)) return knownLookup(req);
    const gen = genOf(file);
    const live = () => genOf(file) === gen;
    // "checking" and its end both notify: a shown sheet's Read control hides
    // while its cache is checked and comes back on a miss. Subscribers keep
    // the cost down (the canvas re-renders only for sheets on screen, the
    // gallery at most once a frame).
    if (!statuses.has(key)) setStatus(key, file, { state: "checking" });
    const entry: { file: string; p: Promise<PageCacheHit | null> } = { file, p: Promise.resolve(null) };
    entry.p = (async () => {
      let hit: PageCacheHit | null = null;
      try {
        const hash = await hashFor(file, req.pdfHash);
        hit = hash ? await cache.get(hash, req.page, { rs: req.rs, rev: await revOf(session) }) : null;
      } catch (e) {
        // failed, not missed: asked again next time rather than remembered
        console.warn(`OCR cache: couldn't look up ${key}`, e);
        if (lookups.get(key) === entry) lookups.delete(key);
        if (live() && !running.has(key) && statuses.get(key)?.status.state === "checking") setStatus(key, file, undefined);
        return null;
      }
      if (!live()) return null;
      // A read started meanwhile owns the status now.
      if (running.has(key)) return hit;
      if (hit) {
        gotLines(key, file, hit.lines);
        setStatus(key, file, { state: "done", ms: hit.ms, rasters: hit.rasters, stale: hit.stale, cached: true });
      } else if (statuses.get(key)?.status.state === "checking") {
        setStatus(key, file, undefined);
      }
      return hit;
    })();
    lookups.set(key, entry);
    return entry.p;
  }

  // A background lookup: only a hash the store has without fetching. None:
  // a quiet miss. One: the file's hash from then on, and the usual lookup.
  async function knownLookup(req: Omit<PageReadRequest, "getPage" | "force" | "signal" | "onProgress">): Promise<PageCacheHit | null> {
    const { file } = req;
    const gen = genOf(file);
    let h: string | null = null;
    try { h = (await req.pdfHashIfKnown?.()) ?? null; } catch { h = null; }
    if (!h || genOf(file) !== gen) return null;
    if (!hashes.has(file)) hashes.set(file, Promise.resolve(h));
    return lookup(req);
  }

  async function readBox(req: BoxReadRequest): Promise<BoxReadResult> {
    const ac = new AbortController();
    const entry = { file: req.file, ac };
    const onAbort = () => ac.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) ac.abort();
    boxes.add(entry);
    const { before, settled } = takeTurn();
    try {
      if (ac.signal.aborted) return ABORTED_BOX;
      // before consent: a read that can't happen asks for no download
      const big = await checkSize(deps.tooLarge, req.rect, req.rs);
      if (big) return big;
      if (ac.signal.aborted) return ABORTED_BOX;
      const r = await session.run(async (sig) => {
        req.onPhase?.("waiting");
        await before(sig);
        req.onPhase?.("reading");
        const pg = await req.getPage();
        return readRegion(pg, req.rs, req.rect, { signal: sig });
      }, { signal: ac.signal });
      if (!r.ok) {
        const f = failureOf(r);
        // the file went away (dropFile) rather than the caller cancelling
        return f.status === "aborted" && !req.signal?.aborted ? { ok: false, status: "page-closed", message: "The page was closed during the read." } : f;
      }
      return { ok: true, lines: r.value.lines, ms: r.value.ms, rasters: r.value.rasters };
    } finally {
      settled();
      boxes.delete(entry);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    read,
    lookup,
    readBox,
    lines: (key) => linesOf.get(key)?.lines,
    cancel(key) {
      const r = running.get(key);
      if (!r || r.ac.signal.aborted) return;
      r.ac.abort();
      setStatus(key, r.file, { state: "stopping" });
    },
    status: (key) => statuses.get(key)?.status,
    active() {
      const out: ActiveRead[] = [];
      for (const [key, { status }] of statuses) {
        if (status.state === "reading" || status.state === "stopping") out.push({ key, status });
      }
      return out;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    dropFile(file) {
      gens.set(file, genOf(file) + 1);
      for (const [key, r] of [...running]) if (r.file === file) { running.delete(key); r.ac.abort(); }
      for (const [key, l] of [...lookups]) if (l.file === file) lookups.delete(key);
      for (const [key, l] of [...linesOf]) if (l.file === file) linesOf.delete(key);
      hashes.delete(file);
      for (const b of boxes) if (b.file === file) b.ac.abort();
      let changed = false;
      for (const [key, s] of [...statuses]) if (s.file === file) { statuses.delete(key); changed = true; }
      if (changed) notify();
    },
    dispose() {
      for (const r of running.values()) r.ac.abort();
      running.clear();
      for (const b of boxes) b.ac.abort();
    },
  };
}

// ── the Read control's face ─────────────────────────────────────────────────

const MS_PER_SECOND = 1000;
/** Seconds with one decimal, rounded half up on the tenth (950 ms → "1.0"). */
function secondsText(ms: number): string {
  const tenths = Math.round((ms / MS_PER_SECOND) * 10);
  return (tenths / 10).toFixed(1);
}

/** "Reading tiles 2/6", "Joining seams 1/3"; before the plan, "Starting…". */
export function progressText(p: SeamProgress | null | undefined): string {
  if (!p) return "Starting…";
  return `${p.phase === "tiles" ? "Reading tiles" : "Joining seams"} ${p.done}/${p.total}`;
}

/** What a probe error says, where Read would be offered. */
export const UNREACHABLE = "The on-device text reader (OCR) couldn't be reached";

export type PageReadView =
  | { kind: "hidden" }
  | { kind: "read"; note?: string }
  | { kind: "reading"; text: string }
  | { kind: "stopping"; text: string }
  | { kind: "done"; text: string; readAgain: boolean }
  /** a read that can't happen (too large): why, and no Read */
  | { kind: "unreadable"; text: string }
  /** the probe couldn't reach the reader: why, and Retry (probe again) */
  | { kind: "unreachable"; text: string };

/** What one sheet's Read control shows. Hidden unless the sheet is a scan
 * (textless true: checked, and planIndex indexIsScanLike — no text layer,
 * or only a few stray runs), and always when the probe says
 * OCR is off or not installed. A read offer (Read page text, with a note
 * after a failure) needs the probe to say available (a probe error shows
 * that instead, with Retry); a read under way (so it can be
 * cancelled) or done (so it stays labelled OCR, cached reads included) shows
 * whatever else the probe says (not asked yet, offline). Read again only for
 * a stale read (by another model rev, the rev known, or by an earlier engine
 * on pageCache's STALE_OK_OPTS, the rev known or not), and only when
 * available. Hidden while the cache is being checked. */
export function pageReadView(s: { textless: boolean | undefined; avail: string | null | undefined; status: PageReadStatus | undefined }): PageReadView {
  if (s.textless !== true || s.avail === "disabled" || s.avail === "uninstalled") return { kind: "hidden" };
  const available = s.avail === "available";
  const offer = (note?: string): PageReadView => (s.avail === "error" ? { kind: "unreachable", text: UNREACHABLE }
    : !available ? { kind: "hidden" } : note ? { kind: "read", note } : { kind: "read" });
  const st = s.status;
  if (!st) return offer();
  switch (st.state) {
    case "checking":
    case "disabled":
    case "uninstalled":
      return { kind: "hidden" };
    case "reading":
      return { kind: "reading", text: progressText(st.progress) };
    case "stopping":
      return { kind: "stopping", text: "Stopping…" };
    case "done":
      return { kind: "done", text: `Read in ${secondsText(st.ms)} s · OCR`, readAgain: st.stale && available };
    case "declined":
    case "aborted":
      return offer();
    case "page-closed":
      return offer(st.message || "The page was closed during the read.");
    case "failed":
      return offer(`Couldn't read this page: ${st.message ?? "unknown error"}`);
    case "error":
      return offer(`The on-device text reader (OCR) didn't start: ${st.message ?? "unknown error"}`);
    case "too-large":
      return { kind: "unreadable", text: st.message ?? TOO_LARGE };
  }
}

/** What the canvas re-renders on: the full status of each sheet on screen,
 * and, for reads of sheets off screen, only which are reading or stopping
 * (their Cancel rows). Off-screen progress, lookups and cache hits leave it
 * unchanged, so they don't re-render the canvas. */
export function readSignature(shownKeys: readonly string[], statusOf: (key: string) => PageReadStatus | undefined, active: readonly ActiveRead[]): string {
  const shown = new Set(shownKeys);
  return JSON.stringify([
    shownKeys.map((k) => [k, statusOf(k) ?? null]),
    active.filter((a) => !shown.has(a.key)).map((a) => [a.key, a.status.state]),
  ]);
}

/** The canvas's re-render decision for read status changes: a notify
 * re-renders only when the readSignature of the screen differs from the one
 * the last render actually used (recorded by that render), not from the one
 * the last notify saw: a status can change without a notify of its own and
 * be rendered by some other re-render, and the next notify must compare
 * against what is on screen. */
export function createReadRenderGate() {
  let rendered: string | null = null;
  return {
    /** the render pass: the signature of what it drew */
    rendered(sig: string): void { rendered = sig; },
    /** a notify: does the screen need a re-render? */
    changed(sig: string): boolean { return sig !== rendered; },
  };
}

/** Rows for reads whose sheet isn't on screen (a read goes on when its sheet
 * leaves): "Reading <sheet>…" with Cancel, then "Stopping <sheet>…". */
export function backgroundRows(active: readonly ActiveRead[], shownKeys: readonly string[], labelOf: (key: string) => string): { key: string; label: string; view: PageReadView }[] {
  const shown = new Set(shownKeys);
  return active.filter((a) => !shown.has(a.key)).map((a) => {
    const label = labelOf(a.key);
    const view: PageReadView = a.status.state === "stopping"
      ? { kind: "stopping", text: `Stopping ${label}…` }
      : { kind: "reading", text: `Reading ${label}…` };
    return { key: a.key, label, view };
  });
}
