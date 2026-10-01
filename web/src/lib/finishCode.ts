// The finish reader's code test (sheetgraph.ts), in a leaf of its own so a
// light module (scheduleRoute.ts, which the canvas loads up front) can ask
// it without loading the sheet graph. sheetgraph.ts imports it from here and
// re-exports it; this is the one copy.

// A finish code: scheduleParse's pattern. A schedule ROW key is looser than a
// plan bubble (detectRooms' 2–3 digits): real room-finish schedules carry
// "3", "3A", "139A" — one to three digits plus up to two letters. A
// building-QUALIFIED key ("A-134") is accepted only for a designator the set
// names (opts.buildings) — otherwise a stray finish code ("P-2") banding to
// the key column would mint a phantom building.
export const CODE_RE = /^[A-Z]{1,4}(-?[A-Z0-9]{1,4})?$/;
// A letters-only key of four or more letters is a word, not a finish code:
// a section heading or a material word set in the key column (FLOORING,
// BASE, TILE, PAINT). Known cost: a real four-letter code with no digit
// ("EPOX") is not read either.
export const finishCodeOk = (p: string): boolean => !/^[A-Z]{4,}$/.test(p) && CODE_RE.test(p);
