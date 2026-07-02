# FEATURES.md — every capability, mapped to its code

The buildable map: what OpenTakeoff does and exactly where each piece lives, so you (or your coding agent) can extend a specific capability without spelunking. The UI for nearly everything is in `web/src/pages/TakeoffCanvas.jsx` (one deliberately monolithic component); the pure logic lives in `web/src/lib/`.

| Capability | What it does | Where the logic lives |
|---|---|---|
| **Ingest** | PDF, image, or `.zip` plan set — unpacked and normalized in-browser, multi-page, up to 4 sheets side-by-side | `web/src/lib/ingest.js`, sheet layout in `TakeoffCanvas.jsx` (`panels`, `panelAt`) |
| **Rendering** | pdf.js raster per sheet + **crisp detail-view**: past ~1.15× zoom the visible region re-renders from vectors at current zoom | render chain + detail-view effect in `TakeoffCanvas.jsx`; pdf.js (`pdfjs-dist`) |
| **Scale** | Auto-detect the drawn scale note per sheet; calibrate from a known dimension; per-sheet memory | `detectScale` in `web/src/lib/sheets.ts`; calibrate flow + `uppFor` in `TakeoffCanvas.jsx` |
| **One-Click Area** | Click inside a room → flood-fill against PDF linework → traced polygon, vertices snapped to true corners | `web/src/lib/oneclick.ts` (`extractVectorGeometry`, `buildMask`, `floodRegion`, `traceRegion`, `snapVertices`) |
| **Manual measure kit** | Area, Rectangle, Linear, Surface-Area (walls), Count, Deduct | tool state machine in `TakeoffCanvas.jsx` (`performClick`, `finishShape`, `commitPoly`/`commitLinear`/`commitSurface`) |
| **45°/90° angle lock** | In-progress segment locks to the 45° family (4° tolerance, ⇧ = hard lock); the click commits the on-axis point; quiet feedback — hairlines brighten, band thickens, chip reads angle + live length | `angleSnap()` + the lock block in `moveCrosshair`, `TakeoffCanvas.jsx` |
| **Endpoint snap** | Cursor snaps to true PDF endpoints (spatial hash of extracted vectors) | `buildSnapGrid`/`nearestSnap` in `TakeoffCanvas.jsx`; endpoints from `oneclick.ts` |
| **Conditions** | One finish each: color + CAD hatch, waste %, ×N multiplier, wall height, border thickness | condition bar + `HatchPattern` in `TakeoffCanvas.jsx`; totals math in `web/src/lib/totals.js` |
| **Assemblies** | Per-condition supporting materials: coverage rate + basis → order qty rounded up; trowel picker for adhesives | assembly editor in `web/src/components/`; math in `web/src/lib/totals.js` |
| **Totals & report** | Per-condition Floor/Wall/Border SF, LF, EA, SY, with/without waste + materials buy list | `web/src/lib/totals.js`; `web/src/components/ReportPanel.jsx` |
| **Export** | CSV / JSON / print | export handlers in `ReportPanel.jsx` |
| **Markups** | Revision clouds, callouts, text notes — separate layer, never counted | markup tools in `TakeoffCanvas.jsx` (`cloudPath`, `placeMarkup`) |
| **Persistence** | Autosave to IndexedDB + localStorage; survives reload; nothing uploaded | `web/src/lib/store.js` |
| **Sample plan** | One-click demo: a real (public) medical-center floor finish plan | `web/public/demo/`, load button in the empty state |
| **Optional AI backend** | Pluggable adapter interface for scale/room/finish suggestions; heuristic default, bring your own model | `server/app.py`, `server/adapters/base.py`, `server/adapters/heuristic.py` |

## Tested surface

`cd web && npm test` — `node:test` over the pure math: `web/test/geometry.test.ts` (polygon area/perimeter, coordinate transforms) and `web/test/totals.test.ts` (waste, SY, coverage → order quantities).

## Extending it

Start with [`AGENTS.md`](AGENTS.md) for the canvas mental model and conventions (coordinate spaces, imperative cursor layer, SVG color literals), then pick your row above. Typical forks: another trade's conditions and assemblies, a new export format in `ReportPanel.jsx`, or a real model behind `server/adapters/base.py`.
