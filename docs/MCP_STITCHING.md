# Stitching sheets over MCP

A floor that is too big for one sheet is drawn on two or more, cut at a **match line**. A room
that crosses the match line cannot be measured on either sheet alone. Stitching joins 2–4 sheets
into one composite surface, so that room is one shape with one area.

The browser canvas has had this since #161 ([user manual](USER_GUIDE.md#stitching-a-floor-split-at-a-match-line)).
From MCP 0.9.110 an agent can do it too, with three tools and one rule: **the server refuses to
measure across a seam until the join has been checked against the drawing's own linework.**

## The tools

| Tool | Stage | What it does |
|---|---|---|
| `stitch_sheets` | setup | Creates a composite from 2–4 loaded sheets. Returns its key, `stitch:<uid>`, which every other tool accepts as a `sheet`. The sheets start butted edge to edge, with `aligned: false`. |
| `align_stitch` | setup | Moves one sheet so that two points you name, one on each sheet, land on each other. Then runs the seam check and reports it. Called with only `stitch`, it re-runs the check on the placement the stitch already has. |
| `list_stitches` | setup | Every stitch in the session: members and their offsets, scale, `aligned`, the last seam check, and how many shapes sit on it. |

## The workflow

1. **Load and scale each sheet.** `load_plan` the first file, then `load_plan {merge: true}` the
   rest (or use the pages of one file, `set.pdf#3` and `set.pdf#4`). `set_scale` every member.
   `stitch_sheets` refuses members with no scale or with different scales.
2. **Create the stitch.** `stitch_sheets {sheets: ["M1.1.pdf", "M1.2.pdf"], name: "Level 1"}`.
   The first sheet stays at the origin. In the starting layout the second sheet sits to the right
   of the first, so a point at `(x, y)` on the second sheet is at `(x + first sheet's width, y)`
   on the composite.
3. **Find the same drawn point on both sheets.** Use a wall corner or a column grid intersection
   that both sheets draw, near the match line. `view_sheet` with a tight `region` on each sheet
   shows it; `get_sheet_vectors` gives exact endpoints. Do not use the match line graphic itself,
   and do not use text.
4. **Align.** `align_stitch {stitch, anchor: [x, y], moving: [x, y]}`, both in composite image px:
   `anchor` is the point on the sheet that stays, `moving` is the same point on the sheet that
   moves. The reply has the new member offsets and the seam check.
5. **Read the seam check.** If `seam_check.passed` is true, the stitch measures like any sheet.
   If it is `withheld`, read `withheld_reasons` and `discrepancies`, look at them with
   `view_sheet {sheet: "stitch:…", region, overlay: true}`, and either realign or stop (below).
6. **Measure.** `measure_polygon`, `measure_line`, `place_count` and the rest take the stitch key
   as `sheet`. Shapes are stored on the composite and count once in `takeoff_summary`.
7. **Hand off.** `export_takeoff` writes the stitch records with the takeoff, and
   `import_takeoff` restores them. `export_marked_pdf` adds the composite as its own page,
   labelled as a composite and not as an architect's sheet.

Alignment is locked once shapes or annotations exist on a stitch, because their coordinates ride
the composite. To realign, start a new stitch.

## The seam check

After an alignment the server takes the vector linework of both sheets near the seam, pairs lines
that should be the same line, and measures how far apart each pair is. The reply gives:

- `max_in`, `p95_in`, `median_in` (and the same in px): the miss between paired lines, in real
  inches at the sheet scale.
- `leftover_rotation_deg`: any rotation between the sheets. Stitching only translates, so sheets
  drawn at different angles cannot be joined.
- `sample_count`: how many line pairs were measured.
- `discrepancies`: the worst pairs, with their coordinates on the composite and on each sheet.

The check passes when the **maximum** miss is at most `tolerance_in` (default 0.5 in) and the
rotation is at most `rot_tolerance_deg` (default 0.25°). It withholds when either is exceeded,
when no linework crosses the seam, or when any one seam of a 3–4 sheet stitch fails. Scanned
sheets with no vector linework are always withheld.

While a stitch is unaligned or withheld, any measurement, edit or proposal whose geometry crosses
a seam is refused, with a message that says why. Shapes that stay inside one member are allowed.

### When the check withholds

- **Median and p95 are large too** (for example median 1.9 in): the sheets are misplaced by about
  that much. Pick a better pair of points and align again.
- **Median and p95 are near zero and only the maximum is high**: the join is probably right and
  one pair is two different lines. Look at the top entries of `discrepancies` with `view_sheet`.
  If they are not walls (see the limits below), you may pass a higher `tolerance_in` to
  `align_stitch`, and you must tell the user that you did and what the numbers were.
- **You cannot tell:** measure each member sheet on its own and tell the user the room that
  crosses the match line needs their eyes. Never add two halves of a room and call it stitched.

## Page tools and stitches

- `reorder_pages` keeps each stitch on its pages.
- `rotate_page` refuses a composite, and refuses a member whose stitch has takeoff on it. On a
  stitch with no takeoff, rotating a member clears `aligned` and the seam check, so the join has
  to be checked again.
- `extract_pages` and `merge_documents` carry a stitch into the new file's takeoff only when all
  of its members are in that file.

## Tested on a real split pair

The unit tests cut one sheet in two, which proves the arithmetic but not the join. The run below
uses two sheets an engineer drew as a split: the HVAC plans M1.1 (south) and M1.2 (north) of a
public county bid set, both at 1/8" = 1'-0", with parallel match lines. It was run on the server
built from this change, through an in-memory MCP client.

| Step | Expected | Observed |
|---|---|---|
| `stitch_sheets`, then measure across the seam before aligning | refused | refused: "Cannot measure across seam on unaligned stitch" |
| `align_stitch` on a point both sheets draw | members placed; linework agrees | second sheet at dx 2237.5, dy 1067.5 px; 125 line pairs, median 0.09 in, p95 0.19 in, rotation 0.00° |
| The same alignment pushed 3 px (2 in at this scale) across the seam | reported as about 2 in, withheld | median 1.93 in, p95 2.17 in, withheld; measuring across the seam refused |
| A 600 × 400 px rectangle across the seam, against its two halves measured on M1.1 and M1.2 | equal | 740.74 SF on the stitch; 337.65 + 403.09 = 740.74 SF on the members |
| A 1,800 px line across the seam | 100 LF | 100 LF |
| `export_takeoff`, then `import_takeoff` in a new session | stitch, offsets and seam check restored | restored, same totals |

Two things this run found, both open:

1. **The default tolerance withheld the correct alignment.** The maximum miss was 1.37 in, from
   one pair: the north sheet's match line graphic, paired with a different line on the south
   sheet. Every other statistic was under 0.2 in. The measurements above were taken after
   passing `tolerance_in: 1.5`. The check fails safe (it refuses, it does not mis-measure), but
   on sets like this one the agent has to inspect the outlier and state the override.
2. **The seam is not at the match line when the sheets overlap a lot.** Each sheet is clipped at
   the midpoint of the area where the two pages overlap. On this pair that left a blank band about
   2 ft wide beside the match line in `view_sheet`, where the north sheet's empty paper covers
   ink the south sheet has. Areas and lengths are not affected, since they are computed from
   coordinates. Snapping and anything else that reads linework sees no ink in that band.

## Limits

- Translation only. Sheets at different rotations or scales cannot be stitched.
- 2–4 members.
- Vector sheets only for the seam check.
- An agent can create and align a stitch; it cannot approve one. A person reviewing the takeoff
  should look at the seam on the marked set like any other machine-made work.
