# Scope collision — two conditions claiming the same floor, as a number that has to read zero

Closes #366. Companion proof with captures from the running app and the real MCP server:
[`scope-collision-verification.md`](scope-collision-verification.md).

## Why

Two conditions can claim the same floor and nothing said so. `detect_rooms` under `CPT-1`,
then a polygon in the same room under `LVT-2` — a second agent, a second session, or the
estimator on a different day — produces two rings over one room, and every total downstream
counts the floor twice. The variants system handles a condition that is *split* on purpose;
it had no answer for two conditions that overlap by accident.

The measurement that catches it already existed in the room eval: an all-pairs shared-floor
check with a hard gate at zero (`web/bench/batch.ts`). It ran in the harness and nowhere the
estimator could see.

## The measurement

One module, `web/src/lib/scopeCollision.js`, read by the MCP verbs and by the canvas badge —
so a headless session and the app can never disagree about what is shared.

- Only committed `floor_area` shapes are compared. A deduct subtracts (it is not a claim), a
  reconciled cut already lives inside its parent's holes, a run has no area.
- Per sheet, every pair whose envelopes touch is intersected **exactly** — JTS overlay, the
  same library `polyarr.ts` builds the wall arrangement with — in sheet px, then scaled to SF
  through that sheet's `units_per_px`². A ring the overlay refuses is repaired once with
  `buffer(0)`; if that yields nothing the shape is reported in `unmeasured` with the reason and
  left out of every number. Never a silent zero.
- A pair on **different conditions** is a *collision*; on the **same condition** a *double
  trace* — a different bug, its own list. Both carry `shared_sf`, `fraction_of_smaller`,
  `iou`, each side's condition / label / review state, and a `look` region (image px, the
  union of both bboxes) for `view_sheet {overlay: true}`.
- The listing floor: a pair is listed when `shared ÷ smaller ≥ min_fraction` (default 0.05 —
  rings that merely kiss along a wall are not claims; 0 lists everything that shares floor).
- **`shared_floor_sf`** — the whole takeoff's number — is Σ areas − area(union) per sheet,
  summed. Counted **once per cell** no matter how many shapes pile on it: summing pairwise
  overlaps triple-counts a three-way pile (the harness learned this in round 9 and this module
  keeps its rule). Always present on `takeoff_summary`, 0 when nothing is shared.
- `SCOPE_DUPLICATE_IOU = 0.5` is pinned equal to the harness's `DUPLICATE_FRAC` by test, and
  a test runs the harness's `batchMetrics` and this module over the same rings and asserts
  the same set of duplicate pairs — the eval gate and the verb agree by construction.

## The verbs

- **`scope_duplicates {sheet?, min_fraction?}`** — read-only. Collisions (biggest shared floor
  first), duplicates, `shared_floor_sf`, `by_sheet`, `unmeasured`.
- **`scope_merge {shape_a, shape_b, winner?}`** — the loser gives up the shared floor:
  - overlap ≥ 98 % of the loser (`SCOPE_NEAR_TOTAL`) → the loser is **deleted** (the same
    space claimed twice, not a room with a sliver left); journaled as a `delete`, so
    `undo_last` re-inserts it at its index.
  - otherwise → the loser is **trimmed** to `loser − winner`, an exact boolean difference
    returning open rings the way `cutout.js` does, quantities from the same
    `polyWithHolesMetrics`; journaled as an `edit`, `undo_last` restores it verbatim;
    `origin.agent_edits` is bumped (an agent revision of pending work).
  - winner: stated, else the reviewed shape over the pending one; refused when neither is
    reviewed and no winner is stated (the verb does not guess which condition the floor
    belongs to) and when both are reviewed (the estimator's call — the badge is theirs).
  - **The ink rule is absolute.** A loser the estimator affirmed is refused whoever is named.
    #366's text allowed a stated winner between two accepted shapes; that would let an agent
    trim ink, which no other verb on this server may do (`edit_shape`, `cut_out`,
    `delete_verdict` all hold the line). The estimator resolves that case in the canvas.
  - a trim that would split the loser into disjoint pieces refuses (a re-trace decision, not a
    merge); a loser carrying reconciled cutouts refuses (trimming would strand their restore
    snapshots).

## The canvas

- A `⚠ N` badge on every condition row that shares floor (N = pairs on that row: a
  cross-condition pair counts on both rows, a double trace once).
- Under the **active** row, the list: `↔ LVT-2 · 212.4 SF shared · 94 %` (or `⧉ double
  trace`), `· both accepted` when neither side is pending, and **Look**, which opens the sheet
  if needed and frames the pair. Look selects nothing — which one wins is the estimator's
  decision, made with the tools they already have (delete, edit).
- Sheets not on canvas have no bitmap dims, so their shapes are unmeasured there (the wire
  measures them from the document); a badge is never a false zero.

## What it never changes

- Totals, exports, the report, sync payloads: nothing new is written. `shared_floor_sf` is a
  computed number on the summary, not stored state.
- No new power over ink.

## Tests

- `web/test/scopeCollision.test.ts` — exact intersections (full, partial, nested, hole,
  three-way once-per-cell), the listing floor, unmeasured reasons, repair of a bow-tie,
  `subtractWinner` remainders (hole, split → null), and the harness agreement.
- `mcp/test/scope.test.ts` — the verbs on the bundled plan: the deliberate 100 % collision,
  the partial one measured exactly, the double trace, `shared_floor_sf` on the summary, trim
  and delete each as one undo step, every refusal (none journals), and a cut parent.
- `mcp/test/conformance.test.ts` — over the wire: the bundled plan's takeoff reads **0**, a
  deliberate collision is caught, merged with the winner stated, and undone in one step.
