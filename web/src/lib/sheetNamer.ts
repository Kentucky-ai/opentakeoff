// The Sheets tree's sheet numbers, per file. Numbers come from page text other
// paths already fetched (offer): the canvas render, gallery thumbnails, plan
// search. They live in memory and, for a local project, in one saved record
// per file, so a reopened project shows them without reading a PDF. No React
// and no pdf.js: the reader is injected (default: sheetName.ts).
//
// Every result carries the generation of the file it was read from: a file
// whose bytes change (re-drop, removal, import) gets a new generation
// (forget), and anything read under the old one is dropped.
import { createChangeSignal } from "./planSearch";
import { READER_VERSION, readSheetNumber, sheetItems } from "./sheetName";

type TextContentLike = { items: unknown[] };
type ViewportLike = { width: number; height: number; transform: number[] };

/** A file's saved numbers: page → number, or null (read; no number). A page
 *  not in `pages` is unread. */
export type NameRecord = { rv: number; numPages: number | null; pages: Record<string, string | null> };

export interface NamerDeps {
  /** the record keys' scope: the project id, or "local" */
  scope: string;
  /** keep records (local mode); off, names live for the session (cloud) */
  persist: boolean;
  meta: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
  /** one page's number from its text */
  read?(tc: TextContentLike, vp: ViewportLike): string | null;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  signal?: { subscribe(fn: () => void): () => void; notify(): void };
  onError?(e: unknown): void;
}

export interface SheetNamer {
  start(): void;
  /** flush what's unsaved, then stop: nothing more is read or written */
  stop(): Promise<void>;
  /** the files in the set: new ones load their records, gone ones drop */
  setFiles(files: Iterable<string>): void;
  /** the file's current generation, to pass back with its text; undefined
   *  once stopped (an offer with it is dropped) */
  gen(file: string): number | undefined;
  /** text another path already has for this page */
  offer(file: string, page: number, gen: number | undefined, tc: TextContentLike, vp: ViewportLike): void;
  /** the file's page count, from a document opened under `gen` */
  setNumPages(file: string, gen: number | undefined, n: number): void;
  /** the file's bytes changed or it left the set: start it over */
  forget(file: string): void;
  /** the page's number; null: read, none; undefined: not read yet */
  number(file: string, page: number): string | null | undefined;
  /** how many of the file's pages have been read */
  readCount(file: string): number;
  /** its bytes changed this session (forget): labels made from the old
   * bytes, such as the tab's, may be stale until its pages are read again */
  stale(file: string): boolean;
  subscribe(fn: () => void): () => void;
}

// each read shows in a performance trace as "sheet-number" (the PR's
// main-thread evidence); a browser without measure options just skips it
const measure = (start: number) => { try { performance.measure("sheet-number", { start }); } catch { /* unsupported */ } };

export const nameKey = (scope: string, file: string) => `sheet_names:${scope}:${file}`;
/** a dirty file's record is written at most this often */
export const WRITE_EVERY_MS = 1000;

// records whose delete failed this session: ignored until rewritten
const untrusted = new Set<string>();
// files whose bytes changed this session, namer or not (Classic layout): their
// tab labels may still name the old revision
const changed = new Set<string>();

/** Note that these files' bytes changed (any layout, any mode). */
export function markSheetNamesStale(scope: string, files: Iterable<string>): void {
  for (const f of files) changed.add(nameKey(scope, f));
}

/** Delete these files' saved numbers. Called wherever a file's bytes change
 *  or it leaves the set, whether or not a namer is running: a revision
 *  dropped in Classic layout must not leave its old numbers behind. */
export async function forgetSheetNames(meta: { del(key: string): Promise<void> }, scope: string, files: Iterable<string>, onError?: (e: unknown) => void): Promise<void> {
  const list = [...files];
  markSheetNamesStale(scope, list);
  await Promise.all(list.map(async (f) => {
    const k = nameKey(scope, f);
    // untrusted first: a namer reading the record before the delete lands
    // must not take it
    untrusted.add(k);
    try { await meta.del(k); untrusted.delete(k); }
    catch (e) { onError?.(e); }
  }));
}

const isRecord = (r: unknown): r is NameRecord =>
  !!r && typeof r === "object" && typeof (r as NameRecord).rv === "number" && !!(r as NameRecord).pages && typeof (r as NameRecord).pages === "object";

interface FileState {
  gen: number;
  /** its record has been read (or there is none to read) */
  loaded: boolean;
  numPages: number | null;
  pages: Map<number, string | null>;
  /** read before the record loaded: merged into it when it does */
  held: Map<number, string | null>;
  dirty: boolean;
  timer: unknown;
  forgotten: boolean;
}

