# Opt-in document adapters

The private protocol tooling can convert eligible current canvas JSON to draft
TakeoffDocument v1 and back. **Only the top-level `schema` identifier changes.**
Every other JSON value, key, array order and absent field is checked for exact
preservation. This is a bounded document conversion, not a new autosave format,
MCP import capability, complete history archive or Academy bridge.

Use the pinned Node version and install protocol dependencies. From the
repository root:

```sh
node protocol/scripts/adapt.mjs --to draft /path/takeoff.json /path/takeoff-draft.json
node protocol/scripts/adapt.mjs --to canvas /path/takeoff-draft.json /path/takeoff-restored.json
```

Both commands require a **new output path in an existing directory**. They
leave the input file untouched, refuse existing files and symlinks, and stage
the complete output beside its destination before linking it into place. The
filesystem must support hard links; there is no overwrite fallback. File JSON
is pretty-printed; whitespace is not part of the preservation claim. Temporary
staging data is removed after success or refusal; a cleanup error is reported.

Exit 0 means conversion succeeded (or the input already uses the requested
identifier). Exit 1 means the profile refused the record; no output file is
created. Exit 2 means usage, read, parse or file-output failure. Standard output
contains a JSON report, never the converted document itself. The output file
contains the full document, including private extensions; it is not a redacted
contribution or a public sharing artifact.

## JavaScript contract

[`adaptTakeoff(record, targetSchema)`](src/adapters.mjs) is a pure, synchronous
function. Targets are `opentakeoff.takeoff-document.v1` and
`opentakeoff.takeoff_canvas.v1`. There is no force option or automatic fallback.

| Result | Contents |
|---|---|
| `converted` | Detached `document`, source/target identifiers, source `preflight` report and checked `preservation` report |
| `unchanged` | Same contract and a detached document, with no changed paths; no input object is returned by reference |
| `refused` | Preflight/target issues and `preservation.checked: false`; no `document` property |

Successful preservation reports use `scope: "json-values-except-schema"`,
`changedPaths: ["/schema"]` for conversion (empty for unchanged), and
`droppedPaths: []`. They describe only this conversion. They do not promise
preservation through a later browser import, MCP export or archive operation.
JavaScript prototypes, object aliases and file formatting are outside the JSON
data contract. Unknown keys such as `__proto__` remain ordinary data keys.

The adapter runs the [preflight profile](PREFLIGHT.md) before conversion and
again on the target. It checks complete JSON equality after reversing the sole
permitted identifier change. The original input is never mutated. Unsupported
targets and invalid/unsupported source records produce no partial document.

## Preserved authority and known limits

The profile's unsupported boundaries still apply: composite frames, holes and
cutout receipts, legacy control-point curves, and nonempty rules/markups/RFIs
require later work. Eligible opaque extensions are copied intact. No schema,
actor label, review flag, approval, timestamp, quantity or original geometry is
inferred beyond changing the document identifier.

Preflight warnings remain in the result. Missing legacy count values stay
absent; missing original history is not reconstructed. A derived base with a
40 LF gross trace and 3 LF numeric allowance remains 37 LF. Existing human
review/approval is transported as an unauthenticated claim. The adapter cannot
authenticate it, and MCP still cannot mint human approval.

Current browser and MCP imports **still reject the draft identifier**. Convert
explicitly back to canvas JSON before using those readers. The
[transport matrix](COMPATIBILITY.md#executable-transport-matrix) remains the
authority for downstream limits: an adapter does not repair MCP workspace loss
or restore archive history. Geometry accuracy/topology, quantity correctness,
PDF availability, complete history and authenticated identity remain unverified.
The [Academy compatibility report](ACADEMY_COMPATIBILITY.md) remains unchanged;
neither schema nor signed artifact is altered by this adapter.

## Reproducible evidence

Run `npm run check --prefix protocol` after installing web/MCP/protocol test
dependencies. [Adapter tests](test/adapters.test.mjs) cover both directions,
idempotency, frozen inputs, detached outputs, missing values, opaque extensions,
timestamps, 24 refusal combinations and CLI success/failure paths. Output
collision tests include the source itself, existing files, hard links and,
on POSIX, symlinks. They assert that refusal creates no converted file and
leaves existing bytes intact. CI runs the protocol suite on Linux and Windows
so file-output behavior is exercised on both platforms.

The generated matrix's `adapter-roundtrip` case uses real MCP Session records
on the public sample PDF, two browser geometry corrections, an existing browser
review/seal, and archive/browser/MCP reimport. It asserts 100 SF floor, 4 SF
independent deduction, 10 LF line, 30 SF wall, two 1 EA counts and 37 LF base;
all measurement records and the first machine ring survive. An MCP edit of the
reviewed shape still refuses; requesting an estimator verdict still creates
an agent verdict. These are synthetic transport checks, not independent plan
interpretation or geometry benchmarks.

Next work connects protocol contracts to focused MCP workflows, with measured
tool-selection and completion results. Default writer adoption, additional
geometry profiles, package extraction, signatures and Academy credentials remain
separate decisions.
