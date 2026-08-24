// Annotation reconciler (Slices 4b + 4c) — wraps a per-project local store with
// an optional Drive sync layer so annotations survive across machines while local
// stays canonical. 4b is the PUSH + SEED half; 4c adds the mutable-doc CONFLICT
// half: divergence detection, conflict resolution (a shape-level three-way merge
// when a common ancestor is known — #313 — else uniform remote-wins),
// loser-snapshot, and the isBusy() defer-gate that keeps a remote adopt from
// clobbering in-flight work.
//
// Composition: base = createLocalStore(folderId) (Slice 3), provider = the
// annotation-sync provider (Slice 4a). The RevisionsPanel/canvas call
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
import { mergeAnnotations, samePayload } from "./merge.js";

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
    base: `sync:${folderId}:synced_base`,
  };

  const readSyncedRev = async () => {
    const v = await metaGet(K.syncedRev);
    return typeof v === "number" ? v : null;
  };
  const isTouched = async () => (await metaGet(K.touched)) === true;

  // The COMMON ANCESTOR for the #313 three-way merge: the payload as of
  // synced_rev, written beside every synced_rev advance as { rev, data }. It is
  // trusted ONLY when its stamped rev matches the durable synced_rev — a crash
  // torn between the two meta writes leaves a mismatch, and a mismatched base
  // silently degrades the next conflict to the uniform remote-wins path (the
  // pre-#313 behavior), never to a merge against the wrong ancestor. Absent on
  // pre-#313 installs for the same safe reason.
  const readMergeBase = async () => {
    const [v, syncedRev] = await Promise.all([metaGet(K.base), readSyncedRev()]);
    if (!v || v.data == null) return null;
    return (v.rev ?? null) === syncedRev ? v.data : null;
  };
  const writeMergeBase = (rev, data) => metaPut(K.base, { rev: rev ?? null, data });

  // ── Slice 4c: conflict reconciliation. A push that finds the remote moved past
  // our base (someone else wrote), or recovery that finds the same at mount, means
  // the remote WINS: snapshot the local (opted) side so nothing is lost, adopt the
  // remote as canonical, advance synced_rev:
  //     snapshot(current local) → base.saveAnnotations(remote) → synced_rev = remote.rev
  // Ordering is the crash spine again — synced_rev advances LAST, so a tear leaves
  // local=remote / synced_rev=stale (next edit re-conflicts and re-reconciles), never
  // the reverse (synced_rev ahead of an un-adopted local → the winner is silently lost).
  //
  // Resolution has two tiers (#313). With a trustworthy common ancestor
  // (synced_base matching synced_rev) the divergence resolves by SHAPE-LEVEL
  // three-way merge — adds union, one-sided deletes hold, both-edited records
  // pick a deterministic winner with the loser preserved inline — and the
  // merged result re-pushes so both machines converge to the union. Without an
  // ancestor (pre-#313 meta, torn base write, rev mismatch) resolution stays
  // UNIFORM remote-wins: a rev-less/regressed remote (a flag-off teammate's
  // write) and a rev-bearing divergent remote resolve identically, and the
  // loser is an immutable snapshot the user can restore, which mints
  // synced_rev+1 and re-pushes to win (why #73 stays retired). TODO: dedup
  // identical loser backups by content hash (plan's named punt).
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
    let repush = false;
    while (pendingRemote && !isBusy()) {
      const remote = pendingRemote;
      const local = await base.loadAnnotations();            // cumulative local divergence
      // ── #313: with a trustworthy common ancestor, resolve at the SHAPE level
      // instead of uniform remote-wins. The merge is a pure function of
      // (base, local, remote), so both machines converge to the same payload
      // without coordinating. No ancestor (pre-#313 install, torn base write,
      // rev mismatch) → the uniform remote-wins path below, unchanged.
      const ancestor = await readMergeBase();
      // Merge ONLY a remote that moved FORWARD past our ancestor (someone
      // pushed beyond us). A REGRESSED remote — a sync client restoring an old
      // file, rev below synced_rev — is older than the ancestor, and a
      // three-way against a newer base would read our already-synced work as
      // "deleted on remote" and silently drop it. Regression (and a rev-less
      // remote, which can't be ordered) falls back to uniform remote-wins with
      // the loser snapshotted — the pre-#313 contract, nothing silent.
      const syncedRev = await readSyncedRev();
      const movedForward = Number.isInteger(remote.rev) && (syncedRev == null || remote.rev > syncedRev);
      // SIBLING FORK (#316): an eventually-consistent transport can hold a
      // remote AT our synced rev with DIFFERENT content — two machines pushed
      // the same rev number and the sync client picked a file-level winner.
      // Neither side's stored ancestor is the true common ancestor (it predates
      // both pushes and is gone), so a three-way here would fabricate
      // deletions. Merge with an EMPTY base instead: pure union — adds from
      // both sides survive, same-uid divergence resolves deterministically,
      // and NOTHING is deleted. The cost (a shape deleted on one side
      // resurfacing) is the safe direction; the gain is neither afternoon lost.
      const siblingFork = ancestor && Number.isInteger(remote.rev) && remote.rev === syncedRev && !samePayload(remote.data, ancestor);
      let m = null;
      if (ancestor && movedForward) m = mergeAnnotations(ancestor, local, remote.data);
      else if (siblingFork) m = mergeAnnotations({}, local, remote.data);
      // Loser preservation: the merge carries every losing ring inline
      // (merge_loser), so a CLEAN merge takes no snapshot — the RFC's disjoint
      // 50/50 case converges with zero loser-snapshots. A merge with same-uid
      // conflicts or a re-import flag still backs up the whole local side
      // (belt and braces); the remote-wins path snapshots always, as before.
      if (!m || !m.clean) await saveSnapshot(m ? "Merge backup" : "Conflict backup", local, folderId);
      // Re-check the gate AS LATE AS POSSIBLE — right before the destructive overwrite.
      // isBusy() was false at loop-top, but the user can start in-flight work during the
      // loadAnnotations/saveSnapshot awaits; adopting then would clobber it. If they did,
      // defer: pendingRemote is still set, so flushPending() retries once idle. (The loser
      // snapshot already taken is harmless — an immutable extra backup; content-hash dedup
      // is the plan's named punt.) This narrows the LOCAL clobber window to just the few
      // fast IDB writes below; the canvas RE-RENDER race — onRemoteUpdate fires
      // synchronously here but the canvas applies it async — is closed on the canvas
      // side by Slice 5b's apply-time isBusy re-check + idle re-read-local (Case 2).
      if (isBusy()) break;
      const adopted = m ? m.merged : remote.data;
      await base.saveAnnotations(adopted);                   // adopt (merged or remote) as canonical
      await metaPut(K.syncedRev, remote.rev);                // advance LAST (crash spine)
      // The next merge's ancestor is what the REMOTE holds at synced_rev — local
      // may now be ahead of it by the merged-in local work. Written after
      // synced_rev; a tear between the two leaves rev≠base.rev, which
      // readMergeBase rejects (degrade, never mis-merge).
      await writeMergeBase(remote.rev, remote.data);
      // A merged adopt that kept any local work is now AHEAD of the remote —
      // push it (after the drain) so the other machine converges to the union
      // too. Plain remote-wins adopts are never ahead, as before.
      if (m && !samePayload(adopted, remote.data)) repush = true;
      // Consume ONLY after a fully-successful adopt: a throw in the writes above leaves
      // pendingRemote set for a later retry (never a dropped update), and if a fresher
      // remote queued during the awaits we keep it — the loop drains to it next iteration.
      if (pendingRemote === remote) pendingRemote = null;
      if (onRemoteUpdate) onRemoteUpdate(adopted, remote.rev);
    }
    // Fire-and-forget: pushOnce awaits bootstrap, and bootstrap may itself be
    // awaiting THIS drain (recover → reconcile → flushPending) — scheduling,
    // not awaiting, keeps that from deadlocking.
    if (repush) schedulePush();
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
    await writeMergeBase(remote.rev, remote.data); // the seed IS the common ancestor (#313)
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
    // Sibling-fork guard (#316): before pushing over a remote that CLAIMS our
    // expectedRev, verify it IS what we synced. An eventually-consistent
    // transport (a synced folder) can serve a same-rev file from another
    // machine — the rev precondition passes and a blind overwrite would bury
    // that machine's afternoon in a file history nobody reads. Content is the
    // tell: remote at expectedRev but ≠ our ancestor → reconcile as a fork
    // (union merge), don't push. Offline/unreadable pulls fall through — the
    // push's own precondition still governs, exactly as before. Skipped with
    // no ancestor (pre-#313 meta): nothing to compare against.
    if (expectedRev != null) {
      const anc = await readMergeBase();
      if (anc) {
        let cur = null;
        try { cur = await provider.pull(); } catch { cur = null; }
        if (cur && cur.data != null && (cur.rev ?? null) === expectedRev && !samePayload(cur.data, anc)) {
          await reconcile({ data: cur.data, rev: cur.rev });
          return;
        }
      }
    }
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
    // What we just pushed is the new common ancestor (#313). Written after
    // synced_rev — a tear leaves rev≠base.rev, which readMergeBase rejects.
    await writeMergeBase(res.rev, payload);
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
  // Lazy remote check (#316): poll-capable transports (a synced folder — free
  // local reads, no provider quota) call this on a slow cadence so a
  // teammate's push is noticed without waiting for a local edit to conflict.
  // A divergent remote routes through reconcile — merge with an ancestor
  // (#313), uniform remote-wins without. Never throws: a failed pull is
  // "offline" and local stays canonical. Skipped while a push is in flight —
  // the push's own precondition surfaces the same divergence.
  async function checkRemote() {
    try {
      await bootstrap;
      if (pushing) return;
      let remote;
      try { remote = await provider.pull(); } catch { return; }
      if (!remote || remote.data == null) return;
      if ((remote.rev ?? null) === (await readSyncedRev())) {
        // Same rev is not proof of same content on an eventually-consistent
        // transport (sibling fork — see maybeFlush). With an ancestor to
        // compare against, different content at our own rev is a fork to
        // reconcile; without one, or with matching content, we're in sync.
        const anc = await readMergeBase();
        if (!anc || samePayload(remote.data, anc)) return;
      }
      await reconcile(remote);
    } catch { /* best-effort; local canonical */ }
  }

  Object.defineProperty(api, "whenSynced", { enumerable: false, value: () => bootstrap });
  Object.defineProperty(api, "checkRemote", { enumerable: false, value: checkRemote });
  Object.defineProperty(api, "whenPushed", { enumerable: false, value: async () => { while (pushing) await pushing; } });
  Object.defineProperty(api, "flushPending", { enumerable: false, value: flushPending });

  return api;
}
