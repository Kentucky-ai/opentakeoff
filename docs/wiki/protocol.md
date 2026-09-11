# Takeoff Protocol

The writer format remains `opentakeoff.takeoff_canvas.v1`. The proposed
`opentakeoff.takeoff-document.v1` is a draft contract with offline validation,
not a new autosave format. Never rename the schema identifier and call that a
completed migration: transport support, semantic checks and loss handling still
need evidence.

| Contract concern | Canonical source |
|---|---|
| Measurement, Calibration, Provenance, Evidence and Review | [Generated schema reference](../../protocol/README.md#generated-schema-reference) |
| Existing fields, writers, readers and projections | [Field inventory](../../protocol/INVENTORY.md) |
| Conforms versus unsupported, including stitches | [Compatibility status](../../protocol/COMPATIBILITY.md) |
| Differences from Academy's records and trust model | [Academy compatibility report](../../protocol/ACADEMY_COMPATIBILITY.md) |
| Minimal event vocabulary without a new event store | [Draft events](../../protocol/EVENTS.md) |

Actor and drawing method are separate. An agent can draw with a manual tool;
human correction still preserves its original outer ring. Existing missing
history cannot be reconstructed, and outer-ring preservation does not imply a
complete historical snapshot of holes or curves.

Human review, a human approval seal, an agent verdict, confidence and Academy
certification are different claims. Validation checks record structure; it does
not prove who authored or approved it. MCP cannot create a human approval.

Follow the implementation order: schema, compatibility tests, then explicit
opt-in adapters. Preserve inputs, IDs, quantities, originals, extensions and
missing-value meaning; refuse unsupported loss. No default writer migration,
Academy schema change, identity/signature system or storage infrastructure is
part of the draft. Run `npm run check --prefix protocol` when changing it.
