# Sheet drag-out

Drag a sheet tab out of the browser and the **marked sheet lands where you
dropped it as a real PDF** — Finder, an email draft, a chat drop zone. The
deliverable of a takeoff is the marked planset; this makes handing one sheet
of it to a GC a single gesture instead of an export dialog and a file hunt.

## Scope

- **In:** plain sheet tabs in the tab strip. A tab whose sheet carries any ink
  (shapes, markups, or approval seals) becomes draggable; dragging it exports
  a **single-sheet marked set** (legend cover + that sheet) via the existing
  `buildMarkedSetPdf` path — the exact renderer the full Marked Set export
  uses, filtered to one sheet. RFI markers on that sheet keep their numbers
  (the linked RFIs ride along); unrelated RFIs don't.
- **Out (deliberately):** stitched-surface tabs. A composite page raises a
  real question — which member-sheet shapes ride a single-"sheet" drag — and
  a silent guess would skew the deliverable. They export through the full
  Marked Set as before.
- **Never changes:** stored data, autosave payloads, the full Marked Set
  export, the report. This feature only *reads* — its one write is a blob URL
  in memory.

## Why hover arms the drag

`dragstart` is synchronous: the file must exist before the drag begins, and a
single-sheet marked PDF takes a second or two to raster. So **hovering a tab
arms it** — the PDF builds in the background and caches as a blob URL keyed by
a content signature (shape ids + computed quantities + markup/approval ids).
Any edit to the sheet invalidates the cache; the next hover rebuilds.

Dragging a tab that isn't armed yet **refuses that drag honestly** (
`preventDefault`) rather than shipping a stale or empty file, kicks off the
build, and says so in the status footer: *"Preparing the marked sheet — drag
again in a moment."*

## Mechanics

- `web/src/lib/dragOut.js` — pure, node-tested: filename sanitizing
  (`dragPart`/`dragFilename`, colon-free because the DownloadURL triple is
  colon-delimited), the `mime:filename:url` payload (`downloadUrlEntry`), the
  content signature, and the blob-URL cache (`createDragCache`, revokes what
  it replaces, coalesces concurrent builds, disposed on unmount).
- `TakeoffCanvas.jsx` — `armSheetDrag` / `onSheetTabDragStart` beside
  `exportMarkedSet` (whose meta/branding wiring they reuse), plus four props
  on the tab chip: `draggable`, `onMouseEnter`, `onDragStart`, `title`.
- `DownloadURL` is Chromium-specific by design — Chromium is where OpenTakeoff
  runs. Other browsers simply get a normal no-file drag; nothing breaks.
- A `text/plain` fallback carries the filename so dropping into a text field
  pastes something sensible.

## Tests

`web/test/dragout.test.ts` — sanitizer edges (colons, hidden-file dots, empty
fallbacks), payload shape, and signature behavior (other sheets ignored;
in-place geometry edits, new markups, and new approvals all invalidate).
