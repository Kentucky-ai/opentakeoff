// CSV cell escaping — the one implementation behind totals.js and
// shapesExport.js (leaf module: imports nothing).
//
// Formula-injection guard (#10): STRING cells starting `=` `+` `-` `@` or a
// tab get a leading `'` so spreadsheet apps render them as text instead of
// executing them. The typeof check runs BEFORE the String() coercion so
// numbers pass through untouched — a -12.5 deduct cell must stay -12.5, not
// become '-12.5. The prefix is applied BEFORE the quote test, so a
// formula-shaped cell that also contains a comma/quote gets the prefixed
// text quoted as a whole.
/** @param {any} v @param {string | number} [delimiter] */
export const csvEsc = (v, delimiter = ",") => {
  // Existing callers pass csvEsc directly to Array.map (its second arg is an index).
  const separator = typeof delimiter === "string" ? delimiter : ",";
  const s = typeof v === "string"
    ? (/^[=+\-@\t]/.test(v) ? `'${v}` : v)
    : String(v ?? "");
  return s.includes(separator) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
