// noteFields — live quantities inside a note's text (#474).
//
// An estimator writes "Provide and install x{{qty}} emergency light fixtures"
// on a note linked to the Emergency Light condition, and the note reads
// "x5 EA" — then "x6 EA" the moment a sixth fixture is counted. The number a
// note quotes can no longer drift from the takeoff it describes.
//
// Rules:
//   - The STORED text keeps the template. Fields resolve at display time only
//     (canvas, Marked Set, report, MCP), so nothing is ever stale on disk and
//     editing a note shows the field, not a frozen number.
//   - {{qty}} resolves against the note's LINKED condition (markup.condition_id),
//     never by name — renaming the condition can't break the note.
//   - The quantity is the MEASURED one: multiplier applied, no waste — the
//     same number the panel chip and the live counter show (liveCounter.js).
//     Every nonzero unit is listed, SF → LF → EA, so a tile floor with a border
//     reads "1,200 SF · 84.25 LF".
//   - A field that can't resolve (no linked condition, a condition with nothing
//     measured yet, or an unknown name) stays LITERAL and is reported, so the
//     renderer can tint it. Never blank, never 0 — a broken note has to be
//     obvious on the printed set.
import { fmtQty } from "./liveCounter.js";
import { areaVal, areaUnit, lenVal, lenUnit, type UnitSystem } from "./units";

/** `{{ name }}` — braces with no braces inside; whitespace around the name is ignored. */
const FIELD_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The ink a note with an unresolved field is drawn in (light / dark canvas) — the --c-danger token. */
export const FIELD_WARN_INK = "#b03a26";
export const FIELD_WARN_INK_DARK = "#ff6b57";

export interface QtyRow {
  id: string;
  shape_count?: number;
  total_sf?: number;
  lf?: number;
  ea?: number;
}

export function hasFields(text: unknown): boolean {
  return typeof text === "string" && text.includes("{{") && new RegExp(FIELD_RE.source).test(text);
}

/** conditionTotals() rows → condition id → "5 EA" / "1,200 SF · 84.25 LF". Conditions with nothing measured are absent. */
export function qtyLabels(totals: QtyRow[], units: UnitSystem = "imperial"): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of totals || []) {
    if (!t || !t.shape_count) continue;
    const parts: string[] = [];
    if (t.total_sf) parts.push(`${fmtQty(areaVal(t.total_sf, units))} ${areaUnit(units)}`);
    if (t.lf) parts.push(`${fmtQty(lenVal(t.lf, units))} ${lenUnit(units)}`);
    if (t.ea) parts.push(`${fmtQty(t.ea)} EA`);
    if (parts.length) out.set(t.id, parts.join(" · "));
  }
  return out;
}

export interface Resolved {
  text: string;
  /** the literal fields left in place, e.g. ["{{qty}}"] — empty when everything resolved */
  unresolved: string[];
}

/** Resolve every field in `text` for a note linked to `conditionId`. */
export function resolveNote(text: unknown, conditionId: unknown, labels: Map<string, string>): Resolved {
  const s = typeof text === "string" ? text : "";
  if (!hasFields(s)) return { text: s, unresolved: [] };
  const unresolved: string[] = [];
  const label = typeof conditionId === "string" && conditionId ? labels.get(conditionId) : undefined;
  const out = s.replace(new RegExp(FIELD_RE.source, "g"), (whole: string, name: string) => {
    if (name.toLowerCase() === "qty" && label) return label;
    unresolved.push(whole);
    return whole;
  });
  return { text: out, unresolved };
}

/** A markup with its text resolved — the SAME object back when it carries no fields, so memoized consumers don't churn.
 *  A copy that still carries an unresolved field is flagged `field_warn` for renderers that only see the markup
 *  (annotationScene). The flag lives on the display copy only; it is never stored. */
export function resolveMarkup<M extends { text?: unknown; condition_id?: unknown }>(m: M, labels: Map<string, string>): { m: M; unresolved: string[] } {
  if (!m || !hasFields(m.text)) return { m, unresolved: [] };
  const r = resolveNote(m.text, m.condition_id, labels);
  return { m: r.unresolved.length ? { ...m, text: r.text, field_warn: true } : { ...m, text: r.text }, unresolved: r.unresolved };
}
