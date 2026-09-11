# Compatibility status

These are incremental schema and preservation checks, not a stable protocol
release or migration claim. Run `npm run check --prefix protocol` for the exact assertions.

| Case | Evidence in this increment | Remaining work |
|---|---|---|
| Empty browser save and browser add command | Real command records conform to the legacy profile and the proposed structural shape; quantity totals and inputs are unchanged by validation. | Broader persisted corpus and every browser commit path. |
| MCP manual area, deduct, line, wall surface and count | Records produced by Session on the bundled sample plan conform, retain proposal IDs, and remain agent-authored/unreviewed with unconfirmed calibration. | All sweeps, derived tools, revisions and wire-level client profiles. |
| Human correction of `agent_v1` | First and subsequent corrections preserve the frozen proposed ring; review and undo retain existing semantics. | Holes, curve evidence and every correction path. |
| Agent `method: manual` correction | Real MCP records for all five manual measurement roles preserve their pre-gesture vertices through browser geometry/reassignment commands, including live preview, undo and redo. Actor, review state and proposal metadata survive unchanged. A self-revised MCP area also retains its pre-human-correction ring through browser import and project archive reopening. | Holes, curve evidence and broader historical records; this establishes outer-vertex preservation at the existing command boundary. |
| Review and approval | Existing browser human seals remain transportable; MCP `markVerdict` hardcodes agent, and editShape refuses human-reviewed work. | Complete mutation/transport authority matrix, including hostile inputs on the wire. Schema validity itself is never authentication. |
| Legacy curves and browser-only origins | Representative legacy spline, canvas-derived and network-origin records validate without rewriting geometry. | Full historical corpus and geometry-specific semantic checks. |
| Browser stitched archive | Existing archive build/parse preserves composite records, original geometry and unknown extensions verbatim in a synthetic fixture. | MCP omits stitches. Do not label its current import/export path lossless for stitched documents. |
| Wall bands and base openings | Real Session records preserve individual wall-band heights, physically clipped run endpoints and exact undo; no generic floor deduction is minted. | No elevation frame or vertical band offset exists; numeric base allowances have no locations. See the [inventory](INVENTORY.md#wall-faces-openings-and-annotation-edits). |
| Invalid data | Schema tests reject malformed tuples, non-finite quantities, invalid scale/confidence/review types and unknown document versions. | Polygon topology, per-role completeness, referential integrity, source availability and quantity recomputation checks. |
| Academy | Source-level compatibility report identifies mismatches. | No adapter or live interoperability proof in this increment. |

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
2. Build the full compatibility fixture matrix and semantic checks, with explicit
   conforms/needs-adapter/unsupported outcomes.
3. Introduce opt-in pure adapters; preserve inputs, IDs, numeric values, originals,
   extensions and authority. Refuse unsupported loss by default.
4. Build `docs/wiki/`, then shorten AGENTS.md into its router and expose the same
   packaged pages as MCP resources. Generate tool/stage/schema references from
   source and measure whether agent tool selection improves.

Default saved-format adoption, package extraction, identity/signatures, Academy
credentials and optional anchoring remain later decisions. No current gate is
lifted by this schema work.
