// PDF layer (Optional Content Group) semantics — issue #85. Pure and
// table-driven: raw CAD layer names → the role their linework plays in a
// takeoff, so buildMask can consume what the file STATES instead of guessing
// with pitch heuristics. No pdf.js, no DOM — the extraction side hands this
// module names; it hands back roles.
//
// Doctrine: refusal over guessing. Only a POSITIVE identification earns a
// role; anything unrecognized is `unknown` and flows through today's
// heuristic path untouched — a wrong `unknown` costs nothing, a wrong
// `boundary` seals a corridor and a wrong `annotation` erases a wall. The
// tables grow by fixture, not by speculation.

export type LayerRole = "boundary" | "finish-pattern" | "annotation" | "structure" | "demolition" | "unknown";

/** Per-segment role codes (buildMask consumes these; layers stay strings
 * everywhere else). HIDDEN is visibility, not semantics — a layer OFF in the
 * default config is excluded whatever its name says (or we trace demolition). */
export const ROLE_CODE: Record<LayerRole, number> = {
  unknown: 0, boundary: 1, "finish-pattern": 2, annotation: 3, structure: 4, demolition: 5,
};
export const ROLE_HIDDEN = 6;

/** One sheet-level layer row — what sheet_info reports and the mask consumes. */
export interface LayerInfo {
  id: string;          // pdf.js OCG id (objId) — stable within the document
  name: string;        // the raw layer name, verbatim
  role: LayerRole;
  confidence: number;  // 0..1 — how sure the classifier is of the role
  visible: boolean;    // default-config visibility (hidden ⇒ excluded outright)
  seg_count: number;   // segments attributed to this layer on the sheet
}

// Token tables. AIA CAD Layer Guidelines core plus the field variants that
// survive export: xref-bind prefixes, separator drift, truncation. Every
// entry is a WHOLE token match after normalization — substring matches are
// how "COLOR" becomes a column.
const DEMOLITION = new Set(["DEMO", "DEMOL", "DEMOLITION", "REMV", "REMOVE"]);
const PATTERN = new Set(["PATT", "PATTERN", "PATTERNS", "HATCH", "HATCHING", "POCHE"]);
// High-confidence annotation: ink that describes the drawing, not the building.
const ANNOTATION = new Set([
  "ANNO", "TEXT", "DIM", "DIMS", "NOTE", "NOTES", "SYMB", "SYMBOL", "IDEN", "TAG", "TAGS",
  "TTLB", "TITLEBLOCK", "LEGN", "LEGEND", "SHBD", "NPLT", "PLOT", "GRID", "GRIDS", "LEVL", "REVS", "REV",
]);
// Objects that live INSIDE rooms — real geometry, but never a room boundary;
// excluding them cleans interiors (lower confidence: field naming is looser).
const FIXTURES = new Set(["FURN", "FURNITURE", "EQPM", "EQUIP", "EQUIPMENT", "CASE", "CASW", "CASEWORK", "MILL", "MILLWORK", "PLMB", "PFIX", "APPL", "SPCL", "SEAT", "SEATING"]);
const STRUCTURE = new Set(["COLS", "COL", "COLUMN", "COLUMNS", "BEAM", "BEAMS", "BRACE", "FNDN", "FOUNDATION", "JOIS", "JOIST", "SLAB"]);
// What bounds a room: walls full and partial height, partitions, glazing and
// storefront, floor/room outlines, doors and windows (their linework seals
// the openings walls leave).
const BOUNDARY = new Set([
  "WALL", "WALLS", "PRHT", "FULL", "PART", "PARTN", "PARTITION", "PARTITIONS",
  "GLAZ", "GLAZING", "STOR", "STOREFRONT", "CWMG",
  "OTLN", "OUTLINE", "OUTLINES", "RM", "ROOM", "ROOMS", "AREA", "AREAS",
  "DOOR", "DOORS", "DR", "WNDW", "WIND", "WINDOW", "WINDOWS",
]);
// AIA discipline designators — the leading token of a conforming name. Used
// only to grade confidence (a match inside "A-WALL-FULL" is surer than a bare
// "WALL") and to catch S-* structural wholesale.
const DISCIPLINES = new Set(["A", "S", "M", "E", "P", "F", "C", "L", "T", "I", "Q", "G", "H", "V", "W", "X", "Z"]);

/** Normalize a raw layer name to comparable tokens: strip the xref path
 * (everything before the LAST `|`), fold CAD xref bind separators (`$n$`),
 * uppercase, split on every non-alphanumeric run. */
