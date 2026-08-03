// Condition twins — a duplicate that stays in the family.
//
// One finish measured in two places is not two conditions, and it is not one condition either.
// The same sheet goods on a slab and on a raised deck take the same field material and different
// preparation underneath: one wants a moisture barrier, the other a primer and a different
// adhesive. A plain copy makes a stranger — fix a coverage rate on one and the other keeps the
// old number — and measuring both areas into a single condition throws away the per-area
// material list entirely, which is the thing you were trying to produce.
//
// A twin keeps the tie. Three fields carry it, deliberately separate:
//   family_id      grouping. Survives a parent delete, survives a split. What groups the rows
//                  in the panel and subtotals in the report.
//   variant_of     inheritance. The condition whose material rows this one follows. Absent =
//                  owns its list (a root, or a twin that was split out).
//   variant_label  the suffix the estimator typed ("Level 2"). Display only — it is baked into
//                  finish_tag at mint, because the TAG is the identity every export and every
//                  MCP tool resolves on.
// and two on each material row:
//   inherited      this row still follows the family
//   origin_id      the parent row's `id` this row mirrors (rows always get FRESH ids — the
//                  material library links by `lib_id` and exports key by row id — so origin_id
//                  is the only link)
// plus `materials_dropped: [origin_id]` on the condition: rows the twin deleted locally. It is
// what renders the struck-through "removed here" line, and what stops a later family edit from
// resurrecting a row the estimator deliberately threw away.
//
// PROPAGATE-ON-WRITE, not resolve-on-read. A parent edit writes into its descendants, so every
// twin always carries a FULLY POPULATED materials list — which is why totals.js, reportColumns,
// rollTakeoff, the marked set, every export and the MCP session keep reading
// `condition.materials` completely unchanged. Resolving inheritance at read time would mean
// teaching all of them; this way the rule lives here and is called from the edit chokepoints.
//
// Pure — no React, no storage, no id generator of its own. Every mint takes an injected
// `mintId` so test/variants.test.ts can drive it deterministically.

/** A material row, as loosely as this module needs to know it. */
export interface VariantRow {
  id: string;
  origin_id?: string;
  inherited?: boolean;
  [k: string]: unknown;
}

/** A condition, as loosely as this module needs to know it. */
export interface VariantCond {
  id: string;
  finish_tag: string;
  family_id?: string;
  variant_of?: string;
  variant_label?: string;
  materials?: VariantRow[];
  materials_dropped?: string[];
  [k: string]: unknown;
}

export type Mint = (prefix: string) => string;

// The variant-label join: an en dash with spaces, so baseTagOf splits it back off and twinning a
// twin never stacks suffixes.
const SEP = " – ";

// Row bookkeeping that must never be copied from a patch or a parent row.
const ROW_LINK_FIELDS = ["id", "origin_id", "inherited"] as const;

/** "CPT-1 – Level 2" → "CPT-1". A tag with no suffix is its own base. */
export function baseTagOf(tag: string | undefined): string {
  const s = String(tag ?? "");
  const i = s.indexOf(SEP);
  return (i === -1 ? s : s.slice(0, i)).trim();
}

/** Compose a twin's tag. Falls back to the base when the label is blank. */
export function variantTag(baseOrTag: string | undefined, label: string | undefined): string {
  const base = baseTagOf(baseOrTag);
  const l = String(label ?? "").trim();
  return l ? `${base}${SEP}${l}` : base;
}

/**
 * First tag in the `candidate`, `candidate (2)`, `candidate (3)` series that `taken` does not
 * hold. `taken` is a Set of NORMALIZED tags and `norm` the normalizer that filled it
 * (scheduleEdit.normalizeTag) — the same " (2)" idiom xlsx.ts uses to uniquify a sheet name.
 * A UI should refuse a collision outright and say so; this is for the programmatic paths.
 */
export function uniqueTag(candidate: string, taken: Set<string>, norm: (s: string) => string): string {
  if (!taken.has(norm(candidate))) return candidate;
  for (let n = 2; n < 500; n++) {
    const t = `${candidate} (${n})`;
    if (!taken.has(norm(t))) return t;
  }
  return `${candidate} (${taken.size + 1})`;
}

/** Is this condition following another one's material list? */
export function isTwin(cond: VariantCond | undefined): boolean {
  return !!cond?.variant_of;
}

