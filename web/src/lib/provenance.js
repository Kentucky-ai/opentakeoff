// Provenance primitives — id minting, timestamping, and the edit stamp every
// shape mutation rides. Plain JS with no DOM dependency so mcp/ and the Node
// test runner can exercise it directly; the canvas and canvasUtil are the only
// web consumers.

// UUID minting with a guard for non-secure contexts: crypto.randomUUID is only
// defined in secure contexts, and plain-HTTP LAN self-hosts are supported
// deployments — those fall back to a time+random token (uniqueness, not
// cryptographic strength, is the contract here).
export const mintUuid = () => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

// ONE clock for every payload timestamp — created_at/updated_at are always
// ISO-8601 UTC so records diff and sort the same on every machine.
export const nowIso = () => new Date().toISOString();

// Stamp a REAL edit onto a shape (kind ∈ "vertex" | "edge" | "move" |
// "reassign") and return the stamped copy — never mutates its input (origin
// and its edits map may be aliased across clipboard copies).
//   - every shape gets updated_at;
//   - a machine-origin shape (origin.method present and not "manual")
//     additionally gets origin.edited = true and a per-kind bump in
//     origin.edits — the running tally of how the estimator corrected it;
//   - the FIRST edit of a machine shape freezes origin.proposed_verts_norm
//     from the PRE-edit verts_norm (deep copy): the machine's original trace
//     survives verbatim once a human starts correcting it. Callers must stamp
//     BEFORE applying the geometry change so the frozen ring is truly pre-edit.
// Manual/no-origin shapes get updated_at and nothing else.
export function stampEdit(shape, kind) {
  const updated_at = nowIso();
  const o = shape.origin;
  if (!o?.method || o.method === "manual") return { ...shape, updated_at };
  const origin = {
    ...o,
    edited: true,
    edits: { ...o.edits, [kind]: (o.edits?.[kind] || 0) + 1 },
  };
  if (!o.proposed_verts_norm && Array.isArray(shape.verts_norm)) {
    origin.proposed_verts_norm = shape.verts_norm.map((v) => [...v]);
  }
  return { ...shape, updated_at, origin };
}
