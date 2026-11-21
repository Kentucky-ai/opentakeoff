// Text-layer revision diff: which strings a reissued sheet added, dropped or
// reworded, and where. Linework diffing cannot see a finish tag that changed
// from one code to another or a dimension that was retyped: the ink that
// moved is glyphs, not segments. This reads the two text layers instead.
// Pure, no DOM dependencies.

export interface TextItem {
  str: string;
  x: number;
  y: number;
}

export interface TextChange {
  type: "added" | "removed" | "changed";
  /** The string on the base sheet (absent for an added string). */
  before?: string;
  /** The string on the revised sheet (absent for a removed string). */
  after?: string;
  /** Position in the BASE sheet's frame, image px. */
  at: [number, number];
}

export interface TextDiffResult {
  changes: TextChange[];
  unchanged: number;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** A printed dimension or scale: 12'-6", 4", 3/8" = 1'-0", 1500 mm. */
export function looksLikeDimension(s: string): boolean {
  return /\d\s*['′’]|\d\s*["″”]|\d\s*(?:mm|cm|m)\b/i.test(s) && /\d/.test(s);
}

/**
 * Diff two text layers. `align` is the offset that carries revised-sheet
 * coordinates into the base frame (the same offset the linework diff uses).
 * A string is unchanged when the same text sits within `tol` px on both
 * sheets; a leftover removed string and a leftover added string within
 * `pairDist` px of each other are one reworded string.
 */
export function diffSheetText(
  base: TextItem[],
  revised: TextItem[],
  align: { dx: number; dy: number } = { dx: 0, dy: 0 },
  tol = 3,
  pairDist = 14,
): TextDiffResult {
  const b = base.map((t) => ({ str: norm(t.str), x: t.x, y: t.y })).filter((t) => t.str);
  const r = revised.map((t) => ({ str: norm(t.str), x: t.x + align.dx, y: t.y + align.dy })).filter((t) => t.str);

  const byStr = new Map<string, number[]>();
  b.forEach((t, i) => {
    const list = byStr.get(t.str);
    if (list) list.push(i); else byStr.set(t.str, [i]);
  });
  const baseUsed = new Uint8Array(b.length);
  const added: number[] = [];
  let unchanged = 0;
  for (let i = 0; i < r.length; i++) {
    const cands = byStr.get(r[i].str);
    let hit = -1;
    if (cands) {
      for (const k of cands) {
        if (baseUsed[k]) continue;
        if (Math.abs(b[k].x - r[i].x) <= tol && Math.abs(b[k].y - r[i].y) <= tol) { hit = k; break; }
      }
    }
    if (hit >= 0) { baseUsed[hit] = 1; unchanged++; } else added.push(i);
  }
  const removed: number[] = [];
  for (let k = 0; k < b.length; k++) if (!baseUsed[k]) removed.push(k);

  // Re-chunking is not a change. Two PDF producers split the same printed line
  // into different text runs ("03- 32 SF" on one issue, "03-" and "32 SF" on
  // the other). A leftover run on one side that the other side's leftover runs
  // on the same baseline spell out exactly, left to right, is the same text.
  const squash = (t: string) => t.replace(/\s+/g, "");
  const rechunk = (whole: { str: string; x: number; y: number }, parts: { i: number; str: string; x: number; y: number }[]): number[] | null => {
    const target = squash(whole.str);
    const line = parts.filter((p) => Math.abs(p.y - whole.y) <= tol && p.x >= whole.x - tol).sort((p, q) => p.x - q.x);
    let built = "";
    const used: number[] = [];
    for (const p of line) {
      const next = built + squash(p.str);
      if (!target.startsWith(next)) { if (!used.length) continue; break; }
      built = next; used.push(p.i);
      if (built === target) return used.length > 1 || squash(p.str) === target ? used : null;
    }
    return null;
  };
  const gone = new Set<number>();   // base indices explained by re-chunking
  const came = new Set<number>();   // revised indices explained by re-chunking
  for (const k of removed) {
    const parts = added.filter((a) => !came.has(a)).map((a) => ({ i: a, ...r[a] }));
    const used = rechunk(b[k], parts);
    if (used) { gone.add(k); used.forEach((a) => came.add(a)); }
  }
  for (const a of added) {
    if (came.has(a)) continue;
    const parts = removed.filter((k) => !gone.has(k)).map((k) => ({ i: k, ...b[k] }));
    const used = rechunk(r[a], parts);
    if (used) { came.add(a); used.forEach((k) => gone.add(k)); }
  }
  if (gone.size || came.size) {
    unchanged += Math.max(gone.size, came.size);
    for (let i = removed.length - 1; i >= 0; i--) if (gone.has(removed[i])) removed.splice(i, 1);
    for (let i = added.length - 1; i >= 0; i--) if (came.has(added[i])) added.splice(i, 1);
  }

  // Pair leftovers by proximity, nearest first: a removed "CPT-1" and an added
  // "LVT-2" at the same spot are one change, not two.
  const cell = Math.max(1, pairDist);
  const grid = new Map<string, number[]>();
  for (const k of removed) {
    const key = `${Math.floor(b[k].x / cell)},${Math.floor(b[k].y / cell)}`;
    const list = grid.get(key);
    if (list) list.push(k); else grid.set(key, [k]);
  }
  const cands: { d: number; a: number; k: number }[] = [];
  for (const a of added) {
    const cx = Math.floor(r[a].x / cell), cy = Math.floor(r[a].y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const k of grid.get(`${gx},${gy}`) || []) {
          const d = Math.hypot(b[k].x - r[a].x, b[k].y - r[a].y);
          if (d <= pairDist) cands.push({ d, a, k });
        }
      }
    }
  }
  cands.sort((p, q) => p.d - q.d || p.k - q.k || p.a - q.a);
  const addedUsed = new Set<number>();
  const removedUsed = new Set<number>();
  const changes: TextChange[] = [];
  for (const c of cands) {
    if (addedUsed.has(c.a) || removedUsed.has(c.k)) continue;
    addedUsed.add(c.a); removedUsed.add(c.k);
    changes.push({ type: "changed", before: b[c.k].str, after: r[c.a].str, at: [b[c.k].x, b[c.k].y] });
  }
  for (const k of removed) if (!removedUsed.has(k)) changes.push({ type: "removed", before: b[k].str, at: [b[k].x, b[k].y] });
  for (const a of added) if (!addedUsed.has(a)) changes.push({ type: "added", after: r[a].str, at: [r[a].x, r[a].y] });
  // Reading order, so a ledger built from this is stable run to run.
  changes.sort((p, q) => p.at[1] - q.at[1] || p.at[0] - q.at[0]);
  return { changes, unchanged };
}
