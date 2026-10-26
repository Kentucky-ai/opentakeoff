// Personal chrome only. Never include this in a project, profile, or sync payload.
export const WORKSPACE_LAYOUT_KEY = "ot.workspace-layout.v1";
export const DEFAULT_LAYOUT = Object.freeze({ locked: true, tools: "left", sheets: "left", work: "right", takeoffs: "right", workWidth: 360, sheetWidth: 264, counter: false, readout: false, palette: false, look: "graphite", backlight: 45 });
export const DOCKS = Object.freeze(["tools", "sheets", "work", "takeoffs"]);
export function normalizeLayout(value) {
  const v = value && typeof value === "object" ? value : {};
  const out = { ...DEFAULT_LAYOUT };
  if (["graphite", "light", "hud"].includes(v.look)) out.look = v.look;
  if (typeof v.backlight === "number" && Number.isFinite(v.backlight)) out.backlight = Math.round(Math.min(100, Math.max(0, v.backlight)));
  for (const key of DOCKS) if (v[key] === "left" || v[key] === "right") out[key] = v[key];
  for (const key of ["locked", "counter", "readout", "palette"]) if (typeof v[key] === "boolean") out[key] = v[key];
  for (const [key, min, max] of [["workWidth", 300, 480], ["sheetWidth", 220, 340]]) {
    if (typeof v[key] === "number" && Number.isFinite(v[key])) out[key] = Math.round(Math.max(min, Math.min(max, v[key])));
  }
  return out;
}
export function moveDock(layout, dock, side) {
  const current = normalizeLayout(layout);
  if (current.locked || !DOCKS.includes(dock) || !["left", "right"].includes(side)) return current;
  return { ...current, [dock]: side };
}
export function readWorkspacePreferences(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1) throw new Error("Unsupported layout");
    return { version: 1, enabled: value.enabled !== false, layout: normalizeLayout(value.layout), saved: (Array.isArray(value.saved) ? value.saved : []).filter((s) => s && typeof s.name === "string" && s.name.trim()).slice(0, 8).map((s) => ({ name: s.name.trim().slice(0, 40), layout: normalizeLayout(s.layout) })) };
  } catch { return { version: 1, enabled: true, layout: { ...DEFAULT_LAYOUT }, saved: [] }; }
}
