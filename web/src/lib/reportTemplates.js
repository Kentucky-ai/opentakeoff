// Saved report templates (issue #114) — named bundles of the report's
// column-visibility prefs + grouping mode, so a user can flip between saved
// layouts. Per-user, cross-project → localStorage (like identity.js and the
// report prefs in reportColumns.js); a template is { id, name, cols, groupBy }.
// Because groupBy is stored as its mode-id STRING ("", "sheet", "label", or a
// custom-column id), a template that captured "By label" just works once that
// mode exists, and a stale mode self-heals through the report's group-by
// normalizer — no coupling to this module.
const KEY = "opentakeoff_report_templates";

const uid = () => "tpl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const cleanName = (n) => (typeof n === "string" ? n.trim() : "");
const cleanCols = (c) => (c && typeof c === "object" && !Array.isArray(c) ? c : {});

// The hydrate gate, shared by loadTemplates and testable in isolation: non-array
// → []; items need a non-empty string id and a visible name; cols coerces to an
// object and groupBy to a string; DEDUPE BY NAME (first wins) — the name is the
// user-facing handle, so two same-name templates would be indistinguishable in
// the list and ambiguous for save-as-overwrite (which matches by name). The row
// React key is t.id, not the name, so this isn't about key collisions.
export function sanitizeTemplates(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (!(t && typeof t === "object" && !Array.isArray(t)) || typeof t.id !== "string" || !t.id) continue;
    const name = cleanName(t.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ id: t.id, name, cols: cleanCols(t.cols), groupBy: typeof t.groupBy === "string" ? t.groupBy : "" });
  }
  return out;
}

// try/catch (private mode / SSR / no localStorage) → [], mirroring loadColPrefs.
export function loadTemplates() {
  try {
    return sanitizeTemplates(JSON.parse(localStorage.getItem(KEY) || "[]"));
  } catch {
    return [];
  }
}

// Quota / private-mode swallowed — the list still returns so the UI stays live.
function persist(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota / private mode */ }
  return list;
}

// Save-as: a same-name template is OVERWRITTEN in place (keeps its id — apply
// links and the list row stay stable); a new name appends. Empty name is a
// no-op (can't create a nameless template). Returns the resulting list.
export function saveTemplate(name, cols, groupBy) {
  const nm = cleanName(name);
  if (!nm) return loadTemplates();
  const list = loadTemplates();
  const existing = list.find((t) => t.name === nm);
  const entry = { id: existing ? existing.id : uid(), name: nm, cols: cleanCols(cols), groupBy: typeof groupBy === "string" ? groupBy : "" };
  return persist(existing ? list.map((t) => (t.id === existing.id ? entry : t)) : [...list, entry]);
}

export function deleteTemplate(id) {
  return persist(loadTemplates().filter((t) => t.id !== id));
}

// Rename by id. NO-OP on a name collision with a DIFFERENT template — otherwise
// two same-name rows would persist and load-time dedupe (first wins) would
// silently drop the renamed one on the next reload (data loss). Renaming to the
// same name, or a free name, proceeds.
export function renameTemplate(id, name) {
  const nm = cleanName(name);
  const list = loadTemplates();
  if (!nm || list.some((t) => t.id !== id && t.name === nm)) return list;   // empty or taken by another → no-op
  return persist(list.map((t) => (t.id === id ? { ...t, name: nm } : t)));
}

// Replace the whole set (Drive Load writes the merged result back through here).
// Sanitizes first — the input may be a hand-merged or Drive-sourced array — so
// the same dedupe/coerce invariants hold as any other write. Returns the stored
// list so the caller can drop it straight into React state.
export function overwriteTemplates(list) {
  return persist(sanitizeTemplates(list));
}

// Merge a Drive template set INTO the local one, name-keyed, LOCAL WINS — the
// device you're on is authoritative, so Load never silently overwrites or
// deletes a layout you just edited here (the MVP is "pull in what's missing,"
// not two-way sync). Both sides sanitize. Remote-only templates append after the
// local ones (local order preserved). A remote id that collides with a local one
// (e.g. a template pushed, then renamed only here) is regenerated so the merged
// list keeps unique ids — t.id is the React key and the apply handle.
export function mergeTemplates(local, remote) {
  const L = sanitizeTemplates(local);
  const names = new Set(L.map((t) => t.name));
  const ids = new Set(L.map((t) => t.id));
  const add = [];
  for (const t of sanitizeTemplates(remote)) {
    if (names.has(t.name)) continue;                 // name clash → local wins, drop remote
    names.add(t.name);
    let id = t.id;
    while (ids.has(id)) id = uid();                  // avoid a duplicate React key / apply handle
    ids.add(id);
    add.push(id === t.id ? t : { ...t, id });
  }
  return [...L, ...add];
}
