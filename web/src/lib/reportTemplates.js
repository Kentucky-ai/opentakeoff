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
// object and groupBy to a string; DEDUPE BY NAME (first wins) — the name keys the
// list UI, so duplicates would collide React keys and confuse "save-as overwrite".
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

// Rename by id. A collision with another template's name is left to load-time
// dedupe (first wins) — the UI should guard against it, but data can't corrupt.
export function renameTemplate(id, name) {
  const nm = cleanName(name);
  if (!nm) return loadTemplates();
  return persist(loadTemplates().map((t) => (t.id === id ? { ...t, name: nm } : t)));
}
