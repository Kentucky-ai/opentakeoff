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

// Declared author (#314) — self-declared exactly the way git sources
// user.name: one localStorage key, no accounts, no login, no network. The
// trust model is initials on a paper markup, which is the correct model for a
// tool whose deployments include air-gapped and self-hosted shops — anyone
// who can edit the payload file can edit the name, and authentication stays
// in whatever the team already runs. Cached in-module so the pure consumers
// (shapeCommands, the node test runner, mcp) read it without a DOM; where
// localStorage is absent the cache alone carries it, and with nothing
// declared every payload is byte-identical to today's.
const AUTHOR_KEY = "ot-author";
let authorCache;                 // undefined = not read yet; null = none declared
export function authorName() {
  if (authorCache === undefined) {
    try { authorCache = (globalThis.localStorage?.getItem(AUTHOR_KEY) || "").trim() || null; }
    catch { authorCache = null; }
  }
  return authorCache;
}
export function setAuthorName(name) {
  const v = (typeof name === "string" ? name : "").trim() || null;
  authorCache = v;
  try {
    if (v) globalThis.localStorage?.setItem(AUTHOR_KEY, v);
    else globalThis.localStorage?.removeItem(AUTHOR_KEY);
  } catch { /* storage blocked — the in-memory declaration still holds */ }
  return v;
}

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
//
// Author (#314): when a name is declared, every stamp additionally carries
// updated_by — the last human to land a real edit — beside updated_at. The
// shape's `author` (who committed it, stamped at mint) is never overwritten:
// the pair answers both of review's questions, "who traced the corridor" and
// "whose edit won". Undeclared ⇒ absent ⇒ payloads byte-identical to today.
export function stampEdit(shape, kind) {
  const updated_at = nowIso();
  const by = authorName();
  const stamp = by ? { updated_at, updated_by: by } : { updated_at };
  const o = shape.origin;
  if (!o?.method || o.method === "manual") return { ...shape, ...stamp };
  const origin = {
    ...o,
    edited: true,
    edits: { ...o.edits, [kind]: (o.edits?.[kind] || 0) + 1 },
  };
  if (!o.proposed_verts_norm && Array.isArray(shape.verts_norm)) {
    origin.proposed_verts_norm = shape.verts_norm.map((v) => [...v]);
  }
  return { ...shape, ...stamp, origin };
}
