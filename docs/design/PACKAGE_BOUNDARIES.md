# Package boundaries: the dependency map and the first extraction

Phase 4 of the roadmap begins with a map, not a move. This page records what the browser app,
the MCP server and the protocol tooling actually share today, measured from the build and the
import graph on `main` at `2797ea0`, names one concrete coupling problem, and proposes one small
extraction with its contract stated up front. No file moves in this change.

## How the map was measured

- `esbuild server.ts --bundle --platform=node --format=esm --packages=external --analyze` on
  `mcp/server.ts`: the exact set of `web/src/lib` files that ship in `dist/server-core.js`.
- Every `import` line in `mcp/src/*.ts`, `mcp/test/*.ts`, `protocol/src/*.mjs`,
  `protocol/scripts/*.mjs`, `protocol/test/*.mjs` that resolves across a package boundary.
- Each shared module read for `document`, `window`, `indexedDB`, `localStorage`, React and
  canvas use.

## The layers, as built

| Layer | Where | Runtime | Who imports it |
|---|---|---|---|
| Browser UI | `web/src/pages`, `web/src/components` | browser only (React, DOM) | nobody outside `web/` |
| Engine libraries | `web/src/lib/*.{js,ts}` | browser and Node; no file imports React | the UI, the MCP server, the protocol tests, the web bench |
| MCP server | `mcp/server.ts`, `mcp/src/*.ts` | Node 20+ over stdio | `bin/server.js`, the MCPB bundle, the tests |
| Packaged resources | `mcp/src/wiki.generated.ts`, `mcp/src/protocol.generated.ts` | embedded in the bundle | `mcp/src/resources.ts` |
| Protocol tooling | `protocol/src`, `protocol/scripts`, `protocol/v1`, `protocol/legacy` | Node 24 dev-only, private package | `protocol/test` only; nothing at runtime |
| Generators and guards | `mcp/scripts/check-*.mjs`, `scripts/check-version-consistency.mjs`, `protocol/scripts/check-*.mjs` | CI and `npm run build` | the build and CI |

**Direction is one-way.** `web/` imports nothing from `mcp/` or `protocol/` (twelve comment
mentions, zero imports). `mcp/src` reaches into `web/src/lib` through 30 import lines naming 30 engine modules, all by relative
path (`../../web/src/lib/…`), enabled by `mcp/tsconfig.json` (`allowJs`, `checkJs: false`, `lib`
without DOM). `protocol/` runtime code imports only `node:*`, `ajv` and itself; its tests import
`mcp/src/session.ts` and about twelve `web/src/lib` modules, which is why the protocol CI job
installs web and mcp first.

## What the MCP bundle actually carries

38 engine files ship inside `dist/server-core.js` (846.8 kB total bundle). The largest:
`oneclick.ts` 88.4 kB, `sheetgraph.ts` 49.3 kB, `markedset.js` 36.8 kB, `symbolsweep.ts`
26.1 kB, `dxf.ts` 13.6 kB, `rollgoods.js` 11.9 kB, `totals.js` 11.1 kB, `svgpath.js` 10.7 kB,
`importTakeoff.js` 7.4 kB, `transitions.ts` 7.2 kB, `scopeCollision.js` 7.0 kB. Twenty-three are
imported directly (all but one through `mcp/src/session.ts`); fifteen ride in transitively.
Seven statically imported files tree-shake to nothing.

Everything shared is DOM-free at the functions the server calls, with three seams:

- `web/src/lib/totals.js` exports `downloadText()` (`document.createElement("a")`) beside the
  pure quantity functions; the server never calls it, but it ships.
- `web/src/lib/markedset.js` has a `document.createElement("canvas")` dark/raster branch and a
  `downloadBytes()`; `mcp/src/marked.ts` uses only the light vector path and says so.
- `web/src/lib/importTakeoff.js` imports `web/src/lib/store.js` (IndexedDB) for one string,
  `ANN_SCHEMA`; esbuild tree-shakes the module to 51 bytes, but an IndexedDB module is in the
  graph for a constant.

`mcp/tsconfig.json` is the de facto DOM-freeness gate for the shared `.ts` files; the shared
`.js` files (`totals.js`, `markedset.js`, `importTakeoff.js`, `approvals.js`, `cutout.js`,
`scopeCollision.js`, `rollTakeoff.js`, `rfi.js`, `geometry.js`, `shapeMetrics.js`) have no gate
(`checkJs: false`).

**Dependencies are declared twice.** The engine modules' packages are re-declared in
`mcp/package.json` because the bundle is built with `--packages=external`: `pdfjs-dist`
(`sheets.ts` and `mcp/src/pdf.ts`), `pdf-lib` (`markedset.js` lazily, `safewrite.ts`), `jsts`
(`scopeCollision.js`), `@turf/*` (`cutout.js`). Ranges drift: `@turf/*` is `^7.3.5` in
`web/package.json` and `^7.4.0` in `mcp/package.json`. `fflate` is web-only.

