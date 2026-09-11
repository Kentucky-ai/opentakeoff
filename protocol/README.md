# Takeoff Protocol v1 — draft

This draft describes the takeoff records OpenTakeoff already writes. It extracts
Measurement, Calibration, Provenance, Evidence, and Review into reusable JSON
schemas. It does not change the canvas, MCP tools, measurements, saved files,
feature gates, or Academy.

The existing writer identifier remains `opentakeoff.takeoff_canvas.v1`. The
proposed identifier is `opentakeoff.takeoff-document.v1`; no application writer
emits it yet. Both profiles describe the current collection names, including
`shapes`, `sheets`, `conditions`, and `approvals`.

- [Field inventory and transport boundaries](INVENTORY.md)
- [Academy compatibility report](ACADEMY_COMPATIBILITY.md)
- [Minimal event vocabulary](EVENTS.md)
- [Compatibility status and follow-on work](COMPATIBILITY.md)
- [Read-only adapter preflight](PREFLIGHT.md)
- [Opt-in document adapters and CLI](ADAPTERS.md)
- [Tracking issue #405](https://github.com/Kentucky-ai/opentakeoff/issues/405)

## Validate this draft

Use Node from the repository's [`.nvmrc`](../.nvmrc). From the repository root:

```sh
npm ci --prefix web
npm ci --prefix mcp
npm ci --prefix protocol
npm run check --prefix protocol
```

The protocol package is private development tooling. It is not imported by the
browser or MCP application and does not publish a new npm package. The test
suite compiles every schema offline, rejects malformed values, and validates
representative records from the existing browser command layer and MCP session.
The [executable transport matrix](COMPATIBILITY.md#executable-transport-matrix)
classifies tested preservation, reader incompatibility and demonstrated loss.
The [read-only preflight](PREFLIGHT.md) gates [opt-in document adapters](ADAPTERS.md)
for a bounded profile. Both directions preserve every JSON value except the
document identifier. Broader compatibility and default-format adoption remain
subsequent steps.

## Contract boundaries

**Structure is not authority.** A JSON schema can check the shape of a human
approval record; it cannot prove a human created it. Existing runtime rules
remain responsible for authority. MCP can transport existing human seals and
mint agent verdicts; it cannot mint a human APPROVED seal or affirm its own
measurements as human-reviewed.

**Method is not actor.** `method: "manual", actor: "agent"` is an existing MCP
record. Missing legacy actor/review fields remain absent during validation.
Current actor strings are claims, not authenticated identities. Unknown values
are retained as unclassified values, never interpreted as human authority.

**Validation changes nothing.** Validators must not coerce values, insert
defaults, strip properties, clamp coordinates, recompute quantities, or normalize
timestamps. Unknown extensions are permitted for compatibility, but their
semantics are not validated. The opt-in adapter copies them intact and checks
preservation; unsupported profile cases return no converted document.

**Geometry has a frame.** Stored `verts_norm` and hole rings are normalized to
their source sheet or composite surface. Values can extend outside 0–1; the
schema retains them. MCP tool inputs use logical image pixels at render scale
2.0 (PDF points × 2). These are distinct from screenshot pixels, CSS pixels,
and device pixels. Calibration is feet per logical image pixel; stored SF/LF
remain imperial even when the display is metric. Validation does not supply
missing source dimensions or claim that a referenced PDF is available.

**Original geometry is evidence.** Preserve `origin.proposed_verts_norm` exactly
when present. It is the recorded machine proposal before human correction, not
necessarily the agent's first-ever draft. It is an exterior trace, not a complete
archive of every intermediate geometry, hole, or curve state. The existing
agent/manual correction fix and remaining limits are documented in [compatibility status](COMPATIBILITY.md).

**Versions have different jobs.** The draft schema version, persisted document
revision, IndexedDB version, browser Git commit, MCP npm version, and Academy
bundle/certificate versions are distinct. This schema-only increment needs no
MCP package bump. Schema `$id` URIs are stable identifiers for offline resolution,
not a claim that these files are already deployed at those URLs.

## Generated schema reference

Run `node protocol/scripts/check-docs.mjs --write` after changing a schema, review
the diff, then run the command without `--write`. CI fails on stale output.

<!--schema-reference-->
| Schema | Declared fields | Schema digest |
|---|---|---|
| [takeoff_canvas.v1 structural profile (draft)](legacy/takeoff-canvas.v1.schema.json) | `schema` | `299752faa877` |
| [Calibration (draft)](v1/calibration.schema.json) | `sheet_id`, `units_per_px`, `scale_source`, `scale_confirmed` | `ed2be0c2bc8a` |
| [Shared value types (draft)](v1/common.schema.json) | `$defs.computed.area_sf`, `$defs.computed.perimeter_lf`, `$defs.computed.count`, `$defs.parentSnapshot.verts_norm`, `$defs.parentSnapshot.verts_norm_holes`, `$defs.parentSnapshot.computed` | `7640cfaec613` |
| [Condition (draft)](v1/condition.schema.json) | `id`, `finish_tag`, `color`, `fill`, `hatch`, `multiplier`, `waste_pct`, `height_ft`, `thickness_in`, `materials`, `materials[].id`, `materials[].name`, `materials[].per`, `materials[].basis`, `materials[].unit`, `materials[].round`, `materials[].note`, `materials[].lib_id`, `materials[].origin_id`, `materials[].inherited`, `roll_setup`, `tile_setup`, `created_at`, `updated_at` | `ac93e013be98` |
| [Existing document collections (draft)](v1/document-fields.schema.json) | `project_name`, `units`, `client_info`, `sheets`, `conditions`, `shapes`, `markups`, `approvals`, `stitches`, `proposals`, `proposals[].id`, `proposals[].label`, `proposals[].rationale`, `proposals[].created_at`, `proposals[].withdrawn_at`, `condition_edit_proposals`, `condition_edit_proposals[].id`, `condition_edit_proposals[].condition_id`, `condition_edit_proposals[].proposed`, `condition_edit_proposals[].rationale`, `condition_edit_proposals[].proposed_at`, `rfis`, `rules`, `sheet_group`, `last_group`, `sheet_tabs`, `sheet_levels`, `layer_overrides`, `condition_columns`, `shape_labels`, `palette`, `provenance_counters` | `8315bdc954b7` |
| [Evidence (draft)](v1/evidence.schema.json) | `schedule_row_tag`, `matched_text`, `seed_norm`, `$defs.assignment.source`, `$defs.assignment.room_tag`, `$defs.assignment.surface`, `$defs.assignment.schedule_sheet`, `$defs.symbol.score`, `$defs.symbol.rotation`, `$defs.symbol.mirrored`, `$defs.symbol.seed`, `$defs.symbol.seed.source`, `$defs.symbol.seed.sheet`, `$defs.symbol.seed.role`, `$defs.symbol.seed.seed_instance`, `$defs.symbol.seed.row`, `$defs.symbol.seed.row.sheet`, `$defs.symbol.seed.row.key`, `$defs.symbol.seed.row.table` | `67b856803f29` |
| [Measurement (draft)](v1/measurement.schema.json) | `id`, `sheet_id`, `condition_id`, `measure_role`, `verts_norm`, `verts_norm_holes`, `computed`, `height_ft`, `label`, `curved`, `cuts_shape_id`, `origin`, `created_at`, `updated_at`, `author`, `updated_by` | `ccb4c2015ee8` |
| [Provenance (draft)](v1/provenance.schema.json) | `method`, `actor`, `seed_norm`, `evidence`, `assignment`, `symbol`, `confidence`, `confidence_factors`, `proposed_verts_norm`, `edits`, `agent_edits`, `derived`, `derived.from_shape_id`, `derived.gross_lf`, `derived.openings_lf`, `derived.between_shape_ids`, `derived.between`, `derived.case`, `derived.gap_in`, `parent_prev`, `hatch_filtered`, `layer_bounded`, `raster_traced`, `edited`, `edited_before_create`, `copied`, `curved`, `gap_bridged_px`, `gap_sealed_px`, `min_pass_px`, `min_pass_delta`, `door_wedges`, `ring_interiors`, `fill_sensitivity`, `net_faces`, `net_starved`, `rule_id`, `seed_shape_id`, `container_shape_id`, `cuts_shape_id`, `proposal_id`, `net_mode` | `30a3f32c91a5` |
| [Review (draft)](v1/review.schema.json) | `$defs.state.reviewed`, `$defs.state.proposed_ts`, `$defs.state.accepted_ts`, `$defs.verdict.id`, `$defs.verdict.actor`, `$defs.verdict.ts`, `$defs.verdict.sheet_id`, `$defs.verdict.at`, `$defs.verdict.shape_id`, `$defs.verdict.text` | `faf9dca2f292` |
| [Composite surface (draft)](v1/stitch.schema.json) | `id`, `name`, `members`, `members[].key`, `members[].dx`, `members[].dy`, `created_at` | `572b0ff30038` |
| [TakeoffDocument v1 (draft)](v1/takeoff-document.schema.json) | `schema` | `3c1069694dcf` |
<!--/schema-reference-->

## Deliberate limits of this first increment

The draft validates known field types, not polygon topology, cross-record
references, quantity correctness, completeness of evidence, or authenticated
identity. Secondary collections such as markups, RFIs, rules, and layout setup
remain preserved objects pending deeper profiles. Acceptance by the existing
permissive importer is not the same as conformance to this structural profile.

The structural tests' identifier substitution remains a schema check. The
separate [opt-in adapter](ADAPTERS.md) adds preflight, target validation and
preservation checks; it does not authorize changing default application saves.
No event log, automatic migration, signature system, credential issuance or
chain infrastructure is introduced here.
