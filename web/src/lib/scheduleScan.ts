// Scan/OCR half of "Import from schedule". PURE and DOM-free on purpose (the
// sheets.ts / oneclick.ts precedent): the canvas rasterizes the marqueed region
// and POSTs it to the optional AI sandbox (POST /ai/parse-schedule); this module
// turns whatever loosely-typed JSON the server/adapter returns into the SAME
// ScheduleRow[] the vector path produces, so both feed the one approval dialog.
//
// The server is bring-your-own-model and may return partial/garbage rows, so
// every field is coerced and validated here — a malformed row is dropped, never
// crashes the dialog. Kept out of the canvas so this coercion is node-testable.

import type { ScheduleRow, Category } from "./scheduleParse.js";

// The one AI endpoint this path calls. Dev proxies /ai/* → localhost:8000
// (see web/vite.config.js); in prod it's dormant unless a backend is wired up.
export const SCAN_ENDPOINT = "/ai/parse-schedule";

// Mirror of scheduleParse's category vocabulary + which categories the dialog
// pre-checks. Duplicated (not imported) so the parser's internals stay private;
// the ScheduleRow *type* is the shared contract, this is just its value domain.
const CATEGORIES: readonly Category[] = ["floor", "base", "wall", "transition", "ceiling", "other"];
const SUGGESTED: Record<Category, boolean> = {
  floor: true, base: true, wall: true, transition: true, ceiling: false, other: false,
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function toCategory(v: unknown): Category {
  const c = str(v).toLowerCase();
  return (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : "other";
}

// Coerce one loosely-typed server object into a ScheduleRow, or null if it has
// no finish tag (an untagged row can't become a condition — drop it).
function toRow(raw: unknown): ScheduleRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const finish_tag = str(o.finish_tag).toUpperCase();
  if (!finish_tag) return null;
  const category = toCategory(o.category);
  return {
    finish_tag,
    section: str(o.section).toUpperCase(),
    category,
    description: str(o.description),
    manufacturer: str(o.manufacturer),
    style: str(o.style),
    spec_color: str(o.spec_color),
    size: str(o.size),
    // trust the server's checkbox intent only if it sent a real boolean;
    // otherwise fall back to the category default (ceiling/other start off).
    suggested: typeof o.suggested === "boolean" ? o.suggested : SUGGESTED[category],
  };
}

/**
 * Normalize a /ai/parse-schedule response ({ rows: [...] }, or a bare array)
 * into validated ScheduleRow[]. Unknown/malformed shapes → [] so the caller
 * shows "no schedule found" rather than inventing rows. De-dupes by finish_tag
 * (first wins) since the dialog keys on it.
 */
export function normalizeScanRows(payload: unknown): ScheduleRow[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { rows?: unknown }).rows)
      ? (payload as { rows: unknown[] }).rows
      : [];
  const out: ScheduleRow[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const row = toRow(item);
    if (!row || seen.has(row.finish_tag)) continue;
    seen.add(row.finish_tag);
    out.push(row);
  }
  return out;
}