## What is shared by import, and what is copied by hand

Shared, single implementation, consumed by import: import/merge rules (`importTakeoff.js`),
marked set (`markedset.js`), report JSON (`totals.js`), approvals, rules, cutouts, scope
collisions, roll goods, RFIs, condition twins, transitions, shape metrics, geometry, DXF,
One-Click, raster masks, room detection, symbol sweep, layers, sheet graph, confidence, scale
detection. The coordinate frame is one constant, `RENDER_SCALE` in `web/src/lib/sheets.ts`,
imported by five MCP files and pinned by `mcp/test/parity.test.ts`.

Copied by hand, with no test that the copies agree:

| Value | Copy 1 | Copy 2 | Copy 3 | Drift on record |
|---|---|---|---|---|
| condition palette (10 colors) | `web/src/components/hatches.jsx:48` `PALETTE` | `mcp/src/session.ts:75` | partial, reordered: `web/src/lib/scheduleParse.ts:147` | none yet; `session.ts:70` says "copied from the canvas" |
| hatch id vocabulary (31 ids) | `hatches.jsx:12` `HATCHES` | `session.ts:78` `HATCH_IDS` | | **historical**: `session.ts:76` records a `fleur` entry that drifted in and was dropped in 2026-07; the canvas later added a real `fleur` hatch (#243), and the two lists were checked equal (31 = 31, same order) before this extraction |
| hatch rotation formula | `web/src/pages/TakeoffCanvas.jsx:5904` | `session.ts:1344` and `:4078` | | |
| condition record minted | `web/src/pages/TakeoffCanvas.jsx:5893` `mintCondition` (has `created_at`) | `session.ts:1334` `conditionFor`, commented "field-identical" | | **yes**: MCP omits `created_at` |
| snap grid and tolerance | `canvasConstants.js:54` `SNAP_CELL = 24` | `oneclick.ts:3739` `SNAP_CELL_PX = 24`, `SNAP_TOL_PX = 7` | `session.ts:73` `SNAP_CELL`, `SNAP_TOL` | |
| takeoff schema id | `store.js:54` `ANN_SCHEMA` | `session.ts:90` | `protocol/src/validation.mjs:7` and `protocol/legacy/takeoff-canvas.v1.schema.json:14` | the only identity family with no checker at all |
| report schema id | `totals.js:498` | `mcp/src/outputs.ts:700` | `mcp/src/safewrite.ts:44` (regex) | |
| `mintUuid` / `nowIso` | `web/src/lib/provenance.js:10` (header: "so mcp/ can exercise it directly") | `session.ts:79` re-declared "mirrors provenance.js" | | MCP never imports the module it mirrors |
| `proposed_condition_edits` rows | `web/src/lib/proposals.js:104` | `session.ts:2038` | | web coerces numbers, MCP does not |
| export payload envelope | `web/src/pages/TakeoffCanvas.jsx:2281` `buildPayload` | `session.ts:4762` `exportPayload` | | canvas writes 8 extra keys (`palette`, `rules`, `stitches`, `layer_overrides`, `provenance_counters`, …); MCP always writes `units` |
| report envelope shape | `totals.js` writer | `mcp/src/outputs.ts:699` zod mirror ("the authority is the web export") | | |
| One-Click gate strings | `web/src/lib/gate.js` | `mcp/src/gate.ts` | | different runtimes, tested separately |

Identity and count fields have guards: `scripts/check-version-consistency.mjs` (seven MCP
version fields, three web fields), `mcp/scripts/check-tool-count.mjs` (22 markers in ten docs
plus a grep for unmarked counts), `check-wiki.mjs` and `check-protocol-resources.mjs` (generated
bundles with source digests). The schema ids have none. Two hand-maintained tables duplicate
generated ones without a check on their content: the tool table in `mcp/README.md` (names are
compared to `docs/MCP_TOOL_INDEX.md`, descriptions are not) and the "Where things live" table in
`docs/wiki/repo-guide.md`, which still says the default conditions are mirrored in
`mcp/src/session.ts`; they are not, and that sentence ships in the packaged wiki.

## The coupling problem this phase picks

Hand-mirrored constants across three packages with no cross-check. It is the only class of
duplication here with a drift already on record (the `fleur` hatch id), it includes the one
identity family nothing guards (the takeoff schema id in four places), and it is the reason
`importTakeoff.js` drags an IndexedDB module into a Node bundle. It is also the smallest thing
in the map: seven frozen values, no functions, no dependencies, no runtime behavior.

The reason the copies exist is stated in the code: `PALETTE` lives in `hatches.jsx`, which
imports React, so nothing outside the browser can import it
(`web/src/lib/canvasUtil.js:5`: "the seeder pulls PALETTE from components/hatches.jsx, which
imports React — don't import this module outside the web app (mcp/ keeps its own mirrored
copies)").

Not chosen, and why: the geometry core (`sheets.ts`, `geometry.js`, `totals.js`, `cutout.js`,
…) is already consumed by import, carries the heavy dependencies; extracting it removes no duplication and only changes the
form of the coupling. The document read/write layer (export payload,
`proposals.js`, `provenance.js`) holds the most consequential drift, two writers of one schema,
but `buildPayload` is welded to canvas component state (`palette`, `conditionColumns`,
`layerOverrides`, `provCounters`); it becomes cheaper after the constants move, so it is the
second increment, not the first.

## The extraction: `web/src/lib/takeoffConstants.ts`

**Status: shipped in 0.9.85** (the PR after this map). The section below is the contract as
proposed; what landed matches it, with two deliberate differences: the protocol package keeps its
runtime import-free and pins the schema id in a test instead of importing the module, and
`scheduleParse.ts`'s `FALLBACK_PALETTE` was left alone because it is a different, shorter list
(it contains `#475569`, which the condition palette does not), not a copy.


One DOM-free engine module that owns the mirrored values, imported by both surfaces and by the
protocol tests. Not a new npm package: there is no consumer outside this repository, the MCP
bundle already inlines engine modules, and a second publish pipeline would add a version to
keep in agreement for no reader.

**Public API** (named, frozen, values only):

```ts
export const TAKEOFF_SCHEMA = "opentakeoff.takeoff_canvas.v1";
export const REPORT_SCHEMA  = "opentakeoff.report.v1";
export const RENDER_SCALE   = 2.0;                 // re-exported by sheets.ts, which keeps its import sites
export const PALETTE: readonly string[];           // the ten condition colors, user data, never re-themed
export const HATCH_IDS: readonly string[];         // the 31 hatch ids in HATCHES order
export const SNAP_CELL = 24;
export const SNAP_TOL  = 7;
export function nextHatchId(conditionCount: number): string;   // the rotation both sides implement today
```

`hatches.jsx` keeps `HATCHES` (ids plus labels plus the SVG patterns, browser-only) and asserts
in a test that its ids equal `HATCH_IDS`. `store.js`, `totals.js`, `mcp/src/session.ts`,
`mcp/src/outputs.ts`, `mcp/src/safewrite.ts`, `canvasConstants.js`, `oneclick.ts` and
`scheduleParse.ts` import instead of re-declaring. `protocol/src/validation.mjs` imports the
schema id the way its tests already import web modules, and a protocol test asserts the JSON
schema's `const` equals it.

**Supported runtimes:** any ES2022 module consumer; no imports at all, so it runs in the
browser build, in the Node bundle and under `node --test` unchanged.

**Ownership:** the engine, `web/src/lib`, under the web `tsconfig`; the repository guide's
"user data, never re-theme" rule for the palette moves onto the module's header.

**Compatibility and versioning:** no persisted format changes and no value changes; every
constant keeps today's literal. `mcp/src/session.ts` changes only in where the values come from,
so the published MCP bytes change and the next `mcp-v*` tag carries it; the web app needs no
release. The `conditionFor` `created_at` omission is a behavior difference and is **not** folded
in silently: the implementation either adds `created_at` with a test and a changelog line, or
records the divergence in the doc; it does not get fixed as a side effect of moving constants.

**Release process:** one PR, the existing gates (`npm run check --prefix web`, MCP typecheck,
tests, `check:tool-count`, `check:wiki`, `check:protocol-resources`, `smoke:dist`, protocol
check), plus three new parity tests: `mcp/test` deep-equals the constants the server uses against
the module; `web/test` asserts `HATCHES.map(h => h.id)` equals `HATCH_IDS` and the canvas's
rotation equals `nextHatchId`; `protocol/test` asserts the legacy schema's `const` equals
`TAKEOFF_SCHEMA`. Bundle size compared before and after with `--analyze` (expected: `store.js`
leaves the graph).

**Exit for the increment (met in 0.9.85; `store.js` out of the graph and `stamps.js` with it, 38 engine files → 37, 846.8 kB → 846.7 kB):** both surfaces import the module, the three parity tests pass on
both CI platforms, `dist/server-core.js` no longer contains `store.js`, no quantity, palette,
hatch or schema value differs from today, and the stale repo-guide sentence is corrected (that
edit changes the packaged wiki and rides the same MCP version bump).

## After that

1. Document read/write: lift `buildPayload`'s inputs out of canvas state and make the export
   envelope one function both writers call; the export-payload parity test that cannot be
   written today becomes possible.
2. Dependency declarations: one place for the engine's runtime package ranges, so `@turf/*`
   cannot drift between `web` and `mcp` again.
3. DOM seams in shared `.js` modules: move `downloadText` and `downloadBytes` beside their
   callers, and put the shared `.js` files under a type gate.

None of these is started here.
