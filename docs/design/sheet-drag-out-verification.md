# Sheet drag-out — live verification

Checked against the running app (Vite dev, Chromium) on the bundled
`demo/sample-finish-plan.pdf` (sheet AF101, detected 1/8" scale, one committed
CPT-1 area) and on a five-sheet local workspace. Synthetic `DragEvent`s with a
real `DataTransfer` were dispatched on the tab chips and the payloads read
back; the OS-level drop into Finder is the one step a synthetic event can't
exercise (CDP cannot drive a native OS drag) — it consumes the same
DownloadURL Chromium's downloads use, and is the first thing to try when
driving the branch by hand.

| Claim | Live result | ✓ |
|---|---|---|
| A tab with ink is draggable; one without isn't | 5-tab workspace: 4 inked tabs `draggable=true`, the un-inked one `false` | ✓ |
| Tooltip invites the drag | `title="Drag this tab out of the app to export the marked sheet"` | ✓ |
| Hover arms; dragstart hands over a real PDF | after `mouseover` + build: `DownloadURL = application/pdf:takeoff-AF101-marked.pdf:blob:…` — fetched the blob: **763,924 bytes, `%PDF-1.7`** (five-sheet workspace: 787,326 bytes) | ✓ |
| Filename is project + sheet, colon-free | `takeoff-AF101-marked.pdf` (unnamed project → `takeoff` fallback) | ✓ |
| Cold drag refuses honestly | un-hovered tab: `defaultPrevented=true`, zero payload types, footer shows *"Preparing the marked sheet — drag again in a moment."*, build kicked off | ✓ |
| Content signature invalidates | unit-tested (geometry edit / new markup / new approval each change it; other sheets don't) | ✓ |
| `text/plain` fallback | set to the filename alongside DownloadURL | ✓ |

**Not exercised live:** the OS drop itself (above), and a stitched-surface
workspace (stitch tabs are out of scope and render `draggable=false` by the
same `isStitchKey` guard the export path uses).

`npm run check` green on Node v24.18.0.
