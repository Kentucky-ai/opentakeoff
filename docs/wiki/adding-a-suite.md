# Adding a trade suite

A trade suite is what one trade adds on top of the core tools: a short method,
the condition tags its tools default to, and a tool of its own only where the
core cannot already do the job. [Trade suites](suites.md) lists the suites
that ship. This page walks one small suite from the first question to a merged
pull request.

The example is a method-only suite for toilet accessories (Division 10). It
needs no tool, because the core tools already count tags against a schedule.
Steps 3 and 4 cover a suite that needs math and a tool of its own; skip them
for a method-only suite. If you know a trade but not the code, the
[Trade suite form](https://github.com/Kentucky-ai/opentakeoff/issues/new?template=trade_suite.yml)
asks the questions in step 1 and needs no code.

## 1. Start from the trade, not the code

Answer these before you open an editor:

- **What gets traced, on which sheets, under which tags?** Floor plans,
  elevations, the roof plan or enlarged plans, and one tag per thing the
  estimator orders separately.
- **Which values come from the documents?** A schedule's marks and quantities,
  a dimension from a section, a spacing from the spec. A suite takes them as
  arguments and never measures them from the drawing.
- **What does the estimator order at the end?** The quantities, in the units
  the trade buys in.

For toilet accessories: nothing is traced, because each accessory is a tag on
the restroom plans. The marks and quantities come from the toilet accessory
schedule. The estimator orders a count per mark. The core tools
`find_schedule`, `sweep_schedule_row` and `place_count` already do that, so the
suite is a method and a tag prefix.

## 2. Register the suite

Add an entry to `TRADE_SUITES` in
[web/src/lib/tradeSuites.ts](../../web/src/lib/tradeSuites.ts):

```ts
{
  id: "toilet_accessories",
  label: "Toilet accessories",
  prefixes: ["TA-"],
  divisions: ["10"],
  summary: "grab bars, dispensers and mirrors counted by schedule mark: core tools",
  tools: [],
  method: [
    "find_schedule for the toilet accessory schedule; its marks (TA-1, TA-2) become the condition tags.",
    "Read the schedule's furnished-by column: owner-furnished accessories are install only.",
    "sweep_schedule_row per mark without commit first, and read every match, withheld and text_only result.",
    "When each accessory shows on one plan only, sweep again with commit:true. When a restroom shows on a floor plan and again on its enlarged plan, place_count the occurrences you keep under the mark, so each accessory counts once.",
    "A mark on the schedule but on no plan is reported, never counted: create_rfi.",
  ].join("\n"),
  presets: [
    { tag: "TA-<n>", measure: "count", what: "accessories, one tag per schedule mark" },
  ],
},
```

| Field | What it holds |
|---|---|
| `id` | The id agents pass to `open_suite {suite}`. Lowercase, with underscores. |
| `label` | The name in the canvas **Trade** picker and the condition's **Trade** select. |
| `divisions` | Two-digit CSI MasterFormat divisions. A division no suite used before also needs a line in `DIVISIONS` in the same file. |
| `summary` | One line, under 140 characters. It is all an agent reads before opening the suite. |
| `tools` | The tools the suite adds. `[]` for a method-only suite. |
| `method` | Short imperative lines that name the tools in order. `open_suite` hands it over once, when the suite opens. |
| `presets` | The tags the method uses, with the measure each is taken with. |
| `prefixes` | The tag prefixes that book a condition to this suite when it has no explicit trade. |

Pick prefixes that no other suite uses and that no common tag starts with,
and write them in capitals: a condition's tag is matched in capitals, by
prefix, and the first suite in the list that matches wins. `PT-` paint tags
stay in Finishes, and a test checks that.

The registry is the only place a suite is declared. `open_suite` builds its
catalog and its division routing from it, and the canvas **Trade** picker
lists every entry. A method-only suite is a complete contribution, like
Finishes and Doors.

## 3. Put the math in pure functions

*Only for a suite with a tool of its own.*

Add the math to [web/src/lib/suiteMath.ts](../../web/src/lib/suiteMath.ts) as
pure functions: numbers in, quantities out, with no session, DOM or file
access, so the canvas can share them. `soffitQuantities` is the smallest model
to copy. It takes the measured lengths plus the document values as inputs,
returns `waste_pct` with a `waste_source` that says whether the waste was
stated or is the suite allowance, and lists anything it could not figure under
`not_figured`.

Test it in [web/test/suiteMath.test.ts](../../web/test/suiteMath.test.ts) and
work every expected number by hand in a comment beside it:

```ts
near(q.rake_soffit_sf, 22.36);        // 44.72 true × 0.5 ft
near(Number(q.vent!.required_nfa_in2), 1440);   // 1500 / 150 = 10 SF = 1440 in²
```

## 4. Add the tool

*Only for a suite with a tool of its own.*

Register the tool with `reg` inside `registerSuites` in
[mcp/src/suites.ts](../../mcp/src/suites.ts), and list its name in the suite's
`tools`. `registerSuites` disables every tool registered through `reg`, so the
tool stays out of `tools/list` until `open_suite` opens the suite. Suite tools are not in `TOOL_STAGES` or the
default tool count. A suite tool is one of two kinds:

- **A derive** commits unreviewed shapes, like drip edge, trim or soffit
  (`soffit_takeoff` is the model). It reads the shapes committed under its tags
  with `session.suiteShapes`, commits through `session.suiteCommit` with
  `derived.from_shape_id` on each new shape, and skips any source shape it
  already derived from (`derivedFrom`), so running it again commits nothing
  new.
- **A rollup** writes material rows, like wire, hangers or fittings
  (`plumbing_rollup` is the model). It reads condition totals with
  `session.suiteTotals` and writes rows with `upsertRows`, which matches rows
  by material name: running it again updates each row with the same name. A
  row whose name changes, like wire for a different conductor count, is added
  beside the old one, and a row a new run no longer writes stays until it is
  removed.

Both kinds call the pure functions from step 3, report `undo_steps` (the
`undo_last {n}` that takes the whole call back) and pass `not_figured`
through, so a missing document value reaches the person instead of a guess.

Two texts in the same file name the suites and no test checks them: the
`SUITE_INSTRUCTIONS` line every client reads at initialize lists the trades
with a tool, and `open_suite`'s description gives what division 07 opens.
Update them for a new tool suite or a new division 07 suite.

Test it over MCP in [mcp/test/suites.test.ts](../../mcp/test/suites.test.ts) on
the bundled sample plan, with the expected numbers worked by hand.

## 5. The rules every suite keeps

- **Never measure the drawing.** A suite reads what is committed; tracing
  stays with the core tools and the person.
- **Never invent a document value.** Pitch, depth, spacing, a grid or a
  quantity is an argument. When the documents do not give one, the method
  says to raise it with `create_rfi`.
- **Label every allowance.** When no waste is stated, the reply says it carried
  the suite allowance so the estimator can override it with their own.
- **No prices, manufacturers or products** anywhere in a suite. A test rejects
  prices and product marks in the registry text.

## 6. What CI checks

Run these from the repository root after
`npm ci --prefix web && npm ci --prefix mcp && npm ci --prefix protocol`.
For the toilet accessories suite, three of them need a change: the MCP suite
tests, the wiki bundle and the version.

| Check | Command | What it catches and the fix |
|---|---|---|
| MCP suite tests | `npm test --prefix mcp` | `suites.test.ts` pins the catalog: the list of suite ids and two counts of suites. Add your id and raise both counts. A suite in division 07 also changes what `open_suite {division: "07"}` opens there, and a suite in division 05 breaks the test that expects 05 to have no suite: move that test to another empty division. |
| Wiki bundle | `npm run check:wiki --prefix mcp` | The packaged copy of the wiki is stale after you edit [suites.md](suites.md). Run `npm run check:wiki --prefix mcp -- --write` and commit the regenerated [mcp/src/wiki.generated.ts](../../mcp/src/wiki.generated.ts). Until then, the wiki test in `npm test --prefix mcp` fails too. |
| Documentation links | `node scripts/check-doc-links.mjs` | A relative link or heading anchor that does not resolve. |
| Web tests | `npm test --prefix web` | The registry checks: ids unique, a method on every suite, a one-line summary, each tool owned once, no prices or product marks. A suite in a division that already has suites changes the pinned division routing, and a new tool changes the pinned list of suite tools: update those assertions. |
| Tool count and index | `npm run check:tool-count --prefix mcp` | A new suite tool changes the generated [tool index](../MCP_TOOL_INDEX.md). Run it with `-- --write` and commit the result. A method-only suite passes unchanged. |
| MCP version | `npm run check:versions --prefix mcp` | Any change under `mcp/`, including the regenerated wiki bundle and the suite tests, fails CI's `mcp-version-guard` job until the MCP version goes up. Pick the next version after `main`'s that has no `mcp-v*` tag, and set it in all seven fields: `mcp/package.json`, two in `mcp/package-lock.json`, two in `mcp/server.json` and two in `web/public/.well-known/mcp.json`. Then run `npm run check:wiki --prefix mcp -- --write` again, since the bundle carries the version. The command checks that the fields agree; the bump itself is checked only in CI. The maintainer may renumber it before merging. |
| Protocol | `npm run check --prefix protocol` | Protocol schemas and their documentation. |
| MCP types | `npm run typecheck --prefix mcp` | Type errors under `mcp/`. `npm test` runs the tests without type checking, so only this catches them. |
| Built server | `npm run build --prefix mcp && npm run smoke:dist --prefix mcp` | The built server, over stdio, including every wiki page. |
| Full web gate | `npm run check --prefix web` | Typecheck, lint, tests, benchmark and build, the same as CI's web job. |

Update these documents in the same pull request:

- [suites.md](suites.md): a row in the suite table, and the new prefix in the
  list under "In the canvas".
- [mcp/README.md](../../mcp/README.md): a row in its suite table.
- [protocol/INVENTORY.md](../../protocol/INVENTORY.md): the suite id in the list
  of `trade` values.
- [CHANGELOG.md](../../CHANGELOG.md): an entry under "Unreleased".

## 7. The evidence table

A suite pull request shows what the suite returns on the bundled sample plan,
against numbers a reviewer can check by hand. The table in
[#607](https://github.com/Kentucky-ai/opentakeoff/pull/607) is the model:

| Case | Expected | Observed |
|---|---|---|
| 40×25 ft roof, 6/12: sloped SF / condition total | 1000 × 1.118034 = 1118.03 | 1118.03 / 1118.03 |
| rake true LF (2 × 25 plan) | 55.90 | 55.90 |
| re-run commits | 0 | 0 |

For a method-only suite, show what an agent receives: the catalog line,
`open_suite {suite}` returning the method and presets with no tools enabled,
and `open_suite {division}` opening the suite. Add the commands that reproduce
the table.

## Checklist

Paste this into the pull request description:

```markdown
- [ ] The trade questions are answered: what is traced, which values come from the documents, what is ordered
- [ ] Registered in web/src/lib/tradeSuites.ts (and DIVISIONS for a new division); prefixes do not collide
- [ ] Tool suites only: pure math in web/src/lib/suiteMath.ts, every expected number worked by hand in the test comments
- [ ] Tool suites only: the tool in mcp/src/suites.ts reads committed shapes, reports undo_steps, is safe to re-run, lists missing values under not_figured
- [ ] No measuring the drawing, no invented document value, every allowance labeled, no prices, manufacturers or products
- [ ] npm test --prefix web and npm test --prefix mcp pass
- [ ] The MCP version is raised to an unused number in all seven fields, and the wiki bundle is regenerated after it
- [ ] npm run check:wiki --prefix mcp, npm run check:tool-count --prefix mcp, npm run check:versions --prefix mcp and node scripts/check-doc-links.mjs pass
- [ ] npm run check --prefix web passes
- [ ] suites.md, mcp/README.md, protocol/INVENTORY.md and CHANGELOG.md updated
- [ ] Evidence table: expected versus observed on the bundled sample plan, with the commands that reproduce it
```
