// One-Click gate — TEMPORARY. The flood engine (one_click, detect_rooms) is
// being re-validated against a wider plan corpus, and until that finishes the
// two verbs are NOT REGISTERED on a default build: an agent that lists tools
// never sees them, so it never tries to call a tool that is not there. The
// engine code stays in web/src/lib (the bench still rules it); only the wire
// surface is withdrawn. OPENTAKEOFF_ONE_CLICK=1 (or the buildServer option)
// puts both verbs back, for the bench, the parity tests and lab use.
//
// This module has no imports on purpose: staging.ts, tools.ts, server.ts and
// the scripts all read it, and a cycle here would be the first thing to break.

/** The verbs withdrawn while the gate is up. */
export const GATED_TOOLS: readonly string[] = Object.freeze(["one_click", "detect_rooms"]);

/** The environment variable that lifts the gate for one process. */
export const ONE_CLICK_ENV = "OPENTAKEOFF_ONE_CLICK";

/** Whether the gated verbs register: an explicit option wins, else the env flag. */
export function oneClickEnabled(explicit?: boolean): boolean {
  return explicit ?? process.env[ONE_CLICK_ENV] === "1";
}

/** Appended to the initialize instructions while the gate is up — the one
 *  place every client reads before its first call. Names the reason, names
 *  the move, and says plainly which verbs do not exist on this server. */
export const GATE_NOTE =
  "ONE-CLICK IS TEMPORARILY GATED: one_click and detect_rooms are NOT registered on this server while the flood engine is re-validated against a wider plan corpus — do not call them, they do not exist here. " +
  "Measure a room with measure_polygon on the wall faces you read from get_sheet_vectors and confirm with view_sheet; sweeps, counts, derive_base and derive_transitions are unchanged and still read committed floor shapes.";

/** The short form for tool descriptions that used to point at one_click. */
export const GATE_HINT = "measure_polygon (One-Click is temporarily gated on this server)";