/** Rows on this condition that no longer follow the family (what the count badge shows). */
export function localCount(cond: VariantCond | undefined): number {
  if (!cond?.variant_of) return 0;   // a root owns everything; "local" is meaningless
  const rows = cond.materials || [];
  return rows.filter((r) => !r.inherited).length + (cond.materials_dropped || []).length;
}

/** Copy a parent row onto a twin: fresh id, origin link, following. */
function copyRow(row: VariantRow, id: string, originId: string): VariantRow {
  return { ...row, id, origin_id: originId, inherited: true };
}

function childrenOf(conds: VariantCond[], parentId: string): VariantCond[] {
  return conds.filter((c) => c.variant_of === parentId);
}

function stripLinks(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch };
  for (const f of ROW_LINK_FIELDS) delete out[f];
  return out;
}

/**
 * Build the twin. Returns the new condition plus the `family_id` the PARENT needs when it is
 * being twinned for the first time (a lone condition has no family yet), or null when it already
 * belongs to one.
 *
 * The twin carries the parent's appearance, params, waste and material rows. It does NOT carry
 * geometry, its palette pin, or `created_at` — a twin is a new condition with no takeoffs, and
 * the estimator measures into it. Appearance: it KEEPS the parent's colour and advances only the
 * hatch, so variants of one finish read as related on the sheet instead of as unrelated scopes.
 */
export function mintTwin(
  parent: VariantCond,
  opts: { label: string; tag?: string; mintId: Mint; nowIso: () => string; nextHatch?: string },
): { twin: VariantCond; parentPatch: { family_id: string } | null } {
  const family_id = parent.family_id || opts.mintId("fam");
  const materials = (parent.materials || []).map((r) => copyRow(r, opts.mintId("mat"), r.id));
  const twin: VariantCond = {
    ...parent,
    id: opts.mintId("cnd"),
    created_at: opts.nowIso(),
    finish_tag: opts.tag || variantTag(parent.finish_tag, opts.label),
    family_id,
    variant_of: parent.id,
    variant_label: String(opts.label ?? "").trim() || undefined,
    materials,
    ...(opts.nextHatch ? { hatch: opts.nextHatch } : {}),
  };
  delete twin.materials_dropped;   // tombstones are per-condition history, never inherited
  delete twin.updated_at;
  if (twin.attrs && typeof twin.attrs === "object") twin.attrs = { ...(twin.attrs as object) };
  return { twin, parentPatch: parent.family_id ? null : { family_id } };
}

// --- propagation ------------------------------------------------------------------
// Each of these walks DOWN the tree: direct children first, then theirs with the child's own row
// id as the new origin. Depth is an estimator's area count, so recursion is free; the `seen`
// guard is only there so a hand-edited payload with a cycle cannot hang the canvas.

/**
 * The parent's row changed → write the same fields into every descendant row still following it.
 * A row the twin has taken over (`inherited: false`) and a row it tombstoned are both left
 * alone: that is the whole override contract.
 */
export function propagateRowPatch(
  conds: VariantCond[], parentId: string, originId: string,
  patch: Record<string, unknown>, seen: Set<string> = new Set(),
): VariantCond[] {
  if (seen.has(parentId)) return conds;
  seen.add(parentId);
  const clean = stripLinks(patch);
  let out = conds;
  for (const child of childrenOf(conds, parentId)) {
    if ((child.materials_dropped || []).includes(originId)) continue;
    const row = (child.materials || []).find((r) => r.origin_id === originId && r.inherited);
    if (!row) continue;
    out = out.map((c) => (c.id !== child.id ? c : {
      ...c,
      materials: (c.materials || []).map((r) => (r.id !== row.id ? r
        : { ...r, ...clean, id: r.id, origin_id: r.origin_id, inherited: true })),
    }));
    out = propagateRowPatch(out, child.id, row.id, clean, seen);
  }
  return out;
}

/**
 * The parent gained a row → every twin gains a following copy, so adding a primer to the family
 * reaches every area. Skipped where the twin tombstoned that row (it said no once) or already
 * carries it.
 */
export function propagateRowAdd(
  conds: VariantCond[], parentId: string, parentRow: VariantRow, mintId: Mint,
  seen: Set<string> = new Set(),
): VariantCond[] {
  if (seen.has(parentId)) return conds;
  seen.add(parentId);
  let out = conds;
  for (const child of childrenOf(conds, parentId)) {
    if ((child.materials_dropped || []).includes(parentRow.id)) continue;
    if ((child.materials || []).some((r) => r.origin_id === parentRow.id)) continue;
    const row = copyRow(parentRow, mintId("mat"), parentRow.id);
    out = out.map((c) => (c.id !== child.id ? c : { ...c, materials: [...(c.materials || []), row] }));
    out = propagateRowAdd(out, child.id, row, mintId, seen);
  }
  return out;
}

