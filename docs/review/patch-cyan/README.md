# Patch cyan accent (2026-10-21)

The accent moves from cobalt / electric blue to the Kentucky AI patch cyan, so this app matches
kentucky-ai.com and OpenTakeoff Premium. The dark looks drop their navy cast for the patch's
cool black. Light surfaces keep their cool white; there the accent is deep teal `#0e636b`, because
white text on the bright cyan would not be readable.

| | Before | After |
|---|---|---|
| Plan gallery | [before-home.jpg](before-home.jpg) | [after-home.jpg](after-home.jpg) |
| Canvas, Backlit graphite (default) | [before-canvas-graphite.jpg](before-canvas-graphite.jpg) | [after-canvas-graphite.jpg](after-canvas-graphite.jpg) |
| Canvas, Studio light | [before-canvas-light.jpg](before-canvas-light.jpg) | [after-canvas-light.jpg](after-canvas-light.jpg) |
| Canvas, HUD | | [after-canvas-hud.jpg](after-canvas-hud.jpg) |
| Report after one traced room | [before-report.jpg](before-report.jpg) | [after-report.jpg](after-report.jpg) |

Smoke run on the bundled sample plan, both builds in Chrome 1440×900:
- Steps: open the sample plan, use the plan's own 1/8" = 1'-0" scale, trace one rectangle with `A`, open the Report.
- Expected: 1 shape, and the same totals before and after.
- Observed: 1 shape. 1,230.2 SF with waste and 136.7 SY in both builds. No page errors.

Not changed on purpose:
- Plan markup inks: selection, RFI clouds, stamps, the marked-set PDF, and the crosshair.
- Condition colors.

These print on the client's drawings and keep their existing contracts.

Seen, but not caused here: in the dark looks the Report's finish names, TOTAL row and per-sheet
numbers render dark on dark. Production shows the same thing (before-report.jpg).
