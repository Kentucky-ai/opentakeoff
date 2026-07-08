// Condition plays — save a tuned condition (appearance, params, waste, and its
// full materials list) as a reusable recipe in THIS browser (localStorage,
// same per-origin scope as the rest of the workspace). No geometry and no ids
// are saved; applying a play mints a fresh condition. Pure list/shape helpers
// are separated from the storage wrappers so they stay node-testable.
const KEY = "opentakeoff_plays";
const COND_KEEP = ["finish_tag", "color", "fill", "hatch", "height_ft", "thickness_in", "waste_pct"];
const MAT_KEEP = ["name", "kind", "per", "basis", "unit", "round", "note", "grout"];

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined && obj?.[k] !== null && obj?.[k] !== "") out[k] = obj[k];
  return out;
};

export function playFromCondition(name, cond, mintId) {
  return {
    id: mintId(),
    name: String(name || cond?.finish_tag || "Play").trim(),
    ...pick(cond, COND_KEEP),
    materials: (cond?.materials || []).filter((m) => m && m.name).map((m) => pick(m, MAT_KEEP)),
  };
}

export function conditionFromPlay(play, finishTag, mintCondId, mintMatId) {
  return {
    id: mintCondId(),
    finish_tag: finishTag || play.finish_tag || "",
    color: play.color, fill: play.fill ?? play.color, hatch: play.hatch || "solid",
    multiplier: 1,
    ...(play.height_ft != null ? { height_ft: play.height_ft } : {}),
    ...(play.thickness_in != null ? { thickness_in: play.thickness_in } : {}),
    ...(play.waste_pct != null ? { waste_pct: play.waste_pct } : {}),
    materials: (play.materials || []).map((m) => ({ id: mintMatId(), ...m })),
  };
}

/** re-saving under the same name replaces (keeps the playbook tidy) */
export function upsertPlay(plays, play) {
  return [...(plays || []).filter((p) => p.name !== play.name), play];
}

export function loadPlays() {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]") || []; } catch { return []; }
}
export function savePlays(plays) {
  try { localStorage.setItem(KEY, JSON.stringify(plays || [])); } catch { /* private mode */ }
}
