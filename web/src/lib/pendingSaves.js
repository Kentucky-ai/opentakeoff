// Pending saves that something must not read around.
//
// The canvas autosaves 700 ms after the last edit. Anything that reads the
// stored project directly (Export everything) would miss an edit made inside
// that window, so the canvas registers a flusher that writes its pending
// payload now, and the reader awaits flushPendingSaves() first.
//
// A flusher resolves once its write has committed and rejects if the write
// failed; flushPendingSaves rejects with the first failure, so a caller can
// refuse to go on rather than read stale data.

const flushers = new Set();

/** Register a flusher; returns the function that removes it. */
export function registerSaveFlusher(fn) {
  flushers.add(fn);
  return () => { flushers.delete(fn); };
}

/** Write every pending save now. */
export async function flushPendingSaves() {
  await Promise.all([...flushers].map((fn) => Promise.resolve().then(fn)));
}
