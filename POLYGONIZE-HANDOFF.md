# Whole-floor room detection — session handoff (2026-08-05)

> **DELETE THIS FILE BEFORE ANY MERGE TO MAIN.** It is working-session state,
> not product documentation.

## The mission, in Michael's words

Stack-CT / Kreo / Togal-class auto-takeoff "taken a step further": full-floor
(or targeted) room polygons overlaid on the plan, snapped to **real wall
boundaries**, each room **named**, each **assigned to a condition with its
supporting materials** — and accuracy is the non-negotiable bar. He is a
Division-9 flooring estimator; rooms end at door thresholds (transitions live
at the door centerline). Mid-way through the day he made the key architecture
call himself: *"start at the walls and base the floor detection off the
walls"* — that call became wave 4 and is validated.

**Hard requirement (his words): every fix lands in BOTH OpenTakeoff and
Spline.** Spline's `frontend/src/lib/oneclick.js` is an older JS port of the
same engine and its canvas already caches `extractVectorGeometry` output per
sheet — the port is mechanical once OT behavior is right. Port AFTER the OT
side is proven, not in parallel.

## Where everything lives

| Thing | Location |
|---|---|
| Working tree (isolated — do NOT work in `~/dev/opentakeoff`, other sessions use it and once yanked it to main mid-test) | `~/dev/ot-worktrees/polygonize` |
| Branch | `feat/polygonize-whole-floor` — **local only, never pushed, no PR.** No merge until Michael has seen it working at his accuracy bar. |
| Dev server (running, background task) | `npm run dev -- --port 5174 --strictPort` from `<worktree>/web`. **Michael tests at http://localhost:5174** (5173 is dead / belongs to the main checkout). |
| Engine | `web/src/lib/polygonize.ts` (all new) + additive changes to `web/src/lib/oneclick.ts` (dash tracking only) |
| Canvas harness | `web/src/pages/TakeoffCanvas.jsx` — Shift+click with One-Click armed (`o`) |
| Tests | `web/test/polygonize.test.ts` — 22 tests, all green; full gate `npm run check` green (~1320 tests) |
| Test corpus (HIS real bid set — never commit these) | `~/dev/incoming/A121-…`, `A122-…` (enlarged unit plans, 1/4″), `A123-CLUBHOUSE` (3/16″). Overlays: `corpus-A12*.png`; full-res crops: `crop-A121-2BR1*.png` |
| Session harness scripts | `<worktree>/scratch-tools/` — `detect-demo.mts` (headless detection dry-run), `render-rings.mts` (overlay render), `cdp.mjs` (no-deps Chrome CDP driver: nav/shot/click+shift/move/key/eval on port 9222) |
| Memory (long-term) | `~/.claude/.../memory/project_polygonize_whole_floor.md` — same story, compressed |

**Node/shell gotcha:** always `bash -lc 'eval "$(fnm env --shell bash)" && fnm use && …'` — must print v24. Node 25 fails 4 unrelated `localStorage` tests. Never trust a test run without confirming `node -v`.

**Headless scripts:** run from `~/dev/opentakeoff/mcp` (needs its node_modules: pdfjs, @napi-rs/canvas, tsx) but import the **worktree's** libs by absolute path. Copy `.mts` into `mcp/` to run (bare-specifier resolution), delete after.

## Architecture (pipeline, in order)

`hardWallSegments(geom, ws, pitchCapPx, pxPerFt, info?)` — what may be a wall:
1. Drop `SEG_CLIP` (invisible), hatch (`classifyHatchSegs` — pass the mask's `ws` and a pitch cap; canvas deliberately uses 2.25 ft vs the mask's 4/3 ft so tile/ceiling grids read as fill).
2. Curve-run analysis (consecutive `SEG_CURVE` chords chained end-to-start): short-span runs (≤5 ft = door/window swings) dropped and replaced by their chord **only in fallback mode** (`chordFrom` index — in walls mode the chord is excluded so the bridge can seal straight; the diagonal-slice bug); high-bend runs (arclen/span ≥ 1.4 = clouds, scallop chains, circles) dropped outright; gentle radius walls (ratio ≈1.1) kept.
3. **Wall-first (`wallPairFilter`) — wave 4, Michael's architecture:** a stroke bounds a room only if it PAIRS: parallel ±4°, offset 3.5″–18″ (3.5″ floor keeps door leaves off their frames; 2.5″ chase walls are an accepted loss), overlap ≥50% of the shorter **and ≥3.5× the offset** (a keynote box is wall-thickness tall but never RUNS). End caps (both endpoints on proven walls) join. Curve/radius chords auto-wall. **Dashed pairs = existing walls (renovation plans); lone dashed strokes = match lines, dropped.** Coverage guard: paired length < 35% of long solid ink ⇒ fall back to the subtractive set (single-line plans; all pre-wave-4 tests pass via this path). `info.mode` = `"walls" | "linework"`, surfaced in the canvas status message.
4. Forensics: `info.collectPairs = true` → `info.pairs` = every admitted pairing `[ax1,ay1,ax2,ay2,bx1,by1,bx2,by2,offsetPx]`. In the app: set `window.__OT_WALL_DEBUG = true` before Shift+click → `window.__wallDump`.