export function createSheetNamer(deps: NamerDeps): SheetNamer {
  const read = deps.read ?? ((tc: TextContentLike, vp: ViewportLike) => readSheetNumber(sheetItems(tc, vp)));
  const timers = deps.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const signal = deps.signal ?? createChangeSignal();
  const fail = (e: unknown) => { try { deps.onError?.(e); } catch { /* reporting only */ } };
  const files = new Map<string, FileState>();
  const waiting = new Set<string>(); // offers whose reader hasn't run yet
  let nextGen = 1; // one counter for every file: a re-created file never reuses a generation
  let state: "idle" | "running" | "stopping" | "stopped" = "idle";
  const live = () => state === "running";

  function ensure(file: string): FileState {
    let st = files.get(file);
    if (st) return st;
    st = { gen: nextGen++, loaded: !deps.persist, numPages: null, pages: new Map(), held: new Map(), dirty: false, timer: null, forgotten: false };
    files.set(file, st);
    if (deps.persist) load(file, st);
    return st;
  }

  function load(file: string, st: FileState) {
    const gen = st.gen, key = nameKey(deps.scope, file);
    const settle = (rec: unknown) => {
      // forgotten (a new generation, already loaded-and-empty) or dropped meanwhile
      if (files.get(file) !== st || st.gen !== gen || st.loaded) return;
      st.loaded = true;
      if (isRecord(rec) && rec.rv === READER_VERSION && !untrusted.has(key)) {
        if (st.numPages == null && typeof rec.numPages === "number") st.numPages = rec.numPages;
        for (const [p, n] of Object.entries(rec.pages)) st.pages.set(Number(p), typeof n === "string" ? n : null);
      }
      // what was read meanwhile joins the record; a page the record has stays
      for (const [p, n] of st.held) if (!st.pages.has(p)) { st.pages.set(p, n); st.dirty = true; }
      st.held.clear();
      if (st.dirty) scheduleWrite(file, st);
      signal.notify();
    };
    deps.meta.get(key).then(settle, (e) => { fail(e); settle(undefined); });
  }

  function complete(st: FileState) { return st.numPages != null && st.pages.size >= st.numPages; }

  function scheduleWrite(file: string, st: FileState) {
    if (!deps.persist || !st.dirty || !live()) return;
    if (complete(st)) { if (st.timer != null) { timers.clear(st.timer); st.timer = null; } void flush(file, st); return; }
    if (st.timer != null) return;
    st.timer = timers.set(() => { st.timer = null; void flush(file, st); }, WRITE_EVERY_MS);
  }

  function flush(file: string, st: FileState): Promise<void> {
    if (!deps.persist || !st.dirty || files.get(file) !== st) return Promise.resolve();
    st.dirty = false;
    const key = nameKey(deps.scope, file);
    const rec: NameRecord = { rv: READER_VERSION, numPages: st.numPages, pages: Object.fromEntries([...st.pages].map(([p, n]) => [String(p), n])) };
    return deps.meta.put(key, rec).then(() => { untrusted.delete(key); }, fail);
  }

  function put(file: string, st: FileState, page: number, n: string | null) {
    if (st.pages.has(page)) return;
    if (!st.loaded) { if (!st.held.has(page)) st.held.set(page, n); }
    else { st.pages.set(page, n); st.dirty = true; scheduleWrite(file, st); }
    signal.notify();
  }

  return {
    start() { if (state === "idle") state = "running"; },
    async stop() {
      if (state === "stopping" || state === "stopped") return;
      state = "stopping";
      const pending: Promise<void>[] = [];
      for (const [file, st] of files) {
        if (st.timer != null) { timers.clear(st.timer); st.timer = null; }
        pending.push(flush(file, st));
      }
      await Promise.all(pending);
      state = "stopped";
    },
    setFiles(list) {
      if (!live()) return;
      const keep = new Set(list);
      for (const f of keep) ensure(f);
      for (const [f, st] of files) if (!keep.has(f)) { if (st.timer != null) timers.clear(st.timer); files.delete(f); }
    },
    gen(file) { return live() ? ensure(file).gen : undefined; },
    offer(file, page, gen, tc, vp) {
      if (!live() || gen === undefined) return;
      const st = files.get(file);
      if (!st || st.gen !== gen || st.pages.has(page) || st.held.has(page)) return;
      const id = `${gen}|${page}|${file}`;
      if (waiting.has(id)) return;
      waiting.add(id);
      // its own task: never lengthens the caller's
      timers.set(() => {
        waiting.delete(id);
        if (!live() || files.get(file) !== st || st.gen !== gen) return;
        let n: string | null;
        const t0 = performance.now();
        try { n = read(tc, vp); } catch (e) { fail(e); return; }
        finally { measure(t0); }
        put(file, st, page, n);
      }, 0);
    },
    setNumPages(file, gen, n) {
      if (!live() || gen === undefined || !Number.isFinite(n) || n < 1) return;
      const st = files.get(file);
      if (!st || st.gen !== gen || st.numPages === n) return;
      st.numPages = n;
      if (st.loaded) { st.dirty = true; scheduleWrite(file, st); }
      signal.notify();
    },
    forget(file) {
      const st = files.get(file);
      if (!st) return;
      if (st.timer != null) { timers.clear(st.timer); st.timer = null; }
      st.gen = nextGen++;
      st.forgotten = true;
      st.loaded = true; // its record is gone (forgetSheetNames): nothing to wait for
      st.dirty = false;
      st.numPages = null;
      st.pages.clear();
      st.held.clear();
      signal.notify();
    },
    number(file, page) {
      const st = files.get(file);
      if (!st) return undefined;
      if (st.pages.has(page)) return st.pages.get(page);
      return st.held.get(page);
    },
    readCount(file) { const st = files.get(file); return st ? st.pages.size + st.held.size : 0; },
    stale(file) { return !!files.get(file)?.forgotten || changed.has(nameKey(deps.scope, file)); },
    subscribe: (fn) => signal.subscribe(fn),
  };
}
