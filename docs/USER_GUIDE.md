# OpenTakeoff — User Guide & Shortcuts

A fast, client‑only flooring takeoff canvas. Drop in a plan set, set the scale, draw
your conditions, read the report. Everything is saved in your browser — no account,
no server.

---

## 1. Quick start (a demo in 6 steps)

1. **Open plans** — drag a PDF, image, or `.zip` plan set onto the canvas (or use **Open plans**). The **gallery** (`G`) shows every sheet; click one (or several) to open.
2. **Set the scale** — on each sheet, click **Scale** and either pick a standard scale (imperial architectural/engineering **or metric ratios** — 1:20 through 1:500) or **Calibrate**: click two points along a known dimension, type the real length (feet — or **meters** in metric mode), **Apply**. Scale is remembered **per sheet**.
3. **Working in metric?** Click the **`ft`/`m`** toggle beside the scale picker. Every readout, chip, panel, the Report, CSV, and the Marked Set legend switch to **m² / m**, and Calibrate takes meters. The toggle only changes the display layer — takeoffs are stored unit-agnostically, so flipping it never changes your measurements. (Supporting-material coverage rates stay as entered, SF/LF-based.)
3. **Pick a condition** — the **Conditions** bar holds your finishes (WD‑1, LVT‑1, …). Click one to arm it (or press its number, `1`–`9`). Edit its color / hatch / waste / height in the bar.
4. **Draw the takeoff** — pick a Measure tool and trace. Each shape is color‑coded to its condition.
5. **Add supporting materials** *(optional)* — open **Assemblies** on the condition (adhesive, sealer, poly…) with coverage rates; order quantities derive automatically.
6. **Report** — open **Report** for the per‑condition breakdown (SF/LF/EA, waste, SY) and the materials buy list; export **CSV** or **JSON**.

Your work autosaves to this browser continuously. Reload and it's still there.

---

## 2. Keyboard shortcuts

### Tools
| Key | Tool | What it does |
|---|---|---|
| `O` | **One‑Click Area** | Click inside a room; the enclosed space auto‑selects, traces, and snaps to corners — hatched/tiled rooms fill to the real walls (hatch linework is classified and seen through). Review, then Create. |
| `A` | **Area** | Trace a polygon → floor SF. |
| `R` | **Rectangle** | Two‑corner rectangle → floor SF. |
| `L` | **Linear** | Trace a run → LF (＋ border SF if the condition has a thickness). |
| `S` | **Surface Area** | Trace a wall run in plan → wall SF (run × condition height). |
| `C` | **Count** | Click to count items → EA. |
| `D` | **Erase shape** | Trace a void/column → subtracts SF (a deduct). |
| `⇧D` | **Erase rectangle** | Rectangle erase. |
| `H` | **Highlighter** | Freehand marker ink — drag to paint (see Markup layer below). |
| `P` | **Pan** | Move around the sheet. |
| `V` | **Select** | Select / move / edit / reassign / delete a shape. |
| `G` | **Gallery** | Open the plan‑set gallery / sheet picker. |

### Conditions
| Key | Action |
|---|---|
| `1`–`9` | Make condition N the active one. |

### While drawing
| Key / action | Effect |
|---|---|
| **Click** (no drag) | Place a point. |
| **Press‑and‑drag** | Pan mid‑measure (without placing a point). |
| **Scroll** | Zoom. |
| `Enter` or **double‑click** | Finish the shape (Area/Erase need ≥3 points; Linear/Surface ≥2). In One‑Click, `Enter` creates the selected space(s). |
| `Backspace` / `Delete` | Remove the last placed point; if nothing's in progress, delete the **selected** shape; in One‑Click, drop the last region. |
| `⌘Z` / `Ctrl+Z` | Undo the last placed point. |
| `Esc` | Cancel the in‑progress shape / selection / proposal. |
| **Hold `⇧` (Shift)** | Force the next segment onto the nearest 45°/90° axis, at any cursor angle (see Angle lock below). |

### Angle lock (45°/90°) & the aim cursor
On the canvas the crosshair **is** the cursor: the OS pointer hides in draw modes, full-page hairlines meet at a star, and everything in progress draws in the instrument's cobalt — committed takeoffs wear their condition's own color.