export function layerNameTokens(raw: string): string[] {
  const base = String(raw || "").split("|").pop() || "";
  return base.replace(/\$\d+\$/g, "-").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

/** Raw layer name → { role, confidence }. Pure, total, never throws. */
export function classifyLayerName(raw: string): { role: LayerRole; confidence: number } {
  const s = String(raw || "").trim();
  // the degenerate cases: everything on layer 0 / "Layer 1" / unnamed — the
  // exporter flattened or the drafter never layered; nothing is stated
  if (!s || /^0$/.test(s) || /^layer\s*\d*$/i.test(s)) return { role: "unknown", confidence: 0 };
  const toks = layerNameTokens(s);
  if (!toks.length) return { role: "unknown", confidence: 0 };
  const conforming = DISCIPLINES.has(toks[0]) && toks.length > 1;
  const grade = (base: number) => (conforming ? base : Math.max(0.5, base - 0.2));
  const has = (table: Set<string>) => toks.some((t) => table.has(t));
  // Order matters: demolition beats boundary ("A-WALL-DEMO" is demolition —
  // traced as a wall it produces a confident wrong number), pattern beats
  // boundary ("A-FLOR-PATT" under a floor outline family is still pattern).
  if (has(DEMOLITION)) return { role: "demolition", confidence: grade(0.95) };
  if (has(PATTERN)) return { role: "finish-pattern", confidence: grade(0.9) };
  if (has(ANNOTATION)) return { role: "annotation", confidence: grade(0.85) };
  if (toks[0] === "S" && toks.length > 1) return { role: "structure", confidence: 0.85 };
  if (has(STRUCTURE)) return { role: "structure", confidence: grade(0.8) };
  if (has(BOUNDARY)) return { role: "boundary", confidence: grade(0.9) };
  if (has(FIXTURES)) return { role: "annotation", confidence: grade(0.65) };
  return { role: "unknown", confidence: 0.2 };
}

/** Build the per-layer role-code table (aligned to layerIds order) from the
 * classified infos. Hidden wins over any role. */
export function layerRoleCodes(layerIds: string[], infoById: Map<string, { role: LayerRole; visible: boolean }>): Uint8Array {
  const codes = new Uint8Array(layerIds.length);
  layerIds.forEach((id, k) => {
    const info = infoById.get(id);
    if (!info) return; // unknown layer: code 0 — heuristics decide
    codes[k] = info.visible === false ? ROLE_HIDDEN : ROLE_CODE[info.role];
  });
  return codes;
}

/** Per-SEGMENT role codes for buildMask: layerOf[si] → the layer's code;
 * segments outside any layer (−1) stay 0 (unknown → heuristic path). */
export function segRoles(layerOf: Int32Array | number[] | undefined, codes: Uint8Array): Uint8Array | null {
  if (!layerOf || !codes.length) return null;
  const n = layerOf.length;
  const out = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const li = layerOf[i];
    if (li >= 0 && li < codes.length && codes[li]) { out[i] = codes[li]; any = true; }
  }
  return any ? out : null;   // an all-unknown sheet short-circuits to the heuristic path
}

/** One document-declared OCG as pdf.js reports it —
 * `getOptionalContentConfig().getGroups()[id]` (name + default-config
 * visibility; everything else on the group is render plumbing). */
export interface OcgGroup { name?: string | null; visible?: boolean }

/** The classified per-sheet layer table: the extraction's id list + per-segment
 * attribution, joined to the document's OCG declarations. This is the ONE
 * derivation both consumers run — the MCP session for `sheet_info.layers`, the
 * canvas for its Layers panel — extracted pure so their tables can never
 * drift. Ids the document doesn't declare (a dangling /OC ref) keep an empty
 * name → `unknown` role, visible: the refusal default. */
export function buildLayerInfos(layerIds: string[], layerOf: Int32Array | number[] | undefined, byId: Map<string, OcgGroup>): LayerInfo[] {
  if (!layerIds.length) return [];
  const counts = new Map<number, number>();
  if (layerOf) for (let i = 0; i < layerOf.length; i++) { const li = layerOf[i]; if (li >= 0) counts.set(li, (counts.get(li) || 0) + 1); }
  return layerIds.map((id, k) => {
    const g = byId.get(id);
    const name = String(g?.name ?? "");
    const { role, confidence } = classifyLayerName(name);
    return { id, name, role, confidence, visible: g ? g.visible !== false : true, seg_count: counts.get(k) || 0 };
  });
}

/** A per-layer estimator/agent override: `include` forces hard boundary,
 * `exclude` drops the layer's ink outright — the SAME semantics the MCP
 * `layers {include, exclude}` filters apply (mcp/src/session.ts rolesFor), so
 * a panel toggle and an agent argument can never mean different things. */
export type LayerOverride = "include" | "exclude";

/** The effective (role, visibility) table for layerRoleCodes: the classified
 * infos with a sheet's overrides applied on top. Overrides for ids not in the
 * table are ignored — a persisted override can outlive its layer (the sheet
 * was re-exported) and must degrade to a no-op, never a throw. */
export function effectiveLayerRoles(infos: LayerInfo[], overrides?: Record<string, LayerOverride> | null): Map<string, { role: LayerRole; visible: boolean }> {
  const m = new Map<string, { role: LayerRole; visible: boolean }>(infos.map((l) => [l.id, { role: l.role, visible: l.visible }]));
  for (const [id, ov] of Object.entries(overrides || {})) {
    const l = m.get(id);
    if (!l) continue;
    if (ov === "include") m.set(id, { role: "boundary", visible: true });
    else if (ov === "exclude") m.set(id, { role: l.role, visible: false });
  }
  return m;
}

/** hydrate() sanitizer for the additive `layer_overrides` payload key
 * (sheetKey → ocgId → override). Object-shape gate + value whitelist,
 * mirroring sanitizeSheetLevels: an ELSE-CLEAR — a payload without the key
 * (every pre-#85 save) sanitizes to {}, never a no-op, so a snapshot load
 * can't inherit the replaced project's overrides. */
export function sanitizeLayerOverrides(raw: unknown): Record<string, Record<string, LayerOverride>> {
  const out: Record<string, Record<string, LayerOverride>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [sheet, ov] of Object.entries(raw as Record<string, unknown>)) {
    if (!ov || typeof ov !== "object" || Array.isArray(ov)) continue;
    const clean: Record<string, LayerOverride> = {};
    for (const [id, v] of Object.entries(ov as Record<string, unknown>)) {
      if (v === "include" || v === "exclude") clean[id] = v;
    }
    if (Object.keys(clean).length) out[sheet] = clean;
  }
  return out;
}
