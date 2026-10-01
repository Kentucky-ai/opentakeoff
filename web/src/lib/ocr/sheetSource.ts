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
  /** the file's document, loaded once and kept until evicted */
  doc(file: string): Promise<D>;
  /** the file's cache entry, if any; never loads */
  cached(file: string): SourceDoc<P> | undefined;
  /** the file's cache entry, loading it first if there is none */
  open(file: string): SourceDoc<P>;
  has(file: string): boolean;
  /** drop the file's document and destroy its worker copy */
  evict(file: string): void;
  clear(): void;
}

/** One document per file. `hashing(file)`, asked as a load starts: null, or
 * where to report the digest of the bytes about to load (it starts before
 * `open` can detach them; reported only while that load is still the
 * file's). A failed load is never kept. */
export function createDocCache<P, D extends DocLike<P> = DocLike<P>>(deps: {
  load(file: string): Promise<Uint8Array>;
  open(data: Uint8Array): LoadingTask<D>;
  hashing(file: string): ((h: Promise<string | null>) => void) | null;
}): DocCache<P, D> {
  interface Entry { task: Promise<LoadingTask<D>>; hash: Promise<string | null> | null }
  const docs = new Map<string, Entry>();
  const destroy = (e: Entry) => { e.task.then((t) => { try { t.destroy(); } catch { /* already gone */ } }).catch(() => {}); };
  const view = (e: Entry): SourceDoc<P> => ({ doc: () => e.task.then((t) => t.promise), hash: e.hash });
  function entry(file: string): Entry {
    const had = docs.get(file);
    if (had) return had;
    const report = deps.hashing(file);
    let settle: (h: Promise<string | null> | null) => void = () => {};
    const hash = report ? new Promise<string | null>((r) => { settle = r; }) : null;
    const e: Entry = {
      hash,
      task: deps.load(file).then((data) => {
        if (report) {
          const h = startPdfHash(data);
          settle(h);
          if (docs.get(file) === e) report(h);
        }
        return deps.open(data);
      }),
    };
    e.task.catch(() => {
      settle(null);
      if (docs.get(file) === e) docs.delete(file);
    });
    docs.set(file, e);
    return e;
  }
  return {
    doc: (file) => entry(file).task.then((t) => t.promise),
    cached(file) { const e = docs.get(file); return e && view(e); },
    open: (file) => view(entry(file)),
    has: (file) => docs.has(file),
    evict(file) { const e = docs.get(file); if (e) { destroy(e); docs.delete(file); } },
    clear() { for (const e of docs.values()) destroy(e); docs.clear(); },
  };
}

export interface SheetSourceDeps<P> {
  cached(file: string): SourceDoc<P> | undefined;
  open(file: string): SourceDoc<P>;
  /** the store's hash of the file's current bytes (may download them) */
  storeHash(file: string): Promise<string | null>;
  /** the store's hash only if it has it without fetching anything */
  storeKnown(file: string): Promise<string | null> | string | null;
}

export interface SheetSource<P> {
  /** The hash a lookup or read keys on: the loaded document's, else one the
   * store already has, else (unless `known`) the document is loaded and its
   * hash taken, so the bytes download once. */
  hash(file: string, opts?: { known?: boolean }): Promise<string | null>;
  /** A page, and the hash of the document it came from. */
  page(file: string, n: number): Promise<{ page: P; hash: Promise<string | null> }>;
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
      return hashOf(file, deps.open(file));
    },
    async page(file, n) {
      const d = deps.open(file);
      const page = await (await d.doc()).getPage(n);
      return { page, hash: hashOf(file, d) };
    },
  };
}

/** A page read's hooks (pageRead's PageReadRequest): the lookup's hash from
 * the source; the page, and the hash its read is stored under, from one
 * document. `opened()`: the page getPage gave, once it has. */
export function readHooks<P>(source: SheetSource<P>, file: string, n: number) {
  let hash: Promise<string | null> = Promise.resolve(null);
  let opened: P | null = null;
  return {
    pdfHash: () => source.hash(file),
    getPage: async () => {
      const s = await source.page(file, n);
      hash = s.hash;
      opened = s.page;
      return s.page;
    },
    pageHash: () => hash,
    opened: () => opened,
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
