# The contribution wire format — `opentakeoff.contribution.v2`

This is the normative contract for what leaves the app when a user clicks
**Contribute**, and for what the bundled capture server banks. Two audited
files implement it end to end — [`web/src/lib/contribute.js`](../web/src/lib/contribute.js)
(builds the payload) and [`capture/capture_server.py`](../capture/capture_server.py)
(receives it) — and this document is the ruler both are held to. If the code
and this spec disagree, one of them has a bug.

## 1. Expert demonstrations, not takeoffs

A contribution is not a takeoff — it is a set of **expert demonstrations**: an
estimator (or an agent acting for one) looked at a region, decided what it is,
traced or accepted its boundary, and stood behind the quantities. Humans and
agents both produce demonstrations, and the wire records which was which. The
highest-value rows are the **corrections**: a machine proposed a boundary, a
human fixed it, and both the machine's trace and the expert's final answer
survive side by side. That pair — what the model would have said vs. what the
expert made it say — is precisely the supervision a takeoff model trains on,
and v2 exists to stop flattening it.

## 2. Privacy invariants (normative)

A conforming contribution **MUST NOT** contain:

- the raw PDF, or any rendered image of it;
- file names, sheet names, or any raw sheet identifier (sheets go out as
  `sheet_1`, `sheet_2`, … — positional tokens minted per payload);
- project, client, or customer names;
- markup text or shape-label text (any free text a user typed onto the plan);
- absolute coordinates (geometry is normalized 0..1 against the sheet);
- scale values (`units_per_px` or anything derived from it — only the scale's
  *provenance* rides, e.g. `"calibrated"`);
- edit timing of any kind beyond each shape's `created_at` — no `updated_at`,
  no per-edit timestamps, no gesture data, no dwell times.

One linkage is deliberate and disclosed: shapes and payloads carry **opaque
durable UUIDs**, so repeated contributions from the same document link over
time — a re-contribution after an addendum supersedes rather than duplicates,
and a corpus can follow one shape across revisions. The ids are minted
locally, contain no content, and reverse to nothing; the linkage is the
feature, and this paragraph is its disclosure.

The builder enforces the origin whitelist mechanically (`pickOrigin` in
`contribute.js`): only registered provenance keys leave the machine, never a
spread of whatever a build happened to store.

## 3. `opentakeoff.contribution.v2`

### Envelope

| field | type | presence | meaning |
|---|---|---|---|
| `schema` | string | required | `"opentakeoff.contribution.v2"` |
| `generator` | string | required | `"opentakeoff"` |
| `generator_version` | string | when known | app version inlined at build time |
| `sheets` | array | required | one entry per sheet that carries shapes (below) |
| `conditions` | array | required | anonymized condition labels (below) |
| `shapes` | array | required | the demonstrations (below) |
| `totals` | array | required | per-condition quantity rollup, ids/colors stripped |
| `counters` | object | when non-empty | aggregate provenance tallies, e.g. `{"shapes_deleted": {"one_click_v1": 2}}` |
| `contributor` | string | optional | free-text credit the user typed at the gate |

### `sheets[]`

| field | type | presence | meaning |
|---|---|---|---|
| `sheet` | string | required | positional token (`"sheet_1"`) — never a file name |
| `scale_source` | string | when recorded | how the sheet's scale was established: `"calibrated"` (user drew a known length), `"detected"` (read from the sheet's text and explicitly adopted), `"standard"` (picked from the standard-scale list), `"unknown"` (predates recording). Newer builds may write other strings; consumers treat unrecognized values as opaque. |

No scale *value* ever appears — a sheet's `units_per_px` stays local.

### `conditions[]`

| field | type | meaning |
|---|---|---|
| `finish` | string | the finish tag (`"LVT-9"`) — the label vocabulary |
| `hatch` | string | fill pattern name |
| `multiplier` | number | condition multiplier |
| `waste_pct` | number | waste percentage the estimator tuned |

### `shapes[]`

| field | type | presence | meaning |
|---|---|---|---|
| `role` | string | required | `floor_area` \| `surface_area` \| `linear` \| `count` \| `deduct` |
| `finish` | string | required | joins the shape to its condition label |
| `sheet` | string | required | positional sheet token |
| `verts_norm` | number[][] | required | final geometry, normalized 0..1 |
| `computed` | object | required | the quantities the expert accepted (SF / LF / EA) |
| `height_ft` | number | when set | wall height override |
| `id` | string | when present | opaque durable UUID (see §2) |
| `created_at` | string | when present | ISO-8601 UTC creation stamp; legacy shapes predate stamping and omit it |
| `origin` | object | when present | whitelisted provenance (§5); absent on legacy shapes |

