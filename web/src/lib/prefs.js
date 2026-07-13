// Build-time feature flag for local-first + optional Drive sync. Set VITE_CLOUD_SYNC=1
// at build time (e.g. the Netlify env) to enable it for the WHOLE deployment at once;
// unset / anything-else = OFF, which reproduces today's Drive-canonical behavior
// byte-for-byte (ProjectGate builds the legacy store — nothing local-first is wired).
//
// Deliberately a DEPLOYMENT flag, NOT a per-user toggle. Local-first sync relies on an
// app-level rev precondition that only enabled clients honor, so a PARTIAL fleet (some
// browsers on, some off) is the mixed-fleet clobber hazard the design warns about.
// Flipping the whole build at once is the "don't share a project until its whole
// collaborator set is opted in" rule, enforced by the deploy instead of left to
// per-user chance. Rollback is one env change + redeploy, no code revert.
//
// No imports / no cloud vocabulary — the gating decision stays cheap and synchronous
// (never blocks a mount on network), and the anonymous bundle pulls in nothing.

/** True when THIS BUILD enabled local-first + optional Drive sync (VITE_CLOUD_SYNC=1). */
export function cloudSyncEnabled() {
  return ((import.meta.env && import.meta.env.VITE_CLOUD_SYNC) || "") === "1";
}
