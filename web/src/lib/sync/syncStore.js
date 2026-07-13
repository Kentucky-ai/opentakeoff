// Annotation reconciler (Slices 4b + 4c) — wraps a per-project local store with
// an optional Drive sync layer so annotations survive across machines while local
// stays canonical. 4b is the PUSH + SEED half; 4c adds the mutable-doc CONFLICT
// half: divergence detection, uniform remote-wins resolution, loser-snapshot, and
// the isBusy() defer-gate that keeps a remote adopt from clobbering in-flight work.
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
 *   signal; fires on a mount seed (4b) and on a remote-wins conflict adopt (4c).
 * @param {(label:string, payload:any, folderId:string)=>Promise<any>} [opts.saveSnapshot]
 *   sink for the loser-backup on a conflict (inject snapSync.saveSnapshot so it syncs
 *   to the other device — Slice 2 dependency). Absent → 4c degrades to 4b (no adopt,
 *   local stays ahead) so nothing is lost when the sink is misconfigured.
 * @param {() => boolean} [opts.isBusy] returns true while the canvas has in-flight
 *   work or a pending debounced save; a remote adopt is DEFERRED until it clears
 *   (Slice 5 wires the real predicate + calls flushPending). Default: never busy.
 */
export function createSyncStore({ base, provider, folderId, onRemoteUpdate, saveSnapshot, isBusy = () => false }) {
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

  // ── Slice 4c: conflict reconciliation. A push that finds the remote moved past
  // our base (someone else wrote), or recovery that finds the same at mount, means
  // the remote WINS: snapshot the local (opted) side so nothing is lost, adopt the
  // remote as canonical, advance synced_rev:
  //     snapshot(current local) → base.saveAnnotations(remote) → synced_rev = remote.rev
  // Ordering is the crash spine again — synced_rev advances LAST, so a tear leaves
  // local=remote / synced_rev=stale (next edit re-conflicts and re-reconciles), never
  // the reverse (synced_rev ahead of an un-adopted local → the winner is silently lost).
  //
  // "Remote wins" is UNIFORM: a rev-less/regressed remote (a flag-off teammate's
  // write) and a rev-bearing divergent remote resolve identically — the plan's
  // CRITICAL rev-less rule generalized to one branch. No updated_at, no clock-skew
  // last-writer tiebreak, no "local wins → re-push over remote" path. (LWW-by-
  // updated_at is a forward-compatible future refinement; its only edge — a genuinely
  // newer local edit staying canonical without a manual restore — needs active
  // co-editing, which the v1 rollout forbids.) The loser is an immutable snapshot the
  // user can restore, which mints synced_rev+1 and re-pushes to win (why #73 stays
  // retired). TODO: dedup identical loser backups by content hash (plan's named punt).
  //
  // The adopt is GATED by isBusy(): overwriting local + re-rendering the canvas while
  // the user has in-flight work (or a debounced save pending) would clobber it. When
  // busy we hold the freshest remote and touch nothing; Slice 5's canvas calls
  // flushPending() once idle. Absent isBusy (dark 4c) defaults to never-busy → eager
  // adopt (safe only with no concurrent save — exactly the isolated/tested case).
  let pendingRemote = null; // freshest divergent remote awaiting a safe adopt

  async function maybeFlush() {
    // Loop so a remote discovered mid-adopt (its awaits yield) still drains. Snapshot
    // is taken HERE (at adopt), not per-conflict — so a burst of conflicts while
    // deferred yields ONE backup of the cumulative local, not O(conflicts) spam.
    while (pendingRemote && !isBusy()) {
      const remote = pendingRemote;
      const loser = await base.loadAnnotations();            // cumulative local divergence
      await saveSnapshot("Conflict backup", loser, folderId); // durable + syncs (Slice 2)
      // Re-check the gate AS LATE AS POSSIBLE — right before the destructive overwrite.
      // isBusy() was false at loop-top, but the user can start in-flight work during the
      // loadAnnotations/saveSnapshot awaits; adopting then would clobber it. If they did,
      // defer: pendingRemote is still set, so flushPending() retries once idle. (The loser
      // snapshot already taken is harmless — an immutable extra backup; content-hash dedup
      // is the plan's named punt.) This narrows the LOCAL clobber window to just the two
      // fast IDB writes below; it does NOT close the canvas RE-RENDER race — onRemoteUpdate
      // fires synchronously here but the canvas applies it async, so Slice 5's callback must
      // ALSO re-check busy at apply time and re-defer (recorded in the Slice 5 task).
      if (isBusy()) break;
      await base.saveAnnotations(remote.data);               // adopt remote as canonical
      await metaPut(K.syncedRev, remote.rev);                // advance LAST (crash spine)
      // Consume ONLY after a fully-successful adopt: a throw in the writes above leaves
      // pendingRemote set for a later retry (never a dropped update), and if a fresher
      // remote queued during the awaits we keep it — the loop drains to it next iteration.
      if (pendingRemote === remote) pendingRemote = null;
      if (onRemoteUpdate) onRemoteUpdate(remote.data, remote.rev);
    }
  }

  // Single-flight drain, exposed (non-enumerable) for Slice 5's canvas to call when
  // in-flight work clears. Never throws into the caller (best-effort; local canonical).
  let flushing = null;
  function flushPending() {
    if (flushing) return flushing;
    flushing = maybeFlush().catch(() => {}).finally(() => { flushing = null; });
    return flushing;
  }

  async function reconcile(remote) {
    // No snapshot sink → can't preserve the loser, so degrade to 4b: leave local
    // ahead (no adopt, no loss). A data-less remote (deleted/unreadable) has nothing
    // to adopt → likewise keep local canonical rather than overwrite it with null.
    if (typeof saveSnapshot !== "function") return;
    if (!remote || remote.data == null) return;
    pendingRemote = remote; // last-discovered wins — freshest Drive truth in serial discovery
    await flushPending();
  }

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
    // Anything else is a real divergence (someone else wrote) → reconcile (4c).
    // Using the recorded baseRev handles the first-push case uniformly: `targetRev-1`
    // arithmetic can't express "based on null" (a not-landed first push leaves the
    // remote rev-less/null, and rev 0 never exists).
    await metaDelete(K.marker);
    const baseRev = typeof marker.baseRev === "number" ? marker.baseRev : null;
    if (remoteRev === baseRev) {
      // The first-push case (baseRev===null, remoteRev===null) is ALSO matched by a
      // rev-less EXTERNAL write (a flag-off teammate) — indistinguishable by rev. But
      // it IS distinguishable by DATA: our own landed first push would show rev 1
      // (caught by the targetRev branch above), so a null-rev remote carrying actual
      // data here is provably external, not our un-landed push. Reconcile it (snapshot
      // the opted local, adopt the teammate's write) instead of blind-overwriting —
      // this closes the last unsnapshotted-loss path. A genuinely-EMPTY remote (no
      // data) is our own un-landed push → re-push. (Numeric baseRev never takes this
      // branch: a same-rev remote there is unambiguously our unchanged base, so
      // re-pushing our legitimately-ahead local is correct — reconciling would revert
      // it to the base rev and drop the un-pushed edits.)
      if (baseRev === null && remote?.data != null) {
        await reconcile(remote);            // external rev-less write → remote wins (Slice 4c)
        return false;
      }
      return true;                          // our push never landed → re-push
    }
    await reconcile(remote);                // real divergence → remote wins (Slice 4c)
    return false;
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
      // verify: drop the marker first, then reconcile. res.remote carries the
      // remote {data, rev} the push saw, so 4c resolves it (remote wins, snapshot
      // the local side) without a second pull.
      await metaDelete(K.marker);
      await reconcile(res.remote);
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

  // Non-enumerable so the store shape stays exactly the 2 methods (must not shadow
  // addSheets et al. when spread into the composite store, and Object.keys stays 2).
  // flushPending is wiring, not test-only: Slice 5 holds the raw annSync reference
  // (not the spread) and calls it from a canvas effect when in-flight work clears.
  Object.defineProperty(api, "whenSynced", { enumerable: false, value: () => bootstrap });
  Object.defineProperty(api, "whenPushed", { enumerable: false, value: async () => { while (pushing) await pushing; } });
  Object.defineProperty(api, "flushPending", { enumerable: false, value: flushPending });

  return api;
}
