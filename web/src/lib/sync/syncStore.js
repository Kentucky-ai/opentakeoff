// Annotation reconciler (Slice 4b) — wraps a per-project local store with an
// optional Drive sync layer so annotations survive across machines while local
// stays canonical. This is the PUSH + SEED half of the engine; the mutable-doc
// CONFLICT half (divergence detection, last-writer-wins, loser-snapshot,
// onRemoteUpdate defer-gating) is Slice 4c and deliberately NOT here.
//
// Composition: base = createLocalStore(folderId) (Slice 3), provider = the
// annotation-sync provider (Slice 4a). The SnapshotPanel/canvas call
// store.loadAnnotations/saveAnnotations unaware sync exists.
//
// Invariants (from the reviewed plan + advisor):
//   • Local write is authoritative and NEVER blocks on the network. loadAnnotations
//     returns local instantly and cannot throw a network error into the mount
//     chain. The Drive push is fire-and-forget.
//   • Durable bookkeeping lives in `sync:<folderId>:*` meta keys, each its OWN key
//     (metaGet/metaPut, no composite record) so autosave/push/recovery never
//     lost-update each other.
//   • CRASH-TORN WRITE ORDERING is the correctness spine — every durable write is
//     ordered so a crash mid-sequence fails SAFE:
//       - `touched` is written BEFORE the annotation content. Torn the safe way →
//         touched=true with no content (benign). The reverse (content, no touched)
//         would let the next mount's seed adopt remote over a real edit = silent
//         loss.
//       - the push `marker` {targetRev} is written BEFORE the push; `synced_rev`
//         advances only AFTER a confirmed push; the marker is cleared LAST. On
//         recovery a lingering marker means "verify against Drive", not "trust".
//   • `expectedRev` for a push is ALWAYS the durable `synced_rev`, never a rev
//     carried in the payload — so a restored old snapshot mints synced_rev+1 and
//     pushes clean (why #73 stays retired on the opted-in path).

import { metaGet, metaPut, metaDelete } from "../store.js";

/**
 * @param {object} opts
 * @param {any} opts.base       per-project local store (createLocalStore(folderId))
 * @param {any} opts.provider   annotation-sync provider (pull/push)
 * @param {string} opts.folderId Drive project folder id (namespaces the sync meta)
 * @param {(data:any, rev:number|null)=>void} [opts.onRemoteUpdate] canvas re-hydrate
 *   signal; in 4b it fires only on a mount seed. (4c adds reconcile/conflict calls.)
 */
