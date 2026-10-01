// The finish reader's code test (sheetgraph.ts), in a leaf of its own so a
// light module (scheduleRoute.ts, which the canvas loads up front) can ask
// it without loading the sheet graph. sheetgraph.ts imports it from here and
// re-exports it; this is the one copy.

// A finish code: scheduleParse's pattern.
export const CODE_RE = /^[A-Z]{1,4}(-?[A-Z0-9]{1,4})?$/;
// A letters-only key of four or more letters is a word, not a finish code:
// a section heading or a material word set in the key column (FLOORING,
// BASE, TILE, PAINT). Known cost: a real four-letter code with no digit
// ("EPOX") is not read either.
export const finishCodeOk = (p: string): boolean => !/^[A-Z]{4,}$/.test(p) && CODE_RE.test(p);
