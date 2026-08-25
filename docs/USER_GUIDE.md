# OpenTakeoff — The User Manual

OpenTakeoff is a takeoff canvas that runs in your browser. Open a plan, set the scale, trace the finishes—or let an AI agent stage the tracing while you keep the accept button—and walk away with a priced-out quantity report, a materials buy list, and a marked set you can send to a GC. Everything happens on your machine: no account, no upload, no install.

This manual takes you from a blank browser tab to a finished, exported takeoff, and covers every shipped feature along the way. Shortcuts appear inline as you meet each tool; the complete table is in [§15](#15-keyboard-reference).

In a hurry, or already in the app? Press **`?`** (or the **?** button in the top deck) for the in-app quick reference—the five-minute path and every key binding, without leaving the canvas. This document is the long form.

**Contents**

1. [Five minutes to a takeoff](#1-five-minutes-to-a-takeoff)
2. [Opening plans and moving around](#2-opening-plans-and-moving-around)
3. [Scale—set it first](#3-scale--set-it-first)
4. [Conditions—your finishes](#4-conditions--your-finishes)
5. [The measuring tools](#5-the-measuring-tools)
6. [One-Click Area](#6-one-click-area)
7. [Selecting and editing shapes](#7-selecting-and-editing-shapes)
8. [Undo and redo](#8-undo-and-redo)
9. [Markups, stamps, and RFIs](#9-markups-stamps-and-rfis)
10. [The report and exports](#10-the-report-and-exports)
11. [Revisions](#11-revisions)
12. [Saving, your data, and Contribute](#12-saving-your-data-and-contribute)
13. [The Agent panel](#13-the-agent-panel)
14. [AI settings and driving OpenTakeoff from an agent](#14-ai-settings-and-driving-opentakeoff-from-an-agent)
15. [Keyboard reference](#15-keyboard-reference)
16. [Troubleshooting](#16-troubleshooting)
17. [Voice and the Command box](#17-voice-and-the-command-box)
18. [Glossary—what the words mean here](#18-glossary--what-the-words-mean-here)

---

## 1. Five minutes to a takeoff

The fastest way to learn the canvas is to run one takeoff end to end on the bundled plan.

1. **Load the sample.** On the opening screen, click **Load sample plan**—a real medical-center floor finish plan. (Your own plans: drag a PDF anywhere onto the page.)
2. **Accept the scale.** Open the **Set scale…** chip in the toolbar. The plan's drawn scale note has already been read off the sheet—click **Plan says 1/4″ = 1′-0″ — use it**. A calibrated ruler bar flashes on the sheet for a few seconds so you can eyeball that it's right (a door opening is about 3′).
3. **Choose a condition.** A fresh workspace ships with a starter set of flooring conditions—CPT-1, LVT-1, CT-1, and friends. Press `1` to arm the first (the number keys answer in list order until you pin your own palette), or open the **☰ Takeoffs** rail button and click one.
4. **One-Click the rooms.** Press `O`, then click inside a room. The room traces itself, wall to wall, as a dashed proposal. Click the next room, and the next. Press `⏎` to create them all.
5. **Read the report.** Open **Report** for the per-condition breakdown—SF, SY, waste-adjusted order quantities, and the materials buy list. Export **CSV**, **Excel**, or a **Marked set** PDF.

That's the whole loop: open → scale → condition → measure → report. Everything autosaves to your browser as you go—reload the tab and your takeoff is still there.

### The working order on a real bid

The sample plan is one sheet. A bid set is forty, and the order you work it in is what keeps the
number defensible. This is the sequence, with the section that covers each step:

1. **Open the whole set at once**—drag the `.zip` straight off the bid platform. Plans, the
   finish schedule, the addenda, all of it ([§2](#2-opening-plans-and-moving-around)).
2. **Scale every sheet you'll measure, and check one dimension on each** (`K`). Ten seconds a
   sheet. A plan set is never one uniform scale, and a wrong scale is every number wrong at once
   ([§3](#3-scale--set-it-first)).
3. **Build your conditions off the architect's schedule**, not off memory—**Schedule** in the
   toolbar parses the finish table and you approve what becomes a condition. The product spec
   rides along as report columns, so the submittal answers itself later
   ([§4](#4-conditions--your-finishes)).
4. **Set waste and materials before you trace**, not after. Waste is per condition and matched to
   the install; the supporting-materials lines are what turn square feet into an order
   ([§4](#4-conditions--your-finishes)).
5. **Stitch anything split at a match line, and align it, before a single shape lands on it.**
   Once takeoffs live on a stitch it won't re-align ([§2](#2-opening-plans-and-moving-around)).
6. **Measure the floors first**—`O`, room by room, condition by condition. Floors are the bulk
   of the number and everything else derives from them ([§6](#6-one-click-area)).
7. **Derive what follows instead of measuring it twice**: base off the rooms you just traced,
   **⟂ Transitions** for the line where two finishes meet—and read what it *reports and never
   counts*, because those are doorway thresholds you still owe
   ([§5](#5-the-measuring-tools)).
8. **Walk the set and look at what landed.** Every sheet, at a zoom where you can see a ring
   overshoot into a corridor. Fix with the grips ([§7](#7-selecting-and-editing-shapes)).
9. **Save a revision** the moment the takeoff is whole. Do it again at every addendum—that's
   what makes the next round a comparison instead of an archaeology dig
   ([§11](#11-revisions)).
10. **Export both**: the Report/Excel for pricing, and the **Marked set** PDF for anyone who has
    to check you—the GC, the PM, your own reviewer ([§10](#10-the-report-and-exports)).

Steps 8 through 10 are the ones under time pressure people skip, and they're the ones that decide
whether a disputed quantity is a five-minute conversation or a re-takeoff.

---

## 2. Opening plans and moving around

### What you can open

Drag onto the canvas (or click the **Open your plans** target on the empty screen):

- **PDF** plan sets—multi-page, multiple files at once.
- **Images**—scans, screenshots, photos of a sheet. They're wrapped into PDF pages in your browser.
- **`.zip` plan sets**—the whole download off a bid platform. Unzipped in the browser; every PDF inside opens. (Hostile-archive guards cap entry counts, sizes, and nesting, so a malformed zip fails cleanly instead of ballooning the tab.)

Nothing uploads anywhere. The file is read locally, rendered locally, and stored locally.

### The sheet gallery (`G`)

Press `G` (or click **Sheets** in the toolbar) for the visual gallery: one card per sheet, with its title-block sheet number, a thumbnail, and status badges—a level chip, **open** if it's already a tab, a shape count, and a scale status (**scale ✓** green, **plan: 1/4″ = 1′-0″** amber when a scale note was detected but not yet adopted, **no scale** red).

- **Open one sheet**: point to a card and click **View**.
- **Open several**: click cards to select them—each gets a numbered badge, and that order is the left-to-right order. Then **Open N as tabs** or **Open N side-by-side** (side-by-side maxes at **4 sheets**; one pan/zoom moves the whole row).
- **Close a PDF**: point to the file's first card and click **✕**. Takeoffs on its sheets are preserved and restore if you re-add the same file.
- `Esc` closes the gallery (when a sheet is open behind it).

### Tabs, groups, and Regroup

Open sheets ride a **Sheets** tab strip: click a tab to view it, **⊞** to put it side-by-side with the current sheet, **✕** to close the tab. The sheet chip's dropdown lists every page and file, and holds **Ungroup — back to one sheet** and **Regroup (N)**—one click to restore your last side-by-side composition after working sheets individually. Each sheet in a group keeps its own scale, takeoffs, and markups.

One caveat that side-by-side makes possible: a trace can't span two grouped sheets. The gap between panels isn't real distance, so a quantity across it would be wrong—the commit refuses and points you at the fix, which is:

### Stitching (a floor split at a match line)

Large floors often arrive cut across sheets at a **match line**—half the building on each. Side-by-side viewing doesn't help you *measure* across the cut; stitching does.

1. In the gallery, select the split sheets (2–4, left-to-right selection order) and click **Stitch N into one surface**. They butt edge-to-edge—no gap—and open as **one** sheet with its own tab and scale (inherited when the members' scales agree).
2. **Join the match line**: click **Align** in the toolbar (it appears while a stitch is open), click a recognizable point near the joint, then click the **same drawn point** on the other sheet. That sheet slides so the two coincide—zoom in first for a tight joint, exactly like calibrating. Where the sheets overlap, each shows its own half up to the seam, so borders near the match line don't cover the plan.
3. Work it like any sheet. A room that crosses the match line traces as **one shape**—manual tools and **One-Click** both work straight across the seam (the members' linework merges into one snap grid and one flood mask). Quantities, the Report, undo, and revisions treat the stitch as a normal sheet.

Notes: align the match line **before** tracing—once takeoffs live on a stitch it won't re-align (their coordinates ride the composite). Deleting a stitch is refused while takeoffs or markups live on it; reopen one anytime from its tab or the gallery's **Stitched surfaces** strip. The Marked Set PDF burns a stitch in as one composite page—members placed at their aligned offsets, each showing its own half up to the seam, shapes drawn once in the frame you measured them in—stamped as a stitched composite so nobody mistakes it for a sheet the architect issued.

Stitching and aligning are yours alone—an AI agent driving OpenTakeoff [over MCP](MCP.md) has no stitch verb, on purpose: judging that two wall junctions are the same drawn point is human work, and a sloppy join quietly skews everything measured across the seam. If an agent will be doing the takeoff on a split floor, do the stitch and align yourself first, or have the agent measure the member sheets individually.

### Levels (multi-floor sets)

In the gallery, select sheets and click **Assign level…** (`"L1"`, `"Level 2"`, `"Garage"`—empty clears). The gallery groups by level with unassigned sheets last, cards wear their level chip, and tabs plus the page picker carry the label. Levels save with the project.

### Pan and zoom

Panning is always at hand, whatever tool is armed:

- **Trackpad**: two-finger scroll pans both axes; pinch zooms.
- **Mouse**: a wheel notch zooms toward the cursor (~12% per notch, glided); `⇧`+wheel pans.
- **Any device**: middle-drag, right-drag, or hold `Space` and drag. There is no Pan tool—pan is never a mode you switch into.
- **Select tool**: dragging open canvas pans—the instinct you brought from desktop takeoff tools works here.
- **Mid-measure**: a held click that moves becomes a pan instead of placing a point. Click-release places; press-drag travels.

### Rendering: crisp at any zoom

Past ~115% zoom the visible region re-renders straight from the PDF vectors at your current zoom, so fine callouts and hatching stay razor-sharp at any depth. Per sheet, the **Render & fill settings** menu (the sliders icon beside the 45° and Snap toggles) offers **Hi-Res render (this sheet)**—a higher base raster quality budget (~28 MP) for dense sheets. Hi-Res is a display setting, saved per sheet per browser; **quantities are never affected by render quality**.

### Layers (CAD-exported sheets)

A sheet exported from CAD often carries an **Optional Content** table—the layer names the
drafter worked in. When it does, a **Layers** rail button appears and the docked panel lists
every layer with the role OpenTakeoff classified it as and whether the PDF has it visible by
default. Each layer takes one of three settings:

- **Auto**—use the classified role (the default, and what One-Click reads).
- **Wall**—treat this layer's ink as hard boundary, so a fill stops at it.
- **Off**—ignore this layer's ink entirely, so a fill passes through it.

This is why One-Click doesn't have to *infer* a room boundary from hatch on a layered sheet: the
drawing already states what its ink is. On the measured fixture corpus, honoring the declared
roles takes mean region IoU from 0.543 to 1.000 across tile-grid, grid-line,
hidden-demolition, furniture, and xref-dialect scenes. Overrides save per sheet, and **Return
every layer on this sheet to Auto** resets them. Sheets with no layer table show no rail button
and no panel—the fill path is byte-identical to a sheet without layers, so nothing changes for
scans or flattened plots.

### Dark view (☾)

The **☾** button in the zoom cluster inverts the sheet pixels themselves—a true negative print, white linework on black, not a CSS filter—with hatches retuned to stay legible. The setting persists per browser, and exports follow it: a dark canvas produces a dark Marked Set PDF.

---

## 3. Scale — set it first

Scale is the foundation. Every square foot on your report is pixels × scale², so a wrong scale is every number wrong at once. OpenTakeoff treats scale accordingly: it's **per sheet**, it's verified visually on every acceptance, and nothing prices without it.

### What refuses to work without a scale

Until a sheet has a scale, the Scale chip reads **Set scale…** in red, the live readout says **Set scale first**, and committing a measurement refuses with *"Set the scale for 〈sheet〉 first."* One-Click won't propose, and pasting a shape onto an unscaled sheet refuses too (paste re-prices on the target sheet). The one exception is **Count**—each (EA) quantities don't depend on scale, so counting works everywhere.

This is deliberate. A takeoff tool that silently measures in pixels produces confident-looking garbage; OpenTakeoff would rather stop you for five seconds.

### Adopting the plan's own note

When a sheet's title block states a scale, OpenTakeoff reads it as you open the sheet. The Scale menu then leads with **Plan says 1/4″ = 1′-0″ — use it** under the heading *From the plan*. **Pointing at the item previews the calibrated guide bar on the sheet behind the menu**—sanity-check before you commit. If the sheet shows several different scales (details are often larger), the suggestion is marked **±** and the tooltip tells you to confirm against a known dimension; when the text shows several scales and no title-block note, nothing is suggested at all—ambiguity is not a suggestion.

### Standard scales

The Scale menu lists the standard architectural scales (1/16″ through 3″ = 1′-0″), engineering scales (1″ = 10′ through 1″ = 60′), and metric ratios (1:20, 1:25, 1:50, 1:75, 1:100, 1:125, 1:200, 1:250, 1:500). Both families are always listed. *Remembered per sheet*—because plan sets are never one uniform scale. In a side-by-side group, the Scale chip targets the sheet you last clicked.

### Calibrate from a known dimension

No usable note? **Calibrate two points…**: click both ends of something the drawing dimensions—the longest string you can find—then type the real length (feet in imperial, meters in metric) and **Apply**. `⌫` pops a misplaced click; both clicks must land on the same sheet.

### Check a dimension (`K`) — make it a habit

`K` is calibrate's read-only twin, for *verifying* a scale before you trace. Click both ends of a printed dimension string; the bar reads what that span **measures** at the current scale (the live cursor chip shows the running length while you pick the second point). Then type what the drawing **says** (`12.5`, `12'6`, `12' 6"`, `12-6`, and `6"` all parse), and a verdict chip grades the error:

- **Green**, within 1%: *matches — scale checks out*.
- **Amber**, within 5%: *off — re-check or recalibrate*.
- **Red**, past 5%: *wrong scale; recalibrate*.

One click on **Recalibrate to this** turns your check into the calibration. Run a check on every new sheet before tracing—it's ten seconds against re-doing a takeoff.

### The guide bar

Every scale acceptance—standard pick, plan-says, calibration, or a check's recalibrate—drops an ephemeral **calibrated ruler bar** on the sheet: a round length with foot (or meter) ticks and the caption *a door opening is about 3′ — if this bar looks wildly off, the scale is wrong*. It dismisses itself after 8 seconds or on your next action, and it's never saved. A 2×-off scale is visually obvious before anything gets traced.

### Rescaling a measured sheet

Change a sheet's scale after tracing and **every shape on that sheet re-prices to the new scale immediately** (counts keep their EA). The Scale menu then offers **Revert scale (was …)**—one step back to the scale the rescale replaced, re-pricing again; the revert is itself revertible. One thing to know: a rescale **clears the undo/redo stack**, because every recorded step froze its quantities at the old scale and undoing one afterwards would resurrect stale numbers.

If the scale you set disagrees with the note printed on the sheet, the chip warns you: **≠ 1/4″ = 1′-0″** in amber, with the tooltip *"You set X, but the plan notes Y — double-check before tracing."*

### Agent-set scales need your confirmation

A scale that arrives from an agent takeoff (an MCP session's export, imported here) is **unconfirmed**: the Scale chip reads **⚠ 1/4″ = 1′-0″ — confirm** in amber, the gallery badge reads **scale ⚠ confirm**, and the Report's provenance footer marks the sheet *agent-set, UNCONFIRMED*. Quantities still compute—but they stand on a number no person has verified. Check a printed dimension (K) first, then choose **Confirm agent-set scale** from the Scale menu; any scale action of your own (a standard pick, plan-says, calibrate, or recalibrate) also counts as confirmation, because your act is the verification.

### Metric

The **`ft` / `m`** toggle beside the Scale chip switches the whole display layer: readouts, shape chips, panels, the Report, CSV, and the Marked Set legend read in m² / m (the SY column retires), and Calibrate takes meters. It's display only—takeoffs are stored unit-agnostically, so flipping it never changes a measurement. Supporting-material coverage rates stay as entered.

---

## 4. Conditions — your finishes

A **condition** is one finish—`LVT-1`, `CPT-2`, `RB-1`—and it's what every measurement commits into. A fresh workspace seeds a flooring starter set (CPT-1, BRD-1, LVT-1, WD-1, VCT-1, SV-1, CT-1, RB-1, TR-1), several with real supporting materials already attached—CT-1 arrives with thinset and a grout line whose coverage derives from tile geometry.

### Creating, editing, deleting

**+ condition** (in the Takeoffs panel footer, the top-bar palette band, or the compact strip) prompts for a finish tag and mints the condition with an auto-rotated color and hatch. The active condition's editor appears inline—in the panel's active row and in the top-bar band:

- **Finish tag**—rename in place.
- **× multiplier**—measure one identical unit, count it N times. Shows as ×N everywhere.
- **Waste %**—the allowance the Report adds on top of the measured quantity. Per condition, matched to the install: ~8% straight-lay LVP, ~15% diagonal, ~20% herringbone.
- **Line** color, **Fill** color (or **No fill**), and the **hatch pattern**—a picker grid of CAD hatches (plank, herringbone, tile, terrazzo…) that names the pattern under your cursor, so the canvas reads like the real drawing.
- **Line style**—the outline dash for this finish's floor and linear takeoffs, on canvas and in the Marked Set.
- **H** (height, ft)—the default for **new** wall traces (Surface Area SF = LF × H) and the vertical-SF display. Existing walls keep the height they were drawn at—select a wall to change only that one (§5).
- **T** (thickness, in)—a Linear run with thickness also computes border/feature-strip SF = LF × T⁄12. Changing it re-flows existing runs.

**Delete** (the row's ✕) asks first when the condition owns shapes—*"Delete 〈TAG〉 and its N takeoff(s)? This can't be undone."*—and means it: the cascade is deliberately outside the undo stack (§8).

There's no per-condition duplicate; the Library fills that role—read on.

### The quick-access palette and `1`–`9`

The band under the toolbar is your working set: **pin** a condition there (the pushpin on its panel row) or **drag** a row onto the band. Palette chips wear cobalt number badges—**that number is the hotkey**: `1`–`9` arm palette conditions in palette order (drag chips to reorder; the numbers follow). Up to 9 pin, mapping 1:1 onto the digits; with nothing pinned, the digits fall back to list order. Single-click a chip to arm it; double-click to open its row in the panel. A digit press only ever arms—it never reassigns a selected shape (§7).

### The Takeoffs panel

The **☰ Takeoffs** rail button docks the panel (it starts collapsed; the palette band is the primary surface). Four tabs:

- **Takeoffs**—every condition with live totals for the open sheets (`SF · SF wall · LF · EA`), a shape count, a **⌖** that zooms the canvas to the condition's takeoffs (double-clicking the row does the same), the Supporting Materials button, the pin, and delete. Above the list: a filter box, **A→Z** natural sort and **≡ grp** tag-family grouping (views only—hotkey numbering never changes). **⌘-click / ⇧-click** rows to bulk-select conditions, then set waste or line color on all of them, or bulk-delete.
- **Library**—reusable condition templates, shared across every plan in this browser. **+ save 〈tag〉 to the library** snapshots the active condition (appearance, waste, H/T, materials); **Apply** adds it to any project as a fresh condition. A fresh workspace seeds from this library—tune your house conditions once and every new job starts with them.
- **Materials**—a browser-wide materials library. Attaching a library material to a condition copies its values and keeps a link (⛓); library edits reach linked lines only when you push them, and overridden fields show amber with a per-field ↺ revert.
- **Columns**—project-wide **custom columns** (for example, *CSI Division*) that classify conditions for report grouping and exports, and the **shape-label vocabulary** (§7).

### Supporting materials — the buy list's source

Open **Supporting Materials** on a condition. Two free-text fields sit above the material list—**Labor** (glue-down, float, nail-down, …) and **Subfloor** (ply, concrete slab, OSB, …)—fill in whatever your bid needs; both round-trip through saved templates and show up as their own Report/CSV/XLSX columns once you've typed a value anywhere in the project.

Below that, list what actually goes on the order: adhesive, sealer, polyurethane, thinset, grout, cove-base adhesive. Each line carries:

- a **coverage rate**—*1 unit per N*—and a **basis**: floor SF, linear LF, each, or **seam LF**;
- a **round up** flag (on by default—you buy whole buckets and bags);
- a **preset picker** for adhesive and mortar lines: real trowel-notch and roller spread rates (PSA rollers at 300 SF/gal down to coarse wood notches at 40 SF/gal; mortar trowels from 90 to 30 SF per 50-lb bag). Generic industry-typical values—always verify against the product data sheet;
- for **grout** lines, an inline **calculator**: enter tile L × W × thickness, joint width (1/32″–1/2″), and bag weight, and the SF/bag rate derives itself, writing its work into the note (`12×24×3/8″ @ 1/8″ · 25 lb`);
- a **note** field for coats, notch, anything the order needs to remember.

Order quantity = measured basis ÷ coverage, **rounded up to whole units**. The Report sums every condition's lines into one combined buy list (§10).

**The seam LF basis** is the one that isn't measured off the drawing—it's *figured* off the
condition's roll layout (§4, Roll goods): the length where two cuts actually meet on the floor,
which is what a heat-weld rod or a carpet seam tape is bought by. That matters because seam
quantity has no relationship to area. A 20-ft-wide room off a 12-ft roll seams once down its
whole length; the same square footage as two separate 10-ft rooms seams not at all—and the
percentage-of-perimeter rule most estimators fall back on can't tell those two jobs apart.
Set the condition's roll goods first: without a roll setup, or with nothing traced yet, a seam
LF line reads **0**, which means *needs a layout* rather than a number you shouldn't trust.

### One finish, two areas — condition twins

The same finish measured in two places is often not the same *scope*. The same sheet goods over a
slab and over a raised deck take the same field material and different preparation underneath: one
wants a moisture barrier, the other a primer and a different adhesive. Making a second condition
by hand means re-entering the whole materials list; measuring both areas into one condition throws
away the per-area buy list, which was the thing you were producing.

**⎘ Duplicate for another area…** at the bottom of Supporting Materials solves it. Name the area
inline—`Level 2`—and you get `SV-1 – Level 2` carrying the whole materials list, still
**following** the original:

- Change a coverage rate on the original and every twin that hasn't touched that row gets it. One
  edit, every area.
- Edit a row on the twin and **only that row** stops following. It shows `✎` instead of `↳`, and
  `↺ follow` hands it back to the family whenever you want.
- Remove a row on the twin and it stays visible, struck through, as *removed here*. "This area has
  no moisture barrier" is a decision, so a later change on the original can't quietly put it back.
  `↺ restore` if you change your mind.
- The condition list nests a twin under its original with `↳` and a count of the rows that have
  gone their own way.
- **⤴ Split out** freezes every following row where it stands and ends the inheritance. The twin
  keeps its name and still groups with its family—only the following stops.

Two things worth knowing:

- **A twin gets its own finish tag, and that matters.** Every export row and every MCP tool
  resolves a condition by its tag, so two conditions sharing one would make the second
  unreachable and collapse into a single condition if you ever re-imported the takeoff. That's why
  the area label is required, and why a label already in use is refused.
- **No takeoffs come along.** The twin starts empty—you measure the new area into it. To move
  existing shapes across, select one and click the twin's row (the reassign gesture).

Deleting an original doesn't orphan its twins: the eldest is promoted in its place and the rest
follow it.

### Roll goods — broadloom, sheet vinyl, and the seams

Tile and plank come in boxes, so SF plus waste is the whole order. Roll goods don't: a 12′ roll
laid into a 14′ room means a seam, and the footage you buy depends on how the cuts nest down the
roll. Open the condition's **+ roll goods…** picker and choose **Broadloom carpet**, **Sheet
vinyl**, or **Sheet rubber**, and every floor area on that condition gets figured into cuts.

The setup sits inline on the condition:

- **Roll width**—a preset, or type feet and inches for an odd width.
- **max** (roll length, ft)—the usable length of one physical roll. **0 = continuous**, cut off
  a single roll. Set it and the cuts pack **across** rolls, with the roll breaks marked on the
  diagram.
- **Direction**—`auto`, or force **N–S** / **E–W** when the pattern or the corridor decides it.
- **Sell unit**—SY, SF, or LF, for how the order reads.
- Seam and wall allowances.

The condition row then shows the figured order: how far down the roll the cuts reach (side-by-side
cuts share length), rounded up to the inch, plus the roll count when a max length is set. If a
single cut can't come off one roll you get **· a cut exceeds one roll** in red—that's a
re-plan, not a rounding note.

**On the canvas.** The cuts draw to scale over their own rooms in material-true colors, numbered
in cutting order. The **Roll goods** panel (rail) shows those same cuts nested **on the roll**
with dimensions, and dragging a cut in the panel re-packs the layout in your order; **reset
order** clears manual sequencing and lets the packer sort widest-then-longest again. Click **edit**
in the panel to draw the figured cuts over the plan and slide or resize them by hand—those
edits are real undo steps, and double-clicking a cut resets it. One note the panel states
outright: a condition's **×N multiplier applies to the order**, while the diagram always shows
one unit's cuts.

**On the report.** **Roll Order LF**, **Rolls**, and **Seam LF** ride the Report, CSV, and Excel
next to the measured quantities, and they're in the `report.v1` export document, so a pricing
consumer reads the figured order rather than re-deriving it. Seam LF is the weld-rod/seam-tape
quantity, counted between adjacent lanes of the same room (two rooms are separated by a wall and
a threshold, not welded together), measured net of the wall overage—a weld doesn't run up the
wall—and only where two lanes actually face each other, so an L-shaped room seams along the
part that does. Point a supporting-materials line at the **seam LF** basis (§4) to turn it into
an order quantity. Removing a roll setup stops the figuring; manual
cut edits on shapes are kept but go inert.

Agents get the same thing headlessly—`roll_setup` is a field on the MCP server's
`edit_condition`, and the reply echoes the figured order ([§14](#14-ai-settings-and-driving-opentakeoff-from-an-agent)).

### Import from schedule

<img src="img/verify-import-schedule-dialog.png" alt="The Import from schedule verify dialog — parsed finishes grouped by category, checked for approval" width="640"/>

Why type conditions the architect already tabulated? Arm **Schedule** in the toolbar and click two corners around the finish schedule on the sheet. The table parses in the browser, and a verify dialog lists every finish it found—grouped Floor / Base / Wall / Transition / Ceiling / Other, each row with the code (click to fix it), description, and flags (**in use**, **duplicate**, **needs a code**). Ceiling and other rows arrive unchecked; you approve what becomes conditions. Each created condition gets category-appropriate color, hatch, and default waste (floor 5%, base and wall 10%), and the schedule's product data (manufacturer, style, color, size) rides along as read-only spec fields that surface as the Report's *Product spec (imported)* columns.

On scanned pages there's no text to parse; team builds with the optional AI backend can read the schedule from pixels—the message tells you when that's what's needed.

---

## 5. The measuring tools

Every measuring tool commits into the active condition and refuses politely without a scale (§3). Trace with click-release; press-drag pans. `⏎` or double-click finishes a shape; `⌫` pops the last point; `Esc` abandons the trace; `⌘Z` mid-trace also pops the last point.

### The aim cursor

On the canvas the crosshair **is** the cursor: the OS pointer hides in draw modes, full-page cobalt hairlines meet at a star, and in-progress work draws in the instrument's own cobalt—committed shapes wear their condition's color. A chip by the cursor carries the live readout for whatever you're doing.

### Area (`A`)

Click vertex by vertex around the space; `⏎`, double-click, or the **Finish** button closes it at three or more points. The live readout shows the running segment length while you trace, and the committed shape reads SF, SY, and perimeter LF—select it any time later and the readout gives you both numbers again, so a footprint's LF never needs a second trace with the Linear tool.

**Curved boundaries.** Buildings are not all right angles: a bowed wall, a radius corner, a curved curb or pool edge. You don't leave the tool for them—the readout carries a **╱ Straight / ⌒ Curve** switch, and you flip it *mid measurement*, as often as you like inside one shape.

- **Curve** mode: **an arc is three clicks, and it is a real circle.** The clicks alternate—the first lands anywhere **on the bow**, the second on its **far end**—and together with the vertex you were already on, those three points define exactly one circle. That is the whole difference: a radius wall *is* a circle, so the arc **sits on it** instead of near it. The bow point draws as a round handle, and the arc redraws live as you aim the far end.
- **`Q`** flips the switch once a trace is going.
- **`⌥`-click** always places the *other* kind for exactly one point—one bow point without leaving Straight, or one hard corner without leaving Curve.

The live chip reads the length **along the arc**, not across it, and sweeps past half a circle are fine: put the bow where the wall actually goes and the arc follows it round. `⏎` waits until the far end is placed—a bow on its own is half a gesture.

So a bowed room is: click the straight walls, flip to Curve, click the bow and the far end, flip back, close it.

The same switch works on **Line**, **Cut Out**, and **Surface Area**: a curved feature strip, a bowed deduct, a radius wall. On `⏎` the shape commits as **one ordinary geometry**—the arc is flattened into the ring or the run, passing exactly through the point you clicked, so SF, LF, Cut Out, the marked set, and every export treat it as the polygon or polyline it now is, and its `origin` records that it was traced with curves.

### Rectangle (`R`)

Two clicks: one corner, then the opposite corner. Between them the cursor chip reads live—`12′ 6″ × 10′ 0″ · 125 SF · 13.9 SY`—and turns **amber the moment a side reaches 12′**: broadloom roll width, a seam falls here. Watch the chip and you're seam-planning while you measure.

### Linear (`L`)

An open run, two or more points → LF. The **╱ Straight / ⌒ Curve** switch works here too (see Area, above)—a run that bends partway along commits as one line. If the condition carries a **thickness**, the run also yields border SF (LF × thickness ÷ 12)—feature strips, borders, transitions. The live chip reads the running segment length, amber at 12′.

### Surface Area (`S`)

Trace a wall run in plan; wall SF = traced LF × the condition's **height**. There's no prompt mid-trace—the height comes from the condition, and the tool refuses if it has none: *"Set a height for 〈TAG〉 (H in the condition editor) — Surface Area = traced LF × height."* After commit, select the wall and the readout offers a **this wall** height override (with a ↺ reset)—full-height tile here, 4-ft wainscot there, same condition. A wall keeps the height it was drawn at even if you later change the condition's default, and an explicit override is honored outright—even `0`.

### Count (`C`)

One click, one marker, one EA. Counts commit immediately on click and are the one measurement that works without a scale.

### Cut Out — deducts (`D`, `⇧D`)

The **Cut Out** menu subtracts voids: **Deduct shape** (`D`) traces a polygon, **Deduct rectangle** (`⇧D`) boxes one. A deduct belongs to the active condition and subtracts its SF from that condition's floor total—columns, shafts, casework, anything inside a traced area that doesn't get flooring. Deducts draw in dashed red and carry their negative sign into the report's shape audit.

### ⟂ Transitions — where two finishes meet

Carpet meets tile and somebody draws a line there, by hand, on every job. Once both finishes are
measured, the canvas can derive it. Activate the condition the transition belongs to—`TR-1`, its
own tag, not one of the two finishes—open the Takeoffs panel, and click **⟂ Transitions…** under
that condition. Choose the two finishes and click **Derive**.

What comes back depends on something worth understanding, because it decides whether a number is
real: **traced rooms don't share edges.** A trace fills to the wall linework, so two rooms on
opposite sides of a partition are separated by four to eight inches of nothing. What's actually
there is proximity, in two flavors that mean completely different things:

- **A butt joint**—the two rooms running together inside *one open space*, a lobby that changes
  from carpet to tile with no wall between them. That run **is** the transition. It commits onto
  the active condition as a dashed linear shape, and the **Accept N proposed shapes** pill inks it
  the same way it inks an imported agent takeoff. `⌘Z` undoes the whole sweep in one step; to drop
  one, select it and press Delete.
- **Wall-separated**—the two rooms running parallel across a partition. They're adjacent, but the
  transition is not the whole shared wall: it's a *threshold, in the doorway*, and nothing in the
  trace record says where the doorway is. Committing 34 LF of threshold because two rooms share
  34 LF of wall would be a wrong number with a machine's confidence behind it. Those are listed
  under **Reported, never counted** with their length and the measured wall thickness, and a
  **look** link that centers the sheet on the run. Find the door and measure the threshold there,
  with the Linear tool.

Three things it refuses outright, before anything commits:

- **Deriving onto one of the two finishes.** A transition has to land on its own condition;
  committing carpet-meets-tile onto the carpet would add the joint's LF to a finish it separates,
  and nothing downstream would show you that.
- **An unscaled sheet.** A transition is a real length.
- **A finish with no rooms on the open sheets.** The derivation only proposes what you can see and
  review—it reads the sheets you have open, not the whole set.

The same derivation is `derive_transitions` over MCP
([§14](#14-ai-settings-and-driving-opentakeoff-from-an-agent)), with the same verdict and the same
refusal.

### Zone check

**Zone** (toolbar button; no hotkey) answers "what's in this wing?" without touching the takeoff. Trace a region the way you'd trace an area—an apartment, a phase—and close it with `⏎`, double-click, or **Finish**. A panel lists every condition whose shapes sit inside, with quantities **and its supporting materials scaled to the zone**, computed by the same rules as the Report. Shapes count by their center point, same sheet only, and counted shapes glow cobalt so inclusion is visible. It's a reading, not a takeoff: nothing is saved, redrawing replaces the zone, and `Esc` or leaving the tool clears it.

### The 45°/90° angle lock

With the **45°** toggle on (it's on by default), the segment you're drawing locks to the 45° family—0°, 45°, 90°, 135° across the sheet—whenever the cursor comes within ~4° of an axis. The lock is quiet: the star swells, the preview line thickens, and the chip reads the locked angle plus the live segment length. **The click commits the exactly-on-axis point**, so walls come out dead square. Hold `⇧` to force the lock at any cursor angle; toggle **45°** off for free-angle tracing.

### Snap (beta)

The **Snap** toggle pulls your cursor onto true PDF endpoints—real corners extracted from the drawing's own vectors. When a snap engages, the chip reads `snap`, and an endpoint snap always beats the angle lock: corners win over axes. Off by default; scans have no vector endpoints, so Snap has nothing to grab there.

### The live readout

The top-right readout tracks the armed tool: totals for the tracing tools, `W × H · SF · SY` for Rectangle, wall SF at the condition height for Surface Area, and running One-Click selection totals. Any run or side that reaches **12′ turns the chip amber**—the roll-width warning rides every tool that measures a length.

---

## 6. One-Click Area

<img src="img/one-click-area.gif" alt="One-Click Area tracing patient rooms wall to wall on the sample plan" width="820"/>

One-Click Area (`O`) is the fastest way to measure a room: click inside it, and the linework bounds a flood fill, the boundary traces itself, and the vertices snap to true corners. What comes back is a **proposal**—dashed, editable, uncommitted—and nothing enters your takeoff until you create it. Review is the point: the engine does the tracing, you keep the judgment.

### The flow

1. Arm `O` and click inside a room. The traced region appears dashed with a star at your seed point.
2. Keep clicking—each click adds a space to the selection (the readout totals them live). **`⌥`-click carves a cutout**: an enclosed area *inside* an already-selected space—a column, a shaft—that will commit as a deduct.
3. **Create** with `⏎`, a double-click, or the **Create (N)** toolbar button. Every space commits as a shape on the active condition; cutouts commit as deducts. The toast confirms: *"Created N takeoff(s) — 〈SF〉 〈TAG〉. Click the next room."*

**Create leaves the newest takeoff selected**, so if you watch a fill land wrong the very next
`⌫` deletes it—no trip to the Edit menu. One-Click stays armed (the message means what it says:
click the next room), and because the proposal branch comes first in the `⌫` chain, the next
fill's backspace still walks that selection back instead of touching the committed shape.

`⌫` walks the selection back (last region drops), and `Esc` discards it all. The readout keeps the crib sheet on screen: *click adds a space · ⌥-click carves a cutout · ⏎ Create · ⌫ undo · Esc cancel*.

### Review before Create

Point to a proposed region and its grips appear:

- **Drag a corner** to move it (it snaps to true drawing endpoints as you drag).
- **Click a corner** to select it—`⌫` then deletes only that point (a space keeps a 3-point floor).
- **Drag an edge grip** to move the whole line—both endpoints together.
- **`⇧`-click an edge** to insert a new anchor at its midpoint and drag it out in the same gesture.

Edits you make before Create ride into the shape's provenance as *corrected before create*, with the machine's original ring frozen alongside—the takeoff remembers what the engine proposed and what you fixed.

### Hatched rooms, and when it refuses

Hatch and poché don't fool the fill: tile grids, plank lines, and section fills are classified as *pattern*, not wall, so a click inside a fully hatched room still traces to the real walls. The escalation is conservative—a strict pass runs first, the hatch-transparent retry only engages when the strict pass comes back trapped, and a retry that balloons past sanity is discarded for the strict result. **A misread can never make the result worse than the strict fill.**

When One-Click refuses, it says why, and the answer is always actionable:

- *"That space isn't enclosed on the plan linework — the fill spilled."*—there's a genuine gap (an open doorway, a break in the wall). Click a more enclosed spot, or trace it with Area (`A`). A hatched room with a real door gap **refuses rather than guessing**—that's deliberate.
- *"Landed in dense linework (hatching/text)."*—the click landed on a text block, or on hatching too dense to read as a room. Zoom in and click an open spot, or use Area.

### Fill sensitivity

The **Fill** slider lives in the **Render & fill settings** menu (sliders icon), with three notches:

- **Strict**—stop at the linework, no hatch crossing (the original behavior).
- **Balanced** (default)—recover hatch-lined rooms to the walls.
- **Aggressive**—cross more pattern and tolerate more growth.

Lower it if fills spill; raise it if hatched rooms come up short. The setting is per browser, and a non-default sensitivity is recorded on the shapes it produced.

**When the slider can't help, it says so.** Sensitivity tunes exactly one thing—how eagerly a
fill escalates past ink the classifier called hatch—so a fill whose boundary is *entirely* hard
ink comes back identical at every notch. Rather than let you crank Strict → Aggressive and
conclude the control is broken, the menu adds the reason for the last fill: *"Nothing on this
fill's boundary classified as a hatch or tile pattern, so every setting returns the same region.
It is stopping on ink the engine still reads as a wall."* That's a different problem—trace it
with Area (`A`), or check the sheet's **Layers** panel ([§2](#2-opening-plans-and-moving-around)) if
it's a CAD export whose ink is mislabeled.

### Scanned plans

A scanned sheet has no vector linework, so the engine reads the rendered pixels instead: adaptive thresholding (shaded rooms and uneven scans read correctly), polarity detection (blueprint negatives invert), and a gap-bridging pass for faded ink—then the same flood-and-trace machinery runs on the scan ink. Raster results skip corner snapping (a scan has no true endpoints) and the readout badges them plainly: ***Traced from scan pixels — verify edges before Create.*** Nudge the grips where the scan is soft, then create. The sensitivity slider doesn't apply on scans, and the refusal messages name the scan honestly (*"the fill escaped through a gap — faded line or open doorway"*).

### The provenance receipt

Every shape One-Click creates records how it was made: the method, the seed point you clicked, whether hatch filtering engaged, whether it was traced from scan pixels, any non-default fill sensitivity, and—if you adjusted the proposal—the machine's original ring frozen next to your final one. You'll never need to think about this while measuring; it's what makes the takeoff auditable later, and it's the backbone of the optional Contribute flow (§12).

---

## 7. Selecting and editing shapes

Arm **Select** (`V`) and click a shape. Shapes stack by kind—filled Areas at the bottom, Cut Outs directly above the fill they punch, Linear and Surface runs above that, Count pins on top—and clicking picks whatever reads as on-top at that spot. So a big Area drawn over a Counter, Line, or Surface never blocks it: the covered element stays clickable through the fill, and the Area itself still selects anywhere in its open fill. Selection is one shape at a time on the canvas, and the same edit grammar as One-Click proposals applies:

- **Drag a corner** to move that vertex (it snaps to true drawing endpoints). **Click a corner first** to select it—`⌫` then deletes only that vertex. A closed shape keeps at least 3 points, a run keeps 2; at the floor, the message tells you *"⌫ again deletes the whole shape."*
- **Drag an edge grip** (mid-edge) to move the whole line—both endpoints together.
- **Press anywhere else along an edge** to insert a new anchor at that exact spot and drag it out in one gesture—a **`+` ghost** rides the edge under your cursor to show where the point will land (it stays clear of the corner and mid-edge grips, so those gestures still win). `⇧`-click at the mid-edge grip still inserts at the exact midpoint.
- **Drag the body** to move the whole shape. Moving never re-prices—translation doesn't change area.
- **`⌫` with nothing else picked** deletes the shape.

Quantities recompute live as you edit. Every completed gesture is one undo step (a drag that ends where it started records nothing), and editing a machine-made shape—One-Click or agent—grades it as *corrected* in its provenance, with the machine's original boundary frozen the first time you touch it. The **Edit** menu in the toolbar carries the same verbs—Copy, Paste, Duplicate, **Flip Horizontal**, **Flip Vertical**, Delete selected, Undo last point, Undo last shape, Redo—with their shortcuts beside them. Flip mirrors the selected shape about its own center (an isometry—SF/LF never change); it has no keyboard shortcut, only the menu.

### Copy, paste, duplicate

- `⌘C` copies the selected shape—the toast reminds you: *"Copied — ⌘V pastes onto the sheet under your cursor."*
- `⌘V` pastes **onto the sheet the pointer is over**—cross-sheet included. A same-sheet paste lands slightly offset so you can see it; a cross-sheet paste keeps the same relative spot and **re-prices against the target sheet's own scale**—never carrying stale square feet (an unscaled target refuses).
- `⌘D` duplicates in place.
- A wall's height override rides along with copies—even an explicit 0. Pasted clones carry their source's lineage, marked as copies in provenance.

### Reassigning a shape's condition

With a shape selected, click a condition **panel row, strip chip, or palette chip**—each shows the reassign affordance when a shape is selected—and the shape moves to that finish, quantities and all. The number keys never reassign: a digit press arms the condition without touching your selection, so a stray `3` can't silently move quantities. Reassigning is one undo step.

### Shape labels — phases and areas

Labels answer "which part of the job is this?" without more conditions: *Phase 1*, *East Wing*, *Alt-2*. The vocabulary lives in the Takeoffs panel's **Columns** tab (add, rename—labeled shapes follow, remove—shapes keep their value); once any labels exist, a **Label** cluster appears in the toolbar:

- Its caption shows the **active label**—every new trace you commit gets it. Set it to *Phase 1*, trace the phase, set it to *Phase 2*, keep going.
- With Select armed and a shape selected, the same dropdown shows **that shape's** label and re-labels it.

Labels drive the Report's *Group: Label* mode and its by-label export sections (§10). Label changes are undoable, and they never mark a shape as edited—classification is not correction.

---

## 8. Undo and redo

`⌘Z` undoes, `⇧⌘Z` redoes—real undo, over a stack of up to 100 steps.

**What's a step.** Creating shapes (a whole One-Click *Create* batch or an agent *Accept* batch is **one** step), every completed edit gesture (a vertex drag, an edge drag, a body move, a vertex delete), a reassign, a label change, a delete, a paste, a duplicate, and placing or lifting an **approval seal** (§9). A drag that ends where it started records nothing—zero motion is not an edit.

**What undo restores.** Everything, exactly: geometry, quantities, stacking order, and provenance. Undoing an edit removes the *edited* flag it stamped; undoing a delete resurrects the shapes byte-for-byte at their original positions in the stack. Redo replays the step; making any new edit discards the redone future, as you'd expect.

**Mid-draw, `⌘Z` pops points.** While a trace is in progress, `⌘Z` removes the last placed point (same as `⌫`)—the command stack only engages when nothing is mid-draw.

**What's deliberately outside the stack:**

- **Deleting a condition.** The confirm says *"This can't be undone"* and means it: the cascade delete of its shapes doesn't record. A condition delete is a decision about the takeoff's structure, not a gesture (Revisions are your parachute—§11).
- **Rescaling a sheet** and **restoring a revision** both **reset the stack**. Every recorded step froze quantities at the old scale (or the old timeline); undoing across that boundary would resurrect stale numbers, so the boundary clears it. A restore always banks the live takeoff first, so nothing is lost—it isn't on the `⌘Z` stack.
- **Markups and condition edits.** The undo stack is for measured shapes (and approval seals). Moving a cloud or changing a waste % is a plain edit—change it back by hand.

One more distinction: **Undo last shape** (Edit menu) and `⌫`-with-nothing-in-progress are not `⌘Z`—they *delete the newest shape* on the sheets you're viewing. That delete records normally, so `⌘Z` can bring the shape back.

---

## 9. Markups, stamps, and RFIs

The markup layer is communication, never quantity: clouds, callouts, notes, highlighter ink, and stamps live on a separate layer the totals never count. The left dock (rail buttons on the canvas's right edge) carries three tabs—**Markups**, **Stamps**, **RFIs**.

### The markup tools

The **Markup** menu holds six tools:

- **Highlighter** (`H`)—freehand marker ink. Press and **drag to paint**, stroke after stroke, no dialog between them. While it's armed, a style popover hangs under the menu: five inks (yellow default), **F / M / B** tip sizes, and a **chisel or round** nib—remembered per browser. Because press-drag paints, press-drag panning is off while the highlighter is armed; pan with `Space`-drag, middle-drag, or right-drag. Strokes stick to their sheet, scale like real ink, and are real objects: with Select, click one (it glows), drag to move it, `⌫` deletes it.
- **Revision cloud**—two corner clicks; the cloud lands immediately, then an optional note editor opens (`Esc` keeps the cloud, skips the note). Clouds can carry a **Rev △** revision number from the panel.
- **Callout**—first click is the *target* (the thing you're pointing at), second is the label spot, then type the text.
- **Text note**—one click, type in place. Empty text doesn't commit.
- **Highlight box**—two corners, done.
- **Dimension line** (`N`)—a standalone dimension string for the width or height the plan never printed: click one end, a live length chip follows the cursor, click the other end. It lands as a line with end ticks labeled with the measured length at the sheet's scale (`12'-6"`), tied to nothing—no condition, no quantity, only the sheet's scale. It needs that scale set (the first click refuses otherwise, same as the measure tools) and won't span sheets. Double-click it to add a note after the length; it prints on the Marked Set like any markup.

Every markup is editable after the fact: with Select, click to select it, drag to move it, **double-click to edit its text in place**. The Markups panel lists them all with an edit pencil, a **color** row (auto or any palette color), **line style** and **weight** controls, and a **Hide layer / Show layer** toggle for the whole layer. (Markup moves are plain edits, not undo steps—the `⌘Z` stack is for measured shapes.)

### Stamps

A **stamp** is a reusable annotation—one or several markup elements saved as a named group and placed with a click. The library seeds with flooring basics (**Plank / tile direction**, **Seam direction**, **Pattern origin**) and is browser-global: build it once, use it on every plan.

Click **Place** on a stamp and the canvas arms it: *click the plan to place it*—every click drops a copy until `Esc` or another tool. Placed stamps are normal, editable markups. Make your own: select any markup and **Save selected markup as stamp**, or **Import** an `.svg` vector symbol (or a stamp-library `.json`); **Export** shares your library the same way.

### Approval stamps

Agent marks are pencil; the estimator's stamp is ink. The **Approve** button in the toolbar arms the approval tool: **click a committed takeoff** to approve it—the seal records which shape it covers—or **click empty plan** to approve the sheet at that point. Click an existing seal to lift it. Unlike markup moves, placing and lifting are real undo steps: `⌘Z` takes the last one back, `⇧⌘Z` re-applies it.

Two glyphs, deliberately unmistakable: the estimator's seal is a green circular ring reading
**APPROVED**; an agent's verdict is a graphite diamond always labeled **AGENT**. Only the toolbar
tool—a human hand—places the estimator seal: no agent, MCP, or import path mints one. Agent
verdict marks are the same record family (`actor: "agent"`), and they render, persist, and undo
identically. An agent working over MCP signs its own work with `mark_verdict` (and clears it with
`delete_verdict`); the tool takes no actor argument, so it can only ever produce the graphite
diamond. That's the whole point of two glyphs: the agent can say *"I measured this and I stand by
it"* without ever being able to claim a person checked it.

Seals ride the project autosave and burn into the **Marked Set PDF** above the markups, and the cover gains a tally line—*N estimator-approved · N agent-marked*—so a PM reading the set knows exactly how much of it a person has looked at. The "Include markups" export checkbox never drops seals: approvals are ink, not annotations.

### RFIs

The **RFI register** turns a markup into a tracked question. In the Markups panel, every cloud, callout, or note carries **Raise RFI** (or **Link existing…** to attach it to an open one). Raising mints the next number—`RFI-001`, `RFI-002`, …—seeds the subject from the markup's text, and opens the register.

Each RFI carries: subject, question, **status** (Open / Answered / Closed / Void), **priority** (low / normal / high), **ball in court** (*Architect / GC…*), opened date, **cost impact** and **schedule impact** flags, and a response—the response date auto-stamps when the status turns Answered. Linked-markup chips fly you to the markup on its sheet; one RFI can link many markups. Deleting an RFI keeps the markups, minus the link.

RFIs export as **RFI CSV** and **RFI JSON** from the Report, and they ride the Marked Set PDF: linked markups get an on-sheet RFI-number marker and the set gains an **RFI schedule** page. An RFI-only project—questions before quantities—still exports a marked set.

---

## 10. The report and exports

<img src="img/report.png" alt="The takeoff report — per-condition breakdown and materials buy list" width="780"/>

Open **Report** for the whole takeoff on one page: a per-condition table, the supporting-materials buy list, per-sheet base quantities, and your markups noted—with a project-name field and a print masthead up top (client, reference, date, prepared-by, and an optional trade-name identity so the output brands as your company).

### The numbers, honestly

- **Measured versus w/Waste.** Waste lives only in the w/Waste column: *SF w/Waste = measured × (1 + waste %)*. The measured quantity is never inflated, so your takeoff and your buy list stay honest about which is which. Waste applies to SF and LF, never EA.
- **SY** = w/Waste SF ÷ 9.
- **Multipliers** show as ×N beside the finish tag and multiply every quantity.
- **Buy list**: each material's quantity = measured basis (floor SF / linear LF / each / figured seam LF) ÷ its coverage rate, **rounded up to whole units**—the number you order, not a theoretical gallon and a half. The combined list sums same-name materials after per-condition rounding.
- The footer says it plainly: *Quantities derived from drawings at stated scales; verify in field.*

### Columns, grouping, templates, theme

- **Columns**—choose what the table (and the CSV) shows. Defaults: Finish, Shapes, Floor SF, Wall SF, Border SF, LF, EA, Waste, SF w/Waste, SY w/Waste. Opt-ins: Total SF, Waste SF, Waste LF, Perimeter LF (reference only—includes openings, never totaled). Roll-goods conditions add **Roll Order LF**, **Rolls**, and **Seam LF** ([§4](#4-conditions--your-finishes)). Custom condition columns, imported product-spec columns (manufacturer, style, color, size, description—from a schedule import), and Labor Type / Subfloor Type (typed into a condition's Supporting Materials panel) appear once they exist. **Labor view** switches to a no-waste actuals set (Total SF in, SF/SY w/Waste out) for tying quantities to labor—attach your own rates externally.
- **Group**—break the table into sections with subtotals: by **Sheet**, by **Label** (once shapes carry labels), or by any custom column. Grouping by a column always carries that column into the CSV.
- **Templates**—save a column-plus-grouping layout by name and recall it on this device. Signed in on a team build, **Push to Drive / Load from Drive** carries templates across your own devices—Load only adds what this device doesn't have; it never overwrites a same-name template.
- **Theme**—import a design-token file (a `tokens.json`) to reskin the report's palette and fonts for output. **Reset** returns the house style.

### Exports

| Export | What you get |
|---|---|
| **CSV** | The condition table, exactly the columns you're showing. |
| **Excel** | A real workbook—**Summary**, **By sheet**, **Materials**, **Shapes** (the audit trail; deducts carry their sign), and **By floor × room**—the cross-section the others each flatten one axis out of: what goes down in *that room on that floor*, ordered quantities per cell, with a floor's unlabeled work rolled up so its rooms still add to the floor. Full-precision cells; formula-shaped names stay inert text. |
| **JSON** | The full structured report—works markups-only and RFI-only too. |
| **Shapes CSV / JSON** | Per-shape measured quantities—no multiplier, no waste; the audit layer. |
| **Print** | The report through your browser's print dialog. |
| **Marked set** | A distribution-ready PDF built in your browser: every sheet that carries takeoffs or markups, the work burned in as drawn—condition colors, hatches, quantity chips, count markers, markups (toggleable)—behind a legend cover with net totals, w/Waste quantities, and a by-sheet breakdown. Exports in your current view: dark canvas → dark PDF. Send it to a GC who will never install anything. |
| **RFI CSV / JSON** | The RFI register (appears once RFIs exist). |

**Contribute** also lives here—covered with the rest of your data in §12.

---

## 11. Revisions

Addenda happen. **Revisions** (the clock icon on the rail) makes them data instead of archaeology.

- **Save** the current takeoff—conditions, shapes, markups—as a named revision (the name defaults to *Rev N — date*). Do it at every bid revision, and before anything risky.
- **Compare** any revision against the live takeoff or against another revision. The diff reads as **quantity deltas**: per condition (measured and ordered), per sheet (base quantities), and on the buy list, with added / removed / changed / unchanged status chips and an **Export compare CSV**. The headline gives you the one number first: ordered SF A → B, and how many conditions moved.
- **Restore** is never a one-way door: it banks the live takeoff as *Auto-backup before restore* first, then loads the revision. (It does reset the undo stack—§8.)

**Honest limits.** The compare is deliberately **quantity-level, not geometric**: it won't show you *which wall moved*, only which condition's numbers moved, on which sheet, by how much. Sub-display wobble (re-trace drift below 0.05 SF, or below half an EA) reads as unchanged, so a re-traced room that lands on the same number doesn't cry wolf. Conditions pair by identity first and finish tag second, so deleting and recreating `CPT-1` diffs as the same condition, not a remove-plus-add.

---

## 12. Saving, your data, and Contribute

### Autosave, locally

Everything—drawings, scales, conditions, markups, RFIs, levels, tabs—autosaves to **this browser** (IndexedDB + localStorage) about a second after every change; the toolbar ticks *saving… / saved ✓*. Reload, close the tab, come back tomorrow: it's there.

**"Client-only" means exactly this:** in the default build there is no server in the loop. Your PDFs are rendered and stored in your browser; your takeoff never leaves your machine; there's no account and no telemetry. The flip side: storage is **per browser, per origin**—a different browser profile, a different machine, even a different `localhost` port is a fresh, empty workspace. Clearing site data clears your work.

So take the takeoff out of the browser: **Sheet → Export takeoff…** writes `〈project〉.takeoff.json`—the exact document autosave writes, every shape, condition, scale, markup, RFI and seal—to a normal file you can back up, archive for years, carry to another machine, or hand to another estimator. **Sheet → Import takeoff…** reads it back as an editable takeoff, not a report. The plan PDF is not inside it: open the same PDF first, then import.

If a saved project fails to load, autosave **pauses itself** and a banner says so—a load failure never overwrites your saved work with an empty canvas. And if OpenTakeoff updates in another tab, the stale tab asks for a reload instead of writing over the newer one.

### Optional: projects on Drive

Team deployments can wire a Google Drive "Projects" root. Then a **project is a Drive folder**: sign in from the opening screen, choose the folder, and the plan PDFs live in it while OpenTakeoff keeps its own sidecars (the takeoff JSON and the working-set manifest) in a hidden `.opentakeoff` subfolder. The gallery grows a **Browse Drive** mode that lists the folder's PDFs—nothing downloads until you add it, so spec books and as-builts stay unopened. Revision snapshots stay in your browser but scope per project; condition and material libraries, stamps, and report preferences stay local to your browser either way. Run OpenTakeoff without signing in and none of this exists.

### Contribute — what's sent, what never is

Every finished takeoff is a set of expert decisions: *this* region is *this* finish at *this* waste. The **Contribute** button in the Report lets you donate that—and only that—to an open flooring model, or bank it into a corpus you own. It's a button, not a background process: **nothing is ever sent until you click it**, and a build with no endpoint configured can't send at all.

What a contribution contains, in plain language:

- your **condition labels** (the finish tags and their hatch, waste %, multiplier),
- each shape's **role and quantities** (SF / LF / EA) and its **geometry as a pure shape**—normalized 0-to-1 against the sheet, so it carries no scale and no location,
- and each shape's **provenance**: the app remembers whether a machine drew it (One-Click, the agent) and whether you fixed it—and sends that memory, including the machine's original boundary next to your corrected one. That pair is exactly what a takeoff model learns from.

What is **never** sent—this list is normative, enforced by a whitelist in the payload builder, and specified field-by-field in [`CONTRIBUTION_SPEC.md`](CONTRIBUTION_SPEC.md):

- the PDF, or any rendered image of it;
- file names or sheet names (sheets go out as `sheet_1`, `sheet_2`, …);
- project, client, or customer names;
- markup text, or any text you typed on the plan;
- absolute coordinates;
- scale **values**—only the scale's *provenance* rides ("calibrated", "detected", or "standard");
- edit timing of any kind beyond each shape's creation stamp.

One linkage is deliberate and disclosed: shapes carry **opaque, locally-minted IDs**, so re-contributing after an addendum supersedes rather than duplicates. The IDs contain nothing and reverse to nothing.

The modal asks for an optional credit line and an attestation that you have the right to share the data. To bank takeoffs into **your own** corpus instead, run the bundled capture server (`python3 capture/capture_server.py`) and point the app at it (`localStorage.opentakeoff_contribute_endpoint = "http://localhost:8787/contribute"`)—see [`capture/README.md`](../capture/README.md).

---

## 13. The Agent panel

The Agent panel is the newest way to run the engine: describe a takeoff in a sentence, and an AI model—**yours**, on your key, from your browser—works the sheet with the app's own tools and stages **dashed proposals you accept or reject**. It is a proposer, never a committer.

### What it is, structurally

Open it from the rail (the target icon: *Agent — describe a takeoff; it stages dashed proposals you accept or reject*). Type a goal—*"Take off the carpet per the finish schedule on this sheet"*—and click **Run** (`⌘⏎`). The model runs a tool-use loop against a registry of the app's own deterministic tools:

- **`list_sheets`**—what's open, with sizes and scale status;
- **`read_sheet_text`**—the sheet's positioned text layer;
- **`read_schedule`**—the same finish-schedule parser you use from the toolbar;
- **`view_region`**—a rendered crop, for scans or ambiguity;
- **`one_click`**—the flood engine, probe-only: it returns the traced ring, it commits nothing;
- **`get_conditions` / `create_condition`**—your condition list (creation dedupes against existing tags);
- **`propose_shapes`**—stage proposals for your review.

**The model never invents geometry.** It can only propose rings the engine traced or coordinates grounded in what it read, and `propose_shapes` rejects anything uncited: *every proposal must cite evidence*. The run streams into the panel log—every tool call, every result, every refusal—capped at 24 steps, with a **■ Stop** button that halts it instantly.

### The scale gate holds

Agent tools refuse an uncalibrated sheet with the same discipline as everything else: *"Set the scale for 〈sheet〉 first — the agent never assumes a scale; ask the estimator to set it."* The agent proposes; it never assumes a scale, and it can't set one.

### Accept, correct, reject

Proposals land on the canvas as **dashed pencil outlines** with a seed star, and in the panel as rows with **evidence chips**—the schedule row it matched (`schedule CPT-1`), the text it matched, the seed it flooded from. Then it's your desk:

- **Accept**: click a proposal on the canvas, use the row's ✓, or **Accept all** / `⏎` for everything on the visible sheets. Accepting commits through the same command layer as your own work—origin *agent*, reviewed by you, the proposed ring frozen, the evidence attached. **A whole accepted batch is one `⌘Z`.**
- **Correct**: edit an accepted shape like any other (§7). Corrections grade in provenance exactly like One-Click corrections—machine ring frozen, your fix recorded.
- **Reject**: the row's ✕, or **Reject all**. Rejection is **local only**—dismissed geometry is discarded and never rides the contribution wire.

A proposal whose sheet you've since closed (or unscaled) is skipped at accept with a message telling you to open the sheet; nothing commits blind.

### Setup — bring your own key

The panel is honest when unconfigured: it explains itself and offers **AI settings…**. Configure an endpoint (OpenAI-style—most local runtimes speak it and need no key—or Anthropic-style), a vision-capable model id, and an optional key (§14). Unconfigured builds make zero AI network calls.

### The keyless demo

To see the loop without an AI account, run the deterministic mock the repo ships:

```bash
node scripts/mock-agent-server.mjs        # listens on http://localhost:8787
```

Point AI settings at it—endpoint `http://localhost:8787`, API style **Anthropic-style**, model `mock`, any non-empty key—open the sample plan with its scale set, and Run. The script drives the real engines (real schedule parse, real one-click probes, real proposals) through a scripted conversation, ending with proposals staged for your review. (The capture server also defaults to port 8787—if you run both, give one a different `PORT`.)

---

## 14. AI settings and driving OpenTakeoff from an agent

### AI settings (BYO everything)

**AI — bring your own key** (opened from the Agent panel) is the one configuration surface for the AI seam:

- **Endpoint**—a hosted API or a local runtime on your own machine (`http://localhost:1234`).
- **API style**—OpenAI-style (the default; most local runtimes) or Anthropic-style.
- **Model**—a vision-capable model id.
- **API key**—optional; local runtimes generally need none. Stored **in this browser's localStorage only**—anyone with access to this browser profile can read it, so use a key you can revoke. The endpoint must allow browser requests (CORS); local runtimes generally allow localhost.

What's sent, and only when you run an AI feature: the sheet region in question and the question—to *your* endpoint. Never the whole plan file, file names, project names, or your takeoff. No telemetry either way. Deployers can bake team defaults with `VITE_AI_ENDPOINT` / `VITE_AI_MODEL` / `VITE_AI_PROVIDER`—but never `VITE_AI_KEY` on a public deploy; the build inlines it.

### MCP — for agent users

The same engine speaks [MCP](https://modelcontextprotocol.io), one command away:
`npx -y opentakeoff-mcp` (or the one-click `opentakeoff-mcp.mcpb` bundle for Claude Desktop). An
MCP client gets **<!--tool-count-->42<!--/tool-count--> tools** plus browsable sheet resources, over the very same measuring engine,
with the same scale gate and the same provenance receipts:

| Group | Tools |
|---|---|
| Open and orient | `load_plan` · `sheet_info` · `sheet_context` · `read_sheet_text` · `find_text` · `view_sheet` |
| Scale | `set_scale` |
| Measure | `one_click` · `detect_rooms` · `measure_polygon` · `cut_out` · `measure_line` · `measure_surface` · `place_count` |
| Repeat and derive | `symbol_sweep` · `sweep_schedule_row` · `derive_base` · `derive_transitions` · `apply_rules` |
| Read the drawing set | `sheet_graph` · `resolve_tag` · `find_schedule` |
| Edit and audit | `list_shapes` · `edit_shape` · `edit_condition` · `edit_materials` · `duplicate_condition` · `split_condition` · `delete_shape` · `undo_last` |
| Mark and sign | `annotate` · `list_annotations` · `link_annotation` · `mark_verdict` · `delete_verdict` |
| Hand off | `takeoff_summary` · `export_takeoff` · `export_report` · `export_marked_pdf` · `import_takeoff` |

If you're the one wiring an agent up rather than the one reading its output, the operating manual
for that side is [`AGENT_GUIDE.md`](AGENT_GUIDE.md)—the same shape as this document, written for
the agent.

A few worth knowing about from the canvas side, because they're the same features you use:

- `detect_rooms` batches `one_click` across every room-number label on a sheet in one call, and
  can commit each room under its own schedule row's floor finish—withholding, with a reason,
  whatever the schedule can't answer.
- The canvas has the same engine as a tool: arm **Symbol (Y)**, marquee ONE instance tight, and
  every placement lights up for review — matches in your condition's color, near-misses as orange
  question marks you answer from the keyboard (↵ accept · X dismiss · → next), your seed as a
  violet ring. The panel reads the drawing's own labels back to you, warns loudly when a count is
  a floor rather than a total, and Commit mints everything as EA counts in one undo step — seed
  included unless you untick it.
- `symbol_sweep` finds every instance of a repeated symbol from one marqueed example, and
  `sweep_schedule_row` mints a condition from a schedule row and counts its drawn markers across
  the plan sheets. Where drafting reuses one generic shape for different devices, `exclude` takes
  counter-example rects around instances you do *not* mean — count the triangles, not the keynote
  ones — and every rejection comes back disclosed and reinstatable, never silently dropped. On a
  flattened export where layers and pen weights are gone but stroke color survives, a stated
  `luminance_tolerance` holds candidates to the seed's own pen — black devices, not their grey
  background twins — with the gate's full cost disclosed the same way. And for labeled families
  the sweep reads the drawing's own names: the tag written beside each placement, or connected by
  its leader line, comes back on every row — so a count isn't just "shapes matched," it's the
  drafter agreeing, and a confident match with *no* label is flagged as the first thing to look at.
- `sheet_graph` / `resolve_tag` / `find_schedule` answer *"what finish is in room 134, and how do
  you know"* with a citation per cell—across continuation sheets and multi-building keys.
- `derive_base` computes base LF from committed rooms (perimeter minus stated openings), and
  `derive_transitions` finds where two finishes meet—the same derivation the canvas's
  **⟂ Transitions…** button runs ([§5](#5-the-measuring-tools)). The second one is worth understanding before
  you read its output: flood-traced rooms **don't share edges**—a trace fills to the wall
  linework, so two rooms across a partition are separated by inches of nothing. Finishes changing
  inside one open space commit as a butt-joint run. Rooms parallel across a wall come back
  **withheld**, with their length and a point to look at, because the real transition is a
  threshold in a doorway and nothing in the trace record locates the doorway. Answer those by
  looking at the sheet and measuring the threshold yourself—the same doctrine as `symbol_sweep`,
  where a near-match is never a silent commit and never a silent drop.
- `edit_condition` reaches the waste %, the ×N multiplier, and `roll_setup`
  ([§4](#4-conditions--your-finishes)), so an agent's takeoff doesn't come back with net === gross.
- `view_sheet` renders a sheet or a tight crop with a calibrated 1-ft/5-ft measuring grid and a
  committed-shapes overlay, so an agent measures off grid cells and verifies its own work by
  looking.
- `export_takeoff` emits the app's own save payload and `import_takeoff` reads one back, so a
  session can be resumed, extended, or audited from either side. `export_marked_pdf` produces the
  marked planset, with machine-traced work disclosed as pending review.
- `load_plan merge` makes the **bid set** the unit of work—plans plus schedule plus addenda—without
  disturbing existing scales, conditions, or shapes.

Multi-document sessions, the coordinate contract, and a full annotated transcript: [MCP.md](MCP.md)
and [`mcp/README.md`](../mcp/README.md).

---

## 15. Keyboard reference

Every shortcut in the app, verified against the code. Letter keys are suppressed while you're typing in a field and while a toolbar menu is open. `Ctrl` stands in for `⌘` on Windows and Linux throughout.

### Tools

| Key | Tool |
|---|---|
| `O` | One-Click Area |
| `A` | Area |
| `R` | Rectangle |
| `L` | Linear |
| `S` | Surface Area (walls) |
| `C` | Count |
| `D` | Deduct shape (Cut Out) |
| `⇧D` | Deduct rectangle |
| `H` | Highlighter |
| `N` | Dimension line—a standalone length label at the sheet's scale (markup, never counted) |
| `K` | Check a dimension |
| `V` | Select |
| `G` | Sheet gallery |
| Hold `M` | Push-to-talk dictation—release runs the command, `Esc` discards (see [§17](#17-voice-and-the-command-box)) |
| `?` | The in-app quick reference—the five-minute path and every shortcut (`Esc` closes) |

### Conditions

| Key | Action |
|---|---|
| `1`–`9` | Arm condition N—palette order once you've pinned a palette, list order otherwise. Never reassigns a selected shape. |

### Drawing

| Key / action | Effect |
|---|---|
| Click (release without moving) | Place a point |
| Press-and-drag | Pan mid-measure (no point placed) |
| `⏎` / double-click | Finish the shape (areas/deducts/zone need ≥ 3 points; linear/surface ≥ 2). In One-Click: **Create** the selection. With agent proposals pending and nothing mid-draw: accept all visible. |
| `⌫` / `Delete` | Pop the last placed point—then, in order: delete the picked One-Click vertex → drop the last One-Click region → delete the picked shape vertex → delete the selected shape → delete the selected markup → pop a calibrate/check point |
| `⌘Z` | Mid-trace: pop the last point. Otherwise: **undo** |
| `⇧⌘Z` | Redo |
| `Esc` | Back out one level: clear the vertex pick first, then everything in progress (trace, proposal, calibration, check, selection, markup draft, armed stamp, zone) |
| Hold `⇧` | Force the 45° angle lock at any cursor angle |
| `Q` | Flip the ╱ Straight / ⌒ Curve switch mid-trace (Area, Cut Out, Line, Surface) |
| `⌥`-click (Area / Cut Out / Line / Surface) | Place the *other* kind of point for one click—a bow point in Straight mode, a corner in Curve mode |
| `⌥`-click (One-Click) | Carve a cutout inside a selected space |
| `⇧`-click an edge | Insert a vertex at the edge midpoint (selected shape or One-Click proposal) and drag it |

### Selected shape or markup (Select tool)

| Key / action | Action |
|---|---|
| `⌘C` | Copy the shape |
| `⌘V` | Paste under the cursor—lands on the sheet the pointer is over |
| `⌘D` | Duplicate |
| `⌫` | Delete (a picked vertex first, else the shape or markup) |
| Double-click a markup | Edit its text in place |

### View and navigation

| Key / action | Effect |
|---|---|
| Scroll (mouse wheel) | Zoom toward the cursor |
| Two-finger trackpad scroll | Pan, both axes |
| Pinch / `Ctrl`+wheel | Zoom |
| `⇧`+wheel | Pan |
| Hold `Space` + drag | Pan (any tool) |
| Middle-drag / right-drag | Pan (any tool) |
| `F` | Focus mode—collapse the chrome, trade it for canvas height |
| `Esc` (gallery open) | Close the gallery; in Browse Drive, back to the plan set |
| `Esc` (menu open) | Close the menu |

### In panels and fields

| Key | Action |
|---|---|
| `⌘⏎` | Run the agent (in the Agent panel's goal box) |
| `⏎` | Apply calibration (calibrate field) · grade the check (check field) · save (revision-name field) |

---

## 16. Troubleshooting

**A sheet renders blank or slow.** Big sheets rasterize on open—give it a beat. If linework goes soft mid-zoom, that's the detail view re-rendering; it sharpens when the gesture settles. For dense sheets, flip **Hi-Res render (this sheet)** in the Render & fill settings menu—display only, quantities unaffected. Side-by-side groups multiply the render load; work single-sheet on a struggling machine.

**One-Click refuses a room.** Read the message—it names the cause. *Fill spilled* = a real gap in the linework: click a more enclosed spot, or trace with Area (`A`). *Dense linework* = the click landed on text or heavy hatching: zoom in, then click open floor. A hatched room that keeps coming up short wants a higher **Fill** sensitivity; fills that leak want it lower—or Strict. On scans, verify the badged edges before Create, and remember the sensitivity slider doesn't apply there.

**The Fill slider does nothing.** Check the note under it. If it says nothing on that fill's
boundary classified as hatch, the slider genuinely has no work to do—the fill is stopping on ink
the engine reads as a wall, at every notch. Trace it with Area (`A`), or on a CAD export open the
**Layers** panel and set the offending layer to **Off** so the fill passes through it.

**The numbers look wrong—everywhere.** That's a scale symptom, not a math symptom. Run **Check a dimension** (`K`) against a printed dimension string. If the verdict is red, **Recalibrate to this**—every shape on the sheet re-prices instantly (and the old scale sits in **Revert scale** if you change your mind). Remember scale is per sheet: a plan set is never one uniform scale.

**⌘Z won't bring something back.** Three known cases: condition deletes cascade their shapes outside the undo stack (deliberate—the confirm warned you); rescaling a sheet resets the stack; restoring a revision resets the stack (but banked your live takeoff first—check Revisions). The stack also caps at 100 steps, and markup moves aren't on it at all.

**"Where did my work go?"** Work lives in the browser that made it, per origin. Same machine, different browser (or profile, or port) = a different workspace. If a load ever fails, autosave pauses and a banner appears—reload the tab to retry; your saved takeoff is untouched. For anything you can't afford to lose, save a **Revision** and export the report; if the browser warns about storage space, delete old snapshots or unused PDFs.

**The Agent panel won't run.** It needs AI settings (endpoint + model; key optional)—the empty state links you there. Tools refusing with *"Set the scale…"* is the scale gate working: set the sheet's scale, run again. Proposals that won't accept usually sit on a sheet that's been closed since—open it and accept. `⏎` accepts only when nothing is mid-draw.

**Endpoint errors in the agent log.** *"Couldn't reach the endpoint — check the URL, and that it allows browser requests (CORS)"* means exactly that; local runtimes generally allow localhost. A run that stalls two minutes reports the timeout plainly—check the model is loaded.

**Browser support.** OpenTakeoff needs a current browser with IndexedDB and localStorage—recent Chromium-family, Firefox, and Safari releases all qualify. Private/incognito windows may cap or evict storage: fine for a look around, wrong for real work.

---

## 17. Voice and the Command box

Your hands are busy—one on the mouse tracing, one on the tool keys.
The Command box and push-to-talk dictation set takeoff metadata without
stealing them away.

**The Command box** (toolbar, next to the label picker) runs a small,
deterministic command language through the exact actions the buttons run:

| Type (or say) | What happens |
|---|---|
| `carpet one` / `CPT-1` / `c p t 1` | Activates CPT-1—creates it first if it doesn't exist (Div-9 patterns: CPT/LVT/VCT/CT/RB/TR + number) |
| `carpet one waste 7` | Activates/creates CPT-1 **and** sets its waste to 7% |
| `waste 12` (also `waste twelve`, `waste 7.5`, `waste ten percent`) | Sets the active condition's waste |
| `label Phase 2` / `clear label` | Arms a shape label for subsequent traces (learning it if new) / disarms |
| `note verify sheet vinyl with GC` | Drops a text markup on the focused sheet and opens the Markups dock |
| `carpet one, this room` (pointer resting on a room) | Arms CPT-1 and one-click-traces the room under your cursor—committed as your work, undo covers it |

Anything ambiguous is refused with a red explanation, never guessed—"carpet
one seven" could be CPT-1 + waste 7 or a mis-heard CPT-17, so it
asks you to say it again.

**When it isn't a command.** If what you said (or typed) isn't in the grammar
at all and you've configured the bring-your-own agent (§14), the red
rejection adds an offer: press `⏎`—or say **"ask the agent"**—to hand
that exact text to the agent as a task. It runs on *your* endpoint with
*your* key, its proposals land as dashed outlines for your review, and
nothing is ever sent without that explicit confirm (`Esc` or 20 seconds
dismisses the offer). Near-miss commands—a garbled number, extra words—never
get the offer; they ask you to say it again.

**Push-to-talk.** Hold **M** (or hold the **Voice** toolbar button), speak,
release to run—the transcript flashes in a chip so you can see what was
heard, then the outcome lands in the message bar. `Esc` mid-hold discards.
Speech is recognized **on your device** in the browser (a ~44 MB model,
downloaded once from the site itself and cached)—audio never leaves your
machine, in keeping with the no-upload pledge. If a deployment doesn't ship
the model, the feature says so plainly; details in
[`docs/VOICE.md`](./VOICE.md).

---

## 18. Glossary — what the words mean here

Most of these are ordinary estimating words. A few are specific to how OpenTakeoff works, and
those are the ones worth pinning down before you rely on a number.

| Term | What it means here |
|---|---|
| **Condition** | One finish—`LVT-1`, `CPT-2`, `RB-1`—carrying its own color, hatch, waste %, multiplier, height, thickness, and materials. Everything you measure commits into one ([§4](#4-conditions--your-finishes)). |
| **Twin** | The same finish measured in a second area that needs different preparation underneath. Gets its own tag (`SV-1 – Level 2`) and follows the original's materials until you edit a row ([§4](#4-conditions--your-finishes)). |
| **Proposal** | A dashed, uncommitted shape—what One-Click traces and what an agent stages. Nothing is in your takeoff until you Create or Accept it ([§6](#6-one-click-area), [§13](#13-the-agent-panel)). |
| **Pencil / ink** | Machine work is pencil (dashed proposals, the graphite `AGENT` diamond); your acceptance is ink (committed shapes, the green `APPROVED` seal). Only a human hand mints the seal ([§9](#9-markups-stamps-and-rfis)). |
| **Provenance** | The record attached to every shape: the scale it was measured at, how it was made, whether a machine proposed it, and whether you corrected it—with the machine's original boundary frozen beside your fix ([§6](#6-one-click-area)). |
| **Reported, never counted** | A quantity the engine found but refuses to commit, with the reason. Transitions across a wall are the common one: the real transition is a threshold in a doorway nothing can locate from a trace. Go measure it ([§5](#5-the-measuring-tools)). |
| **Deduct / Cut Out** | A void subtracted from a condition's floor total—a column, a shaft, casework. Draws dashed red and carries its negative sign into the audit ([§5](#5-the-measuring-tools)). |
| **Measured versus w/Waste** | Measured is what's on the drawing. w/Waste is what you order. Waste lives only in the order column, never in the measured number ([§10](#10-the-report-and-exports)). |
| **Basis** | What a supporting material is bought against: floor SF, linear LF, each, or figured seam LF. Order quantity = basis ÷ coverage rate, rounded up ([§4](#4-conditions--your-finishes)). |
| **Figured seam LF** | Seam length read off the roll layout—where two cuts actually meet—not a percentage of perimeter. Needs a roll setup; without one it reads 0, meaning *needs a layout* ([§4](#4-conditions--your-finishes)). |
| **Roll goods** | Broadloom, sheet vinyl, sheet rubber—material that comes off a roll, so the order depends on how the cuts nest, not on area alone ([§4](#4-conditions--your-finishes)). |
| **Stitch** | Two to four sheets split at a match line, joined into one working surface so a room crossing the seam traces as one shape. Align it before you trace on it ([§2](#2-opening-plans-and-moving-around)). |
| **Level** | A label grouping sheets by floor—`L1`, `Level 2`, `Garage`. Drives gallery grouping and the Excel by-floor sheet ([§2](#2-opening-plans-and-moving-around)). |
| **Label** | Which part of the job a shape belongs to—*Phase 1*, *East Wing*, *Alt-2*. Classification, not correction; drives report grouping ([§7](#7-selecting-and-editing-shapes)). |
| **Scale gate** | Nothing prices without a scale on that sheet. Counts are the exception—EA doesn't depend on scale ([§3](#3-scale--set-it-first)). |
| **Unconfirmed scale** | A scale an agent set, which no person has verified. Quantities compute, but the chip, the gallery badge, and the report all say so until you confirm it ([§3](#3-scale--set-it-first)). |
| **Calibrate versus Check** | Calibrate sets the scale from a dimension you type. Check (`K`) is its read-only twin—it grades the scale you already have ([§3](#3-scale--set-it-first)). |
| **Hatch / poché** | The pattern fill inside a room or wall on the drawing. One-Click classifies it as pattern rather than boundary, so a hatched room still traces to the real walls ([§6](#6-one-click-area)). |
| **Fill sensitivity** | How eagerly a fill escalates past ink the engine called hatch—Strict, Balanced, Aggressive. It cannot help when the boundary is all hard ink, and it says so ([§6](#6-one-click-area)). |
| **Zone check** | A reading, not a takeoff: trace a wing and see what's inside it, with materials scaled to the zone. Nothing is saved ([§5](#5-the-measuring-tools)). |
| **Marked set** | The distribution-ready PDF—your work burned into the drawings behind a legend cover, with a tally of how much of it a person has approved. The deliverable a GC can check ([§10](#10-the-report-and-exports)). |
| **Revision** | A named snapshot of the whole takeoff. Compare two and you get quantity deltas per condition, per sheet, and on the buy list ([§11](#11-revisions)). |
| **Contribute** | The opt-in button that donates a takeoff's labels and normalized shapes—never the plan, the names, or the coordinates—to a training corpus ([§12](#12-saving-your-data-and-contribute)). |

---

*OpenTakeoff is Apache-2.0 and the codebase is deliberately readable—when you outgrow the manual, [`FEATURES.md`](../FEATURES.md) maps every capability to its code. Driving it from an agent instead? [`AGENT_GUIDE.md`](AGENT_GUIDE.md) is this document's counterpart.*
