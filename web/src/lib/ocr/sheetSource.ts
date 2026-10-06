// Which bytes an OCR read pairs with (#471). The page cache keys a read by
// the hash of its PDF, so that hash must be of the bytes the page was read
// from, not of whatever the store holds now: a cloud re-drop replaces a
// file's bytes under the same name while an open document still has the old
// ones. No OCR imports: the canvas's document cache is built from this.
import { startPdfHash } from "./pdfHash";

interface DocLike<P> { getPage(n: number): Promise<P> }

/** A file's cached document as the source sees it: the document, and the
 * hash of the bytes it was opened from (null: not hashed here, so the
 * store's hash stands for it). */
export interface SourceDoc<P> {
  doc(): Promise<DocLike<P>>;
  hash: Promise<string | null> | null;
}

/** A pdf.js loading task, as far as the cache needs one. */
interface LoadingTask<D> { promise: Promise<D>; destroy(): unknown }

export interface DocCache<P, D extends DocLike<P>> {
  /** the file's document, loaded once; kept until evicted, or trimmed once
   * idle past the cap. The caller must hold it pinned or leased. */
  doc(file: string): Promise<D>;
  /** the file's cache entry, if any; never loads, and isn't a use */
  cached(file: string): SourceDoc<P> | undefined;
  /** the file's cache entry, loading it first if there is none; pinned or
   * leased, as `doc` */
  open(file: string): SourceDoc<P>;
  has(file: string): boolean;
  /** has, and its document has finished loading */
  loaded(file: string): boolean;
  /** drop the file's document and destroy its worker copy, leased or not */
  evict(file: string): void;
  clear(): void;
  /** destroy the least recently used idle documents past the cap */
  trim(): void;
  /** hold the file's document (loading it) until the returned release */
  lease(file: string): () => void;
  /** make these the most recently used (in order), e.g. files just unpinned */
  touch(files: Iterable<string>): void;
  /** opened since its last forced evict or clear, even if trimmed since */
  wasLoaded(file: string): boolean;
  /** run `fn` on the file's document, held until it settles */
  withDoc<T>(file: string, fn: (doc: D) => T | Promise<T>): Promise<T>;
  /** `withDoc`, but only if the document is already loaded: else undefined,
   * and nothing loads */
  withLoadedDoc<T>(file: string, fn: (doc: D) => T | Promise<T>): Promise<T | undefined>;
}

/** One document per file. `hashing(file)`, asked as a load starts: null, or
 * where to report the digest of the bytes about to load (it starts before
 * `open` can detach them; reported only while that load is still the
 * file's). A failed load, or one pdf.js can't parse, is never kept.
 *
 * Each loaded document is a pdf.js worker, so at most `maxIdle` loaded ones
 * stay that are neither pinned (`pinned()`, asked afresh on every trim) nor
 * leased; past that the least recently asked for go. The defaults keep
 * every document until evicted. */
export function createDocCache<P, D extends DocLike<P> = DocLike<P>>(deps: {
  load(file: string): Promise<Uint8Array>;
  open(data: Uint8Array): LoadingTask<D>;
  hashing(file: string): ((h: Promise<string | null>) => void) | null;
  pinned?(): Iterable<string>;
  maxIdle?: number;
}): DocCache<P, D> {
  interface Entry { task: Promise<LoadingTask<D>>; hash: Promise<string | null> | null; leases: number; loaded: boolean }
  // Map order is recency: the first entry is the least recently asked for
  const docs = new Map<string, Entry>();
  // names opened since their last forced evict, trimmed or not (counted from
  // the load's start, as `has` is)
  const everOpened = new Set<string>();
  const maxIdle = deps.maxIdle ?? Infinity;
  const destroy = (e: Entry) => { e.task.then((t) => { try { t.destroy(); } catch { /* already gone */ } }).catch(() => {}); };
  const drop = (file: string, e: Entry) => { destroy(e); docs.delete(file); };
  const bump = (file: string, e: Entry) => { docs.delete(file); docs.set(file, e); };
  const view = (e: Entry): SourceDoc<P> => ({ doc: () => e.task.then((t) => t.promise), hash: e.hash });
  function trim() {
    const pins = new Set(deps.pinned?.() ?? []);
    const idle = [...docs].filter(([f, e]) => e.loaded && !e.leases && !pins.has(f));
    for (const [f, e] of idle.slice(0, Math.max(0, idle.length - maxIdle))) drop(f, e);
  }
  // the release closes over this entry: once only, and a no-op if a forced
  // evict replaced it meanwhile
  function hold(file: string) {
    const e = entry(file);
    e.leases++;
    let held = true;
    return {
      e,
      release() {
        if (!held) return;
        held = false;
        if (docs.get(file) === e) { e.leases--; trim(); }
      },
    };
  }
  async function withDoc<T>(file: string, fn: (doc: D) => T | Promise<T>): Promise<T> {
    const { e, release } = hold(file);
    try { return await fn(await e.task.then((t) => t.promise)); } finally { release(); }
  }
  function entry(file: string): Entry {
    const had = docs.get(file);
    if (had) { bump(file, had); return had; }
    const report = deps.hashing(file);
    let settle: (h: Promise<string | null> | null) => void = () => {};
    const hash = report ? new Promise<string | null>((r) => { settle = r; }) : null;
    const e: Entry = {
      hash,
      leases: 0,
      loaded: false,
      task: deps.load(file).then((data) => {
        if (report) {
          const h = startPdfHash(data);
          settle(h);
          if (docs.get(file) === e) report(h);
        }
        const t = deps.open(data);
        t.promise.then(
          () => { if (docs.get(file) === e) { e.loaded = true; trim(); } },
          // a parse failure would otherwise hold its worker for good
          () => { if (docs.get(file) === e) drop(file, e); },
        );
        return t;
      }),
    };
    e.task.catch(() => {
      settle(null);
      if (docs.get(file) === e) docs.delete(file);
    });
    docs.set(file, e);
    everOpened.add(file);
    return e;
  }
  return {
    doc: (file) => entry(file).task.then((t) => t.promise),
    cached(file) { const e = docs.get(file); return e && view(e); },
    open: (file) => view(entry(file)),
    has: (file) => docs.has(file),
    loaded: (file) => !!docs.get(file)?.loaded,
    evict(file) { const e = docs.get(file); if (e) drop(file, e); everOpened.delete(file); },
    clear() { for (const e of docs.values()) destroy(e); docs.clear(); everOpened.clear(); },
    trim,
    touch(files) { for (const f of files) { const e = docs.get(f); if (e) bump(f, e); } },
    wasLoaded: (file) => everOpened.has(file),
    lease: (file) => hold(file).release,
    withDoc,
    withLoadedDoc: async (file, fn) => (docs.get(file)?.loaded ? withDoc(file, fn) : undefined),
  };
}

