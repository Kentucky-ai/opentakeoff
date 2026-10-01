// Import from schedule — the entry point existing importers (and the
// Token-shaped callers) already use. The reader lives in scheduleRead.ts (the
// sheet graph's finish reader behind a marquee); the row contract and the
// row → condition seed step live in the light scheduleRows.ts. This module
// re-exports both, so importing it loads the sheet graph: the canvas imports
// scheduleRows.ts statically and scheduleRead.ts on demand instead.
export { parseSchedule } from "./scheduleRead.ts";
export { rowToSeed } from "./scheduleRows.ts";
export type { Category, CategorySource, ConditionSeed, ScheduleRow, Token } from "./scheduleRows.ts";
