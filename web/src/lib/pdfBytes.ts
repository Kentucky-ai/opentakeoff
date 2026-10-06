// A session's raw PDF bytes, kept so a file opened again comes from memory,
// not a second download. A copy is the file's size; the pdf.js document it
// opens into costs several times that.

export interface ByteCache {
  /** a fresh copy of the file's bytes, loaded once while kept: pdf.js and a
   * worker transfer may detach what they're given */
  get(name: string): Promise<Uint8Array>;
  /** drop the file's copy; a load in flight for it isn't kept when it lands,
   * and the next get loads afresh */
  forget(name: string): void;
}

/** Copies are kept while their total fits `maxBytes`, the least recently
 * asked for going first; one bigger than the whole budget is never kept. A
 * failed load isn't kept either, and its error reaches every caller. No
 * budget turns the cache off: every get loads. */
export function createByteCache(deps: { load(name: string): Promise<Uint8Array>; maxBytes: number }): ByteCache {
  if (!(deps.maxBytes > 0)) {
    return { get: (name) => deps.load(name), forget() {} };
  }
  // Map order is recency: the first entry is the least recently asked for
  const kept = new Map<string, Uint8Array>();
  const loading = new Map<string, Promise<Uint8Array>>();
  let total = 0;
  const drop = (name: string) => {
    const b = kept.get(name);
    if (b) { total -= b.byteLength; kept.delete(name); }
  };
  function keep(name: string, b: Uint8Array) {
    drop(name);
    if (b.byteLength > deps.maxBytes) return;
    kept.set(name, b);
    total += b.byteLength;
    for (const [n] of kept) {
      if (total <= deps.maxBytes) break;
      drop(n);
    }
  }
  // the kept master never leaves: every caller gets its own copy
  const copy = (p: Promise<Uint8Array>) => p.then((b) => b.slice());
  return {
    get(name) {
      const had = kept.get(name);
      if (had) { kept.delete(name); kept.set(name, had); return Promise.resolve(had.slice()); }
      let p = loading.get(name);
      if (!p) {
        // a forget meanwhile takes this load out of `loading`
        const mine: Promise<Uint8Array> = deps.load(name).then(
          (b) => { if (loading.get(name) === mine) { loading.delete(name); keep(name, b); } return b; },
          (e) => { if (loading.get(name) === mine) loading.delete(name); throw e; },
        );
        loading.set(name, (p = mine));
      }
      return copy(p);
    },
    forget(name) { drop(name); loading.delete(name); },
  };
}

/** How many bytes of copies to keep: none on a low-memory device, whose
 * budget is tightest and where one plan set can outgrow a small cap. */
export function byteBudget(lowMemory: boolean): number { return lowMemory ? 0 : 256 * 1024 * 1024; }
