# Minimal event vocabulary — draft only

These names describe existing operations. They are not a new event log, wire
API, replay system, or storage requirement. No existing writer emits them.

| Proposed event | Existing operation | Meaning and limit |
|---|---|---|
| `measurement.created` | Browser add command or MCP commit | A new measurement was committed. Does not imply human review. |
| `measurement.corrected` | Human geometry/reassignment command or agent edit | Identify actor/source and affected measurement explicitly. Human corrections and agent self-revisions remain distinguishable. |
| `measurement.removed` | Delete/withdraw operation | A record was removed; an aggregate deletion counter cannot reconstruct this event. |
| `calibration.changed` | Browser calibration or MCP setScale | A sheet's scale changed. Agent-set scale remains unconfirmed until existing human action confirms it. |
| `review.recorded` | Human proposal acceptance or review action | Preserve affected IDs and the observed decision. An agent verdict is not a human acceptance. |
| `approval.recorded` | Human seal or agent verdict creation | Preserve the approval family's actor. An agent can record its own verdict, never a human seal. |
| `approval.revoked` | Seal/verdict removal | Preserve which existing verdict was revoked and who acted. MCP refuses removal of human seals. |
| `revision.saved` | Existing snapshot save | References a captured revision. Does not imply every earlier operation was logged. |

Any future event representation should reference the affected record and observed
time, identify the actor claim and source, and reference existing before/after
snapshots or evidence when available. It must distinguish a record imported from
another source from a new action performed here. Do not invent timestamps,
authors, or events to fill missing history.

The browser's bounded undo stack and persisted revision snapshots are different
things. Neither proves a complete ordered history. Persistent event emission,
canonical serialization, signatures and replay semantics need a later design.
