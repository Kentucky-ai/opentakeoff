# How the sheet graph is tested

The sheet graph (#87) reads a plan set's schedules and answers *what finish is specified in room 134, and how do you know*. This note records how that claim is measured, what it currently scores, and what it still cannot read—so the next person to improve it starts from the number rather than from scratch.

## The ruler

`mcp/scripts/graph-eval.mjs` scores the graph against a corpus of **real plan sets**, on two metrics. Either one alone is gameable:

| metric | question | why it exists |
|---|---|---|
| **cell accuracy** | for every (room, surface) the key states, did `resolve_tag` return the same code? | the finish it reports is the finish the schedule states |
| **tag classification** | of the numbers it calls rooms, how many *are* rooms? | cell accuracy can sit at 1.000 while the graph invents thirty rooms that do not exist |
| **row → symbol** (`keys/<id>.rowsym.csv`, 2026-09-05) | for every scheduled mark the key names, does `sweep_schedule_row` resolve it to drawn instances — and refuse the marks the set never draws? | a schedule row that reads perfectly and then counts a phantom device is a wrong bid; the count is reported beside the verdict with its method (`L` by label, `M` mixed) but the yes/no is what is graded |

The second metric is not optional. A finish plan is covered in 2–3 digit numbers that are not rooms—keynote hexagons, detail markers, dimension fragments, legend rows. Counting them as rooms made every one come back `no schedule row`, which is **the same sentence a genuinely omitted room produces**. The case the feature exists to catch was being buried under look-alikes.

## What makes the score mean anything

**The answer key is read off the rendered sheet; the parser reads the PDF text layer.** Two independent channels. A key built from parser output measures nothing at all.

`mcp/scripts/graph-render.mjs` renders each set's tables in legible horizontal bands for exactly this purpose.

Two smaller rules, both learned the hard way:

- **The scorer throws on an unknown surface in a key** rather than skipping the row. Its first run reported a confident 43.8% because a `WALL_E` key row silently failed to match a `WALL E` alias and every wall row was dropped. A ruler that quietly discards what it cannot measure is worse than no ruler.
- **A set the task is not well posed for stays unlabeled.** Labeling it would measure something other than the parser.

## Current state (opentakeoff-mcp 0.9.47)

Four sets, four general contractors, four building typologies:

| set | typology | cell P / R | tag P / R |
|---|---|---|---|
| gym set A | gym | 1.000 / 1.000 | 1.000 / 1.000 |
| gym set B | gym | 1.000 / 1.000 | 1.000 / 1.000 |
| retail set | retail | 1.000 / 1.000 | 1.000 / 1.000 |
| municipal set | treatment plant | 1.000 / 1.000 | 1.000 / 1.000 |

**434 finish cells—0 wrong, 0 missed. 86 room tags—0 non-rooms reported.**

Five distinct header shapes are covered: a two-tier `WALLS` parent over `N | E | S | W`; a single `WALL FINISH` column; a three-tier block with *two* columns both headed `FINISH`; a hand-lettered set that **centers** its cells and carries a `CASEWORK` tier; and `ROOM #` / `ROOM NAME` cells that both lead with the same vocabulary word.

Four sets is a small corpus. Treat the number as "no known failure on four real sets", not as a general accuracy.

## What real sets broke that fixtures never would

Every one of these was a wrong number in a bid, and none was reachable from synthetic tests:

- **Wall codes bled into BASE.** `WALLS (PLAN DIRECTION)` spans four sub-columns whose labels are single letters—not vocabulary—so they anchored nothing and each wall column banded to whichever neighbor was nearest.
- **A door schedule was read as a finish schedule.** Those carry a `MARK` column too, so a finish code colliding with a door mark chained to a door.
- **A finish table headed `SYMBOL`** (no `CODE`, no `MARK`) never extracted, so *zero* rooms chained to a product definition.
- **Columns were assumed to start where the header sits.** Headers are centered; cells are left-aligned. Two values sharing a left edge had centers 120 px apart, and center-banding split one column in two.
- **Cell alignment was assumed at all.** Some sets center their cells. A map that fits *badly* is now discarded rather than trusted—a mediocre map looks authoritative and merges a column into its neighbor, where plain nearest-anchor reads the table correctly. A true alignment scores 0.82–0.90; a wrong one 0.54.

## Known gaps

Three corpus sets are deliberately unscored, and they are the honest next lanes:

1. **A plan with no room numbers in its text layer at all**—zero 3-digit spans, zero room-name spans. Its schedule extracts cleanly; there is nothing on the plan side to join it to. No parser fixes this one.
2. **A schedule shape that yields no room-finish table.**
3. **A wall sub-tier headed `1 2 3 4`** with no parent to name it, on a set that also drops the boxed material code inside its floor cell—and that code is the half that chains to the material schedule.

4. **An equipment schedule with a three-tier header whose key column sits on the upper tier** (a heat-pump schedule on a real mechanical set). `findHeaderRow` descends to the lowest tier and finds no key there, so the table is skipped — honestly, with no phantom rows — but its marks then refuse.

Plus **revision clouds**, which remain arc-chain linework these detectors do not read. Delta triangles and `REV` tags are read; a cloud with no text marker is not, and absence of markers is not absence of revisions.

## Running it, and adding a set

The corpus lives **outside this repo**—real plan sets are never committed. Point the scorer at a directory holding `sets.json` plus `keys/<id>.csv` and `keys/<id>.tags.csv`:

```bash
node --import tsx scripts/graph-eval.mjs <corpus-dir> [setId ...] [--report]
node --import tsx scripts/graph-render.mjs <corpus-dir> <setId> --bands 3
```

Key formats:

```
keys/<id>.csv        room,surface,code     surface ∈ FLOOR BASE CEILING WALL WALL_N WALL_E WALL_S WALL_W
keys/<id>.tags.csv   tag,is_room           is_room ∈ 1 | 0
```

A blank `code` means the schedule states none there, and the parser must not invent one. A room the schedule lists **twice** with different finishes cannot go in a key at all—there is no single right answer, and refusing is the correct behavior; leave it out of the cell key and keep it in the tags key.

Every fix in this lane ships with a fixture in `web/test/sheetgraph.test.ts` that reproduces the real failure. Fixtures are vendor-neutral by house rule: invented codes and `VENDOR-A`-style names, never a real manufacturer.
