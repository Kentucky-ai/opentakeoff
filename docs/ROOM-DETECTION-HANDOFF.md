# Room detection — handoff

**Status: not shippable. Works on 1 of 4 real sheets. Do not merge anything until it clears the bar below.**

You are picking up One-Click room detection for OpenTakeoff. The estimator who
owns this product has spent months on it and the current behaviour is, in his
words, "a liability" — it returns boundaries that are visibly wrong at walls
and doors, and a boundary he has to inspect costs him more than drawing it by
hand. Read the bar first, then the history, then the plan.

---

## 1. The bar

**Parity with STACK's "Assist Polygon", measured on his own hand takeoffs.
Anything less is not acceptable.** We drove STACK live on the same sheets;
what it does is documented in §4.

Two acceptance criteria, both required:

1. **Accuracy** — within 5% of his hand-traced area. He has said 95–98% is fine
   and he will correct from there.
2. **Trust** — the boundary must be *visibly* right: on the walls, not inset,
   not crossing a partition, closed across doorways. **A polygon that is 2% off
   but visibly wrong at a wall is a FAILURE**, because it forces him to inspect
   every result, which is the entire cost the feature exists to remove.

Criterion 2 is the one that has killed every attempt so far. Optimising area
error while the geometry looks wrong is the trap.

### The standing rule from the owner: **no shortcuts, ever**

Every heuristic tried in this program scored well on the sheet it was measured
on and broke on the next one. If a cheap test and a correct mechanism both
exist, build the mechanism. **Prefer refusing (return null, fall back) over
returning a plausible-looking wrong answer.** Validate on sheets that disagree
with each other, never on one.

---

## 2. What exists right now

Branch: **`feat/ink-classification`** (unmerged; `main` is untouched and stock).

### Built and working

