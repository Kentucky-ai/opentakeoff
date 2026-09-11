# Existing record inventory

Baseline: OpenTakeoff `fed45fb`, MCP source 0.9.77. This inventory distinguishes
persisted document fields, session-only state, and purpose-specific exports.
The [generated schema reference](README.md#generated-schema-reference) lists all
fields modeled by this draft, including nested definitions.

## Document and storage

| Existing path or structure | Meaning, writer and reader | Draft treatment and evidence |
|---|---|---|
| `schema` | [store.js](../web/src/lib/store.js) stamps `opentakeoff.takeoff_canvas.v1`; browser exports and MCP `exportPayload` use it. | Existing identifier has a separate [legacy profile](legacy/takeoff-canvas.v1.schema.json). [Current-record tests](test/current-records.test.mjs) check the real writer identifier. |
| `project_name`, `units`, `client_info` | Browser `buildPayload` in [TakeoffCanvas.jsx](../web/src/pages/TakeoffCanvas.jsx) persists project context. MCP exports an empty project name and `imperial`; it is not a complete browser project mirror. | Preserve optional fields; metric is display mode. [Import tests](../web/test/importTakeoff.test.ts), [schema tests](test/schema.test.mjs). |
| `sheets[]` | Persisted calibration rows from browser `buildPayload` and MCP `exportPayload`. This array is not an inventory of every open unscaled PDF. | [Calibration](v1/calibration.schema.json); absent rows do not prove a source is missing. [Session tests](../mcp/test/session.test.ts). |
| `conditions[]`, `condition_columns`, `shape_labels`, `palette` | Conditions configure scope, display, multiplier, waste and materials; browser also persists custom columns, labels and pins. | Condition's core fields are typed; custom collections remain preserved arrays. [Condition columns](../web/src/lib/conditionColumns.js), [shape labels](../web/src/lib/shapeLabels.js), [totals tests](../web/test/totals.test.ts). |
| `shapes[]`, `markups[]` | Measurements and annotations are separate families. Markup type/position/text plus image/source references carry no takeoff quantity. [Canvas writer](../web/src/pages/TakeoffCanvas.jsx), [MCP interfaces/export](../mcp/src/session.ts). | Measurements use a first-class schema. Markups remain opaque objects in this increment. [Source-trace tests](../web/test/sourceTrace.test.ts), [schema tests](test/schema.test.mjs). |
| `approvals[]` | Human seals and agent verdicts share a record family, independent of shapes' review flags. [approvals.js](../web/src/lib/approvals.js), MCP `markVerdict`/`exportPayload`. | [Review verdict definition](v1/review.schema.json); transport is not minting authority. [Approval tests](../web/test/approvals.test.ts), [current-record tests](test/current-records.test.mjs). |
| `proposals[]`, `condition_edit_proposals[]` | Named agent batches and proposed condition diffs. Fields include `id`, `label`, `rationale`, `created_at`, `withdrawn_at`, or `condition_id`, `proposed`, `proposed_at`. [Session](../mcp/src/session.ts), browser proposal acceptance. | Preserve the records and optional times; do not turn a pending diff into the current condition. [Proposal tests](../web/test/proposals.test.ts), [MCP proposal tests](../mcp/test/proposals.test.ts). |
| `rfis[]`, `rules[]` | RFIs carry IDs/numbers, dates, text, response, status, impact flags and optional agent origin/tombstones. Rules cite learned corrections. MCP can import rules to rerun, but `exportPayload` omits rules; RFI export strips tombstones. | Preserve opaque objects without promising all transports preserve them. [rfi.js](../web/src/lib/rfi.js), [rules.ts](../web/src/lib/rules.ts), [RFI tests](../web/test/rfi.test.ts). |
| `sheet_group`, `last_group`, `sheet_tabs`, `sheet_levels`, `layer_overrides` | Browser working state and sheet interpretation from `buildPayload`; MCP emits empty group/tab/level fields and omits layer overrides. | Preserve known shapes, but no claim that an MCP round trip retains workspace state. [Sheet groups](../web/src/lib/sheetGroups.ts), [import tests](../web/test/importTakeoff.test.ts). |
| `stitches[]` | Browser creates `{id, name, members:[{key,dx,dy}], created_at?}`; ID starts `stitch:`. Member offsets use logical image pixels. | [Stitch schema](v1/stitch.schema.json); MCP cannot operate on it and omits it from export. [Stitch tests](../web/test/stitches.test.ts), [archive check](test/current-records.test.mjs). |
| `provenance_counters` | Browser aggregate deletion counts by origin method; contribution export selects its own counters. | Preserved object, not per-event history. [Shape command tests](../web/test/shapeCommands.test.ts), [contribution tests](../web/test/contribute.test.ts). |

## Measurement, calibration, and authorship

| Fields | Existing semantics and authority | Schema and checks |
|---|---|---|
| `id`, `sheet_id`, `condition_id`, `measure_role` | Browser [shape commands](../web/src/lib/shapeCommands.js) and MCP `commit`. Roles: `floor_area`, `deduct`, `linear`, `surface_area`, `count`. IDs are references, not authenticated identity. | [Measurement](v1/measurement.schema.json). [Current-record tests](test/current-records.test.mjs) exercise all five MCP manual roles. [Preflight](PREFLIGHT.md) checks selected active references for the bounded adapter profile. |
| `verts_norm`, `verts_norm_holes`, `computed.area_sf`, `.perimeter_lf`, `.count`, `height_ft` | Normalized exterior/line/point geometry, hole rings, stored quantities, per-wall height. Counts are scale-free. Existing math remains authoritative. | [Measurement](v1/measurement.schema.json), [common values](v1/common.schema.json). [Session](../mcp/test/session.test.ts), [geometry](../web/test/geometry.test.ts), [totals](../web/test/totals.test.ts) checks. |
| `curved`, `origin.curved` | Top-level legacy `curved` means spline control points; modern circular arcs bake vertices and mark `origin.curved`. [curve.js](../web/src/lib/curve.js), [arc.js](../web/src/lib/arc.js). | Preserve both without converting or conflating them. [Current-record tests](test/current-records.test.mjs). |
| `label`, `cuts_shape_id`, `roll_layout`, `tile_layout` | Shape labels; reconciled deduct lineage; per-shape material layout metadata. [shapeCommands.js](../web/src/lib/shapeCommands.js) controls mutations. | Label/cutout keys typed; layout objects retained as extensions pending their own profile. [Shape command tests](../web/test/shapeCommands.test.ts). |
| `created_at`, `updated_at`, `author`, `updated_by` | Creation/edit timestamps and optional self-declared human labels. Browser stamps at real mutations; old/MCP records may omit them. [provenance.js](../web/src/lib/provenance.js). | Optional strings/timestamps, no invented defaults or authentication claims. [Provenance tests](../web/test/provenance.test.ts). |
| `sheets[].units_per_px`, `scale_source`, `scale_confirmed` | Positive feet per logical image pixel. Source labels include standard/calibrated/detected/upp/unknown. MCP-set scale is explicitly unconfirmed. Legacy absent confirmation follows existing behavior. | [Calibration](v1/calibration.schema.json); [session tests](../mcp/test/session.test.ts), [import tests](../web/test/importTakeoff.test.ts). Validation never flips confirmation. |

## Provenance, evidence, and review

| Fields under `shape.origin` unless stated | Existing semantics and source | Schema and evidence |
|---|---|---|
| `method`, `actor` | Independent dimensions. MCP supports manual agent traces; browser also emits `net_v1`, `derived`, and actor `canvas`. `rule` is distinct from agent. [Session](../mcp/src/session.ts), [canvas](../web/src/pages/TakeoffCanvas.jsx). | [Provenance](v1/provenance.schema.json) preserves nonempty unknown strings as unclassified. [Current-record tests](test/current-records.test.mjs). |
| `reviewed`, `proposed_ts`, `accepted_ts` | Human review state and timing, inline on origins; proposal acceptance stamps them. Missing fields do not prove a new human decision. | [Review state](v1/review.schema.json), [reviewState.js](../web/src/lib/reviewState.js), [shapeCommands.js](../web/src/lib/shapeCommands.js). [Current-record tests](test/current-records.test.mjs). |
| `seed_norm`, `evidence.schedule_row_tag`, `.matched_text`, `.seed_norm` | Detection seed or cited basis for an in-canvas agent proposal. [Canvas proposal acceptance](../web/src/pages/TakeoffCanvas.jsx). | [Evidence](v1/evidence.schema.json). Contribution limits strings and fields separately; [contribution tests](../web/test/contribute.test.ts). |
| `assignment.source`, `.room_tag`, `.surface`, `.schedule_sheet` | A schedule-based or asserted finish assignment. MCP `commit` supplies asserted when no cited assignment exists. | [Evidence assignment](v1/evidence.schema.json), [session tests](../mcp/test/session.test.ts), [MEP tests](../mcp/test/mep.test.ts). A label-only count's richer tool result is not all persisted onto its origin. |
| `symbol.score`, `.rotation`, `.mirrored`, `.seed` | Match evidence. Seed can identify instance, detail sheet, or schedule row; fields include sheet, role, row sheet/key/table, and browser `seed_instance`. | [Evidence symbol](v1/evidence.schema.json). [Session writers](../mcp/src/session.ts), [MCP tool tests](../mcp/test/tools.test.ts). |
| `confidence`, `confidence_factors` | Geometry-signal score and named deductions. It prioritizes review; it is not accuracy probability or human approval. | [confidence.ts](../web/src/lib/confidence.ts), [confidence tests](../web/test/confidence.test.ts). Bounds 0–1, no score defaults. |
| `hatch_filtered`, `raster_traced`, `layer_bounded`, `fill_sensitivity`, `gap_bridged_px`, `gap_sealed_px`, `min_pass_px`, `min_pass_delta`, `door_wedges`, `ring_interiors` | Engine receipts: filtering, raster/layer basis, gap sealing, minimum-passage effect, included doorway/ring signals. MCP `floodStamp` and browser one-click commit. | [Provenance](v1/provenance.schema.json), [confidence tests](../web/test/confidence.test.ts), [session tests](../mcp/test/session.test.ts). Not all evidence survives contribution projection. |
| `net_faces`, `net_starved`, `net_mode` | Browser network detection count, starvation boolean, room/field mode. [netroom.js](../web/src/lib/netroom.js), [canvas commit](../web/src/pages/TakeoffCanvas.jsx). | Explicitly modeled despite absence from MCP ShapeOrigin. [Current-record tests](test/current-records.test.mjs). |
| `proposed_verts_norm`, `edited`, `edits`, `edited_before_create`, `copied`, `agent_edits` | Frozen machine ring, human correction flags/tallies, pre-commit correction, copy lineage, and separate agent self-edits. First human edit freezes the pre-edit ring for explicit agent actors or non-manual methods. | [provenance.js](../web/src/lib/provenance.js), MCP `editShape`. [Provenance tests](../web/test/provenance.test.ts), [current-record tests](test/current-records.test.mjs). Agent/manual command preservation and undo/redo are covered. |
| `derived`, `rule_id`, `seed_shape_id`, `container_shape_id`, `proposal_id` | Parent measurement citations, stated openings/gross lengths, paired finish joints, learned-rule seed/container, proposal batch membership. | [Provenance](v1/provenance.schema.json), [rules.ts](../web/src/lib/rules.ts), [MCP proposal tests](../mcp/test/proposals.test.ts), [transition tests](../mcp/test/transitions.test.ts). |
| `cuts_shape_id`, `parent_prev.verts_norm`, `.verts_norm_holes`, `.computed` | Frozen cutout parent for durable restoration, independent of a bounded undo journal. | [Parent snapshot](v1/common.schema.json), [shapeCommands.js](../web/src/lib/shapeCommands.js), [MCP session tests](../mcp/test/session.test.ts). |
| `approvals[].id`, `.actor`, `.ts`, `.sheet_id`, `.at`, `.shape_id`, `.text` | Verdict-family fields outside shape origin. `estimator` is human ink, `agent` is a machine verdict. Optional ts on legacy import. | [Review verdict](v1/review.schema.json), [approvals.js](../web/src/lib/approvals.js), [current-record tests](test/current-records.test.mjs). |

## Separate stores and projections

| Structure | Fields and boundary | Evidence |
|---|---|---|
| Takeoff snapshots | `{id, ts, label, payload, project?}` in IndexedDB; quantity-level compare does not imply stable shape correspondence across redraws. Not embedded automatically in the current takeoff JSON or project archive. The [snapshot compatibility case](COMPATIBILITY.md#executable-transport-matrix) checks exact payloads, IDs, scope and quantity deltas. | [store.js](../web/src/lib/store.js), [revisions.js](../web/src/lib/revisions.js), [store tests](../web/test/store.test.ts), [revision tests](../web/test/revisions.test.ts). |
| PDF revisions | Current/archived bytes with name, hash, revision number and time. A PDF content hash does not automatically bind every shape to that historical asset version. Current project archives carry current bytes only; a fresh-store transfer restarts the PDF at revision 1 and does not restore prior revisions. | [store.js](../web/src/lib/store.js), [store tests](../web/test/store.test.ts). |
| Undo/redo | Bounded command/inverse history; commands may contain pre-edit snapshots. It is not a complete durable event log. | [shapeCommands.js](../web/src/lib/shapeCommands.js), [shape command tests](../web/test/shapeCommands.test.ts). |
| Project archive | `opentakeoff.project_archive.v1`: manifest `{schema, app, created, project_name?, plans, takeoff}` plus PDFs. | [projectArchive.js](../web/src/lib/projectArchive.js), [archive tests](../web/test/projectArchive.test.ts), [current-record tests](test/current-records.test.mjs). |
| Report | `opentakeoff.report.v1`: computed order quantities, waste, material requirements and disclosure, not the editable geometry document. | MCP `exportReport` in [session.ts](../mcp/src/session.ts), [totals.js / reportJson](../web/src/lib/totals.js), [MCP tool tests](../mcp/test/tools.test.ts). |
| Contribution | `opentakeoff.contribution.v2`: derived data and deep-whitelisted evidence. Author/timing and unapproved extra evidence must not leak through a general-purpose protocol export. | [contribute.js](../web/src/lib/contribute.js), [contribution tests](../web/test/contribute.test.ts). |
| Session/transient state | Loaded pdf.js documents, vector/mask caches, rendered panels, current proposal pointer, selection, gesture previews, temporary agent suggestions and bounded journals. | [Session](../mcp/src/session.ts), [canvas](../web/src/pages/TakeoffCanvas.jsx), [session tests](../mcp/test/session.test.ts). Do not serialize these as new durable fields in this increment. |

The inventory names existing paths; its tests provide targeted evidence, not a
claim that every permutation has been validated. Unknown project extensions and
secondary families need the broader corpus before the protocol is declared stable.

## Wall faces, openings and annotation edits

Existing `surface_area` shapes store a plan run in `verts_norm`, a per-shape
`height_ft`, and computed SF/LF. A stepped wall uses multiple height bands;
there is no persisted vertical offset or elevation plane. An annotation can
cite which band a run represents, but it is not a new geometry field.
`cut_out` clips the entire height of the selected run. Partial-height openings
therefore require separate bands. Generic `deduct` shapes subtract floor SF;
this draft does not reinterpret them as wall deductions.

Existing `linear` runs can retain physical gaps as separate polylines.
`derive_base` instead stores a closed perimeter and an unlocated numeric
`origin.derived.openings_lf` allowance. These are different evidence claims.
Clipping a numerically netted perimeter refuses; use explicit installed runs.
The [current-record tests](test/current-records.test.mjs) verify a 54 SF stepped
face, a 3 ft physical opening, actual surviving endpoints, pending review,
structural conformance and undo without adding a role or changing schemas.

`edit_annotation` changes only existing `markups[].text`. Its session-only
inverse stores the previous string; persisted markup geometry, extensions,
links and review records remain untouched. RFI-linked notes refuse this edit.
See the [wire tests](../mcp/test/tools.test.ts). No new durable event is claimed.
