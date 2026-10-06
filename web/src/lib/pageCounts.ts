// The project's known page counts (the gallery's `sheet_pages:` cache), so a
// large set's gallery and tree show without loading every PDF. The stored map
// is written whole, so nothing is written until it has loaded: a count
// learned earlier waits and joins it, and never replaces the stored counts.
export type PageCountMap = Record<string, number>;

export interface PageCounts {
  remember(name: string, count: number): void;
  forget(names: Iterable<string>): void;
  get(): PageCountMap;
  /** the stored map has loaded (or failed to: then it starts empty) */
  hydrated(): boolean;
}

export function createPageCounts(deps: { load(): Promise<unknown>; save(m: PageCountMap): Promise<void>; onChange(m: PageCountMap): void }): PageCounts {
  let map: PageCountMap = {}, loaded = false;
  const early: PageCountMap = {};
  const save = () => { deps.save(map).catch(() => { /* cache only — rediscovered next open */ }); };
  function remember(name: string, count: number) {
    if (!Number.isFinite(count) || count < 1) return;
    if (!loaded) { early[name] = count; return; }
    if (map[name] === count) return;
    map = { ...map, [name]: count };
    deps.onChange(map);
    save();
  }
  const settle = (m: unknown) => {
    if (m && typeof m === "object") map = { ...(m as PageCountMap) };
    loaded = true;
    deps.onChange(map);
    for (const [n, c] of Object.entries(early)) { delete early[n]; remember(n, c); }
  };
  deps.load().then(settle, () => settle(null));
  return {
    remember,
    forget(names) {
      let hit = false;
      const next = { ...map };
      for (const n of names) { delete early[n]; if (n in next) { delete next[n]; hit = true; } }
      if (!hit) return;
      map = next;
      deps.onChange(map);
      save();
    },
    get: () => map,
    hydrated: () => loaded,
  };
}
