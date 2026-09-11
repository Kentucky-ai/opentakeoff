# Compatibility status

These are incremental schema and preservation checks, not a stable protocol
release or migration claim. Run `npm run check --prefix protocol` for the exact assertions.

The [read-only preflight](PREFLIGHT.md) now checks a bounded first adapter
profile: role completeness, active references and calibration, with explicit
unsupported cases and unchanged inputs. It adds no conversion or application
runtime validation. Its eligibility result is distinct from the transport
matrix's boundary-specific outcomes below.

| Case | Evidence in this increment | Remaining work |
|---|---|---|
| Empty browser save and browser add command | Real command records conform to the legacy profile and the proposed structural shape; quantity totals and inputs are unchanged by validation. | Broader persisted corpus and every browser commit path; the matrix below adds actual file/archive transport cases. |
| MCP manual area, deduct, line, wall surface and count | Records produced by Session on the bundled sample plan conform, retain proposal IDs, and remain agent-authored/unreviewed with unconfirmed calibration. | Sweeps, remaining derived tools and wire-level client profiles; manual file round trips and numeric fixtures are covered below. |
| Human correction of `agent_v1` | First and subsequent corrections preserve the frozen proposed ring; review and undo retain existing semantics. | Holes, curve evidence and every correction path. |
| Agent `method: manual` correction | Real MCP records for all five manual measurement roles preserve their pre-gesture vertices through browser geometry/reassignment commands, including live preview, undo and redo. Actor, review state and proposal metadata survive unchanged. A self-revised MCP area also retains its pre-human-correction ring through browser import and project archive reopening. | Holes, curve evidence and broader historical records; this establishes outer-vertex preservation at the existing command boundary. |
| Review and approval | Existing browser human seals remain transportable; MCP `markVerdict` hardcodes agent, and editShape refuses human-reviewed work. | Complete mutation/transport authority matrix, including hostile inputs on the wire. Schema validity itself is never authentication. |
| Legacy curves and browser-only origins | Representative legacy spline, canvas-derived and network-origin records validate without rewriting geometry. | Full historical corpus and geometry-specific semantic checks; both curve representations now have exact archive/MCP preservation cases below. |
| Browser stitched archive | Existing archive build/parse preserves composite records, original geometry and unknown extensions verbatim in a synthetic fixture. | The executable matrix reproduces MCP loss of stitches and composite calibration, even with both source PDFs loaded. Do not label that path lossless. |
| Wall bands and base openings | Real Session records preserve individual wall-band heights, physically clipped run endpoints and exact undo; no generic floor deduction is minted. | No elevation frame or vertical band offset exists; numeric base allowances have no locations. See the [inventory](INVENTORY.md#wall-faces-openings-and-annotation-edits). |
| Invalid data | Schema tests reject malformed tuples, non-finite quantities, invalid scale/confidence/review types and unknown document versions. Preflight adds role completeness and selected active-reference checks for its bounded profile. | Polygon topology, broader references/roles, source availability and quantity recomputation checks. |
| Academy | Source-level compatibility report identifies mismatches. | No adapter or live interoperability proof in this increment. |

## Executable transport matrix

This table is generated from [the case catalog](test/transport-matrix.json).
[The executable cases](test/transport-matrix.test.mjs) require one implementation
per catalog row and run through the current browser command/import/archive/storage code
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
| `transitions-roundtrip` | conforms | Derived transition through archive/MCP | A 10 LF shared edge retains exact geometry, paired source IDs and pending proposal; a six-inch wall gap creates no threshold. |
| `rule-results-roundtrip` | conforms | Rule-generated measurement through archive/MCP | One closed-island deduct retains rule actor, seed/container/proposal IDs and exact quantity; reapplication adds nothing. Rule definitions remain excluded from MCP export. |
| `snapshot-storage` | conforms | Browser snapshot store (in-memory IndexedDB) | 100 SF and corrected 150 SF snapshots retain IDs, timestamps, project scope, extensions and original ring; quantity comparison reports +50 SF. |
| `pdf-revision-storage` | conforms | Browser PDF revision store (in-memory IndexedDB) | Two distinct byte versions retain exact bytes and independently checked SHA-256 hashes; importing identical bytes adds no revision. |
| `archive-history` | unsupported | Full browser history → current project archive | Current takeoff/PDF survives archive transfer; two snapshots and prior PDF bytes do not transfer to a fresh store. Current PDF restarts at revision 1. |
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

The transition case verifies a 10 LF shared edge and its actual endpoints, paired
source IDs and proposal metadata. Six-inch wall separation is withheld without
changing the document. The rule case injects synthetic vector linework into the
sample sheet's mask; it exercises the real rule engine and file-import boundary,
not PDF discovery. A 40×40 px island at 0.1 ft/px is analytically 16 SF; the existing
raster-mask candidate must remain within 2 SF, while its transported geometry and
stored quantity must match exactly. Open linework produces no deduct. The rule's
last-run audit IDs can still name an undone shape; they are historical references,
not a promise that every referenced shape is currently present.

Snapshot and PDF revision cases exercise the real browser storage functions using
isolated in-memory IndexedDB, not a live browser's disk or cloud sync. Snapshot
payloads conform to the takeoff schemas; their outer ID/time/project envelopes
remain separate store records. The project archive preserves the current document
and PDF bytes, but does not carry snapshot history or previous PDF revisions.
Transferring it to a fresh store starts the current PDF at revision 1. An adapter
must not claim to reconstruct those histories from a current document or archive.

Remaining coverage includes sweeps, broader rule/transition cases, cloud revision
sync, polygon topology, completeness beyond the preflight profile, hostile wire inputs across all
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
2. Use the [preflight profile](PREFLIGHT.md) as the first bounded adapter gate;
   extend the matrix for later profiles before claiming broader compatibility.
3. Introduce opt-in pure adapters; preserve inputs, IDs, numeric values, originals,
   extensions and authority. Refuse unsupported loss by default.
4. Maintain the [shared wiki](../docs/wiki/README.md), AGENTS.md router and
   packaged MCP resources. Tool/stage/schema references are generated and
   checked against source. Measure tool-selection improvement before claiming
   that reduced discovery cost has been demonstrated.

Default saved-format adoption, package extraction, identity/signatures, Academy
credentials and optional anchoring remain later decisions. No current gate is
lifted by this schema work.
