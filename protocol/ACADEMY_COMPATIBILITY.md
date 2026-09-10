# Academy compatibility report

Read this before changing either protocol. OpenTakeoff baseline: `fed45fb`.
Academy baseline: `e7bb5eb1a5c54a60ad8f03a9f90c59f844cd0217`.
No Academy code, schema, signed bundle, or certificate changes in this increment.

## Different records, different claims

| Concept | OpenTakeoff | Academy | Required boundary |
|---|---|---|---|
| Document | Editable shapes, calibration, scope, review and working state | RunBundle v1.0 with answers, ordered trace, telemetry and integrity | Neither replaces the other. A future bridge is an explicit projection with evidence references. |
| Geometry | Normalized per-sheet/composite vertices; tool calls take image pixels | Quantity answers have item/value/unit and optional room/confidence; tool results may carry geometry in the trace | Quantity rows alone cannot reconstruct an editable takeoff or original/corrected geometry. |
| Scale | Feet per image pixel; stored quantities in SF/LF; metric display is separate | Environment uses pixels per selected unit | Reciprocal conversion is valid only after matching frame and units. Areas square the conversion. |
| Actor | Omitted or declared actor/author, including manual agent traces | Contestant model/harness identity plus self-reported/proctored attestation | A local name is a claim, not a verified signing identity. |
| Review | Human review flag, human seal, and agent verdict are distinct | A certificate asserts a scored competency under stated conditions | Confidence, human approval and certification cannot promote one another. |
| Confidence | Engine signals used to prioritize shape review | Optional quantity-level confidence | Define a meaning before mapping; identical numeric ranges do not establish equivalence. |
| Correction history | Frozen proposed ring, correction counters, snapshots, bounded undo | Ordered observable call/result trace with sequence and relative times | Never fabricate missing calls, timing, or prior geometry from a snapshot. |
| Integrity | No signature required for normal local records | Canonical bundle hash; optional entrant and Academy signatures | Do not rehash or mutate an existing signed bundle when adding document references. |
| Privacy | Contribution export intentionally strips fields and whitelists evidence | Trace fields permit specified redaction; ranked data has its own disclosure rules | Protocol adoption must not broaden a contribution payload or automatically export private project data. |
| Capabilities | Default MCP excludes `one_click` and `detect_rooms` | Engine backend calls `one_click` for room discovery | Require explicit capability/version handling. Do not silently lift the gate or certify a substituted workflow. |
| Composite surfaces | Browser stitches are persisted, but MCP export omits them | Backend operates source sheets and discovered rooms | A stitched document requires a separate, loss-aware adapter design. |

Academy's RunBundle uses `additionalProperties: false` at key levels. Adding a
TakeoffDocument directly to an answer or bundle is not schema-compatible merely
because both are JSON. A separate schema version or permitted trace/artifact
mapping requires Academy review. A valid TakeoffDocument does not constitute a
valid scored run, and a valid scored run does not establish human approval.

## Source evidence

- [RunBundle schema](https://github.com/Kentucky-ai/opentakeoff-academy/blob/e7bb5eb/schema/run-bundle.schema.json): `bundleVersion`, contestant, attestation, task answers, trace, telemetry and integrity.
- [Certificate schema](https://github.com/Kentucky-ai/opentakeoff-academy/blob/e7bb5eb/schema/cert.schema.json): certificate identity, subject, competency, result, evidence and signature.
- [Academy protocol](https://github.com/Kentucky-ai/opentakeoff-academy/blob/e7bb5eb/PROTOCOL.md): trust tiers and certification rules.
- [Environment](https://github.com/Kentucky-ai/opentakeoff-academy/blob/e7bb5eb/src/environment.js): `pxPerUnit` and selected linear units.
- [Engine backend](https://github.com/Kentucky-ai/opentakeoff-academy/blob/e7bb5eb/src/ot-backend.js): `one_click` room discovery.
- [Engine transport](https://github.com/Kentucky-ai/opentakeoff-academy/blob/e7bb5eb/src/ot-mcp-client.js): subprocess setup; extra environment is supplied only when configured.
- [Bundle hashing](https://github.com/Kentucky-ai/opentakeoff-academy/blob/e7bb5eb/src/bundle.js): canonical hash input and excluded integrity fields.
- [OpenTakeoff field inventory](INVENTORY.md): writers, authority and projections on this side.

## Required follow-on checks

Before any bridge ships, test unit/frame conversion, missing geometry/history,
unknown schema versions, privacy projections, signatures remaining verifiable,
and unavailable tool capabilities. Keep both repositories' schemas and signed
artifacts unchanged until an explicit mapping is reviewed. The current protocol
tests do not claim live Academy interoperability.
