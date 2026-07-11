// Sheet levels — the multi-floor gallery-grouping feature. Pure helpers only
// (mirrors zone.js): the hydrate() payload sanitizer and the gallery's
// group-and-sort logic, extracted so both are unit-testable independent of
// the TakeoffCanvas reducer and the SheetGallery component.

// hydrate() sanitizer for the additive `sheet_levels` payload key: an
// object-shape gate (a corrupted/legacy payload must not put an array or
// primitive where the gallery indexes by sheet key) plus a string/non-empty
// value filter — mirrors the client_info string-fields gate elsewhere in
// hydrate(). This is an ELSE-CLEAR: a snapshot load without a sheet_levels
// key (old payloads lack it) must not inherit the replaced project's levels,
// so a non-object input sanitizes to {}, not a no-op.
export function sanitizeSheetLevels(raw) {
  return Object.fromEntries(
    Object.entries(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {})
      .filter(([, v]) => typeof v === "string" && v.trim())
  );
}

// Natural (numeric-aware) string compare — "L2" sorts before "L10".
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

// Gallery grouping: sheets group by their assigned level (natural sort on
// the level name), with unassigned sheets in their own trailing group.
// Orphan level values (a level assigned to a sheet key no longer in
// allKeys) never surface: levelNames and every group derive from allKeys,
// never from levels' own key set. Empty groups are dropped. With no levels
// assigned anywhere this returns a single { level: null, keys: allKeys } —
// callers can tell "no levels exist yet" apart from "every sheet, individually,
// is Unassigned" (level: "").
export function groupSheetsByLevel(allKeys, levels) {
  const levelNames = [...new Set(allKeys.map((k) => levels[k]).filter(Boolean))].sort(naturalCompare);
  if (!levelNames.length) return [{ level: null, keys: allKeys }];
  return [
    ...levelNames.map((lv) => ({ level: lv, keys: allKeys.filter((k) => levels[k] === lv) })),
    { level: "", keys: allKeys.filter((k) => !levels[k]) },
  ].filter((g) => g.keys.length);
}

// Within-group title-block sort — applied ONLY to a group that itself
// carries a level (g.level truthy). The Unassigned group (g.level === "")
// and the no-levels-yet group (g.level === null) both keep the incoming
// (file/page) order regardless of whether some OTHER group has a level.
//
// This is the fix for a real churn bug: gating the sort on "do ANY levels
// exist in the whole gallery" (rather than per group) meant the moment a
// single sheet got a level, the ENTIRE gallery — including the often-large
// Unassigned group — switched from stable file/page order to label-compare
// sort. Title-block labels arrive asynchronously as thumbnails render, so
// Unassigned cards would visibly jump around as labels streamed in — the
// exact reshuffling a per-gallery gate was supposed to prevent; it only
// covered the zero-levels case, not the mixed case that matters in practice
// (a project gets its levels assigned one sheet at a time).
export function sortGalleryGroups(groups, labelOf) {
  return groups.map((g) => (
    g.level ? { ...g, keys: [...g.keys].sort((a, b) => naturalCompare(labelOf(a), labelOf(b))) } : g
  ));
}