/**
 * The parent lost a row → twins lose the copies still following it. A copy the twin had taken
 * over SURVIVES: once the estimator edits a row it is theirs, and the parent deleting its own row
 * is not a reason to throw away someone's local spec. The survivor is cut loose so nothing
 * dangles.
 */
export function propagateRowRemove(
  conds: VariantCond[], parentId: string, originId: string, seen: Set<string> = new Set(),
): VariantCond[] {
  if (seen.has(parentId)) return conds;
  seen.add(parentId);
  let out = conds;
  for (const child of childrenOf(conds, parentId)) {
    const row = (child.materials || []).find((r) => r.origin_id === originId);
    if (!row) continue;
    if (row.inherited) {
      out = out.map((c) => (c.id !== child.id ? c
        : { ...c, materials: (c.materials || []).filter((r) => r.id !== row.id) }));
      out = propagateRowRemove(out, child.id, row.id, seen);
    } else {
      out = out.map((c) => (c.id !== child.id ? c : {
        ...c,
        materials: (c.materials || []).map((r) => {
          if (r.id !== row.id) return r;
          const rest = { ...r };
          delete rest.origin_id;
          delete rest.inherited;
          return rest;
        }),
      }));
    }
  }
  return out;
}

/**
 * The parent's list was replaced wholesale (a template applied onto it, a play, a schedule
 * re-seed) rather than edited row by row, so the twins' origin_ids point at rows that no longer
 * exist. Re-base: rows whose origin is gone are dropped, rows the parent now has arrive, and
 * every LOCAL row survives untouched. Without this a wholesale replace would leave twins
 * silently inert — still labelled as following a family they can no longer hear.
 */
export function rebaseChildren(
  conds: VariantCond[], parentId: string, mintId: Mint, seen: Set<string> = new Set(),
): VariantCond[] {
  if (seen.has(parentId)) return conds;
  seen.add(parentId);
  const parent = conds.find((c) => c.id === parentId);
  if (!parent) return conds;
  const live = new Set((parent.materials || []).map((r) => r.id));
  let out = conds;
  for (const child of childrenOf(conds, parentId)) {
    const kept = (child.materials || []).filter((r) => !(r.inherited && r.origin_id && !live.has(r.origin_id)));
    const have = new Set(kept.map((r) => r.origin_id).filter(Boolean) as string[]);
    const droppedSet = new Set(child.materials_dropped || []);
    const added = (parent.materials || [])
      .filter((r) => !have.has(r.id) && !droppedSet.has(r.id))
      .map((r) => copyRow(r, mintId("mat"), r.id));
    out = out.map((c) => (c.id !== child.id ? c : { ...c, materials: [...kept, ...added] }));
    out = rebaseChildren(out, child.id, mintId, seen);
  }
  return out;
}

/** Edit on a TWIN's own row: it stops following the family from here on. */
export function markRowLocal(cond: VariantCond, id: string): VariantCond {
  return {
    ...cond,
    materials: (cond.materials || []).map((r) => (r.id === id ? { ...r, inherited: false } : r)),
  };
}

/**
 * Delete a row ON a twin. A following row leaves a tombstone (so the panel can show it, and so a
 * later family edit cannot bring it back); a local row just goes.
 */
export function dropRowLocal(cond: VariantCond, id: string): VariantCond {
  const row = (cond.materials || []).find((r) => r.id === id);
  const materials = (cond.materials || []).filter((r) => r.id !== id);
  if (!row?.inherited || !row.origin_id) return { ...cond, materials };
  const dropped = [...(cond.materials_dropped || [])];
  if (!dropped.includes(row.origin_id)) dropped.push(row.origin_id);
  return { ...cond, materials, materials_dropped: dropped };
}

/**
 * The per-row undo: this row goes back to following the family. Works from either state — an
 * overridden row is overwritten from the parent's current values, a tombstoned one is re-added.
 * Returns `conds` unchanged when there is nothing to follow.
 */
