// Lifecycle only; pdf.js and OffscreenCanvas stay in the browser adapter.
export type TileRender = { type: "renderTile"; reqId: number; sheetKey: string; scale: number; rect: { x: number; y: number; w: number; h: number }; dark: boolean };
export type TileMessage =
  | { type: "openSheet"; sheetKey: string; openId: number; pageNum: number; data: ArrayBuffer }
  | TileRender
  | { type: "cancel"; reqId: number }
  | { type: "closeSheet"; sheetKey: string };
interface LoadingTask<Page> {
  promise: Promise<{ getPage(n: number): Promise<Page> }>;
  destroy(): Promise<void>;
}
interface RenderTask { promise: Promise<ImageBitmap>; cancel(): void; }
export interface TileWorkerDeps<Page> {
  load(data: ArrayBuffer): LoadingTask<Page>;
  render(page: Page, request: TileRender): RenderTask;
  post(message: unknown, transfer?: Transferable[]): void;
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
  type Entry = { ready: ReturnType<typeof deferred<Page>>; chain: Promise<void>; task?: LoadingTask<Page>; destroyed: boolean };
  type Flight = { entry: Entry; cancelled: boolean; stop: ReturnType<typeof deferred<never>>; task?: RenderTask };
  const sheets = new Map<string, Entry>();
  const inflight = new Map<number, Flight>();

  function release(entry: Entry, error: Error) {
    entry.ready.reject(error);
    for (const flight of inflight.values()) {
      if (flight.entry !== entry) continue;
      flight.stop.reject(error);
      try { flight.task?.cancel(); } catch { /* already finished */ }
    }
    if (!entry.destroyed && entry.task) {
      entry.destroyed = true;
      // pdf.js can reject, or leave its load promise pending, on destruction.
      // Neither is allowed to retain our ready/render waiters.
      try { void entry.task.destroy().catch(() => {}); } catch { /* teardown failed */ }
    }
  }

  function handle(msg: TileMessage): void | Promise<void> {
    if (msg.type === "openSheet") {
      if (sheets.has(msg.sheetKey)) return;
      const entry: Entry = { ready: deferred<Page>(), chain: Promise.resolve(), destroyed: false };
      sheets.set(msg.sheetKey, entry);
      void (async () => {
        try {
          entry.task = deps.load(msg.data);
          const doc = await entry.task.promise;
          if (sheets.get(msg.sheetKey) !== entry) return;
          const page = await doc.getPage(msg.pageNum);
          if (sheets.get(msg.sheetKey) !== entry) return;
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
    entry.chain = entry.chain.then(async () => {
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
    return entry.chain;
  }
  return { handle, get pendingCount() { return inflight.size; } };
}
