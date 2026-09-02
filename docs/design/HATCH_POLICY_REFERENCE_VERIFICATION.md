# Hatch-policy reference verification

## Result

The reference policy does not clear OpenTakeoff's real-sheet bar in its current form. This is a captured negative result, not an accuracy claim.

The runner uses `extractVectorGeometry` on the two PDF-backed cases in `web/bench/corpus`. That is the same segment, meta-byte, and luminance output exposed by `get_sheet_vectors`; the MCP parity test separately holds the public verb byte-for-byte against this extraction path.

| Case | Extracted segments | Existing classifier | Reference result |
| --- | ---: | --- | --- |
| `sample-plan` | 6 | 0 soft segments, 0 families | 0 proposals |
| `va-finish-plan` | 71,819 | 25,157 soft segments, 37 families | raw input rejected; filtered proposal timed out after 5 seconds |

The real finish-plan input contains 2,895 zero-length segments. The reference proposal stage rejects the first one as degenerate. Removing only those segments avoids that validation error, but the full-sheet proposal stage does not finish inside the declared five-second budget.

The classification-only comparison is also intentionally unfavorable to the reference. It feeds all 37 families found by the existing classifier perfect lattice metrics, while limiting context to evidence present in the extractor output. All 37 remain `uncertain`. The extractor does not currently emit the trusted group IDs or clip/fill evidence IDs required for a `hatch` decision. Consequently, this reference would soften none of the families that the current classifier handles.

These results leave two unresolved requirements:

1. The proposal stage needs an input adapter that accounts for extractor degenerates and an algorithmic bound suitable for dense real sheets.
2. The classification contract needs evidence the extractor actually supplies, with a held-out comparison against `classifyHatchSegs` before it can be considered a policy.

The retry gate still has only synthetic coverage. This run did not find a real case where today's escalation splits or merges a room, so it does not support integrating the gate into production yet.

## Reproduce

From `web/`:

```sh
npm run bench:hatch-policy-reference -- --output bench/hatch-policy-reference-results.json
```

The exact captured output is committed at [`web/bench/hatch-policy-reference-results.json`](../../web/bench/hatch-policy-reference-results.json). The runner terminates the proposal child after five seconds and records `timeout`; it does not infer completion from silence.