v1's flat `origin_method` string is gone from the wire — the server derives it
from `origin.method` (§4).

### Full example — the provenance triad

One hand-traced shape, one machine proposal accepted verbatim, one machine
proposal the estimator corrected:

```json
{
  "schema": "opentakeoff.contribution.v2",
  "generator": "opentakeoff",
  "generator_version": "0.1.0",
  "sheets": [{ "sheet": "sheet_1", "scale_source": "detected" }],
  "conditions": [
    { "finish": "LVT-9", "hatch": "plank", "multiplier": 1, "waste_pct": 10 }
  ],
  "shapes": [
    {
      "role": "floor_area", "finish": "LVT-9", "sheet": "sheet_1",
      "id": "0f7b8f9e-0000-4000-8000-000000000001",
      "created_at": "2026-07-18T12:00:00.000Z",
      "verts_norm": [[0.05, 0.05], [0.20, 0.05], [0.20, 0.20], [0.05, 0.20]],
      "computed": { "area_sf": 88.0, "perimeter_lf": 40.0 },
      "origin": { "method": "manual" }
    },
    {
      "role": "floor_area", "finish": "LVT-9", "sheet": "sheet_1",
      "id": "0f7b8f9e-0000-4000-8000-000000000002",
      "created_at": "2026-07-18T12:01:00.000Z",
      "verts_norm": [[0.30, 0.30], [0.45, 0.30], [0.45, 0.50], [0.30, 0.50]],
      "computed": { "area_sf": 120.0, "perimeter_lf": 48.0 },
      "origin": { "method": "one_click_v1", "seed_norm": [0.37, 0.40], "reviewed": true }
    },
    {
      "role": "floor_area", "finish": "LVT-9", "sheet": "sheet_1",
      "id": "0f7b8f9e-0000-4000-8000-000000000003",
      "created_at": "2026-07-18T12:02:00.000Z",
      "verts_norm": [[0.60, 0.60], [0.80, 0.60], [0.80, 0.85], [0.60, 0.85]],
      "computed": { "area_sf": 260.0, "perimeter_lf": 62.0 },
      "origin": {
        "method": "one_click_v1", "seed_norm": [0.70, 0.70], "reviewed": true,
        "edited": true, "edits": { "vertex": 2, "move": 1 },
        "proposed_verts_norm": [[0.61, 0.60], [0.79, 0.60], [0.79, 0.83], [0.60, 0.84]]
      }
    }
  ],
  "totals": [],
  "counters": { "shapes_deleted": { "one_click_v1": 1 } }
}
```

### `opentakeoff.contribution.v1` (accepted legacy)

The previous wire: no `sheets` array (a `sheet_count` integer instead), no
per-shape `id`/`created_at`/`origin`, provenance flattened to an optional
`origin_method` string. Servers keep accepting it (§6); rows derived from it
simply lack the v2 columns.

## 4. The capture row — `opentakeoff.capture.v2`

The capture server flattens each contribution into one JSONL row per labeled
shape (`corpus/takeoff_labels.jsonl`). Both wire versions produce v2 rows;
v2-only columns are **key-omitted** on rows a v1 payload produced — absence
means "the wire didn't carry it", never an empty-string placeholder.

| field | presence | meaning |
|---|---|---|
| `ts` | always | server-side ingest time (UTC ISO-8601) |
| `schema` | always | `"opentakeoff.capture.v2"` |
| `sheet` | always | positional sheet token from the payload |
| `measure_role` | always | shape role |
| `verts_norm` / `bbox_norm` | always | WHERE — normalized polygon + its bbox |
| `finish_tag` | always | WHAT — the condition is the label |
| `hatch` / `waste_pct` / `multiplier` | always | the label's tuned parameters |
| `height_ft` | always (may be null) | wall height override |
| `computed` | always | accepted quantities |
| `origin_method` | always | derived: `origin.method`, else v1's flat `origin_method`, else `"unknown"` (§5) |
| `contributor` | always | credit string, `""` if none |
| `contribution` | always | 12-hex prefix of the payload hash — joins the row to its `raw/` archive file |
| `shape_id` | v2, when present | the shape's opaque durable UUID |
| `created_at` | v2, when present | the shape's creation stamp |
| `origin` | v2, when present | the whitelisted origin object, verbatim |
| `scale_source` | v2, when present | joined from the payload's `sheets[]` by the shape's sheet token |
| `generator_version` | v2, when present | app version that built the payload |
| `contribution_schema` | v2, when present | the wire schema the row came from |

