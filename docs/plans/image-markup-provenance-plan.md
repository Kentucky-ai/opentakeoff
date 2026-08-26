# Plan — image-markup provenance, naming, thumbnails, placement & audit

Enhancements to the image-markup feature on `feat/206-image-annotation` (PR #206).
Verified against the branch rebased on `main` (2026-08-25); file:line refs are
that tree. **This version is post-adversarial-review** — three reviewers
(data-model/sync, scope/simplicity, UX) rewrote the first draft. Their convergent
findings and the resulting cuts are recorded below.

## Current state (verified)

- Capture (`TakeoffCanvas.jsx:2903-2907`) is a two-click marquee; 2nd click calls
  `captureRegionMarkup`, drops the image **at the marquee centre**, resets to
  select. Upload (`:6091`) drops at view centre. `source` is already
  `"capture"|"upload"`.
- `addMarkup` (`:4998`) already stamps `created_at`; markups carry **no** `author`,
  `name`, or thumbnail.
- Panel row (`:7878`) renders text only → an image row shows `(no text)`; `svg`
  gets a special-cased `(vector symbol)`. The image render branch (`:8340`) never
  paints `m.text`, so a name stored in `text` cannot leak onto the canvas.
- Canvas image render (`:8352-8358`) draws its frame via `halo(...)`, which
  **returns null unless selected** (`:8211`) — so a deselected screenshot is
  visually identical to the sheet under it. **This is the "invisible drop."**
- `deleteMarkup` (`:5175`) is a bare `setMarkups` filter — **not** on the undo
  stack (`undoStackRef` `:571` is shapes-only) and the 🗑 (`:7881`) has no confirm.
- Provenance primitives (`lib/provenance.js`): `authorName()`
  (`localStorage["ot-author"]`, `null` when undeclared), `nowIso()`, `mintUuid()`.
  Author is declarable only via the command line (`author <name>`, `:7483/5779`) —
  no plain GUI field.
- Sync/merge: `markups[]` on a synced project is rewritten by
  `lib/sync/merge.js` (resurrect/union/winner-pick) and can be wiped by the
  remote-wins fallback (`syncStore.js:170`) or an older-build teammate. Wholesale
  replaces — hydrate (`:1508`), Restore, remote-adopt, `importTakeoff` — bypass
  `addMarkup`/`deleteMarkup` entirely.

## Requirements (from Kevin)
1. A real **placement** feel (not an invisible drop over its source).
2. **Thumbnail** in the side panel.
3. **Name** after the source sheet + a sequence number.
4. **Provenance** for capture and upload — who, when taken/uploaded, when placed.
5. An **auditable log** of everything placed or removed.

## Design (post-review minimum)

### 1. Panel thumbnail + name — KEEP (fixes an existing panel gap; ~zero schema)
- **Name** = `"<sheetBaseLabel>-<NN>"`, `sheetBaseLabel` from `labelFor` (the bare
  sheet base, **not** the mutable compound `tabLabel` which yields
  `Level 1 · A-101 · 3-01`). `NN = 1 + count(image markups on same sheet_id)`,
  zero-padded, **collisions tolerated after deletes (NOT called monotonic)** — the
  first draft's `1+count` "monotonic" claim was false (delete 02 of 01/02/03 →
  next = 03, dup). Stored in the **existing `text` field** at creation → the
  existing panel row renders it and the existing ✎ edits it (images aren't `svg`,
  so they already get a ✎). Upload → filename sans extension.
- **Thumbnail** generated at capture/upload as a ~64 px-longest-side JPEG, held in
  a module-level **memory-only** `Map<markupId, dataURL>` (rebuilt from `m.src` on
  load), rendered in the panel row. **Never persisted** — the aggregate gate
  `MAX_IMAGE_MARKUP_BYTES` (16 MB, project-wide) sums `src.length`; a stored thumb
  would eat that budget, and a 40 px `<img src=fullDataURL>` decodes the full
  1600 px source (hundreds of MB of live RGBA across a busy sheet).

### 2. Placement is a first-class, re-enterable action (corrected after live test)
Kevin, testing the branch: "the placement UI sort of functions but I don't see
any way to select the image from the list and then place it — only immediately
after capture do I have the chance to place." That's the real requirement, and the
first draft's "drop-in-place only, ghost-follow is speculative" was wrong. The app
already has every piece; they just aren't wired for image placement.

