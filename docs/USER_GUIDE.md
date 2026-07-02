# OpenTakeoff — User Guide & Shortcuts

A fast, client‑only flooring takeoff canvas. Drop in a plan set, set the scale, draw
your conditions, read the report. Everything is saved in your browser — no account,
no server.

---

## 1. Quick start (a demo in 6 steps)

1. **Open plans** — drag a PDF, image, or `.zip` plan set onto the canvas (or use **Open plans**). The **gallery** (`G`) shows every sheet; click one (or several) to open.
2. **Set the scale** — on each sheet, click **Scale** and either pick a standard scale or **Calibrate**: click two points along a known dimension, type the real length in feet, **Apply**. Scale is remembered **per sheet**.
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
| `O` | **One‑Click Area** | Click inside a room; the enclosed space auto‑selects, traces, and snaps to corners. Review, then Create. |
| `A` | **Area** | Trace a polygon → floor SF. |
| `R` | **Rectangle** | Two‑corner rectangle → floor SF. |
| `L` | **Linear** | Trace a run → LF (＋ border SF if the condition has a thickness). |
| `S` | **Surface Area** | Trace a wall run in plan → wall SF (run × condition height). |
| `C` | **Count** | Click to count items → EA. |
| `D` | **Deduct** | Trace a void/column → subtracts SF. |
| `⇧D` | **Deduct rectangle** | Rectangle deduct. |
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
| `Enter` or **double‑click** | Finish the shape (Area/Deduct need ≥3 points; Linear/Surface ≥2). In One‑Click, `Enter` creates the selected space(s). |
| `Backspace` / `Delete` | Remove the last placed point; if nothing's in progress, delete the **selected** shape; in One‑Click, drop the last region. |
| `⌘Z` / `Ctrl+Z` | Undo the last placed point. |
| `Esc` | Cancel the in‑progress shape / selection / proposal. |
| **Hold `⇧` (Shift)** | Force the next segment onto the nearest 45°/90° axis, at any cursor angle (see Angle lock below). |

### Angle lock (45°/90°)
With the **45°** toggle on (it's on by default, next to Snap), the segment you're drawing **locks to the 45° family** — 0°, 45°, 90°, 135° across the sheet — whenever your cursor comes within a few degrees of one. The lock is deliberately quiet: the crosshair brightens, the preview line thickens, and a small chip by the cursor reads the locked angle plus the **live length of the segment** (once the sheet has a scale). The point you click is the locked point, so walls come out dead square. Hold **`⇧`** to force the lock at any angle; toggle **45°** off for free-angle tracing. Endpoint **Snap** (when enabled) takes priority over the angle lock — corners beat axes.

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
- **Line / fill color** and a **hatch pattern** (plank, herringbone, tile, terrazzo, …) so each finish reads like the real drawing.
- **Multiplier (×N)** — measure one identical unit, multiply by N.
- **Waste %** — a flooring allowance applied **only in the Report** (order quantity), never to the live measured number.
- **Height (H)** — default height for new Surface‑Area (wall) traces; also drives vertical‑SF display. Existing walls keep the height they were drawn at.
- **Thickness (T)** — a Linear run with thickness also yields border/feature‑strip SF (LF × T/12).

### Supporting materials (assemblies)
Per condition, list the consumables (adhesive, sealer, polyurethane, thinset, grout, cove‑base adhesive…). Each has a **coverage rate** and a **basis** (floor SF / linear LF / each). Order qty = measured ÷ coverage, **rounded up** to whole units. Adhesive lines get a **trowel picker** that fills the SF/gal from the notch size. A `note` field carries trowel notch / # of coats. The Report sums these into a **buy list**.

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

### Markup layer
Revision clouds, callouts, and text notes — annotations only, kept separate from measurements (never counted).

### Report & export
Per‑condition breakdown (Floor/Wall/Border SF, LF, EA, Total SF, SY, with and without waste), a combined materials buy list, and **CSV / JSON** export.

### Saving
All drawings, scales, conditions, and markups autosave to this browser (IndexedDB + localStorage). Storage is **per origin** — i.e. per `localhost:PORT` / per domain. A different port = a fresh, empty workspace.

---

## 4. Tips

- Door openings usually stay closed in One‑Click (the door leaf + swing arc are linework). If a fill **spills**, click a more enclosed spot or trace with **Area**.
- Raster (scanned) plans have no vector linework — One‑Click/Snap won't work; trace manually.
- Set the scale **before** you measure; changing it re‑flows dependent shapes.
- Waste is per condition — set it to match the install (e.g. ~8% straight‑lay, ~15% diagonal, ~20% herringbone).
