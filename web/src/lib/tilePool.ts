// Main-thread client for a small pool of pdfTile.worker.ts instances (#86).
// Mirrors voiceRecognizerClient.ts's lazy-worker-lifecycle pattern.
//
// Every open sheet is loaded into EVERY worker in the pool (broadcast, not
// hash-pinned to one) — a pdf.js Page object can't have two renders in
// flight at once, so the old design assigned a whole sheet to exactly ONE
// worker to dodge that. In practice that made the "pool" pointless for the
// common single-sheet view: every tile for every zoom/pan funneled through
// one worker, one render at a time, while the other 1-2 workers sat idle —
// confirmed live as the actual cause of a "takes forever, fills in as a
// wave" complaint, not a render-speed problem so much as a concurrency-of-1
// problem. Each worker gets its OWN independent pdf.js Document/Page (its
// own parse of the same bytes), so tile requests can now be spread round-
// robin across the whole pool — real N-way parallelism, N = pool size,
// including within a single open sheet. The cost is N redundant parses of
// the same (typically sub-few-MB) plan sheet, which is cheap next to what it
// buys: pdf.js parse time was never the bottleneck here, per-tile RENDER
// time was, and that's exactly what this parallelizes.
export interface TileRequest {
  sheetKey: string;
  scale: number;               // pdf.js render scale (RENDER_SCALE * density)
  rect: { x: number; y: number; w: number; h: number }; // level px
  dark: boolean;
}

export interface TileResult { w: number; h: number; bitmap: ImageBitmap; }

type OutMsg =
  | { type: "sheetReady"; sheetKey: string }
  | { type: "sheetError"; sheetKey: string; message: string }
  | { type: "tile"; reqId: number; sheetKey: string; w: number; h: number; bitmap: ImageBitmap }
  | { type: "tileError"; reqId: number; sheetKey: string; message: string };

const POOL_SIZE = Math.max(1, Math.min(3, (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) - 1 || 2));

interface SheetOpenState {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
  settled: boolean;
  readyCount: number; // workers that have reported sheetReady so far
}

export function createTilePool(size = POOL_SIZE) {
  const workers: Worker[] = [];
  const sheetOpen = new Map<string, SheetOpenState>();
  const pending = new Map<number, { resolve: (r: TileResult) => void; reject: (e: Error) => void; workerIdx: number }>();
  let nextReqId = 1;
  let rrCounter = 0; // round-robins tile requests across the whole pool
  let disposed = false;

  function ensureWorker(i: number): Worker {
    if (!workers[i]) {
      const w = new Worker(new URL("../pdfTile.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<OutMsg>) => onMessage(e.data);
      workers[i] = w;
    }
    return workers[i];
  }

  function onMessage(m: OutMsg) {
    if (m.type === "sheetReady") {
      const st = sheetOpen.get(m.sheetKey);
      if (!st || st.settled) return;
      st.readyCount++;
      if (st.readyCount >= size) { st.settled = true; st.resolve(); }
      return;
    }
    if (m.type === "sheetError") {
      const st = sheetOpen.get(m.sheetKey);
      if (!st || st.settled) return;
      st.settled = true; st.reject(new Error(m.message));
      return;
    }
    if (m.type === "tile") { pending.get(m.reqId)?.resolve({ w: m.w, h: m.h, bitmap: m.bitmap }); pending.delete(m.reqId); return; }
    if (m.type === "tileError") { pending.get(m.reqId)?.reject(new Error(m.message)); pending.delete(m.reqId); return; }
  }

  /** Idempotent — calling twice for the same sheetKey is a no-op after the
   *  first. `data` is an ArrayBuffer this pool now OWNS: it's sliced into a
   *  fresh transferable copy per worker (transfer detaches, so one buffer
   *  can't be handed to N workers), so the caller's own copy is untouched
   *  either way. Resolves once every worker has the sheet open. */
  function openSheet(sheetKey: string, pageNum: number, data: ArrayBuffer): Promise<void> {
    if (disposed) return Promise.reject(new Error("tile pool disposed"));
    const existing = sheetOpen.get(sheetKey);
    if (existing) return existing.promise;
    let resolve!: () => void, reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const st: SheetOpenState = { promise, resolve, reject, settled: false, readyCount: 0 };
    sheetOpen.set(sheetKey, st);
    for (let i = 0; i < size; i++) {
      const copy = data.slice(0); // independent transferable per worker
      ensureWorker(i).postMessage({ type: "openSheet", sheetKey, pageNum, data: copy }, [copy]);
    }
    return promise;
  }

  function requestTile(req: TileRequest): { promise: Promise<TileResult>; reqId: number; cancel: () => void } {
    const reqId = nextReqId++;
    const workerIdx = rrCounter++ % size;
    const w = ensureWorker(workerIdx);
    const promise = new Promise<TileResult>((resolve, reject) => {
      pending.set(reqId, { resolve, reject, workerIdx });
      w.postMessage({ type: "renderTile", reqId, sheetKey: req.sheetKey, scale: req.scale, rect: req.rect, dark: req.dark });
    });
    const cancel = () => { pending.delete(reqId); w.postMessage({ type: "cancel", reqId }); };
    return { promise, reqId, cancel };
  }

  function closeSheet(sheetKey: string) {
    for (let i = 0; i < size; i++) ensureWorker(i).postMessage({ type: "closeSheet", sheetKey });
    sheetOpen.delete(sheetKey);
  }

  function dispose() {
    disposed = true;
    for (const w of workers) w?.terminate();
    workers.length = 0;
    sheetOpen.clear(); pending.clear();
  }

  return { openSheet, requestTile, closeSheet, dispose };
}
