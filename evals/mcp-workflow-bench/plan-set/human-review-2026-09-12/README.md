# Human review loop on an agent takeoff, 2026-09-12

The end-to-end path a person follows to review an agent's takeoff in the browser, exercised
against the real app on the bundled sample plan and recorded as ordered screenshots. The
takeoff reviewed is the blind agent run from `../guidance-trial-2026-09-12/after/`. The
walkthrough is the illustrated section "Reviewing an agent's takeoff, start to finish" in
`docs/USER_GUIDE.md`.

What was exercised, in order (`cdp-review-walkthrough.mjs`, run against a Vite dev server
from a throwaway headless Chrome profile, one fresh profile per phase):

1. Open the plan PDF and adopt its own scale note (the import refuses a mismatched calibration).
2. **Import takeoff…**: six agent shapes land dashed, one Accept pill for the batch, all `origin.reviewed: false`.
3. Select a pending ring, nudge one corner: the shape re-prices and is graded as corrected, the agent's ring frozen as `origin.proposed_verts_norm`.
4. Click the batch's Accept pill: all six ink in one step.
5. **Export takeoff…** (`takeoff-after-review.json`), **Export project archive…** (`.otk`), Report, **Download marked set** (2 pages: legend cover + AF101 with the six shapes).
6. In a second, empty browser profile, open the `.otk`: plan, scale, conditions and shapes come back; the sheet gallery opens first because the archive holds two sheets. **Export takeoff…** again (`takeoff-after-reopen.json`).

Checks (`phaseA-log.json`, `phaseB-log.json`, `reopen-compare.json`):

| Check | Result |
|---|---|
| shapes after import / after accept | 6 / 6, all `origin.actor: agent` |
| `origin.reviewed` after Accept | 6 of 6 `true` |
| corrected shapes with the original ring frozen | 1 |
| approval records or stamps in the export | 0 |
| reopen on a clean profile: geometry, review flags, frozen originals and SF identical to the pre-reopen export | yes |
| marked set | 2 pages, 6 takeoff items |

What this does and does not prove. It proves the controls exist, work in the stated order, and
persist through the archive on a clean machine. It does not prove human approval: the Accept
click here was issued by a script in a throwaway browser, which is exactly why the guide says a
takeoff is approved when an estimator clicks Accept in their own browser. Stitching was not
exercised (the sample is a single measured sheet). Cross-machine sync was not exercised; the
archive is a file handoff.