### Fingerprint / dedup semantics

Rows are hash-gated by `_fingerprint` — a SHA-1 over the label-relevant tuple
(`verts_norm`, `measure_role`, `finish_tag`, `computed`, `hatch`, `waste_pct`,
`multiplier`, `height_ft`). Re-contributing an unchanged takeoff appends
nothing; retag or reshape and it re-captures. The fingerprint is **deliberately
unchanged from v1** so the upgrade can't double-bank existing corpora — with
one documented consequence: a v2 re-contribution of a shape already banked
from a v1 payload is dup-skipped, so its JSONL row keeps the v1-era columns.
The full v2 payload still lands verbatim in the `raw/` archive, so the richer
provenance is recoverable by re-deriving (delete `state.json` and replay
`raw/` if you want a corpus rebuilt at full v2 fidelity).

### `raw/` archive and mirror discipline

Every distinct payload is archived verbatim at `corpus/raw/<hash>.json` —
the row format can evolve and old contributions re-derive. The optional
`--mirror` copies the label file into a synced share **whole and atomically**
after each write, never live-appending inside a sync folder (append churn
there breeds conflict copies); a wedged share can strand an expendable mirror
thread, never the capture itself.

## 5. Provenance vocabulary

The `origin` object is a registry, not a convention — these are the only keys
the client will send (`pickOrigin` whitelist), and the only keys a consumer
should rely on:

| key | type | meaning |
|---|---|---|
| `method` | string | how the geometry came to exist: `"manual"` (hand-traced) or `"one_click_v1"` (machine flood-fill proposal); `"import"` reserved |
| `actor` | string | omitted = a human at the canvas; `"agent"` = an MCP client committed it |
| `reviewed` | bool | a human affirmed the shape at an explicit gate (e.g. clicked Create on a proposal) |
| `edited` | bool | corrected after Create |
| `edited_before_create` | bool | corrected between proposal and Create (grip drags on the live region) |
| `copied` | bool | pasted clone — carries its source's lineage but no fresh evidence; excluded from correction stats |
| `seed_norm` | [x, y] | normalized one-click seed point |
| `proposed_verts_norm` | number[][] | the machine's original trace, frozen at the first human correction |
| `hatch_filtered` | bool | one-click ran with hatch filtering |
| `raster_traced` | bool | traced from scan pixels rather than vector linework |
| `fill_sensitivity` | number | non-default one-click fill sensitivity |
| `edits` | object | per-kind correction tally, e.g. `{"vertex": 2, "move": 1}` |

**Computing correction magnitude.** For a corrected machine shape
(`proposed_verts_norm` present), the standard measure is **IoU between the
polygon of `proposed_verts_norm` and the polygon of `verts_norm`**: 1.0 means
the human accepted the machine's boundary exactly (only possible on
`edited_before_create` round-trips that ended where they started); lower IoU
means a heavier correction. `edits` gives the gesture-count view of the same
fact; the geometry is the ground truth.

**`origin_method: "unknown"` semantics.** A row whose shape carried neither an
`origin` object nor a v1 `origin_method` string banks as `"unknown"` — the
shape predates provenance stamping, or came from a build that didn't record
it. This is a deliberate change from the v1 server's default of `"human"`:
absence of evidence is not evidence of a hand trace, and a corpus that
defaults unknowns to human would corrupt any human-vs-machine split trained
on it. Treat `"unknown"` as unlabeled, not as manual.

## 6. Versioning policy

- **Within a version, changes are additive.** New optional fields may appear
  on `contribution.v2` payloads and `capture.v2` rows without a schema bump;
  consumers ignore keys they don't know. No field is renamed, retyped, or
  removed within a version.
- **Anything non-additive is a new version** — a new schema string, never a
  mutation of the old one.
- **Servers accept N and N−1.** The bundled capture server accepts
  `contribution.v2` and `contribution.v1` and rejects everything else with
  HTTP 400. When v3 exists, v1 falls off.

## 7. Scope boundary

This spec covers exactly what the explicit **Contribute** gate emits: a
final-state snapshot, sent only when a user clicks the button, containing only
the fields above. The ambient event-stream edition — rows banking on autosave
and commit, deletion records with geometry, decision trails, rejected
proposals and their dismissal context, per-edit timing — is the commercial
capture layer inside [Spline](https://spline.quisutdeus.io), and its schemas
are deliberately not specified here. The boundary is drawn on purpose and
we'd rather say so than blur it: OpenTakeoff's gate gives you (and the open
corpus) the demonstration; the behavioral stream around it is the product.
