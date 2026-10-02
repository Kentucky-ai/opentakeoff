// A schedule row the schedule itself marks NOT USED or N.I.C. (not in
// contract). Light on purpose: the reader (sheetgraph.ts, scheduleRead.ts)
// and the Import from schedule dialog both import it, and the dialog must not
// load the sheet graph.

/** What a NOT USED marker normalizes to. */
export type NotUsedForm = "NOT USED" | "NOT IN CONTRACT" | "NIC";
/** Why a row starts unticked: the schedule marks it not used, or not in contract. */
export type NotUsedKind = "not-used" | "not-in-contract";

/** The tail of a key cell after its code (or a whole cell), normalized:
 * uppercase; leading `-–—:,` and spaces stripped; a trailing period stripped;
 * enclosing parentheses stripped only when the text starts with "(" and that
 * parenthesis closes at the very end ("(NOT USED)" → "NOT USED", but
 * "(CUT) (C)" is left alone); a trailing period stripped again; N.I.C. in any
 * spacing → NIC; runs of spaces collapsed. */
export function normalizeTail(text: string): string {
  let t = text.toUpperCase().trim().replace(/^[-–—:,\s]+/, "");
  t = t.replace(/\.$/, "");
  if (t.startsWith("(") && closingParen(t) === t.length - 1) t = t.slice(1, -1);
  t = t.replace(/\.$/, "");
  t = t.replace(/\bN\.?\s*I\.?\s*C\b\.?/g, "NIC");
  return t.replace(/\s+/g, " ").trim();
}

/** The index of the parenthesis that closes the one at index 0, or -1. */
function closingParen(t: string): number {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** "NOT USED", "NOT IN CONTRACT" or "NIC" when the whole text says so in one
 * of the printed forms (NOT USED, (NOT USED), NOT USED., - NOT USED, N.I.C.,
 * (N.I.C.), N. I. C. …), else null. Prose and longer text: null. */
export function normalizeNotUsed(text: string): NotUsedForm | null {
  const t = normalizeTail(text);
  return t === "NOT USED" || t === "NOT IN CONTRACT" || t === "NIC" ? t : null;
}

/** NOT USED → "not-used"; NOT IN CONTRACT / N.I.C. → "not-in-contract"; else null. */
export function notUsedKind(text: string): NotUsedKind | null {
  const f = normalizeNotUsed(text);
  return f == null ? null : f === "NOT USED" ? "not-used" : "not-in-contract";
}

/** The note a NOT USED row's label carries (leading space; the dialog
 * appends it to the visible text for screen readers). An unpicked row that
 * can be picked also says it can be selected anyway. */
export function notUsedNote(kind: NotUsedKind, s: { pickable: boolean; picked: boolean }): string {
  const base = kind === "not-used" ? " The schedule marks this row not used." : " The schedule marks this row N.I.C. (not in contract).";
  return s.pickable && !s.picked ? `${base} Select it to create a condition anyway.` : base;
}