| Thing | Where | State |
|---|---|---|
| **Sub-path identity** | `web/src/lib/oneclick.ts` — `SubPath`, emitted by `extractVectorGeometry` | Solid. Each drawn FIGURE as a contiguous segment range + bbox + closed flag + paint flags + `fillLum`. 100% coverage, exactly once per segment, verified on 3 sheets. Everything below depends on it. |
| **Fill colour** | same, `fillLum` on `SubPath` | Just added, untested downstream. Rec.709 luminance of the fill in force when the figure was built. The mirror of the existing stroke `lum` (#260). |
| **Planar arrangement** | `web/src/lib/arrangement.ts` | Works. weld → split at crossings → half-edge face traversal → `faceAt` / `growRoom` / `roomOutline`. 30–100 ms on real sheets. Exact, not heuristic. |
| **Finish-texture classifier** | `oneclick.ts` — `classifyFleckSegs` | Works, shipped-quality, tested. Figures smaller than `MIN_THICK_FT` in a dense FIELD are floor texture. Cut click fragmentation 38 distinct answers → 11 on one room. |
| **Door-swing machinery** | `oneclick.ts` — `flagNonDoorArcs`, `markPolylineArcs`, `arcClusterFit`, `splitMergedArcs`, `doorLeafCells` | Already exists and is well tested. **You will need this for §5 step 3 — do not rebuild it.** |
| **Scoring harnesses** | session scratchpad, see §6 | Score against the owner's real hand takeoffs and render PROOF images. |

### Built and REMOVED — do not resurrect

`web/src/lib/drawnrooms.ts` — picks a pre-drawn closed figure enclosing the
click ("the drafter already drew the room"). Scored 9/13 within 5% on one sheet
and was **rejected by the owner on sight**: it returns figures that stop short
of walls, cross partitions, and dive into door jamb pockets, because it never
verifies the figure IS the room. It is unwired from the click path. It is left
in the branch only as a record. **A clip path is legitimate *evidence* about a
room boundary; it is not an answer on its own.**

---

## 3. The corpus — use it, do not add to it casually

`~/Desktop/OT-Corpus/` on the owner's machine.

- **`all-goldens.json`** — **124 shapes the owner traced BY HAND across 4 sheets / 8 pages.** This is the answer key. Fields: `sheet_id`, `tag`, `role` (`floor_area` | `deduct`), `sf` (his computed area), `verts` (normalised 0–1), `holes`.
- The four PDFs. **Never commit these to the repo** — real client plans. Only derived, non-identifying fixtures may be committed.

| Sheet | Character | Flood today | Best attempt so far |
|---|---|---|---|
| **Park Community `IA2.01`** | Vector-rich. 427 clip paths, mid-grey (fillLum ≈128) wall poché, heavy stipple, tile grid | 2/13 within 5%, **0/13 usable** | **arrangement: 9/13, visibly correct** |
| **Harlan hotel** (5 pages) | Vector, dense furniture/fixtures. **No mid-grey poché** — fills are black or white only | 1/11 | **0/11 — the open problem** |
| **The View at Deane Hill** | Image underlay + sparse vectors; its clip paths are detail VIEWPORTS, not rooms | 0/3 | 0/3 (correctly refuses) |
| **finishplan-17 (A-500)** | **Pure scan. 0 vectors, 100% image** | n/a | n/a — and **STACK's assist is greyed out here too**, so this lane is not a competitive gap |

**Any change must be scored on Park AND Harlan.** Park alone is how every
previous attempt fooled itself.

---

## 4. How the competition actually does it (researched, not guessed)

### STACK "Assist Polygon" — the bar, driven live

- A **mode** beside Polygon and Rectangle, not a magic button.
- **Vector only.** Greyed out on the scanned sheet with "You must set a scale before measuring". Enabled on Park and Harlan.
- Hover highlights a candidate region; click commits it; clicks accumulate into one measurement (same multi-space model OpenTakeoff already has).
- With the cursor off the drawing it proposes the **whole floor plate**; over a room it narrows to that room.
- **Boundary quality is the bar:** hugs wall faces, wraps alcove notches, goes around door openings. Never inset, never crossing a partition.
- Measured against the owner's hand takeoff on Park: SERVER ROOM 281 SF vs his 272.5 (+3.1%); ASSISTANT MANAGER 119 vs 113.7 (+4.6%); STORAGE 42 vs ~36.4 (+15%). **So parity is achievable — we were at +0.1%, +0.2%, −0.5% on the same rooms with the arrangement.**

### Kreo — published pipeline

Source: <https://www.kreo.net/news-2d-takeoff/floor-plan-recognition-technologies>

1. Image preprocessing (deskew, denoise, patching)
2. Geometry extraction / vectorisation — **wall centerline extraction**, contour detection + polygon approximation
3. Object recognition — deep learning; **interior vs exterior walls distinguished by line thickness**; doors and windows recognised as "critical elements for determining connectivity"
4. **Room segmentation — logically "CLOSING" openings (replacing doors and windows with solid lines), then identifying enclosed areas**
5. Topological analysis — rooms as graph nodes, doors as edges

Implementation: **U-Net** (semantic segmentation) + **Mask R-CNN** (instance detection for doors). Kreo also states it reads native PDF/CAD vector data, not rasterised images.

### Togal.AI

Computer vision / deep learning, explicitly **not a rules-based system**. Claims up to 98% on floor-plan detection. Detects rooms, net vs gross area, wall linear footage, and counts.

### What this tells us

1. **Step 4 is the one we are missing.** Both leaders CLOSE the openings before extracting rooms. Our arrangement is exactly the "identify enclosed areas" substrate; it leaks through doorways because nothing closes them. The owner independently said the same thing: *"we can break polygons at doorways."*
2. **Line thickness is the industry's wall signal** — and it is a signal we have but do not use (pen nibble in `meta >> 4`, plus paired-parallel-line structure, plus `fillLum`).
3. The leaders use ML for recognition. **We do not have to** — but if a rigorous geometric route stalls on Harlan, an ML wall/door segmenter is the industry-standard answer and is a legitimate route, not a defeat.

---

## 5. The plan

### Step 0 — dependency: replace the hand-rolled arrangement with JSTS

The owner has approved new dependencies. **`jsts`** (npm, the JavaScript port of
JTS/GEOS) provides `jsts.operation.polygonize.Polygonizer` — the standard,
battle-tested "linework → polygons" implementation, which correctly handles
dangles and cut edges. It requires **noded** input (edges meeting only at
endpoints); `jsts.noding` does that step.

`arrangement.ts` already does weld + node + face extraction and is passing its
tests, so this is a *validation* move, not a rewrite: run both, compare face
counts and areas on Park, and keep JSTS if it is more robust on Harlan's
denser linework. Do not skip evaluating it — hand-rolled planar topology is
exactly where subtle bugs hide.

### Step 1 — decide what is a WALL, from evidence the file states

This is the blocker. Current code asks *"is this face thin?"* — a geometric
guess that holds on Park and fails on Harlan. Do not tune it. Signals available,
strongest first:

- **`fillLum` on a filled figure** (just added, untested). On Park the wall
  poché is mid-grey (fillLum ≈128, 34 wall-shaped figures) and the finish
  washes are pale — separable. On Harlan there is **no mid-grey at all** (fills
  are 0 or 255), so Harlan's walls are drawn some other way. **First job:
  render Harlan's fills by luminance and LOOK at what its walls actually are.**
- **Pen weight** — `meta[i] >> 4`, the device line width. Kreo uses thickness as
  its wall signal.
- **Paired parallel lines** a wall-thickness apart — a double-line wall is two
  parallel strokes 4–8 in apart with nothing between. `classifyOffsetAnnotationSegs`
  already contains machinery for finding parallel neighbours; read it.
- **Hatched poché** — walls filled with a hatch pattern rather than solid; `classifyHatchSegs` and `hatchFamilies` already identify hatch families.

**Deliver this as a per-segment or per-face CLASS, not a boolean soft bit.**
The core architectural mistake in this codebase (see §7) is that four
classifiers each identify a different thing and then all write the same value.

### Step 2 — arrangement over structural ink only

Feed step 1's wall class to the arrangement. Faces are then rooms and wall
cavities rather than "every tag box and fixture outline".

### Step 3 — CLOSE THE OPENINGS (the missing piece)

Before extracting faces, insert a synthetic edge across every door and window
opening, exactly as Kreo describes. **The door-swing machinery already exists**
(`flagNonDoorArcs`, `arcClusterFit`, `splitMergedArcs`, `doorLeafCells`) — a
swing arc gives you the hinge and the leaf, and therefore the jamb pair to
close between. Also handle cased openings with no swing drawn (a gap in the
wall network bounded by two jamb stubs facing each other).

Record each inserted edge as synthetic so a room's provenance can report which
part of its boundary was inferred — the existing flood already does this via
`sealedPx` / `virtualFrac`; follow that precedent.

### Step 4 — room = face, and multi-room regions

- Click → containing face → room. No seed sensitivity, exact vertices.
- STACK also supports growing a **multi-room region** (it proposes the whole
  floor plate on hover and committed 1,814 SF and 2,882 SF regions spanning
  many rooms). The owner traced a 715 SF multi-branch corridor tile region by
  hand, so this is real work, not an edge case. Faces make it natural: grow
  across non-wall edges, stop at walls.

---

## 6. How to verify — non-negotiable

**The owner cannot and should not trust numbers from a script he cannot open.**
He said so explicitly. Every claim ships with a picture.

`PROOF-*.png` render (harness in the session scratchpad, `show.mjs`): plan
linework faint, **his hand ring in GREEN**, **your result in BLUE when within
5%**, **RED when not**, your ring shrunk 3 px toward its centroid so his stays
visible underneath. Two already exist for reference:
`~/Desktop/OT-Corpus/PROOF-park.png` (mostly blue-on-green — the good case) and
`PROOF-harlan.png` (red everywhere — the failure).

Harnesses in `/private/tmp/claude-501/-Users-sfgprecon/<session>/scratchpad/`
— **copy them into `web/bench/` and make them a real, committed bench target**,
they should not have lived in a temp directory:

- `show.mjs` — the PROOF renderer
- `room.mjs` — arrangement + wall growth, scored per room against the goldens
- `multi.mjs` — any approach vs the flood, per sheet
- `frag.mjs` — **click-stability**: scan a grid of clicks inside a room and count DISTINCT answers. This is the metric that matches the owner's actual complaint ("click two inches over, different number"). Baseline: one room went from 38 distinct answers to 11 with texture classification; STACK is effectively 1.

Also required before any merge: `npm run check` in `web/` (typecheck + lint +
test + build), `npm test` in `mcp/`, `npm run bench` and `npm run bench:callouts`
(MAE must stay 33.8% or the delta must be explained in the PR).

---

## 7. Architectural note — the thing to fix properly

`buildMask` currently does this:

```
oneclick.ts:1507   const soft = classifyHatchSegs(...)     // knows: hatch
oneclick.ts:1517   if (annot[i])  soft[i] = 1;             // knows: annotation ring
oneclick.ts:1522   if (fleck[i])  soft[i] = 1;             // knows: floor texture
oneclick.ts:1528   if (tagbox[i]) soft[i] = 1;             // knows: label box
oneclick.ts:1540   let v = ... soft[si] ? 2 : 1;           // stores: 2
```

Four classifiers each identify a different thing and all write the same number.
By the time the flood sees the mask, hatch, a tag box, stipple and a dimension
string are indistinguishable. **Every heuristic in this program exists to infer
back information that was computed and then discarded one line later.** Carry a
CLASS per segment instead. The `SubPath` work is the foundation for it.

---

## 8. Working agreements with the owner

- **Show, don't tell.** Numbers without a picture are worthless to him.
- **Refuse rather than guess.** A confident wrong answer is worse than "I don't know" — the flood is always available as a fallback.
- He is a working Division 9 estimator; his hand takeoff is ground truth and his ruler is wall-to-wall at the finish face, the ruler he bids.
- He will test in the real app, not in a harness. Wire changes into `TakeoffCanvas.jsx` behind the existing propose → Create gate.
- **Known bug worth its own issue, unrelated but serious:** the app keeps shapes in React state only — `snapshots` in IndexedDB is empty, and a page refresh destroyed a session of his takeoff work. One browser crash away from ruining a bid.

---

## 9. Definition of done

1. **Park ≥ 12/13 within 5%**, every result visibly on the walls in the PROOF image.
2. **Harlan ≥ 9/11 within 5%** on page 1, same visual standard. This is the one that proves it generalises.
3. Deane Hill: correctly **refuses** and falls back rather than returning wrong geometry.
4. Click-stability: one dominant answer for ≥ 90% of clicks inside a room.
5. Doorways closed — no two rooms merged through an opening.
6. Owner drives it in the app on all four sheets and calls it an asset.
