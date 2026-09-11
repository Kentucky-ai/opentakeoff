# Takeoff Protocol

The writer format remains `opentakeoff.takeoff_canvas.v1`. The proposed
`opentakeoff.takeoff-document.v1` is a draft contract with offline validation,
not a new autosave format. Never rename the schema identifier and call that a
completed migration: transport support, semantic checks and loss handling still
need evidence.

## Machine-readable MCP resources

MCP 0.9.82 packages the allowlisted draft schemas as read-only resources. Start
at `takeoff://protocol` for the compact index, then read an individual schema at
`takeoff://protocol/{path}` (for example,
`takeoff://protocol/v1/measurement.schema.json`). These resources are available
before a plan is loaded and in staged mode. They are discovery and contract
material; they do not add a validator tool, change a writer, or make a session a
complete `TakeoffDocument`.

The resource URI is a transport address. Each schema keeps its existing `$id`
and relative `$ref` behavior, so the embedded registry can resolve references
offline. An `$id` URL is a stable schema identifier for resolution, not a
promise that the schema is hosted at that URL. The packaged index links back to
this wiki page for conceptual protocol guidance.

The schemas describe record shape and declared relationships. They do not prove
polygon topology, geometry or quantity accuracy, source/PDF availability,
complete history, active-reference integrity, transport preservation, or review
or approval authenticity. Evidence, provenance, and review fields remain
records and claims, not authentication. Unknown extension fields remain opaque.
Secondary families such as markups, RFIs, rules, and layout/workspace data are
not fully semantically validated. `exportPayload()` is a projection: it omits
rules and browser stitches, strips RFI tombstones, and does not represent the
complete browser workspace or project document.

| Contract concern | Canonical source |
|---|---|
| Measurement, Calibration, Provenance, Evidence and Review | [Generated schema reference](../../protocol/README.md#generated-schema-reference) |
| Existing fields, writers, readers and projections | [Field inventory](../../protocol/INVENTORY.md) |
| Conforms versus unsupported, including stitches | [Compatibility status](../../protocol/COMPATIBILITY.md) |
| Inspect or explicitly convert a document | [Preflight](../../protocol/PREFLIGHT.md) and [opt-in adapter CLI](../../protocol/ADAPTERS.md) |
| Differences from Academy's records and trust model | [Academy compatibility report](../../protocol/ACADEMY_COMPATIBILITY.md) |
| Minimal event vocabulary without a new event store | [Draft events](../../protocol/EVENTS.md) |

Actor and drawing method are separate. An agent can draw with a manual tool;
human correction still preserves its original outer ring. Existing missing
history cannot be reconstructed, and outer-ring preservation does not imply a
complete historical snapshot of holes or curves.

Human review, a human approval seal, an agent verdict, confidence and Academy
certification are different claims. Validation checks record structure; it does
not prove who authored or approved it. MCP cannot create a human approval.

Private repository tooling now converts the bounded core profile between canvas
and draft JSON after preflight, target validation and exact preservation checks.
It changes only the schema identifier and writes a separate file; unsupported
records refuse. Browser/MCP readers still require canvas JSON. Conversion does
not establish geometry accuracy or repair downstream transport loss. The CLI is
not a packaged MCP tool; use the canonical adapter guide for commands and limits.

Follow the implementation order: schema, compatibility tests, then explicit
opt-in adapters. Preserve inputs, IDs, quantities, originals, extensions and
missing-value meaning; refuse unsupported loss. No default writer migration,
Academy schema change, identity/signature system or storage infrastructure is
part of the draft. Run `npm run check --prefix protocol` when changing it.
