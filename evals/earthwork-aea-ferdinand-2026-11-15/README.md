# Earthwork: average end area against a printed answer key

**Question:** can OpenTakeoff support a general contractor's earthwork takeoff
(cut and fill CY), and do its measurements match an engineer's own published
numbers?

**Answer today:** the parts work and match the engineer's numbers at the station
level. A real earthwork workflow does not exist yet, and neither does a
sitework-specific UI. Those gaps are tracked in the linked issue.

## Answer key

The answer key is a public Indiana DNR culvert bid set (see `sheets/SOURCE.md`). For
each of 37 stations along line PR-ACCESS RD, the engineer prints the following
quantities:

- `Ac` / `Af`: the cut and fill end areas in SF
- `Vc` / `Vf`: the cut and fill volumes in CY from the previous station
- `Area Benching` / `Volume Benching`

Sheet 8 also prints the project EARTHWORK SUMMARY: 555 CY total excavation (which
includes 105 CY unsuitable and 360 CY benching), 440 CY fill, 550 CY fill + 25%
shrink, and 100 CY borrow.

## Test 1: measure an end area in OpenTakeoff (MCP 0.9.105)

Station 14+50 on XS1 (page 2 here).

1. `set_scale` by `calibrate` on the printed grid. The axis labels -75 → 75 are
   4,318.7 px apart, which is 150 ft. The vertical labels 500 → 520 are 575.8 px
   apart, which is 20 ft. Both work out to 28.79 px/ft, so H = V = 1" = 5'.
2. Trace both hatched benching regions with `measure_polygon`. Every vertex is
   copied verbatim from `get_sheet_vectors` over a tight crop.
3. Overlay-check the result: `out/xs-1450-overlay.png`.

| | OpenTakeoff | Printed | Δ |
|---|---|---|---|
| Area Benching, 14+50 | 9.23 + 12.15 = **21.38 SF** | **21.3 SF** | +0.4 % |

A thin hatched sliver at the right toe was not traced, so the true difference is
slightly larger than 0.4%.

## Test 2: average end area volumes, all 37 stations

```
python runs/aea_check.py sheets/indnr-ferdinand-culvert-XS.pdf   # needs pymupdf
```

The script recomputes `(A1 + A2) / 2 × L / 27` from the printed end areas and compares
the result with the printed `Vc` / `Vf`. Its full output is in `out/aea_check.txt`.

- The script reports 33/37 stations within 1 CY. One of the four flags is a
  text-layer split in the parser: 29+50 is printed `Vf = 25 CYS`, the parser reads
  2, and the computed value is 24.5. **That makes 34/37 agree.**
- Three stations really do differ from the engineer. Each one was re-read on the
  sheet with `read_sheet_text`:

| Station | Computed | Printed |
|---|---|---|
| 14+68.50 fill | 18.5 CY | 13 CY |
| 15+12.00 cut | 6.1 CY | 2 CY |
| 31+50.00 cut | 5.2 CY | 0 CY |

  These three are probably adjustments made by the design software, such as
  component splits or end-area corrections. That cause has not been confirmed.

## Test 3: tie to the Earthwork Summary (does not tie yet)

The section volumes sum to 391 CY cut and 414 CY fill, with the 29+50 value
corrected. The printed benching volumes sum to 345 CY, while the summary says
360 CY. Getting from the sections to the summary (555 / 440) needs the engineer's
split between unsuitable material and benching, and the set does not state that
split. **No claim is made here that OpenTakeoff reproduces the summary.**

## What this proves and what it doesn't

- Proven: measuring an area on a section sheet at H = V scale, and the average end
  area arithmetic, both against a published engineer's answer key.
- Not proven: any automation. The traces were hand-placed from vectors, and the end
  areas for test 2 were read from the printed text rather than measured. On this
  sheet the section lines are drawn as filled outlines rather than strokes, so
  separating existing ground from proposed is not yet automatic.
- No volume unit exists today. An earlier test that used `multiplier` to turn LF of
  trench into CY reported the result as LF and added it into the LF grand total.

`out/xs-1450-marked-set.pdf` is the marked set exported with `export_marked_pdf`.
