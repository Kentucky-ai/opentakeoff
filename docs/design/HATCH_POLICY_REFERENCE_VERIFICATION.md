# Hatch-policy reference verification

## Result

The reference policy does not clear OpenTakeoff's real-sheet bar in its current form. This is a captured negative result, not an accuracy claim.

The runner uses `extractVectorGeometry` on the two PDF-backed cases in `web/bench/corpus` and three pages from the public VA plan sets in `bench/open-sheets`. That is the same segment, meta-byte, and luminance output exposed by `get_sheet_vectors`; the MCP parity test separately holds the public verb byte-for-byte against this extraction path.

| Case | Extracted segments | Existing classifier | Reference result |
| --- | ---: | --- | --- |
| `sample-plan` | 6 | 0 soft segments, 0 families | 0 proposals |
| `va-finish-plan` | 71,819 | 25,157 soft segments, 37 families in 54 ms | raw input rejected; filtered proposal timed out after 5 seconds |
| Dublin A-601 finish plan | 35,538 | 12,950 soft segments, 28 families in 41 ms | raw input rejected; filtered proposal timed out after 5 seconds |
| Roseburg A-03a floor plan | 72,303 | 2,137 soft segments, 35 families in 83 ms | raw input rejected; filtered proposal timed out after 5 seconds |
| Roseburg A-04a RCP | 62,867 | 1,887 soft segments, 23 families in 77 ms | raw input rejected; filtered proposal timed out after 5 seconds |

All four real-sheet inputs contain zero-length segments: 2,895 in the original finish-plan case, 2,026 in Dublin, 727 in Roseburg A-03a, and 604 in Roseburg A-04a. The reference proposal stage rejects the first degenerate segment in each input. Removing only those segments avoids that validation error, but no full-sheet proposal finishes inside the declared five-second budget.

The classification-only comparison is also intentionally favorable on geometry and strict on evidence. It feeds every family found by the existing classifier perfect lattice metrics, while limiting context to evidence present in the extractor output. All 123 family instances across the four real-sheet runs remain `uncertain`. The extractor does not currently emit the trusted group IDs or clip/fill evidence IDs required for a `hatch` decision. Consequently, this reference would soften none of the families that the current classifier handles.

## Review questions from the open sheets

The Dublin sheet visibly contains two finish patterns, including adjacent corridor regions. The reference does not reach a family result. After degenerate filtering it times out, so it cannot answer "two families or one" within the budget. The existing classifier returns 28 family instances, but they are not a stable two-family partition: the dominant diagonal pattern is split among several adjacent angle/pitch buckets. For example, `h-a56.0p1.7w1` appears four times, while nearby 55.5 and 57 degree signatures produce additional instances. This is evidence of fragmentation, not evidence that the two materials were separated correctly.

The Roseburg comparison uses the matching Area A floor-plan and reflected-ceiling-plan pages. The floor plan visibly hatches in-scope rooms while leaving `NO WORK` rooms plain; the RCP uses an orthogonal ceiling grid. The reference again times out on both filtered pages. The existing classifier returns 35 family instances on the floor plan and 23 on the RCP, but the full-page counts do not establish room-versus-grid discrimination. The committed per-instance IDs and bounding boxes make this failure checkable without treating a global family count as semantic accuracy.

These results leave two unresolved requirements:

1. The proposal stage needs an input adapter that accounts for extractor degenerates and an algorithmic bound suitable for dense real sheets.
2. The classification contract needs evidence the extractor actually supplies, plus region-level ground truth for material hatch versus ceiling grid, before it can be considered a policy.

The retry gate still has only synthetic coverage. This run did not find a real case where today's escalation splits or merges a room, so it does not support integrating the gate into production yet.

## Reproduce

From `web/`:

```sh
npm run bench:hatch-policy-reference -- --output bench/hatch-policy-reference-results.json
```

The exact captured output is committed at [`web/bench/hatch-policy-reference-results.json`](../../web/bench/hatch-policy-reference-results.json). The runner terminates the proposal child after five seconds and records `timeout`; it does not infer completion from silence.
