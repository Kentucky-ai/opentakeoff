// Lifecycle only; pdf.js and OffscreenCanvas stay in the browser adapter.
export type TileRender = { type: "renderTile"; reqId: number; sheetKey: string; scale: number; rect: { x: number; y: number; w: number; h: number }; dark: boolean };
export type TileMessage =
  // docKey: the identity of the bytes (PdfSource.key). Sheets opened with the
  // same docKey share one document in this worker; without one, a sheet has
  // its own. `data` is a Blob only with a docKey: it is read by byte range.
  | { type: "openSheet"; sheetKey: string; openId: number; pageNum: number; data: ArrayBuffer | Blob; docKey?: string }
  | TileRender
  // One page's text, read off the main thread (#580): no sheet need be open.
  // The document is this worker's shared one for docKey, held for the read.
  | { type: "pageText"; reqId: number; pageNum: number; scale: number; data: ArrayBuffer | Blob; docKey: string }
  // Load the document for docKey ahead of the sheet that will want it, so
  // the worker parses while the main thread is still finding the page.
  | { type: "warmDoc"; data: ArrayBuffer | Blob; docKey: string }
  | { type: "cancel"; reqId: number }
  | { type: "closeSheet"; sheetKey: string };
interface LoadingTask<Page> {
  promise: Promise<{ getPage(n: number): Promise<Page> }>;
  destroy(): Promise<void>;
}
interface RenderTask { promise: Promise<ImageBitmap>; cancel(): void; }
export interface TileWorkerDeps<Page> {
  load(data: ArrayBuffer | Blob): LoadingTask<Page>;
  render(page: Page, request: TileRender): RenderTask;
  post(message: unknown, transfer?: Transferable[]): void;
  /** A page's text and what places it, as something that can be posted. */
  text?(page: Page, scale: number): Promise<unknown>;
  /** Free what a page cached for painting, once no open sheet shows it. Only
   * asked of a shared document (a private one is destroyed instead). */
  cleanup?(page: Page): void;
  /** How long a shared document with no open sheet is kept, so the next
   * sheet of the same file opens without parsing it again. 0: not kept. */
  idleMs?: number;
  /** A shared document that has opened this many sheets is destroyed when
   * its last one closes, not kept: what it caches per page (fonts, images,
   * the byte ranges read) is bounded by this. */
  maxSheets?: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // A sheet may close before any tile awaits it.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const message = (error: unknown) => String((error as Error)?.message || error);

export function createTileWorkerCore<Page>(deps: TileWorkerDeps<Page>) {
  // One pdf.js document. Private (key null): one sheet's own, destroyed when
  // that sheet closes. Shared (#580): every open sheet of the same bytes, in
  // this worker, reads from it, so a flip to another page of a big set costs
  // a getPage, not another parse of the file.
  type Doc = {
    key: string | null; task: LoadingTask<Page>; refs: number; opened: number; destroyed: boolean;
    idle?: ReturnType<typeof setTimeout>;
    // one render at a time per PAGE: two sheets on the same page of a shared
    // document hold the same pdf.js page object
    chains: Map<number, Promise<void>>;
  };
  type Entry = { ready: ReturnType<typeof deferred<Page>>; doc?: Doc; pageNum: number; page?: Page; released: boolean };
  type Flight = { entry: Entry; cancelled: boolean; stop: ReturnType<typeof deferred<never>>; task?: RenderTask };
  const sheets = new Map<string, Entry>();
  const docs = new Map<string, Doc>();
  const inflight = new Map<number, Flight>();
  const idleMs = deps.idleMs ?? 0, maxSheets = deps.maxSheets ?? Infinity;

  function destroyDoc(doc: Doc) {
    if (doc.idle !== undefined) { clearTimeout(doc.idle); doc.idle = undefined; }
    if (doc.key !== null && docs.get(doc.key) === doc) docs.delete(doc.key);
    if (doc.destroyed) return;
    doc.destroyed = true;
    // pdf.js can reject, or leave its load promise pending, on destruction.
    // Neither is allowed to retain our ready/render waiters.
    try { void doc.task.destroy().catch(() => {}); } catch { /* teardown failed */ }
  }

  function acquire(data: ArrayBuffer | Blob, docKey: string | undefined, use = 1): Doc {
    const had = docKey !== undefined ? docs.get(docKey) : undefined;
    if (had) {
      if (had.idle !== undefined) { clearTimeout(had.idle); had.idle = undefined; }
      had.refs++; had.opened += use;
      return had;
    }
    const doc: Doc = { key: docKey ?? null, task: deps.load(data), refs: 1, opened: use, destroyed: false, chains: new Map() };
    if (doc.key !== null) {
      docs.set(doc.key, doc);
      // a document that can't load is never the one the next open is given
      doc.task.promise.catch(() => { if (doc.key !== null && docs.get(doc.key) === doc) docs.delete(doc.key); });
    }
    return doc;
  }

  function unref(doc: Doc) {
    if (--doc.refs > 0) return;
    const keep = doc.key !== null && docs.get(doc.key) === doc && idleMs > 0 && doc.opened < maxSheets && !doc.destroyed;
    if (!keep) { destroyDoc(doc); return; }
    doc.idle = setTimeout(() => { doc.idle = undefined; if (doc.refs === 0) destroyDoc(doc); }, idleMs);
    // a kept document never holds a Node test (or a worker's shutdown) open
    (doc.idle as { unref?: () => void }).unref?.();
  }

  function release(entry: Entry, error: Error) {
    entry.ready.reject(error);
    for (const flight of inflight.values()) {
      if (flight.entry !== entry) continue;
      flight.stop.reject(error);
      try { flight.task?.cancel(); } catch { /* already finished */ }
    }
    if (entry.released) return;
    entry.released = true;
    const doc = entry.doc;
    if (!doc) return;
    if (doc.key !== null && entry.page !== undefined && deps.cleanup) {
      let shown = false;
      for (const other of sheets.values()) if (other !== entry && other.doc === doc && other.pageNum === entry.pageNum && !other.released) shown = true;
      if (!shown) { try { deps.cleanup(entry.page); } catch { /* a render is still unwinding: pdf.js cleans up after it */ } }
    }
    unref(doc);
  }

  function handle(msg: TileMessage): void | Promise<void> {
    if (msg.type === "openSheet") {
      if (sheets.has(msg.sheetKey)) return;
      const entry: Entry = { ready: deferred<Page>(), pageNum: msg.pageNum, released: false };
      sheets.set(msg.sheetKey, entry);
      void (async () => {
        try {
          entry.doc = acquire(msg.data, msg.docKey);
          const doc = await entry.doc.task.promise;
          if (sheets.get(msg.sheetKey) !== entry) return;
          const page = await doc.getPage(msg.pageNum);
          if (sheets.get(msg.sheetKey) !== entry) return;
          entry.page = page;
          entry.ready.resolve(page);
          deps.post({ type: "sheetReady", sheetKey: msg.sheetKey, openId: msg.openId });
        } catch (error) {
          if (sheets.get(msg.sheetKey) !== entry) return;
          sheets.delete(msg.sheetKey);
          release(entry, new Error(message(error)));
          deps.post({ type: "sheetError", sheetKey: msg.sheetKey, openId: msg.openId, message: message(error) });
        }
      })();
      return;
    }
    if (msg.type === "closeSheet") {
      const entry = sheets.get(msg.sheetKey);
      // Remove first: a new open owns the key even while destruction is pending.
      sheets.delete(msg.sheetKey);
      if (entry) release(entry, new Error("sheet closed"));
      return;
    }
    if (msg.type === "warmDoc") {
      // held until it has loaded (or failed), then left to the idle timer:
      // the sheet that follows finds it open. Not a use toward maxSheets.
      if (idleMs <= 0) return;
      let doc: Doc;
      try { doc = acquire(msg.data, msg.docKey, 0); } catch { return; }
      return doc.task.promise.then(() => {}, () => {}).then(() => unref(doc));
    }
    if (msg.type === "pageText") {
      const { reqId } = msg;
      return (async () => {
        let doc: Doc | undefined;
        try {
          if (!deps.text) throw new Error("this worker reads no text");
          doc = acquire(msg.data, msg.docKey);
          const page = await (await doc.task.promise).getPage(msg.pageNum);
          deps.post({ type: "pageText", reqId, text: await deps.text(page, msg.scale) });
        } catch (error) {
          deps.post({ type: "pageTextError", reqId, message: message(error) });
        } finally {
          if (doc) unref(doc);
        }
      })();
    }
    if (msg.type === "cancel") {
      const flight = inflight.get(msg.reqId);
      if (flight) {
        flight.cancelled = true;
        flight.stop.reject(new Error("tile cancelled"));
        try { flight.task?.cancel(); } catch { /* already finished */ }
      }
      return;
    }
    const { reqId, sheetKey, rect } = msg;
    const entry = sheets.get(sheetKey);
    if (!entry) {
      deps.post({ type: "tileError", reqId, sheetKey, message: "sheet not open" });
      return;
    }
    const flight: Flight = { entry, cancelled: false, stop: deferred<never>() };
    inflight.set(reqId, flight);
    // the open above set entry.doc synchronously, unless its load threw
    const chains = entry.doc?.chains;
    const chain = (chains?.get(entry.pageNum) ?? Promise.resolve()).then(async () => {
      try {
        const page = await Promise.race([entry.ready.promise, flight.stop.promise]);
        if (flight.cancelled || sheets.get(sheetKey) !== entry) throw new Error("sheet closed");
        const task = deps.render(page, msg);
        flight.task = task;
        // Also clean a late bitmap if cancellation wins this race.
        let abandoned = false;
        const rendered = task.promise.then(bitmap => { if (abandoned) bitmap.close(); return bitmap; });
        let bitmap: ImageBitmap;
        try { bitmap = await Promise.race([rendered, flight.stop.promise]); }
        catch (error) { abandoned = true; throw error; }
        if (flight.cancelled || sheets.get(sheetKey) !== entry) { bitmap.close(); throw new Error("sheet closed"); }
        deps.post({ type: "tile", reqId, sheetKey, w: rect.w, h: rect.h, bitmap }, [bitmap]);
      } catch (error) {
        if (!flight.cancelled) deps.post({ type: "tileError", reqId, sheetKey, message: message(error) });
      } finally {
        inflight.delete(reqId);
      }
    });
    chains?.set(entry.pageNum, chain);
    return chain;
  }
  return { handle, get pendingCount() { return inflight.size; }, get docCount() { return docs.size; } };
}