With the **45°** toggle on (it's on by default, next to Snap), the segment you're drawing **locks to the 45° family** — 0°, 45°, 90°, 135° across the sheet — whenever your cursor comes within a few degrees of one. The lock is deliberately quiet: the star swells, the hairlines brighten, the preview line thickens, and a small chip by the cursor reads the locked angle plus the **live length of the segment** (once the sheet has a scale). The point you click is the locked point, so walls come out dead square. Hold **`⇧`** to force the lock at any angle; toggle **45°** off for free-angle tracing. Endpoint **Snap** (when enabled) takes priority over the angle lock — corners beat axes.

### Selected shape (Select tool)
| Key | Action |
|---|---|
| `⌘C` / `Ctrl+C` | Copy the takeoff. |
| `⌘V` / `Ctrl+V` | Paste it under the cursor (lands on the sheet you're hovering). |
| `⌘D` / `Ctrl+D` | Duplicate it. |

---

## 3. What each part does

### Conditions (finishes)
A condition is one finish (e.g. `WD-1` red oak). It carries:
- **Line / fill color** and a **hatch pattern** (plank, herringbone, tile, terrazzo, …) so each finish reads like the real drawing. The hatch picker is a 4×4 swatch grid — hover a swatch and the caption under the grid names the pattern; the selected one is outlined in cobalt.
- **Multiplier (×N)** — measure one identical unit, multiply by N.
- **Waste %** — a flooring allowance applied **only in the Report** (order quantity), never to the live measured number.
- **Height (H)** — default height for new Surface‑Area (wall) traces; also drives vertical‑SF display. Existing walls keep the height they were drawn at.
- **Thickness (T)** — a Linear run with thickness also yields border/feature‑strip SF (LF × T/12).

### Supporting materials (assemblies)
Per condition, list the consumables (adhesive, sealer, polyurethane, thinset, grout, cove‑base adhesive…). Each has a **coverage rate** and a **basis** (floor SF / linear LF / each). Order qty = measured ÷ coverage, **rounded up** to whole units. Adhesive and mortar lines get a **coverage preset picker** (trowel notch / roller) that fills the spread rate; grout lines get inline **tile geometry inputs** (tile L × W × thickness, joint width 1/32″–1/2″, bag lbs) that derive the SF/bag rate and write the derivation into the note. Preset values are generic industry‑typical rates — verify against the product data sheet. A `note` field carries trowel notch / # of coats. The Report sums these into a **buy list**.

### Measure roles → totals (the math)
| Role | Adds to |
|---|---|
| `floor_area` / `rect` | Floor SF |
| `deduct` | Subtracts from floor SF |
| `surface_area` | Wall SF (traced LF × height) |
| `linear` | LF (＋ border SF if thickness) |
| `count` | EA |
| `multiplier` | × N on every quantity |
| `waste %` | Added on top in the Report (SF + LF; never EA) |

### Plan set & sheets
- **Gallery** (`G`) — the visual sheet picker; open one or several sheets side‑by‑side.
- **Per‑sheet scale** — plan sets are never one uniform scale; set it per sheet.
- **Regroup** — restore the last side‑by‑side composition in one click after scaling sheets individually.
- **Hi‑Res** — crisper rendering when zoomed in (per sheet, per browser). Does **not** change quantities.
- **Snap (beta)** — snap points to plan lines/corners.
- **Dark view (☾)** — negative-print mode in the zoom cluster: sheets invert to light-on-dark, hatches stay legible, and the toggle is remembered per browser.

### Markup layer
Highlighter, revision clouds, callouts, and text notes — annotations only, kept separate from measurements (never counted). The markup (◇) and takeoffs (☰) panel toggles live on the slim **rail on the canvas's right edge** (zoom-cluster style); the takeoffs panel docks beside it.

**Highlighter** (`H`, under Markup) is freehand marker ink — and every stroke is a real object: with **Select** (`V`), click a stroke to pick it (it glows cobalt), **drag to move it**, `⌫` to delete it. Press and **drag to paint** — stroke after stroke, no panel popping open between them. While it's armed, a style popover hangs under the Markup menu: five inks (yellow default), **F / M / B** tip sizes, and a **chisel or round** nib; your style is remembered per browser. One tradeoff to know: because press‑drag paints, the usual press‑and‑drag pan is unavailable while the highlighter is armed — pan with **Space‑drag, middle‑drag, or right‑drag** instead (or `P`). Strokes stick to their sheet, scale with the plan like real ink, and export into the Marked Set PDF in their own color. `Esc` abandons a stroke mid‑paint.

### Report & export
Per‑condition breakdown (Floor/Wall/Border SF, LF, EA, Total SF, SY, with and without waste), a combined materials buy list, and **CSV / JSON** export — plus **Marked set**: a distribution-ready PDF of every sheet that carries takeoffs or markups, with the work burned in as drawn and a legend cover (net totals, waste-adjusted order quantities, by-sheet breakdown). It exports in your current view — dark canvas → dark PDF. Share it with a PM or GC; they need nothing but a PDF reader.

### Saving
## Zone check

Arm **Zone** in the toolbar and trace a region — an apartment, a wing, a phase — the way you'd trace a deduct; **⏎, double‑click, or Finish** closes it. A panel lists every condition whose shapes sit inside (counted by their **center point**, same sheet only — counted shapes glow cobalt), with quantities and each condition's **materials scaled to the zone**, computed by the same rules as the Report. It's a reading, not a takeoff: nothing is saved — redraw replaces the zone; `Esc` or switching tools clears it.

## Sheet levels (multi‑floor sets)

In the gallery, select sheets and hit **Assign level…** ("L1", "Level 2", "Garage" — empty clears). The gallery groups by level with unassigned sheets last, each card wears its level chip, and open tabs plus the page picker carry the label. Levels save with the project.

## Condition plays

Tuned a condition just right — waste, materials, appearance? **⭑ Save play** (in the condition bar) stores it in this browser; **Plays ▾** applies any saved play as a fresh condition on any project (you pick the new finish tag). No geometry travels with a play, and re‑saving a name replaces it.

All drawings, scales, conditions, and markups autosave to this browser (IndexedDB + localStorage). Storage is **per origin** — i.e. per `localhost:PORT` / per domain. A different port = a fresh, empty workspace.

---

## 4. Tips

- Door openings usually stay closed in One‑Click (the door leaf + swing arc are linework). If a fill **spills**, click a more enclosed spot or trace with **Area**. A hatched room with a genuinely open doorway still refuses rather than guessing — that's deliberate.
- Raster (scanned) plans have no vector linework — One‑Click/Snap won't work; trace manually.
- Set the scale **before** you measure; changing it re‑flows dependent shapes.
- Waste is per condition — set it to match the install (e.g. ~8% straight‑lay, ~15% diagonal, ~20% herringbone).