export function followFamily(
  conds: VariantCond[], condId: string, originId: string, mintId: Mint,
): VariantCond[] {
  const cond = conds.find((c) => c.id === condId);
  if (!cond?.variant_of) return conds;
  const parent = conds.find((c) => c.id === cond.variant_of);
  const src = (parent?.materials || []).find((r) => r.id === originId);
  if (!src) return conds;
  const dropped = (cond.materials_dropped || []).filter((k) => k !== originId);
  const existing = (cond.materials || []).find((r) => r.origin_id === originId);
  const materials = existing
    ? (cond.materials || []).map((r) => (r.id !== existing.id ? r : copyRow(src, r.id, originId)))
    : [...(cond.materials || []), copyRow(src, mintId("mat"), originId)];
  return conds.map((c) => {
    if (c.id !== condId) return c;
    const next: VariantCond = { ...c, materials };
    if (dropped.length) next.materials_dropped = dropped; else delete next.materials_dropped;
    return next;
  });
}

/**
 * Split out. Every following row freezes at its current values and the link is cut, so parent
 * edits stop arriving. The condition STAYS in the family: it still groups and subtotals with its
 * siblings — what ends is the inheritance, which is what "these two need different materials
 * now" actually means.
 */
export function splitFromFamily(conds: VariantCond[], condId: string): VariantCond[] {
  return conds.map((c) => {
    if (c.id !== condId) return c;
    const next: VariantCond = {
      ...c,
      materials: (c.materials || []).map((r) => {
        const rest = { ...r };
        delete rest.origin_id;
        delete rest.inherited;
        return rest;
      }),
    };
    delete next.variant_of;
    delete next.materials_dropped;
    return next;
  });
}

/**
 * A parent is being deleted → promote its eldest surviving twin instead of orphaning the rest.
 * The promoted twin owns its rows outright (they are already materialized — propagate-on-write
 * guaranteed that) and the remaining siblings re-point at it, with their origin_ids remapped
 * through the promoted twin's rows.
 *
 * `del` is the id set about to be removed. Returns the conditions with lineage repaired; the
 * caller still does the actual removal.
 */
export function promoteOnDelete(conds: VariantCond[], del: Set<string>): VariantCond[] {
  let out = conds;
  for (const dead of conds.filter((c) => del.has(c.id))) {
    const kids = out.filter((c) => c.variant_of === dead.id && !del.has(c.id));
    if (!kids.length) continue;
    const heir = kids[0];
    const remap = new Map<string, string>();
    for (const r of heir.materials || []) if (r.origin_id) remap.set(r.origin_id, r.id);
    out = out.map((c) => {
      if (c.id === heir.id) {
        const next: VariantCond = {
          ...c,
          materials: (c.materials || []).map((r) => {
            const rest = { ...r };
            delete rest.origin_id;
            delete rest.inherited;
            return rest;
          }),
        };
        delete next.variant_of;        // the heir is a root now
        delete next.materials_dropped; // its tombstones referenced the dead parent's ids
        return next;
      }
      if (c.variant_of !== dead.id) return c;
      const next: VariantCond = {
        ...c,
        variant_of: heir.id,
        materials: (c.materials || []).map((r) => (
          r.origin_id && remap.has(r.origin_id) ? { ...r, origin_id: remap.get(r.origin_id) } : r
        )),
      };
      if ((c.materials_dropped || []).length) {
        next.materials_dropped = (c.materials_dropped || []).map((k) => remap.get(k) || k);
      }
      return next;
    });
  }
  return out;
}

/**
 * Panel order: each root followed by its twins, depth-first, roots keeping the array's own order
 * (which is canonical — the 1-9 hotkeys are positional and the payload serializes it, so nothing
 * here ever reorders `conditions` itself). An orphan — a `variant_of` pointing at a condition
 * that isn't there — renders as a root rather than vanishing.
 */
export function familyView(conds: VariantCond[] = []): { cond: VariantCond; depth: number }[] {
  const byId = new Map(conds.map((c) => [c.id, c]));
  const kids = new Map<string, VariantCond[]>();
  for (const c of conds) {
    if (c.variant_of && byId.has(c.variant_of)) {
      const arr = kids.get(c.variant_of) || [];
      arr.push(c);
      kids.set(c.variant_of, arr);
    }
  }
  const out: { cond: VariantCond; depth: number }[] = [];
  const walk = (c: VariantCond, depth: number) => {
    out.push({ cond: c, depth });
    for (const k of kids.get(c.id) || []) walk(k, depth + 1);
  };
  for (const c of conds) if (!(c.variant_of && byId.has(c.variant_of))) walk(c, 0);
  return out;
}

/** Depth by condition id — the panel's indent, computed off the full list. */
export function familyDepths(conds: VariantCond[] = []): Map<string, number> {
  return new Map(familyView(conds).map((v) => [v.cond.id, v.depth]));
}