- **Row click = select + fly-to.** The markups panel row (`:7866`) has NO click
  handler; `flyToMarkup` (`:5374`) exists but is wired only to the RFI register
  (`:7981`). Wire a row click to `selectMarkup(m.id)` + `flyToMarkup(m)` (guarding
  the ✎/🗑/link controls from double-firing) so selecting an image from the list
  locates and selects it on canvas — the same affordance the RFI panel already has.
- **Re-enterable Place/Reposition.** Add a **Place** action on the image row (and
  keep the post-capture placement) that arms a placement mode: the image follows
  the cursor and the next click drops it. Re-placeable at any time, not only in the
  half-second after capture. `armStamp`/`placeStamp` (`:5188/5192`) is the existing
  arm-then-click-to-place precedent to model on. State: one `pendingPlaceId`; Esc
  cancels; clicking the toolbar/panel/another sheet cancels cleanly.
- **Permanent frame.** Render image markups with a **permanent low-weight
  double-stroke frame** (white + ink, thin — legible in both canvas themes, since
  images draw without dark-mode invert) **regardless of selection**, so a placed
  image stays a visible object after deselect instead of vanishing into the sheet
  (the halo is selection-only today, `:8211`).

### 3. `author` on the image record — SIMPLIFY (the defensible "who")
- Stamp `author = authorName()` at creation on both paths (images-only scope).
  Timestamps come from the existing `created_at` (= when placed). Surface
  provenance as a native `title=` tooltip on the panel row, degrading gracefully
  when `author` is null.
- **CUT `source_at` and `src_sheet_id`:** both are provably always-equal to
  `created_at` / `sheet_id` in the shipped flow; add them the day a
  capture-here-place-there flow exists.

### 4. Removed-only audit log — separate append-only store
- Log **removals only** — placements are reconstructable from live records
  (`created_at` + `author`); a parallel `placed` entry is a second source of truth
  that drifts. One hook in `deleteMarkup`. Entry: `{ id: mintUuid(), markup_id,
  name, sheet_id, ts, actor }`.
- **Home = a dedicated append-only IndexedDB store** (new object store beside
  `SNAP_STORE`/`REV_STORE`). This is what "auditable" *requires*, not a costlier
  alternative to it: an array in the synced payload is provably wipeable — the
  sync merge (`merge.js`) never writes it, the remote-wins fallback and an
  older-build teammate can delete it, and wholesale replaces bypass the hooks. A
  store that never round-trips through the merge is the only thing that keeps the
  log intact under sync.
- **Known gap (deferred):** wholesale replaces (Restore, remote-adopt, import) are
  not interactive removals and won't be logged by the `deleteMarkup` hook alone.
  Closing it means reconciling the store against `markups[]` after each wholesale
  replace — real work, out of this slice, but named so it isn't mistaken for done.

### CUT entirely
`source_at`, `src_sheet_id`, monotonic/high-water counter, `placed` entries,
extending author/audit to all markup types.
(Ghost-follow placement is back IN — see §2; Kevin's live test proved it's a
requirement, not speculation.)

## Decisions (made 2026-08-25)
- **Audit home:** dedicated append-only IndexedDB store (§4) — the requirement,
  not the costly option.
- **Delete safety:** add a confirm on the 🗑 / Delete key for image markups (the
  destructive-action pattern conditions already use). Delete stays destructive but
  is no longer a single silent click.
- **Author identity in the UI:** identity is CLI-only today (`author <name>`).
  Expose it as a first-class UI field (a "Your name" input in
  settings/overflow) writing the same `localStorage["ot-author"]` key
  `authorName()` reads. Provenance's "who" then populates for every user, not just
  those who know the command.
- **Scope:** image markups only for this PR; the audit store is keyed generically
  so extending to other markup types later is additive, not a rewrite.

## Still open
- **Audit visibility:** the store surfaces only on inspection/export unless given a
  viewer. Default: export/inspection for this PR; a viewer is a follow-up.

## Slices (tracer-bullet, each builds + node tests green)
1. Name into `text` (pure `markupName(labelFor, sheetId, markups)` helper + tests)
   + `author` stamp on both capture and upload paths.
2. Panel thumbnail (memory-only thumb Map) + name render + `title` provenance
   tooltip. Visual verify.
3. Placement: row click = `selectMarkup` + `flyToMarkup`; re-enterable **Place**
   action (arm → cursor-follow → click to drop, Esc cancels); permanent
   double-stroke frame on the canvas render. Visual verify.
4. Removed-only audit store (new IndexedDB object store) + `deleteMarkup` hook.
   Node test.
5. Delete confirm for image markups (🗑 / Delete key).
6. "Your name" author field in the UI, writing the `ot-author` key.
