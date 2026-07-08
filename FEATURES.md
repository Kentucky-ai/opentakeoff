# FEATURES.md — every capability, mapped to its code

The buildable map: what OpenTakeoff does and exactly where each piece lives, so you (or your coding agent) can extend a specific capability without spelunking. The UI for nearly everything is in `web/src/pages/TakeoffCanvas.jsx` (one deliberately monolithic component); the pure logic lives in `web/src/lib/`.

| Capability | What it does | Where the logic lives |
|---|---|---|
| **Ingest** | PDF, image, or `.zip` plan set — unpacked and normalized in-browser, multi-page, up to 4 sheets side-by-side | `web/src/lib/ingest.js`, sheet layout in `TakeoffCanvas.jsx` (`panels`, `panelAt`) |
| **Rendering** | pdf.js raster per sheet + **crisp detail-view**: past ~1.15× zoom the visible region re-renders from vectors at current zoom | render chain + detail-view effect in `TakeoffCanvas.jsx`; pdf.js (`pdfjs-dist`) |
| **Scale** | Auto-detect the drawn scale note per sheet; calibrate from a known dimension; per-sheet memory | `detectScale` in `web/src/lib/sheets.ts`; calibrate flow + `uppFor` in `TakeoffCanvas.jsx` |
| **One-Click Area** | Click inside a room → flood-fill against PDF linework → traced polygon, vertices snapped to true corners. **Hatch-robust:** hatch/poché families are classified and made transparent to an escalated pass, so hatched rooms and tile grids fill to the real walls | `web/src/lib/oneclick.ts` (`extractVectorGeometry` + per-segment meta, `classifyHatchSegs`, `buildMask`, `floodRegion`, `traceRegion`, `snapVertices`) |
| **Manual measure kit** | Area, Rectangle, Linear, Surface-Area (walls), Count, Deduct | tool state machine in `TakeoffCanvas.jsx` (`performClick`, `finishShape`, `commitPoly`/`commitLinear`/`commitSurface`) |
| **45°/90° angle lock + aim cursor** | OS pointer hides on canvas; hairlines + house star are the cursor; in-progress segments lock to the 45° family (4° tolerance, ⇧ = hard lock) and the click commits the on-axis point; star swells, band thickens, chip reads angle + live length | `angleSnap()` in `web/src/lib/geometry.js`; the lock block in `moveCrosshair`, `TakeoffCanvas.jsx` |
| **Endpoint snap** | Cursor snaps to true PDF endpoints (spatial hash of extracted vectors) | `buildSnapGrid`/`nearestSnap` in `web/src/lib/geometry.js`; endpoints from `oneclick.ts` |
| **Conditions** | One finish each: color + CAD hatch, waste %, ×N multiplier, wall height, border thickness | Takeoffs panel (docked, resizable) + `HatchPattern` in `TakeoffCanvas.jsx`; totals math in `web/src/lib/totals.js` |
| **Takeoffs panel at scale** | Filter, natural sort, tag-family grouping (all view-only — hotkeys stay positional), ⌘/⇧ multi-select bulk edit, ⌖ zoom-to-condition, optional compact strip | panel block + `renderCondRow`/`condGroups` in `TakeoffCanvas.jsx`; prefs under `opentakeoff_panel` (localStorage) |
| **Condition library** | Browser-wide reusable templates (appearance, waste, H/T, materials); fresh workspaces seed from it | Library tab in `TakeoffCanvas.jsx`; `loadTemplates`/`saveTemplates` in `web/src/lib/store.js` (meta store key) |
| **Assemblies** | Per-condition supporting materials: coverage rate + basis → order qty rounded up; trowel picker for adhesives | `MaterialsEditor` in `TakeoffCanvas.jsx` (inline in the Takeoffs panel rows); math in `web/src/lib/totals.js` |
| **Totals & report** | Per-condition Floor/Wall/Border SF, LF, EA, SY, with/without waste + materials buy list | `web/src/lib/totals.js`; `web/src/components/ReportPanel.jsx` |
| **Export** | CSV / **Excel (.xlsx)** — four-tab workbook (Conditions / By sheet / Materials / Shapes), SpreadsheetML hand-rolled in-browser and zipped with the bundled fflate / JSON / print / **Marked Set PDF** — marked sheets with the takeoff burned in (colors, clipped hatch, quantity chips, markups) + a legend cover with net totals and a by-sheet breakdown; follows the current light/dark view | export handlers in `ReportPanel.jsx`; `web/src/lib/xlsx.js`; `web/src/lib/markedset.js` |
| **Markups** | Revision clouds, callouts, text notes — separate layer, never counted | markup tools in `TakeoffCanvas.jsx` (`placeMarkup`); `cloudPath` in `web/src/lib/geometry.js` |
| **Dark view (negative print)** | ☾ in the zoom cluster inverts sheet pixels in place (one difference pass, an involution — no filter layers, no re-render) with dark hatch/fill variants baked into the patterns | `invertCanvasPixels` + dark pattern ids in `TakeoffCanvas.jsx` |
| **Persistence** | Autosave to IndexedDB + localStorage; survives reload; nothing uploaded | `web/src/lib/store.js` |
| **Sample plan** | One-click demo: a real (public) medical-center floor finish plan | `web/public/demo/`, load button in the empty state |
| **Optional AI backend** | Pluggable adapter interface for scale/room/finish suggestions; heuristic default, bring your own model | `server/app.py`, `server/adapters/base.py`, `server/adapters/heuristic.py` |

## Tested surface

`cd web && npm test` — `node:test` over the pure math: `web/test/geometry.test.ts` (One-Click pipeline incl. the hatch-robust fill and meta emission), `web/test/canvas-geometry.test.ts` (angle lock, hit-testing, metrics, snap grid), and `web/test/totals.test.ts` (waste, SY, coverage → order quantities, vertical-wall SF).

## Extending it

Start with [`AGENTS.md`](AGENTS.md) for the canvas mental model and conventions (coordinate spaces, imperative cursor layer, SVG color literals), then pick your row above. Typical forks: another trade's conditions and assemblies, a new export format in `ReportPanel.jsx`, or a real model behind `server/adapters/base.py`.