`detectAllRoomsDetailed(hardSegs, opts)` — faces → rooms (`detectAllRooms` = `.rooms` wrapper):
1. `nodeSegments` (split at crossings/T-junctions) → `snapSegments` (weld, string keys — packed numeric keys collide) → `extendDangles` (heal ≤1 ft) → `bridgeDangles` (door-line seal: MUTUAL-nearest COLLINEAR degree-1 tips ≤6 ft, blocked by crossing ink; collinearity must be inside the nearest-search or double-line jamb tips consume each other) → re-node.
2. `polygonizeFaces` — half-edge face trace; **returns hole rings per face** (a component's outside walk = the hole boundary of the containing face; owner must be bigger than the hole).
3. Filters on **NET area (ring − holes) with hole perimeters** (else nested-rect cavities read as rooms): min area, thinness (2·A/P), round-tag cull (small near-circles = room bubbles).
4. Label binding: `opts.labelPts` (from `roomLabelSeeds(positionedText)`) — each tag binds to the smallest containing face → `RoomFace.labels`; canvas turns single-label rooms into named shapes (label = room number).
5. Island cull: vertex-connected components; keep if component ≥5% of the biggest OR containment chain reaches a kept face.
6. Flags: coverage >0.5 by children, or dominant (> sum of the rest) → `suspectOuter` (red in UI; committing double-counts children — reviewer decides).
7. Region cull with **tag-vouched holes**: a flagged face's ring-minus-holes is annotation territory; a hole is sanctuary only if the sheet's room tags vouch for it; culled parents take descendants. Every cull counted in `culled {tags, floaters}` — never silent.

Canvas (`detectAllRoomsAt`, TakeoffCanvas.jsx): Shift+click → cached segs/meta/`segDashedRef` + `ensureMask().ws` + positioned-text labels → engine (minAreaSf 12) → regions into the EXISTING One-Click `proposal` state (dashed rings, per-vertex edit, hover+⌫ deletes the hovered ring, ⏎ commits one shape per ring on the active condition, origin `polygonize_v1` + `healed`/`door_sealed`/`suspect_outer` flags, per-region `label`). Status message reports counts, mode, culls.

`oneclick.ts` changes (additive only, mask/flood untouched): dash graphics-state tracking (`setDash`, gState `D`, save/restore-correct) → optional `VectorGeometry.dashed` per-segment array.

## Wave history (all commits on the branch)

1. `bc56a7f` — the overnight patch (planar arrangement) + 3 review fixes (suspectOuter flags not drops; string weld keys; pitch-cap parity param).
2. `1c31b0b` — canvas harness (⇧-click → proposal rail, tints, ⌫-hovered).
3. `d087357` — room intelligence: bridgeDangles, tag cull, island cull, tag-vouched region cull, label binding. (529 → 187 spaces on the VA sample, 22 named.)
4. `5d86771` — wall classification: dashed ink, swing→chord, cloud drop, radius keep, wider pitch cap.
5. `8a86b85` — **wall-first** (his call): wallPairFilter + coverage fallback + net-area filters. VA sample mega-face GONE.
6. `53adfbf` — pair forensics + 3.5″ floor.
7. (last) — walls mode excludes swing chords (diagonal-slice fix); full-res review rig.

## Verdict history — read this to understand the bar

Michael rejected wave 1 (noise), wave 3 (keynote boxes ringed, Room 163 missed, hatch jags), and my low-res "strong result" claim on the corpus run (**"extremely sub standard work"** — he was right: my whole-sheet renders were ~quarter-resolution and hid boundary errors he could see at zoom). **Review discipline now: full-resolution crops only** (`renderPng(2)`, crop the region, rings at 1:1 — pattern in `scratch-tools/`, see `crop-A121-2BR1-v2.png`). Never claim boundary quality from a sheet thumbnail. Also: report honestly — he trusts the work more when failures are named with mechanisms.

## Current verified state (Prospect Cove corpus, full gate green)

- All three of his sheets run **wall-first** (72–75% coverage), scales auto-detect, <1 s/sheet.
- Units: rooms detect in all six unit types; dims/notes/title block produce nothing; no false walls from text so far EXCEPT table rows (below).
- **THE OPEN ROOT CAUSE (found at full res): CAPPED JAMBS.** Wall assemblies end in a cap stroke → wall-line endpoints are degree-2 → `bridgeDangles` never fires on properly-drawn double-line plans → interior doors, patio sliders, and window openings stay topologically open → rooms merge and flood out through window bands into dimension zones (his "way out of bounds"). This one mechanism explains most remaining wrongness on his sheets.

## NEXT BUILD (start here): cap-to-cap opening seals

Two short marked cap segments (len ≈ wall thickness, spanning a pair) facing
each other across ≤ ~8 ft of empty space = an OPENING (door/window). Emit two
seal segments joining corresponding cap endpoints (both wall faces) so the
threshold is straight and the assembly stays closed. Orientation-match the
endpoints (inner↔inner, outer↔outer — nearest-per-endpoint works); block if
solid ink crosses the gap; provenance → `sealed` like bridgeDangles. Then
verify on `crop-A121-2BR1` at full res: kitchen/living/laundry must separate,
nothing may leak below the window band. **The same cap-pair geometry, fed to
`buildMask`, is the fix for Michael's daily-driver complaint: plain One-Click
bites a wedge out of rooms with IN-swing doors (out-swing fine). That flood
fix touches the shared engine — verify against `npm run bench`,
engineParity.test.ts, and MCP conformance.**

## Then, ranked

1. **Table/text-row cull** — schedule + area-table rows pair at 7–9″ and ring on both his sheets (A121 toilet-accessory schedule, A123 area schedules). Likely fix at island level (stack of uniform-height sibling faces) or pen-weight demotion — use `collectPairs` forensics first, don't guess.
2. **Tag misbinding** — detail bubbles ("4/A702" → "702") name rooms wrongly on unit plans (room names there are WORDS; numerics are sheet refs). Filter before binding.
3. **Open-plan merges** (A123 clubhouse): lobby+corridor+community are one mass — Modernfold folding partitions + cased openings wider than the bridge. Real design question (Div9 may WANT splits at finish-change lines); discuss with Michael.
4. **Scoring ruler**: A123 prints the architect's per-room SF (clubhouse table total 6,204 SF; we detected 9,537 with the merges). Score detection against the printed schedule each iteration — numbers, not vibes.
5. Known engine debts: collinear partially-overlapping strokes aren't noded; layered-sheet roles (#85) and inset-annotation softening not replicated in hardWallSegments; `wallCoverageLast` is module-level state (ugly, works); coverage threshold 0.35 and bridge 6 ft are unmeasured constants.
6. **Spline port of everything above** (required, after OT proves out).

## Michael-workflow notes

- He tests hands-on; give exact keystrokes (`o`, Shift+click, hover+⌫, ⏎, Esc). Status bar messages are the only feedback he reads.
- Desktop is TCC-blocked for this Terminal — his screenshots reach us via `osascript` Finder-duplicate to `~/dev/incoming` (pattern in memory). Screenshot filenames carry U+202F before "PM".
- Plain One-Click (no Shift) is his production tool today — protect it; nothing in this branch touches the flood path yet.
- He corrected two records today: SAM2 was never finished (don't cite it as a success), and in-swing doors are a real daily pain in One-Click.

## Background processes (as of handoff)

- Vite dev server, worktree, port 5174 (background task in the old session — if dead, restart: `cd ~/dev/ot-worktrees/polygonize/web && bash -lc 'eval "$(fnm env --shell bash)" && fnm use && npm run dev -- --port 5174 --strictPort'`).
- Nothing else. Headless Chrome instances from verification were killed. The three early Explore agents died to 529s hours ago.
