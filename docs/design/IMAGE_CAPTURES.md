# "Captures": a cross-sheet image library in the sidebar

Reshapes image markups on `feat/206-image-annotation` from per-sheet annotations
into a portable **Captures** library. Verified against the branch (file:line refs
are the current worktree). Approved in chat; this is the spec for adversarial
review before implementation.

## Already built this session (uncommitted, verified green)
- Panel row click → `selectMarkup` + `flyToMarkup` (locate/select from the list).
- Re-enterable **Place**: `placingImageId` + cursor-follow with a grab-offset (no
  teleport), centre-on-place via `flyToMarkup`, Esc/commit clear. `onPointerMove`
  `:3644`, `onPointerDown` `:2846`, Place button in the row.
- Permanent double-stroke frame on the canvas image render (`:8390`) — visible when
  deselected.
- Naming: `<sheetBaseLabel>-NN` written into `text`; `author = authorName()`
  stamped; upload uses the file name. `addImageMarkup` `:6462`.
- Memory-only thumbnail (`ensureThumb`, `imgThumbs`) + provenance `title` tooltip
  in the row.

## Current seam (why cross-sheet fails today)
A markup is bound to one sheet by `sheet_id`, enforced in:
1. Panel list + count — `markups.filter(m => panelKeySet.has(m.sheet_id))`
   (`:7949`, `:6920`). ← the seam.
2. `visibleMarkups` — `markups.filter(m => keys.has(m.sheet_id))` (`:1073`).
3. Canvas render — per panel `m.sheet_id === p.key` (`:8265`). ← keep (a capture
   draws on the sheet it currently lives on).
Placement already sets `sheet_id: tp.key` on drop, so a capture CAN change sheets;
it just can't be reached from another sheet. Fix = the panel list (#1).

## Design (v2 — revised after review round 1)

### A. Captures section (Markups tab, below per-sheet annotations)
- Per-sheet list changes to `type !== "image"`. New **Captures** section lists ALL
  `type === "image"` (global, every sheet). Upload button moves into its header.
- Row: `[thumb] name(✎)  ·<sheet badge>·  <relative time>  Place  <◎ trace>
  <caption-toggle>  [link]  🗑`. Drops color/line-style/weight (raster-meaningless).
  Uploads omit the trace + toggle (no source); the row anchors on **Place**, which
  both share — no empty gaps.
- **Sheet badge = current `sheet_id`** (where the capture lives now). When it
  differs from the origin, the trace control reads **"◎ from <src>"** so
  "captured on A, now on B" is legible without hovering; when they match, "◎ Source".
- **Always-on name search** (one `<input>` + `.filter()`, matching the
  `TakeoffsPanel`/`RfiPanel` always-on-filter idiom). The this-sheet/all-sheets
  **scope toggle is CUT to v2** — the list is global (all sheets) and the per-row
  sheet badge already gives at-a-glance "which sheet" legibility, so a scope control
  earns nothing for a handful of captures and risks re-introducing the seam. Add it
  only on real demand.
- **Discoverability:** the per-sheet section's empty state (`:7946`) gains a pointer
  — "Images now live in **Captures** below" — so a user who placed an image doesn't
  lose it when it leaves the annotation list.

### B. Relative timestamps
- Compact natural-language age of `created_at` (`just now`, `2h ago`, `yesterday`,
  `3d ago`, older → a date). Pure helper `relativeAge(iso, nowMs)`.
- Hover `title` → explicit `Aug 25, 2026, 7:58 PM (UTC)` via `absoluteUtc(iso)`.
- **No live tick.** No precedent in the app for a re-render-to-age timer, and a
  top-level 60 s `setState` would re-render the whole ~9,500-line canvas component.
  Accept staleness; the panel re-renders on any interaction and the hover gives the
  exact time. (`imageProvenance` must also switch to `src_sheet_id` — see C.)

### C. Source trace (◎) — captures only
- Capture records `src_sheet_id = panel.key` and
  `src_rect = [[x0/panel.img.w, y0/panel.img.h], [x1/panel.img.w, y1/panel.img.h]]`
  reusing the ALREADY-CLAMPED `x0..y1` from `captureRegionMarkup` (`:6430-6433`).
  NOT the raw stage-px `a`/`b` (carry `xOffset`, unclamped) and NOT `bw`/`bh` (the
  1600px raster size). Uploads omit both. `rs` never enters normalization —
  `renderScalesRef` is pinned to `RENDER_SCALE`, so rect and `at` share one frame.
- **Dedicated navigation — NOT `flyToMarkup`.** `flyToMarkup` resolves `m.sheet_id`
  (the current sheet) and `pendingFlyRef` can only carry a markup id, so it cannot
  express "open the SOURCE sheet and frame a rect." Add `pendingSourceRef =
  {sheet_id, rect, token}` and a mirror of the open-then-center effect (`:2169`) that
  opens `src_sheet_id` (via `openSheets` if not loaded) and centers on the rect
  midpoint by **replicating the transform math at `:5411-5416`** (NOT calling
  `centerOnMarkup`, which centers on `m.at` and then `selectMarkup`s — it can't take
  a synthetic `{sheet_id, rect}`). Flash renders **inside the source panel's `<g>`**
  (same `n * p.img.w` mapping as `:8446`). Transient `sourceFlash` is its OWN
  `useState` — never written onto a markup.
  - **Staleness guard (riskiest new mechanism):** `pendingSourceRef` carries no
    markup id to validate against, so a ref parked in a broadly-keyed effect is a
    latent view-teleport if the source panel never reaches `img.w>0`. Clear it on
    `status==="error"` and with a bounded retry / attempt-token; never leave it set.
  - **Mid-Place guard:** starting a trace while `placingImageId` is set must
    `setPlacingImageId(null)` + clear `placeGrabRef` first, or the riding image drops
    onto the source sheet on the navigation click.
  - `openSheets(…,false)` collapses a side-by-side group (`goToSheet` → `setSheetGroup([])`) — acceptable (the user asked to go to the source), noted.
