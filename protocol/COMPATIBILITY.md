# Compatibility status

This is the first schema increment, not a stable protocol release or migration
claim. Run `npm run check --prefix protocol` for the exact assertions.

| Case | Evidence in this increment | Remaining work |
|---|---|---|
| Empty browser save and browser add command | Real command records conform to the legacy profile and the proposed structural shape; quantity totals and inputs are unchanged by validation. | Broader persisted corpus and every browser commit path. |
| MCP manual area, deduct, line, wall surface and count | Records produced by Session on the bundled sample plan conform, retain proposal IDs, and remain agent-authored/unreviewed with unconfirmed calibration. | All sweeps, derived tools, revisions and wire-level client profiles. |
| Human correction of `agent_v1` | First and subsequent corrections preserve the frozen proposed ring; review and undo retain existing semantics. | Holes, curve evidence and every correction path. |
| Agent `method: manual` correction | A characterization test reproduces the missing original-geometry freeze. Structural validation leaves the missing field missing. | A separately scoped correctness fix and positive preservation regression before calling this path preservation-compliant. |
| Review and approval | Existing browser human seals remain transportable; MCP `markVerdict` hardcodes agent, and editShape refuses human-reviewed work. | Complete mutation/transport authority matrix, including hostile inputs on the wire. Schema validity itself is never authentication. |
| Legacy curves and browser-only origins | Representative legacy spline, canvas-derived and network-origin records validate without rewriting geometry. | Full historical corpus and geometry-specific semantic checks. |
| Browser stitched archive | Existing archive build/parse preserves composite records, original geometry and unknown extensions verbatim in a synthetic fixture. | MCP omits stitches. Do not label its current import/export path lossless for stitched documents. |
| Invalid data | Schema tests reject malformed tuples, non-finite quantities, invalid scale/confidence/review types and unknown document versions. | Polygon topology, per-role completeness, referential integrity, source availability and quantity recomputation checks. |
| Academy | Source-level compatibility report identifies mismatches. | No adapter or live interoperability proof in this increment. |

## Known preservation gap

In [provenance.js](../web/src/lib/provenance.js), `stampEdit` returns after the
timestamp stamp when `origin.method === "manual"`. MCP `measurePolygon` and
other manual measurement methods use `method: "manual", actor: "agent"`.
Consequently a human correction of that shape does not currently freeze
`proposed_verts_norm`. The characterization test records that fact; its passing
does not mean the desired preservation requirement is satisfied.

Do not fix it by changing the schema to claim that every machine original exists,
and do not backfill a lost original from the corrected geometry. A follow-on
correctness change must preserve method/actor distinctions, cover the real
browser mutation path, and retain undo behavior before adapter admission.

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
