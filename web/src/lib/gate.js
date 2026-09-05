// One-Click gate — TEMPORARY. The flood engine is being re-validated against a
// wider plan corpus; until that finishes the One-Click tool is withdrawn from
// the canvas rail, the `O` shortcut, the voice trace, and the in-app agent's
// tool list. The engine code stays (the bench still rules it) — only the ways
// a person or an agent can reach it are closed. Mirrors mcp/src/gate.ts.
//
// Lift it for a build with VITE_ONE_CLICK=1 (Vite inlines the env at build
// time). Tests and lab drivers can lift it at runtime by setting
// globalThis.__OT_ONE_CLICK = true before the first call — the check is a
// function, read at call time, never frozen at import.

export function oneClickEnabled() {
  try { if (globalThis.__OT_ONE_CLICK === true) return true; } catch { /* no globalThis */ }
  try { return import.meta.env?.VITE_ONE_CLICK === "1"; } catch { return false; }
}

/** The one sentence every surface uses when something reaches for the tool. */
export const ONE_CLICK_GATE_MESSAGE =
  "One-Click Area is temporarily gated while the flood engine is re-validated against a wider plan corpus. Trace the room with Area (A) meanwhile.";
