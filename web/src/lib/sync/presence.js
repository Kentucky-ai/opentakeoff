// Presence without a server (#317) — know someone's in the project before you
// collide. A per-device heartbeat file under the `.opentakeoff` sidecar the
// sync layers already own: presence/<device-uid>.json holding the declared
// author name (#314), the sheet currently open, and an ISO timestamp. It rides
// ANY transport that implements the snapshot-provider contract (findChild /
// createFolder / listChildren / getJson / putJson / deleteFile) — a synced
// folder, Drive, a 365 document library — because presence is just files, like
// everything else here.
//
// What this deliberately is NOT (RFC): not locking, not realtime. A heartbeat
// through an eventually-consistent transport is seconds-to-minutes stale by
// construction, so the language is "last seen", never "is editing" — advisory
// awareness, the coat on the chair. A crashed session leaves at worst one
// stale file, never a lock; the next writer garbage-collects it.
//
// Privacy default: presence WRITES only when an author name is declared —
// anonymous stays invisible. Reading is always on (an anonymous estimator
// still deserves to see the coat on the chair).
//
// Quota: one putJson + one listChildren + one getJson per live peer, per
// beat. At the default 15-minute cadence an 8-hour session with one peer is
// ~96 provider calls — background noise on any provider's limits (the RFC's
// <100 budget; the folder transport passes a faster cadence because local
// reads are free).

import { metaGet, metaPut } from "../store.js";
import { mintUuid } from "../provenance.js";

const PRESENCE_FOLDER = "presence";

// A stable per-browser device uid (NOT an identity — the declared author name
// is the human-facing part; this only keys the heartbeat file).
export async function ensureDeviceId() {
  const k = "presence:device";
  let id = await metaGet(k);
  if (typeof id !== "string" || !id) {
    id = `dev-${mintUuid()}`;
    await metaPut(k, id);
  }
  return id;
}

/**
 * @param {object} opts
 * @param {any} opts.provider     snapshot-provider contract (transport-agnostic)
 * @param {() => Promise<string>} opts.ensureSidecarId  the shared `.opentakeoff`
 *   resolver for this transport (same injection discipline as snapshotSync —
 *   one sidecar, no split-brain)
 * @param {() => Promise<string|null>} [opts.findSidecarId] NON-creating resolver
 *   for the read path: an anonymous session (no author declared) only READS
 *   the room and must never litter an empty sidecar into a fresh transport.
 *   When omitted, anonymous reads fall back to ensureSidecarId (tests/standalone).
 * @param {string} opts.deviceId  this device's heartbeat file key
 * @param {() => string|null} opts.getAuthor  declared author name; null → no writes
 * @param {() => string|null} [opts.getSheet] label of the sheet currently open
 * @param {number} [opts.intervalMs] beat cadence (default 15 min)
 * @param {number} [opts.staleMs]  hide a peer after this silence — defaults to
 *   3 missed beats with a 10-minute floor (slack in sync-cycles, not seconds:
 *   clock skew and replication lag both land inside it)
 * @param {number} [opts.gcMs]     DELETE a peer's file after this silence
 *   (default 4× stale, ≥ 1 h) — a kill -9'd session's file outlives it only
 *   until the next writer's beat
 * @param {() => number} [opts.now] injectable clock for tests
 */
export function createPresence({
  provider,
  ensureSidecarId,
  findSidecarId,
  deviceId,
  getAuthor,
  getSheet = () => null,
  intervalMs = 15 * 60_000,
  staleMs,
  gcMs,
  now = () => Date.now(),
}) {
  const stale = staleMs ?? Math.max(3 * intervalMs, 10 * 60_000);
  const gc = gcMs ?? Math.max(4 * stale, 60 * 60_000);

  // presence folder id, memoized locate-else-create (cleared on failure so a
  // transient error retries instead of wedging forever).
  let presP = null;
  function ensurePresenceFolderId() {
    if (!presP) {
      presP = (async () => {
        const sidecarId = await ensureSidecarId();
        const child = await provider.findChild(sidecarId, PRESENCE_FOLDER);
        if (child) return child.id;
        const { id } = await provider.createFolder(sidecarId, PRESENCE_FOLDER);
        return id;
      })().catch((e) => { presP = null; throw e; });
    }
    return presP;
  }

  let peersCache = [];
  const subscribers = new Set();
  const notify = () => { for (const cb of subscribers) { try { cb(peersCache); } catch { /* subscriber's problem */ } } };

  // One beat: write our heartbeat (named authors only), then read the room —
  // fresh peers into the cache, corpses past the GC horizon deleted. Never
  // throws: presence is advisory and must not surface transport blips.
  async function beat() {
    try {
      const name = getAuthor();
      let presId;
      if (name) {
        presId = await ensurePresenceFolderId();
        await provider.putJson({
          folderId: presId,
          name: `${deviceId}.json`,
          data: { device: deviceId, name, sheet: getSheet() ?? null, at: new Date(now()).toISOString() },
        });
      } else {
        // Anonymous: read-only pass. Resolve without creating — a fresh
        // transport with no presence yet stays untouched (no litter), and an
        // empty room is simply an empty room.
        const sidecarId = await (findSidecarId ? findSidecarId() : ensureSidecarId());
        if (!sidecarId) { peersCache = []; notify(); return; }
        const child = await provider.findChild(sidecarId, PRESENCE_FOLDER);
        if (!child) { peersCache = []; notify(); return; }
        presId = child.id;
      }
      const children = await provider.listChildren(presId);
      const next = [];
      for (const c of children) {
        if (!c.name || !c.name.endsWith(".json")) continue;
        const dev = c.name.slice(0, -".json".length);
        if (dev === deviceId) continue;
        let rec;
        try {
          rec = await provider.getJson(c.id);
        } catch {
          continue; // unreadable heartbeat never wedges the room
        }
        const at = Date.parse(rec?.at || "");
        if (!rec || typeof rec.name !== "string" || !Number.isFinite(at)) continue;
        const age = now() - at;
        if (age > gc) {
          // the crashed session's coat has been on the chair long enough
          await provider.deleteFile(c.id).catch(() => {});
          continue;
        }
        if (age > stale) continue; // silent lately — hidden, not deleted yet
        next.push({ device: dev, name: rec.name, sheet: rec.sheet ?? null, at: rec.at, ageMs: age });
      }
      next.sort((a, b) => a.name.localeCompare(b.name) || a.device.localeCompare(b.device));
      peersCache = next;
      notify();
    } catch { /* advisory: a failed beat is a skipped beat */ }
  }

  let timer = null;
  return {
    beat, // exposed for the focus/visibility nudge and for tests
    peers: () => peersCache,
    onPeers(cb) { subscribers.add(cb); return () => subscribers.delete(cb); },
    start() {
      if (timer) return;
      beat(); // first read is immediate — the room shows without waiting a cycle
      timer = setInterval(beat, intervalMs);
      // In Node (tests, tooling) an interval holds the event loop open; unref
      // lets the process exit. Browsers return a number — optional chain no-ops.
      timer?.unref?.();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
