# Local-first sync — architecture & adding another provider

A developer's map of the optional local-first sync layer (enabled by
`VITE_CLOUD_SYNC=1`; see [`GOOGLE_SETUP.md`](GOOGLE_SETUP.md) for the operator side).
The goal that shapes everything below: **local IndexedDB is always canonical, the
cloud is an optional background sync, and no one is forced to let data leave the
machine to do useful work.**

## The shape

With the flag **off**, a cloud project uses `createCloudStore` — Drive is canonical,
exactly as it always was. With the flag **on**, `main.jsx`'s `ProjectGate` builds a
**composite** store instead (`web/src/lib/sync/composite.js`):

```
{ ...cloud, ...annSync, ...snapSync }
```

- **annotations** → a per-project local store (`createLocalStore(folderId)`) wrapped
  by the annotation reconciler (`createSyncStore`). Local is authoritative; a
  background push mirrors it to Drive, a mount pull seeds a fresh machine.
- **snapshots** → the local snapshot store wrapped by an append-only Drive union
  (`createSnapshotSync`) — immutable records, deduped by id.
- **PDFs / sheet manifest / `listFolder`** → stay `createCloudStore` (big, team-owned,
  shared). This is why the canvas's `cloudMode` duck-typing (`typeof store.listFolder`)
  still holds.

Later spreads shadow earlier ones, so the sync layers override only the annotation
and snapshot methods and leave everything else Drive-backed.

## The correctness model (annotations)

Mutable docs need conflict handling; the reconciler (`web/src/lib/sync/syncStore.js`)
does it with an **app-level revision precondition**, not HTTP preconditions:

- The payload carries a monotonic `rev`; the store keeps a durable `synced_rev` per
  project in `sync:<folderId>:*` meta keys.
- A push is `getJson`-before-`put`: it only writes if the remote is still at the rev
  we based on (`expectedRev`, always derived from the durable `synced_rev`).
- On a real divergence the **remote wins and the local side is snapshotted** before
  adopting it — nothing is lost silently, it becomes a restorable Snapshot.
- Crash-torn writes are ordered so a tear always fails safe (touched-before-content;
  marker-before-push; `synced_rev` advanced only after a confirmed push).

Snapshots are immutable, so they need none of this — a pushed record can't conflict,
and a pulled one enters via `putSnapshot` and never becomes a push candidate, so a
delete can't be resurrected.

## The provider seam (Drive now, OneDrive/O365 later)

The sync modules depend on **injected providers**, never on `drive.js`. Two small
interfaces, both satisfied today by Google via thin adapters:

**Annotation provider** — `web/src/lib/sync/provider.js` (`createDriveProvider`):

| method | contract |
|---|---|
| `pull()` | `{ data, rev } \| null` (null = no remote yet) |
| `push(data, { expectedRev })` | `{ rev }` on success, or `{ conflict, remote }` if the remote moved |

**Snapshot provider** — `web/src/lib/google/snapshotSyncAdapter.js` (`driveSnapshotProvider`):
`findChild`, `createFolder`, `listChildren`, `getJson`, `putJson`, `deleteFile`.

Auth stays **outside** the provider — the app shell owns sign-in and hands the
sync layer a ready `drive` client.

### To add a provider (e.g. OneDrive / SharePoint / O365)

1. Implement the two small shapes above against the new backend's SDK (a `pull`/`push`
   pair, and the six-method file API). Nothing else in `sync/` changes.
2. Wire it in `ProjectGate` behind the same build flag, injecting the **single**
   shared sidecar resolver into both sync layers (as Drive does) so they can't
   split-brain the container folder.

That's the whole surface. **This is intentionally documented, not built** — a second
provider is YAGNI until one is real. What makes it tractable is the **cut-line**: the
dependency is strictly one-way — the sync modules import the store API and an injected
provider, never the reverse, and nothing in the store core, the canvas, or the Snapshot
panel imports them. The *only* importer is `main.jsx`'s opted-in branch (a dynamic
`import("./lib/sync/composite.js")`). Remove that one branch and delete `web/src/lib/
sync/*` + `web/src/lib/google/snapshotSync*`, and a fully working local-first app
remains with no dangling imports. And because `SnapshotPanel` / `snapshotDiff` / the
store core carry zero Drive references, the upstream/parent repo can cherry-pick the
snapshot feature (`putSnapshot` + the snapshot-sync module) on its own.

## Where things live

| Concern | File |
|---|---|
| Per-project local store, `putSnapshot`, durable meta KV | `web/src/lib/store.js` |
| Annotation reconciler (rev precondition, seed, crash recovery, conflict) | `web/src/lib/sync/syncStore.js` |
| Annotation Drive provider | `web/src/lib/sync/provider.js` |
| Composite assembly + the canvas `syncBridge` | `web/src/lib/sync/composite.js` |
| Snapshot Drive union + its provider adapter | `web/src/lib/google/snapshotSync.js`, `…/snapshotSyncAdapter.js` |
| Canvas defer-gate predicate | `web/src/lib/canvasBusy.ts` |
| The build flag | `web/src/lib/prefs.js` (`cloudSyncEnabled`) |