export function createSyncStore({ base, provider, folderId, onRemoteUpdate }) {
  // Fail fast on a miswired composite. Without this, a null/incomplete provider
  // would let saveAnnotations still write touched/marker meta and then leave a
  // marker that recovery keeps forever (its pull throws → treated as "offline") —
  // a hard-to-debug wedge. Validate base too: a bad base loses the local write.
  if (!base || typeof base.loadAnnotations !== "function" || typeof base.saveAnnotations !== "function") {
    throw new Error("createSyncStore: base with loadAnnotations()/saveAnnotations() is required");
  }
  if (!provider || typeof provider.pull !== "function" || typeof provider.push !== "function") {
    throw new Error("createSyncStore: provider with pull()/push() is required");
  }
  const K = {
    touched: `sync:${folderId}:touched`,
    syncedRev: `sync:${folderId}:synced_rev`,
    marker: `sync:${folderId}:marker`,
    lastPushedAt: `sync:${folderId}:last_pushed_at`,
  };

  const readSyncedRev = async () => {
    const v = await metaGet(K.syncedRev);
    return typeof v === "number" ? v : null;
  };
  const isTouched = async () => (await metaGet(K.touched)) === true;

  // ── mount recovery: a lingering marker means a push was in flight when we died.
  // Read Drive to disambiguate landed-vs-not; never assume. Returns true when the
  // push provably did NOT land and we're cleanly one ahead (so caller re-pushes).
  async function recover() {
    const marker = await metaGet(K.marker);
    if (!marker || typeof marker.targetRev !== "number") {
      if (marker) await metaDelete(K.marker); // garbage marker → drop
      return false;
    }
    let remote;
    try {
      remote = await provider.pull();
    } catch {
      // Offline: can't verify. KEEP the marker and stay "push pending" — retry on
      // a later mount when back online. Never assume it landed or didn't.
      return false;
    }
    const remoteRev = remote?.rev ?? null;
    if (remoteRev === marker.targetRev) {
      // it landed → adopt the rev, clear the marker
      await metaPut(K.syncedRev, remoteRev);
      await metaDelete(K.marker);
      return false;
    }
    // Didn't land at targetRev. Clear the marker either way; if the remote is
    // STILL exactly what we based the push on (`baseRev` — a number, or null for a
    // first push where synced_rev was unset), our push never took → re-push.
    // Anything else is a real divergence (someone else wrote) → leave it for 4c.
    // Using the recorded baseRev handles the first-push case uniformly: `targetRev-1`
    // arithmetic can't express "based on null" (a not-landed first push leaves the
    // remote rev-less/null, and rev 0 never exists).
    await metaDelete(K.marker);
    const baseRev = typeof marker.baseRev === "number" ? marker.baseRev : null;
    return remoteRev === baseRev;
  }

  // ── mount seed: a truly-fresh (never-touched) project adopts remote wholesale.
  // Fire-and-forget: a failed pull must never throw into the mount chain. Once
  // `touched` is true (a prior real edit), seeding is off — steady-state reconcile
  // is 4c, not a seed.
  async function seedOnMount() {
    if (await isTouched()) return;
    let remote;
    try {
      remote = await provider.pull();
    } catch {
      return; // failed pull is best-effort; local stays canonical
    }
    if (!remote || remote.data == null) return; // no remote yet → nothing to seed
    // Re-check: the user may have started editing during the pull await. If so
    // this is no longer a seed (their edit wins locally; 4c reconciles later).
    if (await isTouched()) return;
    await base.saveAnnotations(remote.data); // adopt remote into local (no touched — not a local edit)
    // Base future pushes on remote's rev. A rev-less remote (a flag-off teammate's
    // write) stores synced_rev=null, so the next edit's push runs expectedRev=null
    // and blind-overwrites it (rev → 1). That's the mixed-fleet hazard the plan
    // hands to 4c (rev-less remote WINS, snapshot the local side); 4b only seeds.
    await metaPut(K.syncedRev, remote.rev);
    if (onRemoteUpdate) onRemoteUpdate(remote.data, remote.rev);
  }

  // Recovery then seed, once, at construction. loadAnnotations does NOT await this
  // (local returns instantly); the push path does, so a push can't race recovery.
  const bootstrap = (async () => {
    try {
      const needsRepush = await recover();
      await seedOnMount();
      return needsRepush;
    } catch {
      // Recovery/seed is best-effort — a failure here must never reject bootstrap
      // (the push path awaits it) or throw into a caller. Local stays canonical.
      return false;
    }
  })();
  // If recovery found a cleanly-unlanded push, re-attempt AFTER bootstrap settles
  // (scheduling inside recover would deadlock on `await bootstrap` in pushOnce).
  bootstrap.then((needsRepush) => { if (needsRepush) schedulePush(); }).catch(() => {});

  // ── single-flight push with trailing re-run, so rapid autosaves coalesce into
  // at most one in-flight push plus one queued follow-up (always pushing latest).
  let pushing = null;
  let pushAgain = false;
  function schedulePush() {
    if (pushing) { pushAgain = true; return; }
    pushing = (async () => {
      do {
        pushAgain = false;
        try { await pushOnce(); } catch { /* best-effort: local is canonical */ }
      } while (pushAgain);
    })().finally(() => { pushing = null; });
  }

  async function pushOnce() {
    await bootstrap; // recovery/seed settle before any push
    const expectedRev = await readSyncedRev(); // durable base, never payload.rev
    const targetRev = (expectedRev ?? 0) + 1;
    // Record BOTH the target and the base we're pushing from, so recovery can tell
    // "our push never landed" (remote still == baseRev, incl. null first-push) from
    // a real divergence — see recover(). Marker written BEFORE the push.
    await metaPut(K.marker, { targetRev, baseRev: expectedRev });
    const payload = await base.loadAnnotations(); // latest local content (coalesced)
    const res = await provider.push(payload, { expectedRev });
    if (res.conflict) {
      // Provider refused — we KNOW nothing was written, so there's nothing to
      // verify: drop the marker and leave synced_rev (local stays ahead, touched
      // stays true). Real conflict resolution is 4c.
      await metaDelete(K.marker);
      return;
    }
    await metaPut(K.syncedRev, res.rev);          // advance AFTER confirmed push
    await metaPut(K.lastPushedAt, Date.now());    // for the Slice 6 status line
    await metaDelete(K.marker);                   // clear marker LAST
  }

  const api = {
    // Local, instant, never a network read — the canvas mount can't be blocked or
    // thrown into by a flaky Drive. The background seed (if any) re-hydrates via
    // onRemoteUpdate.
    async loadAnnotations() {
      return base.loadAnnotations();
    },

    // Local write authoritative; then a fire-and-forget precondition push. `touched`
    // is set BEFORE the content write (crash-ordering spine — see header).
    async saveAnnotations(payload) {
      await metaPut(K.touched, true);
      await base.saveAnnotations(payload);
      schedulePush();
    },
  };

  // Test-only, non-enumerable so the store shape stays exactly the 2 methods
  // (must not shadow addSheets et al. when spread into the composite store).
  Object.defineProperty(api, "whenSynced", { enumerable: false, value: () => bootstrap });
  Object.defineProperty(api, "whenPushed", { enumerable: false, value: async () => { while (pushing) await pushing; } });

  return api;
}
