# Personal workspace preview

## Problem and result

The takeoff canvas has accumulated several persistent control rows and floating boxes. Frequent actions compete with appearance settings, and panel placement is fixed. The optional workspace preview groups file/navigation actions in a header and current drawing settings in a separate context row. Measuring tools retain their sidebar order and shortcuts. **Layout** lets each user move Sheets, Work, Takeoffs, and the measuring rail to either side, adjust panel widths, lock positions, and save named arrangements.

Choose **⋯ → Workspace preview**, or open `/?workspace=calm`. **Classic layout** switches back without reloading. The default for an existing or new browser remains classic unless the user explicitly opts in. The URL option enables the preview on the same application; it does not select a new project.

## Design evidence

This is a design synthesis, not a comparative usability experiment. Product documentation establishes capabilities; vendor testimonials are selected marketing; community comments identify possible friction without establishing how prevalent it is. Older comments are labeled below and do not establish defects in current releases. Vellum here means Vellum AEC; unrelated writing and AI-workflow products were excluded.

| Source | Observation | Decision |
|---|---|---|
| [Bluebeam panel customization](https://support.bluebeam.com/revu/how-to/customize-panels.html) and [profiles](https://support.bluebeam.com/user-manual/menus/revu/profiles.html) | Users can collapse/reposition panels and preserve working arrangements. | Explicit layout controls, saved arrangements, a lock and reset. No automatic tool reordering. |
| [OST product documentation](https://www.oncenter.com/products/on-screen-takeoff-wip-takeoff-software/) | Conditions and repeatable work are central to estimating workflows. | Keep condition selection near drawing actions and retain the existing Takeoffs library. This preview adds no estimating formulas or repeated-area mechanism. |
| [PlanSwift selected testimonials](https://www.planswift.com/about/takeoff-estimating-testimonials/) | Vendor-selected customers value quick navigation, reusable setup and Excel handoff. | Existing drawing handlers and exports remain the source of behavior; changing chrome must not introduce a second takeoff implementation. |
| [Estimators discussing tools, May 2024](https://www.reddit.com/r/estimators/comments/1d4ntok/recommended_takeoff_software/) | Preferences diverge between Bluebeam, OST and PlanSwift; familiarity and trade workflow matter. | Preserve sidebar ordering and shortcuts, provide an immediate classic comparison. There is no universal winner in this discussion. |
| [zzTakeoff features](https://www.zztakeoff.com/features) and [different views per user request](https://www.zztakeoff.com/community/feature-requests/multi-player-allow-for-different-views-per-user) | Shared work benefits from collaboration, but shared visibility can interfere with an individual's task. | Layout lives in browser preferences, outside project payloads and synchronization. An imported measurement cannot rearrange the user's workspace. |
| [zzTakeoff undo request](https://www.zztakeoff.com/community/feature-requests/is-there-a-undo-and-redo-button) | A request for recoverable actions was subsequently marked completed. | Expose existing Undo/Redo directly. This is not a claim that zzTakeoff currently lacks undo. |
| [Autodesk viewer](https://help.autodesk.com/cloudhelp/ENU/Takeoff-Takeoff/files/viewer.html), [inventory](https://help.autodesk.com/cloudhelp/ENU/Takeoff-Takeoff/files/Inventory.html), and [detailed view](https://help.autodesk.com/cloudhelp/ENU/Takeoff-Takeoff/files/Detailed_View.html) | Sheet navigation, quantities and contextual editing are distinct surfaces. | Optional searchable sheet navigation; condition properties are disclosed when needed; Work locates the selected measurement on its sheet. |
| [Vellum AEC](https://vellumaec.com/) | Public workspace images show a restrained frame and prominent drawing. Geometry, snapping and rendering claims are vendor descriptions. | Reduce idle chrome, keep panels closed until requested. Renderer changes are outside this work; no independent Vellum performance comparison was conducted. |
| [Figma accessibility guidance](https://help.figma.com/hc/en-us/articles/35063862380311-Accessibility-at-Figma) and [Airtable views](https://support.airtable.com/articles/5189551686-getting-started-with-airtable-views) | Adjustable interface sizing and personal/locked views support individual working preferences. | Separate personal arrangement from shared measurement state. The analogy does not imply those products support arbitrary docking of every control. |

Three primary research papers informed the interaction design:

- [Findlater and McGrenere, CHI 2004: static, adaptive and adaptable menus](https://www.cs.ubc.ca/labs/imager/tr/2004/findlater04menus/findlater04menus.pdf). A 27-participant laboratory study found tradeoffs between stable, automatically adapting, and user-customizable menus. It supports caution about automatic rearrangement. It does not prove this layout makes estimators faster. Controls retain their order, customization is explicit, and classic remains available.
- [Amershi et al., CHI 2019: Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf). The guidelines emphasize understandable capabilities, appropriate feedback, correction and recovery. Work displays recorded provenance and real review state, preserves undo, and does not invent progress for an external agent. A reviewed measurement is not presented as independently verified accuracy.
- [Hutchins, Hollan and Norman, 1985: Direct Manipulation Interfaces](https://hci.ucsd.edu/hollan/direct-manip.pdf). Visible objects and feedback can reduce the gap between intent and action; the paper also discusses the value of scripting repetitive tasks. Clicking a work item opens its actual boundary for inspection, while agents continue to use the existing engine. A human need not reproduce an agent's clicks to inspect its result.

These findings motivated decisions and acceptance checks, not numerical claims about productivity. A timed study with practicing estimators remains needed before claiming fewer errors or faster takeoff.

## Personal layout contract

- Four movable surfaces: **Measuring tools**, **Sheets**, **Work and review**, and **Takeoffs**. Each docks left or right. This iteration does not implement arbitrary floating windows, bottom docking, or rearrangement of every legacy panel.
- Layout starts locked. Unlock in **Layout** to expose movement handles and position selectors. Drag a handle to a highlighted edge, or focus it and use Left/Right. Escape cancels movement; releasing outside either edge leaves placement unchanged.
- Lock prevents movement and Takeoffs edge resizing. It does not disable opening panels, drawing, or editing measurements. Work/Sheets width controls are disabled while locked.
- Arrangements save positions, Work/Sheets widths, lock state, and optional palette/counter visibility. They do not save which panels are currently open. Up to eight names are retained; saving an existing name replaces it. Reset restores the default arrangement and retains named arrangements.
- `ot.workspace-layout.v1` is browser-local, validated and versioned. It is absent from project JSON, archives, portable profiles and the sync payload. Storage failure is shown in Layout; the current arrangement remains usable for the session.
- Classic preserves its controls and measurement behavior. **All controls** temporarily reveals that toolbar inside the preview, including advanced drawing styles and other existing settings.
- The search dialog finds tools, scale choices, sheets and existing actions. It supports keyboard selection and Escape. It is an action finder, not a natural-language agent or the gated Command box.

## Layout values

Existing color, typography, spacing and control-size tokens are reused; the brand and condition colors are unchanged.

| Value | Default / bounds | Rationale |
|---|---|---|
| Tools side | Left | Preserve familiar tool access and ordering |
| Sheets side / width | Left / 264 px; 220–340 px | Search and sheet labels without a permanently open navigator |
| Work side / width | Right / 360 px; 300–480 px | Legible quantities, filters and receipts |
| Takeoffs side / width | Right / existing panel preference | Reuse the existing resize and persistence behavior |
| Layout lock | On | Measuring clicks cannot accidentally rearrange the interface |
| Pointer movement threshold | 6 px | A handle click does not begin dragging |
| Drop target | Up to 264 px or 30% of workspace width | Explicit side targets; release in the middle cancels |
| Saved arrangements | 8, names up to 40 characters | Bound local preferences and menu length |
| Header simplification | 1250 px | Reclaim title/search-label space before controls overflow |
| Wrapping chrome / sheet overlay | 900 px | Keep controls reachable on narrower windows |
| Small-screen brand suppression | 640 px | Preserve vertical drawing space; actions remain visible |
| Action dialog | 560 px maximum, 50 visible results | Bound search rendering; querying searches all supplied actions |

A dock change requests the same existing viewport refresh used for panel resizing. The tile compositor, coordinate conversion, calibration arithmetic, geometry, shape commands and report math are unchanged.

## Acceptance

Run Node 24 `cd web && npm run check`. Verify layout movement/lock/reload, classic round trip, keyboard action search, sidebar tools, scale controls, drawing and undo, imported agent review, cross-sheet navigation, export/report, and narrow-window bounds in the real browser. See [verification](personal-workspace-verification.md).
