# Read-only adapter preflight

`takeoff-document-core.v1` is a **draft eligibility profile for a future
document-envelope adapter**, available as private repository tooling. It accepts
the current canvas and draft document identifiers for inspection. It does not
convert either format, change current browser/MCP writers, or enable MCP to
import the draft format. It is not an MCP tool or a published package.

From the repository root, using the pinned Node version and installed protocol
dependencies:

```sh
node protocol/scripts/preflight.mjs /absolute/path/to/takeoff.json
npm run check --prefix protocol
```

The first command reads one JSON file and prints a JSON report. Exit 0 means
`eligible`; exit 1 means `invalid` or `unsupported`; exit 2 means a usage,
read or JSON parse error. No file is written. The JavaScript entry point is
[`preflightTakeoff(record)`](src/preflight.mjs), sharing the same offline,
non-coercing [schema validator](src/validation.mjs) as the compatibility tests.

## Report contract

| Field | Meaning |
|---|---|
| `profile` | `takeoff-document-core.v1`, independent of the input schema identifier |
| `status` | `invalid` if any error exists, otherwise `unsupported` if any unsupported issue exists, otherwise `eligible` |
| `issues[]` | Severity (`error`, `unsupported`, `warning`), stable code, JSON Pointer path and explanation; source values are not included in messages |
| `notVerified[]` | Geometry accuracy, polygon topology, source availability, quantity recomputation, approval authenticity, history completeness and MCP transport preservation |

Warnings do not prevent eligibility. All reports explicitly list what remains
unverified. `invalid` means failure of this profile, not a claim that the existing
permissive importer rejects the same record. Unknown extensions remain opaque:
eligibility requires a future adapter to copy them intact, not understand them.
Issue paths identify fields and can contain caller-provided extension keys;
review reports before publishing them.

## Supported boundary

The profile checks existing conditions, five measurement roles, calibration,
proposals, condition-edit proposals and existing review records. It requires:

- Structural schema conformance and finite, acyclic JSON data, including
  extensions. Values that JSON serialization would drop or rewrite (such as
  getters, sparse arrays, negative zero, `undefined` or dates) refuse. Inputs
  deeper than 100 nested containers are unsupported.
- Unique IDs within conditions, shapes, calibration rows, proposals, approvals
  and condition-edit proposals. Active condition/proposal references must resolve.
- An explicit `sheets` calibration collection. Dimensional measurements need a
  calibration row; unscaled counts may use an empty collection. A calibration
  row does not prove the PDF is available or that a human confirmed scale.
- At least three distinct vertices for floor areas/independent deductions, two
  for lines/wall surfaces, and one for counts. This is cardinality, not topology.
- A stored area for floor/deduct/surface roles or length for linear roles, with
  nonnegative known quantities. Explicit counts must be positive integers. An
  absent count warns about the existing totals default of one and stays absent.
- A positive shape or fallback condition height for wall surfaces.

Derived base quantities are preserved as stored: a 40 LF traced perimeter minus
3 LF unlocated opening allowances remains 37 LF. Baked arc vertices identified
by `origin.curved` remain ordinary stored geometry. No quantity is recomputed,
no coordinate is clamped, and no timestamp, actor or review default is inserted.

Missing historical source shapes warn; lineage can legitimately outlive deletion
or undo. An explicitly agent-authored, human-edited record without its original
outer ring warns about missing history. No original can be reconstructed here.
Existing human review/approval is an unauthenticated transported claim; passing
preflight never gives MCP authority to create human approval.

## Explicitly unsupported

Nonempty stitches, rules, markups and RFIs; composite measurement frames; legacy
control-point curves (`shape.curved`); hole rings and reconciled cutout receipts
require later profiles. The checks report these boundaries without changing or
discarding records. Missing calibration or surface height also needs resolution.

Workspace metadata and unknown JSON extensions may pass as opaque fields that
a future document adapter must preserve. **This does not promise MCP transport:**
current MCP export drops some document families and workspace fields. Use the
[transport matrix](COMPATIBILITY.md#executable-transport-matrix) for those limits.
An envelope adapter also cannot recover snapshots, earlier PDF bytes, or missing
machine originals from a current document.

## Reproducible evidence

[`test/preflight.test.mjs`](test/preflight.test.mjs) uses real MCP Session commits
on the public sample PDF and actual browser correction/review commands. Frozen
inputs and complete before/after comparisons check read-only behavior. No private
plans, project prices or external services are used.

| Scenario | Expected and asserted |
|---|---|
| Five manual roles plus derived base | Eligible for both identifiers; 100 SF floor, 4 SF independent deduct, 10 LF line, 30 SF wall, two 1 EA counts and 37 LF base remain exact |
| Two browser corrections and review | First machine ring and evidence remain exact; existing human seal unchanged; authentication explicitly unverified |
| Schema-valid defects | Duplicate IDs, dangling active references, insufficient distinct vertices, missing role quantity, negative quantities and fractional counts report errors at the affected paths |
| Unsupported records | Nine family/frame/geometry cases pass the structural schema but refuse this profile; the distinct baked-arc representation remains eligible |
| Deliberate non-guarantees | Collinear area points and an incorrect positive cached area can pass; topology and recomputation explicitly remain unverified |
| CLI | Parseable reports, correct status/exit codes, unchanged source bytes, no source values in messages, and usage/read/parse failures |

The next increment is an **opt-in pure adapter** for this profile, with exact
input preservation and refusal tests. Default saved-format adoption, broader
geometry profiles, authenticated identity and Academy interoperability remain
separate work. The [Academy compatibility report](ACADEMY_COMPATIBILITY.md)
still applies; neither system's schema changes in this increment.
