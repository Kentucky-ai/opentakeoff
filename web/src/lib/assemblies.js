// Assemblies — a condition's recipe of items, saved once and applied anywhere.
//
// An assembly item IS a supporting-material row (lib/totals.js), so a condition
// that carries one needs nothing new to be measured, reported or priced:
//   { name, unit, per, basis, rule?, waste_pct?, round, note, kind?, grout? }
//   rule "coverage" (default): 1 unit per `per` basis units — 1 gal per 150 SF
//   rule "each":               `per` units per 1 basis unit — 2 per EA (per piece)
//   waste_pct:                 the item's own allowance, before the round-up
// and on the condition, per project, its optional prices:
//   price ($ material per unit) and labor_price ($ labor per unit).
//
// The library is per-user and cross-project, like Company setup
// (lib/companySetup.js): it lives in localStorage and travels in the
// .otprofile (lib/profile.js). It holds RECIPES ONLY — a saved assembly never
// carries a price (prices belong to the project they were entered on, the
// template rule in lib/canvasUtil.js), never a library link (lib_id) and never
// a twin's family bookkeeping. Nothing ships in it: an empty library is the
// default and the estimator builds every assembly.

import { instantiateMaterial } from "./materials.js";
import { isMaterialLine, MATERIAL_RULES } from "./totals.js";

const KEY = "opentakeoff_assembly_library";
export const ASSEMBLY_EVENT = "opentakeoff:assemblies";
export const NAME_LIMIT = 120;
const BASES = ["area", "linear", "count", "seam_lf"];
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const nonNeg = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };

/**
 * A condition material row → an assembly item: the recipe fields only, each
 * valid or defaulted. Prices, ids, library links and family state are dropped.
 * @param {any} m
 * @returns {object|null} null for a row with no name (not a material line)
 */
export function assemblyItem(m) {
  if (!isPlainObject(m) || !isMaterialLine(m)) return null;
  const name = String(m.name).slice(0, NAME_LIMIT);
  if (!name.trim()) return null;
  const out = {
    name,
    unit: typeof m.unit === "string" ? m.unit.slice(0, 24) : "",
    per: nonNeg(m.per),
    basis: BASES.includes(m.basis) ? m.basis : "area",
    round: m.round !== false,
    note: typeof m.note === "string" ? m.note.slice(0, 400) : "",
  };
  if (MATERIAL_RULES.includes(m.rule) && m.rule !== "coverage") out.rule = m.rule;
  const w = nonNeg(m.waste_pct);
  if (w > 0) out.waste_pct = w;
  if (typeof m.kind === "string" && m.kind) out.kind = m.kind;
  if (isPlainObject(m.grout)) out.grout = { ...m.grout };
  return out;
}

/**
 * The library's load gate: every entry has a non-empty string id (unique,
 * first wins), a visible name and at least one valid item.
 * @param {any} raw
 * @returns {Array<{id: string, name: string, items: object[]}>}
 */
export function sanitizeAssemblies(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const a of raw) {
    if (!isPlainObject(a) || typeof a.id !== "string" || !a.id || seen.has(a.id)) continue;
    const name = typeof a.name === "string" ? a.name.trim().slice(0, NAME_LIMIT) : "";
    const items = (Array.isArray(a.items) ? a.items : []).map(assemblyItem).filter(Boolean);
    if (!name || !items.length) continue;
    seen.add(a.id);
    out.push({ id: a.id, name, items });
  }
  return out;
}

/**
 * Save a condition's items as a named assembly. Returns null when the
 * condition has no named material rows (nothing to save).
 * @param {any} cond
 * @param {string} name
 * @param {string} id
 */
export function conditionToAssembly(cond, name, id) {
  const items = (cond?.materials || []).map(assemblyItem).filter(Boolean);
  const n = String(name || "").trim().slice(0, NAME_LIMIT);
  if (!items.length || !n || !id) return null;
  return { id, name: n, items };
}

/**
 * An assembly → fresh condition material rows (new ids, round defaulted, the
 * grout geometry deep-copied by instantiateMaterial). Items whose name the
 * condition already carries (case-insensitive) are skipped, so applying an
 * assembly twice, or onto a condition that already has its adhesive, never
 * doubles a buy-list line.
 * @param {{items: object[]}} assembly
 * @param {(prefix: string) => string} mintId
 * @param {any[]} [existing] the target condition's current material rows
 * @returns {{rows: object[], skipped: string[]}}
 */
export function assemblyRows(assembly, mintId, existing = []) {
  const have = new Set((existing || []).filter(isMaterialLine).map((m) => String(m.name).trim().toLowerCase()));
  const rows = [], skipped = [];
  for (const it of (assembly?.items || []).map(assemblyItem).filter(Boolean)) {
    const k = it.name.trim().toLowerCase();
    if (have.has(k)) { skipped.push(it.name); continue; }
    have.add(k);
    rows.push(instantiateMaterial(it, mintId("mat")));
  }
  return { rows, skipped };
}

export function loadAssemblies() {
  try {
    return sanitizeAssemblies(JSON.parse(localStorage.getItem(KEY) || "[]"));
  } catch {
    return []; // private mode / SSR / corrupt JSON
  }
}

// Returns true/false so the UI can report a failed save (quota / private mode).
// Tells any open panel to re-read (the same tab; other tabs get "storage").
export function saveAssemblies(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitizeAssemblies(list)));
  } catch {
    return false;
  }
  try { globalThis.dispatchEvent?.(new Event(ASSEMBLY_EVENT)); } catch { /* no window (node) */ }
  return true;
}

export const ASSEMBLY_STORAGE_KEY = KEY;
