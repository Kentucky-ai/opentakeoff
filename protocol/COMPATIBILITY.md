# Compatibility status

These are incremental schema and preservation checks, not a stable protocol
release or migration claim. Run `npm run check --prefix protocol` for the exact assertions.

| Case | Evidence in this increment | Remaining work |
|---|---|---|
| Empty browser save and browser add command | Real command records conform to the legacy profile and the proposed structural shape; quantity totals and inputs are unchanged by validation. | Broader persisted corpus and every browser commit path; the matrix below adds actual file/archive transport cases. |
| MCP manual area, deduct, line, wall surface and count | Records produced by Session on the bundled sample plan conform, retain proposal IDs, and remain agent-authored/unreviewed with unconfirmed calibration. | Sweeps, remaining derived tools, revisions and wire-level client profiles; manual file round trips and numeric fixtures are covered below. |
| Human correction of `agent_v1` | First and subsequent corrections preserve the frozen proposed ring; review and undo retain existing semantics. | Holes, curve evidence and every correction path. |
| Agent `method: manual` correction | Real MCP records for all five manual measurement roles preserve their pre-gesture vertices through browser geometry/reassignment commands, including live preview, undo and redo. Actor, review state and proposal metadata survive unchanged. A self-revised MCP area also retains its pre-human-correction ring through browser import and project archive reopening. | Holes, curve evidence and broader historical records; this establishes outer-vertex preservation at the existing command boundary. |
| Review and approval | Existing browser human seals remain transportable; MCP `markVerdict` hardcodes agent, and editShape refuses human-reviewed work. | Complete mutation/transport authority matrix, including hostile inputs on the wire. Schema validity itself is never authentication. |
| Legacy curves and browser-only origins | Representative legacy spline, canvas-derived and network-origin records validate without rewriting geometry. | Full historical corpus and geometry-specific semantic checks; both curve representations now have exact archive/MCP preservation cases below. |
| Browser stitched archive | Existing archive build/parse preserves composite records, original geometry and unknown extensions verbatim in a synthetic fixture. | The executable matrix reproduces MCP loss of stitches and composite calibration, even with both source PDFs loaded. Do not label that path lossless. |
| Wall bands and base openings | Real Session records preserve individual wall-band heights, physically clipped run endpoints and exact undo; no generic floor deduction is minted. | No elevation frame or vertical band offset exists; numeric base allowances have no locations. See the [inventory](INVENTORY.md#wall-faces-openings-and-annotation-edits). |
| Invalid data | Schema tests reject malformed tuples, non-finite quantities, invalid scale/confidence/review types and unknown document versions. | Polygon topology, per-role completeness, referential integrity, source availability and quantity recomputation checks. |
| Academy | Source-level compatibility report identifies mismatches. | No adapter or live interoperability proof in this increment. |

## Executable transport matrix

This table is generated from [the case catalog](test/transport-matrix.json).
[The executable cases](test/transport-matrix.test.mjs) require one implementation
per catalog row and run through the current browser command/import/archive code
and MCP Session/file-import boundary using synthetic geometry on the public sample
PDF. These are transport tests, not a blind geometry benchmark or new runtime
validation. The reviewed [Academy boundaries](ACADEMY_COMPATIBILITY.md) remain
unchanged; no Academy interoperability is claimed.

- **conforms** means the stated fixture and boundary preserve the asserted fields
  and quantities. It does not certify every document or authenticate its author.
- **needs-adapter** means the proposed format needs an explicit mapping before
  the existing reader can accept it. No adapter is implemented here.
- **unsupported** means the current transport refuses the case or loses required
  information. Tests pass by demonstrating that limit; these rows are never
  counted as successful migrations. A future adapter must refuse these paths
  until preservation is implemented and tested.

<!--transport-matrix-->
| Case | Outcome | Tested boundary | Assertion |
|---|---|---|---|
| `manual-roundtrip` | conforms | MCP → browser import → MCP file import | Five manual roles retain records, 100 SF floor, 4 SF independent deduct, 10 LF run, 30 SF wall and 2 EA; repeated import adds nothing. |
| `cutout-roundtrip` | conforms | Reconciled hole through archive and MCP | 100 SF parent becomes 96 SF; the 4 SF receipt is not deducted twice. Hole rings, parent snapshot and proposal survive; deleting the imported receipt restores 100 SF. |
| `derived-base-roundtrip` | conforms | Derived base through MCP import | 40 LF boundary minus 3 LF stated openings remains 37 LF, with source ID and allowance intact; no recomputation as the gross trace. |
| `curves-roundtrip` | conforms | Legacy control points and baked browser arc | Curve flags, vertices, evidence and quantities survive archive and MCP import exactly; no conversion between curve meanings. |
| `review-transport` | conforms | Browser approval and MCP mutation boundary | Correction preserves original outer vertices and evidence; existing approval survives import; MCP verdict stays agent and reviewed geometry refuses editing. |
| `scale-conflict` | unsupported | Merge into conflicting local calibration | Import refuses atomically with source and destination unchanged; no unit conversion inferred. |
| `draft-import` | needs-adapter | Draft document → current import | Draft structure validates but browser and MCP imports reject its identifier; no adapter exists yet. |
| `stitch-mcp` | unsupported | Browser composite → MCP export | Archive retains composite records; MCP omits stitches and composite calibration while retaining shapes referencing the unavailable frame. |
| `extensions-mcp` | unsupported | Whole browser workspace → MCP export | Top-level extensions, project metadata and rules survive archive but not MCP export; shape extensions survive. Imported rules remain in session only. |
| `missing-source` | unsupported | Unloaded source sheet → MCP | Import retains the shape but cannot export its unloaded sheet calibration. Schema validity does not prove source availability. |
<!--/transport-matrix-->

The quantity fixtures independently specify rectangle/hole areas, straight-run
lengths, wall height and counts. Full record equality protects geometry,
calibration, proposal IDs, evidence and originals across supported boundaries.
The negative controls show that duplicate IDs, missing condition/sheet/proposal
references and a changed stored quantity can pass the structural schema. Active
reference assertions and expected quantities detect those defects in this corpus;
there is no general semantic validator in the application yet. Historical lineage
may legitimately reference a removed shape, so these checks do not treat every
historical reference as a live foreign key.

Run `npm run check --prefix protocol`. After intentionally changing a case,
regenerate the table with `node protocol/scripts/check-matrix.mjs --write`;
CI rejects a stale table or a catalog row without a matching executable case.

Remaining coverage includes sweeps, rule application, transitions, full revision
storage, polygon topology, per-role completeness, hostile wire inputs across all
mutations and wider legacy records. The curve case preserves both representations
without reinterpreting them; it does not establish complete hole/curve edit history.

## Agent/manual preservation correction

[provenance.js](../web/src/lib/provenance.js) now recognizes an explicit
`actor: "agent"` independently of the drawing method. The first human correction
freezes the pre-edit `verts_norm` in `proposed_verts_norm`, including when the
method is `manual` or absent. Later edits retain that original and tally human
corrections separately from `agent_edits`. Correction does not create review or
approval. Human manual shapes retain their timestamp-only behavior.

The [current-record tests](test/current-records.test.mjs) exercise real MCP
records through the browser command boundary and exact undo/redo; the
[primitive tests](../web/test/provenance.test.ts) cover deep copies, later edits,
unchanged inputs and actor/method distinctions. These assertions failed before
the fix. Existing lost originals remain missing: neither schema validation nor
this fix can reconstruct geometry discarded by an earlier edit. The field
preserves outer vertices, not a complete historical snapshot of holes or curves.

## Next increments

1. Review this inventory and the [Academy report](ACADEMY_COMPATIBILITY.md).
2. Extend the executable compatibility matrix above to the remaining corpus and
   semantic checks before claiming complete compatibility.
3. Introduce opt-in pure adapters; preserve inputs, IDs, numeric values, originals,
   extensions and authority. Refuse unsupported loss by default.
4. Maintain the [shared wiki](../docs/wiki/README.md), AGENTS.md router and
   packaged MCP resources. Tool/stage/schema references are generated and
   checked against source. Measure tool-selection improvement before claiming
   that reduced discovery cost has been demonstrated.

Default saved-format adoption, package extraction, identity/signatures, Academy
credentials and optional anchoring remain later decisions. No current gate is
lifted by this schema work.