/** How many idle documents to keep: each holds its own pdf.js worker, whose
 * cost tracks the count of documents more than their bytes. */
export function docIdleMax(lowMemory: boolean): number { return lowMemory ? 2 : 4; }

export interface SheetSourceDeps<P> {
  cached(file: string): SourceDoc<P> | undefined;
  open(file: string): SourceDoc<P>;
  /** the store's hash of the file's current bytes (may download them) */
  storeHash(file: string): Promise<string | null>;
  /** the store's hash only if it has it without fetching anything */
  storeKnown(file: string): Promise<string | null> | string | null;
  /** hold the file's document while a page from it is in use */
  lease?(file: string): () => void;
}

export interface SheetSource<P> {
  /** The hash a lookup or read keys on: the loaded document's, else one the
   * store already has, else (unless `known`) the document is loaded and its
   * hash taken, so the bytes download once. */
  hash(file: string, opts?: { known?: boolean }): Promise<string | null>;
  /** A page, the hash of the document it came from, and the release of the
   * lease that holds that document (call it once the page is done with). */
  page(file: string, n: number): Promise<{ page: P; hash: Promise<string | null>; release: () => void }>;
}

export function createSheetSource<P>(deps: SheetSourceDeps<P>): SheetSource<P> {
  const hashOf = (file: string, d: SourceDoc<P>) => d.hash ?? deps.storeHash(file);
  const knownOf = async (file: string) => { try { return (await deps.storeKnown(file)) ?? null; } catch { return null; } };
  return {
    async hash(file, { known = false } = {}) {
      const had = deps.cached(file);
      // known: nothing is hashed (a legacy local record would be)
      if (had) return had.hash ?? (known ? knownOf(file) : deps.storeHash(file));
      const k = await knownOf(file);
      if (k || known) return k;
      // held while it hashes; the read that follows takes its own lease
      const release = deps.lease?.(file);
      const h = hashOf(file, deps.open(file));
      if (release) h.then(release, release);
      return h;
    },
    async page(file, n) {
      const release = deps.lease?.(file) ?? (() => {});
      const d = deps.open(file);
      try {
        const page = await (await d.doc()).getPage(n);
        return { page, hash: hashOf(file, d), release };
      } catch (e) { release(); throw e; }
    },
  };
}

/** A page read's hooks (pageRead's PageReadRequest): the lookup's hash from
 * the source; the page, and the hash its read is stored under, from one
 * document. `opened()`: the page getPage gave, once it has. `release()`:
 * let that document go once the read settles (a no-op if getPage never ran:
 * a cache hit opens nothing). */
export function readHooks<P>(source: SheetSource<P>, file: string, n: number) {
  let hash: Promise<string | null> = Promise.resolve(null);
  let opened: P | null = null;
  let held: (() => void) | null = null;
  return {
    pdfHash: () => source.hash(file),
    getPage: async () => {
      const s = await source.page(file, n);
      hash = s.hash;
      opened = s.page;
      held = s.release;
      return s.page;
    },
    pageHash: () => hash,
    opened: () => opened,
    release: () => { const r = held; held = null; r?.(); },
  };
}

/** A cache lookup's hooks: with `known`, nothing is fetched to hash. */
export function lookupHooks<P>(source: SheetSource<P>, file: string) {
  return {
    pdfHash: () => source.hash(file),
    pdfHashIfKnown: () => source.hash(file, { known: true }),
  };
}

/** What re-adding files resets, from store.addPdf's answers. `reset`: names
 * whose search entries, OCR reads and thumbnails start over (a revision, or a
 * fresh add, which a text pass that landed after a close must not outlive);
 * identical local bytes keep theirs. `evict`: names whose loaded document
 * goes too. A cloud re-add reports no revision and may have replaced the
 * bytes, so it always resets, and evicts a loaded document. */
export function readdEffects(
  results: readonly { name: string; revised?: boolean; unchanged?: boolean }[],
  o: { cloud: boolean; loaded: (name: string) => boolean },
): { reset: string[]; evict: string[] } {
  const reset: string[] = [], evict: string[] = [];
  for (const r of results) {
    if (!o.cloud && r.unchanged) continue;
    reset.push(r.name);
    if (r.revised || (o.cloud && o.loaded(r.name))) evict.push(r.name);
  }
  return { reset, evict };
}