- `imageProvenance` (`:6501`) must read `src_sheet_id` (fallback `sheet_id` for
  uploads/legacy) — today it reads `sheet_id` and would misreport the origin.

### D. Source caption (toggle) — captures only, DEFAULT OFF
- `source_label: false` by default; a per-row toggle sets it true, its off-state
  clearly styled "off".
- When true, draw a caption **hugging the image frame** — a chip on the top edge,
  attached to the box so it stays inside `hitMarkup`/`halo`/framing — with
  `pointerEvents:"none"` (every child of the image `<g>` is), reading
  `Source: <label> · p.<page>` where page comes from `parseSheetKey(src_sheet_id)`
  (`file`/`page`, already imported `:41`) and `<label>` from `sheetBaseLabel(
  src_sheet_id)`. Explicit legible color (a white/ink-backed chip like the
  text-markup chip — the image render does no dark-mode invert). Anchor it clear of
  the link **badge** at `(x0, y0-9/z)` (`:8457`) and guard a short capture so the
  fixed-screen-size chip doesn't overrun into the bottom-right resize-handle zone.
- **Exports too:** the marked-set PDF's image path gains the caption — but mirror
  the **rotated cloud-chip path (`markedset.js:762`, `rotate: chipRot`), NOT the
  axis-aligned svg text (`:787`)**, because the image path is the rotated-page path
  (`imageDrawParams`); an axis-aligned caption would detach from a rotated capture.
  Derive the label the SAME way as the canvas (`sheetBaseLabel`) so screen and PDF
  agree (`sheets[].label` = `tabLabel` carries a "Level 1 · " prefix — don't use it).
- Uploads: no source → no toggle, no caption.

### Cross-sheet placement (correcting the already-built Place)
- **Place is two cases** (reconciling Kevin's "center on it" hop-fix with cross-sheet
  drop):
  - **On an open sheet (same-sheet reposition):** keep today's behavior —
    `flyToMarkup(m)` centers the view on it + grab-in-place (offset preserves where
    the image sits, no teleport). This is the hop-fix Kevin asked for.
  - **On another sheet (cross-sheet place):** do NOT navigate — enter
    `placingImageId` on the CURRENT sheet and **zero the grab offset** (`dx=dy=0`)
    so the image centers under the cursor on first contact (its `at` from the other
    sheet is meaningless here). Commit message must not claim "the view centered on
    it" in this branch.
  - Branch on `panelKeySet.has(m.sheet_id)` in the Place handler and in the first-
    contact grab (`:3670`).
- **Sync durability:** an image move/resize must stamp `updated_at: nowIso()`, else
  a 3-way sync tie (`created_at` equal) resolves remote-wins and silently reverts
  it. Stamp at the **commit boundaries** — `onPointerUp` (`:3831`, covers both
  `markupMove` at `:3805` and `markupResize`) and the Place commit in `onPointerDown`
  (`:2853`) — NOT the per-frame preview mappers (`:3676`/`:3815`): the house doctrine
  (`:149-157`) is that live-drag preview frames don't stamp, the commit does. The
  preview-mapper approach also misses the ordinary same-sheet `markupMove` drag.

### Capture record — new fields (captures only; uploads omit)
`src_sheet_id: string`, `src_rect: [[n,n],[n,n]]`, `source_label: boolean`.
Additive — ride `markups[]` wholesale (`buildPayload :2194`, hydrate `...m` `:1524`,
`importTakeoff :144`, `merge.js stable()`), **no `ANN_SCHEMA` bump**, old payloads
degrade cleanly (absent → caption off / trace hidden). `contribute.js` excludes
markups, so the new fields cannot leak into the training payload.

## Slices
1. Capture record fields + the correct `src_rect` formula in `captureRegionMarkup`;
   `updated_at` stamps on move/resize; `imageProvenance` → `src_sheet_id`. Pure
   `relativeAge`/`absoluteUtc`/caption-text helpers + node tests.
2. Canvas: source caption (frame-hugging chip, exports to marked-set) + the
   `sourceFlash` overlay in the source panel `<g>`.
3. Place: strip navigation, zero off-sheet grab offset, fix message. Dedicated
   `pendingSourceRef` navigation for ◎ trace.
4. Captures section: split per-sheet (`type !== "image"`) from the global Captures
   list; row (thumb/name/badge/time/Place/trace/toggle/link/delete); Upload moved
   in; always-on **name search** (scope toggle deferred); per-sheet empty-state
   pointer.
5. Live-verify: capture on A, switch to B, place on B; ◎ flashes A's region;
   caption toggles + exports; relative time + hover.

## Review outcome — GO (2 rounds)
Round 1 surfaced 5 blocker/majors (Source-nav, Place-nav, provenance origin, sync
stamp, caption export); round 2 verified the v2 fixes and returned **GO**, with the
refinements now folded in: stamp at commit boundaries not preview mappers; source
centering replicates the transform math (not `centerOnMarkup`); `pendingSourceRef`
staleness guard + mid-Place guard; caption mirrors the rotated chip path (`:762`)
with one label derivation; scope toggle cut to v2. Resolved & confirmed clean:
coordinate frame (formula pinned), schema round-trip (additive, no bump), privacy
(markups excluded from `contribute.js`), `sourceFlash`/`src_rect` load-bearing,
no live-tick. Riskiest remaining item to watch during build: the `pendingSourceRef`
lifecycle.
