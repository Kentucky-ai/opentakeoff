// pdf.js-free sheet-grouping helpers, split out (like sheetKey.ts) so hydrate's
// group normalization is unit-testable without loading pdfjs-dist.

// Normalize a loaded annotations payload's sheet grouping into { sheetGroup,
// lastGroup } for hydrate(). CRUCIAL invariant: when loading INTO group mode
// (>= 2 sheets), the two share the SAME array instance. The canvas effect that
// keeps lastGroup synced to sheetGroup — `if (sheetGroup.length >= 2)
// setLastGroup(sheetGroup)` — then bails on a reference-equal setState instead of
// dirtying lastGroup in a FOLLOW-UP commit. That follow-up commit would escape the
// one-shot autosave suppression (savesArmed at mount / suppressNextSave on a sync
// reconcile) and spuriously re-save the just-loaded content — harmless churn on the
// legacy path, but rev churn + a flipped seed `touched` (and peer loser-snapshot
// spam) on the local-first sync path. When loading into single-sheet mode we keep
// the distinct remembered group so Regroup can restore it. Content matches the old
// inline hydrate logic exactly; only the instance sharing (and its no-op) is new.
// `soloOk` (#161): a composite surface (a stitch) is a legitimate group of
// ONE — its key alone in sheet_group must survive the >= 2 gate, ref-shared
// with lastGroup exactly like a real group so the sync effect still no-ops.
export function normalizeLoadedGroups(
  a: { sheet_group?: unknown; last_group?: unknown },
  maxGroup: number,
  soloOk?: (key: string) => boolean,
): { sheetGroup: string[]; lastGroup: string[] } {
  const grp = Array.isArray(a.sheet_group) ? (a.sheet_group as string[]).slice(0, maxGroup) : [];
  const lg = Array.isArray(a.last_group) ? (a.last_group as string[]).slice(0, maxGroup) : grp;
  const grouped = (g: string[]) => g.length >= 2 || (g.length === 1 && !!soloOk?.(g[0]));
  // grouped → reuse `grp` (same ref as sheetGroup); single-sheet → the remembered group (or none)
  const lastGroup = grouped(grp) ? grp : (grouped(lg) ? lg : []);
  return { sheetGroup: grp, lastGroup };
}
