# Public test sheets

Real construction sheets for testing OpenTakeoff against something harder than
the bundled sample. Every sheet comes from a set the State of Missouri, Office
of Administration, Division of Facilities Management, Design and Construction
posted publicly for bidding. Each file is the original vector page, extracted
unchanged, with the PDF document metadata removed. The source links are below.

Use them for PR evidence. When a change affects detection, quantities or the
canvas, show before and after on one of these sheets (or another public sheet
you link) instead of a synthetic plan.

| File | Sheet | Printed plan scale | Good for |
|---|---|---|---|
| `mo-albany-maintenance-S-101-foundation.pdf` | S-101 Footing & Foundation Plan | 1/8" = 1'-0" (details 3/4") | Concrete suite (#611): slab on grade, grade beams, pad footing schedule, stoops |
| `mo-state-fair-fire-station-A-101-floor-plan.pdf` | A-101 First Floor Plan | 1/8" = 1'-0" (enlarged plan 1/4") | Room detection, floor takeoff, doors, a plan with an enlarged view on the same sheet |
| `mo-state-fair-fire-station-A201-exterior-elevations.pdf` | A201 Exterior Elevations | 1/8" = 1'-0" | Masonry and siding suites (#612): brick veneer wainscot, fiber-cement siding, openings |
| `mo-veterans-home-A101-overall-floor-plan.pdf` | A101 Overall Floor Plan | 1/16" = 1'-0" | Letter-prefixed room numbers (C112, C120, C125) for #656, and match lines between areas |
| `mo-veterans-home-A102-A105-area-plans.pdf` | A102–A105 Floor Plan, four areas | 1/8" = 1'-0" | Stitching across match lines (#575, #642/#652), prefixed room numbers |
| `mo-veterans-home-A111-reflected-ceiling-plan.pdf` | A111 Overall Reflected Ceiling Plan | 1/16" = 1'-0" | Ceilings suite and 2'×2' / 2'×4' lay-in grid (#653/#654, #661) |

## What `main` reads today

These are measured, not targets. The test loaded each file with the MCP `Session` on
`main` at `7e3986ba`. Where a value is wrong, that is a known gap you are
welcome to fix.

| Sheet | Sheet number read | Scale detected | Vector segments |
|---|---|---|---:|
| Albany S-101 | `S1.01` ✗ (a detail callout, not `S-101`) | 3/4" ✗ (a detail scale; the plan is 1/8") | 56,294 |
| Fire station A-101 | `A-101` | none ✗ | 173,944 |
| Fire station A201 | `A201` | 1/8" | 88,108 |
| Veterans Home A101 | `A101` | 1/16" | 37,564 |
| Veterans Home A102 / A103 / A104 / A105 | each correct | 1/8" each | 14,677 / 14,685 / 14,444 / 15,146 |
| Veterans Home A111 | `A111` | 1/16" | 23,696 |

```bash
cd mcp
node --import tsx -e '
import("./src/session.ts").then(async ({ Session }) => {
  const s = new Session();
  const { sheets } = await s.loadPlan("../demo/public-sheets/mo-veterans-home-A111-reflected-ceiling-plan.pdf");
  for (const sh of sheets) console.log(await s.sheetInfo(sh.sheet));
});'
```

## Sources

All sheets were posted by the Missouri Office of Administration, Division of
Facilities Management, Design and Construction, as public bid documents:

- **Albany Readiness Center, new maintenance building** (Missouri Army National
  Guard), project T2327-01, bid documents 11/15/2024. Sheet S-101.
  <https://oa.mo.gov/sites/default/files/bid-opportunities/_T2327-01%20Final%20Bid%20Plans.pdf>
- **Missouri State Fair, new fire station**, Sedalia, project F2405-01, issued
  09/19/2025. Sheets A-101 and A201.
  <https://oa.mo.gov/sites/default/files/bid-opportunities/_F2405-01Final%20Bid%20Plans.pdf>
- **St. Louis Veterans Home, C Wing**, project U2607-01, issued 06/26/2026.
  Sheets A101, A102–A105 and A111.
  <https://oa.mo.gov/sites/default/files/bid-opportunities/_U2607-01%20-%20Final%20Plans.pdf>

The drawings remain the work of their architects and engineers of record, as
shown in each title block. They are included only so contributors can test the
tool. They are not for construction or any other use. If you are a rights
holder and want a sheet removed, open an issue and we will remove it.

Never commit a private or client plan here. See [`../README.md`](../README.md).
