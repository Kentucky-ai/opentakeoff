# Split-Screen Canvas (Reference Pane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the takeoff canvas into two panes — the existing interactive stage plus a second **read-only reference pane** that independently pans/zooms/frames any sheet (or the same sheet at a different zoom), created by dragging a tab onto the canvas with a directional drop-zone overlay.

**Architecture:** The reference pane is a **second render surface inside the existing `TakeoffCanvas` component**, not a second component instance. It reads the same `shapes`/`conditions`/`scales` state (so measurements mirror live and read-only), but has its own display transform (`refTfRef`/`refStageRef`) and its own pane-namespaced render caches. Only the *display* transform is duplicated — never the coordinate/measurement/keyboard/undo machinery, which stays singular and owned by the primary pane. This is the deliberate outcome of an adversarial review that rejected a two-interactive-pane design as a de-facto state-management rewrite that also reintroduced the match-line seam-measurement hazard `stitch` exists to prevent.

**Tech Stack:** React (plain `useState`/`useRef`, no state library), pdf.js (`pdfjs-dist`) tile-worker rendering into HTML5 canvases under an SVG overlay, native HTML5 drag-and-drop, Node's built-in `node:test` runner for pure-module unit tests, Playwright MCP for UI verification.

**Spec:** This plan is self-contained; the design was settled through a grilling session and hardened through three adversarial code-grounded reviews. The resolved decisions are captured in the Global Constraints and Design Decisions sections below.

## Global Constraints

- **Reference pane is READ-ONLY.** It never receives tools, keyboard shortcuts, set-scale, snap, undo, or shape editing. The primary pane exclusively owns all measurement and all single-sheet global actions (one-click, detect-rooms, export, MCP). No exceptions — this is what keeps the state model singular and dissolves the match-line hazard.
- **Exactly two panes, one split, no nesting.** One primary + one reference. Never a third pane, never a grid.
- **Split orientation is vertical (left/right) or horizontal (top/bottom).** A V↔H flip toggle lives on the divider. Because the reference pane is its own viewport component, orientation is CSS `flex-direction`, not a new coordinate-routing system.
- **Document state has one owner.** `shapes` (`TakeoffCanvas.jsx:439`... whole-project, filtered by `sheet_id`), `conditions` (`:433`), `scales` (`:356`), and the undo stack (`undoStackRef`) are never duplicated. The reference pane renders from them; it never mutates them.
- **Every reference-pane DOM id must be pane-namespaced.** SVG `<pattern>` ids from `patId` (`:6529`), any `url(#…)` reference, and any `data-*` querySelector must carry a `ref` prefix in the reference overlay, or duplicate ids across the two `<defs>` blocks corrupt fills (document-order-dependent `url(#…)` resolution).
- **Persistence is additive and omit-when-absent**, matching `buildPayload` (`:2173`): no split → no `split_view` key → byte-identical round-trip for non-split projects. Restore layout (orientation, ratio, referenced sheetKey) but NOT exact zoom (matches the app never persisting `tf`).
- **Render budget is bounded.** Total live sheets across both panes must be capped (primary group members + reference members). Split-screen is disabled on `LOW_MEMORY_DEVICE` (the device that already ships a jetsam memory-kill recovery path in `tilePool.ts`) and below the narrow-viewport threshold (`useIsNarrow`, `:365`).
- **No AI attribution in commits** (repo convention; the pre-commit hook enforces it). Use the exact commit messages given; do not add `Co-Authored-By`/`Generated-with` trailers.
- **Do the work in a git worktree, not the shared main checkout** (concurrent sessions share one HEAD). Branch name: `feat/split-screen-reference-pane`.
- Test command: `cd web && npm test` (runs `node --import tsx --test test/*.test.ts`). Typecheck: `cd web && npm run typecheck`. Full gate: `cd web && npm run check`.

## Design Decisions (the "why", so an executor doesn't relitigate)

- **Why read-only, not two interactive panes:** `shapes`/`conditions`/`scales`/undo are plain component-local `useState` — two React instances would each get their own copy and never share edits. Making both panes interactive means first lifting the entire document model into a shared store (net-new architecture this app deliberately does without), plus routing 5+ global `keydown` listeners through a focused-pane gate, a single-owner undo, and doubling every render budget. The read-only pane rides the *already-decomposed* render half (per-panel detail/base canvases) and skips the singleton input/coordinate half, delivering the stated user need — "frame one sheet here, another sheet/area there while I measure" — at a fraction of the cost.
- **Why no groups-inside-a-pane:** a 4-up in a half-width pane is strictly worse than the full-width 4-up the app already ships via `sheetGroup` (`MAX_GROUP=4`); and because a group slot can hold a *stitch*, groups-in-panes would push the true render ceiling toward ~16–32 member canvases. The primary pane keeps its existing group feature unchanged; the reference pane frames exactly one sheet **or** one existing stitch.
- **Why the match-line concern is moot here:** `stitch` exists because "a sloppy [match-line] join silently skews every seam-crossing quantity," so measuring the two halves of a match-lined floor separately is a hazard. With only the primary pane measurable, that can't happen through split-screen.

## File Structure

**New pure modules (unit-tested with `node:test`):**
- `web/src/lib/splitView.ts` — the split-view value type + `serializeSplitView` / `normalizeSplitView` (persistence codec, defensive load). One responsibility: the split-view data model.
- `web/src/lib/dropZones.ts` — `dropZoneAt(rect, x, y, opts)` pure hit-testing for the 5-zone overlay. One responsibility: pointer → zone.

**New React modules (verified via Playwright):**
- `web/src/components/SplitLayout.jsx` — the flex split container + draggable divider + orientation flip. Presentational; takes `orientation`, `ratio`, `onRatioChange`, `onFlip`, `onCollapse`, and two children (primary, reference).
- `web/src/components/ReferencePane.jsx` — the read-only second surface: own `refStageRef`/`refTfRef`, own wheel/drag pan-zoom, base + detail canvases + read-only shape SVG overlay, its own thin tab bar and empty state.
- `web/src/components/DropZoneOverlay.jsx` — the ghost-half + "Split ◧ Vertical / ⬓ Horizontal" label shown during a tab drag over a pane.

**Modified:**
- `web/src/pages/TakeoffCanvas.jsx` — host the split state, wire persistence, make tabs draggable, mount `SplitLayout`/`ReferencePane`/`DropZoneOverlay`, add the sheet-chip menu control, add `patId` prefix param.
- `web/src/lib/sheets.ts` or a new `web/src/lib/splitView.ts` — export the total-sheet cap constant.

---

### Task 1: Split-view data model + persistence codec

**Files:**
- Create: `web/src/lib/splitView.ts`
- Test: `web/test/splitView.test.ts`
- Modify: `web/src/pages/TakeoffCanvas.jsx` (add `splitView` state; wire into `buildPayload` at `:2173` and `restoreSavedPayload`/hydrate near `:1547`)

**Interfaces:**
- Produces:
  - `type SplitView = { orientation: "v" | "h"; ratio: number; refKey: string }` — `ratio` is the primary pane's fraction of the split axis (0.2–0.8); `refKey` is the sheetKey framed in the reference pane.
  - `serializeSplitView(sv: SplitView | null): object | null` — returns the persisted object, or `null` when there is no split (caller omits the key).
  - `normalizeSplitView(raw: unknown): SplitView | null` — defensive load; returns `null` for anything malformed or an unknown/missing `refKey` shape.
  - `MIN_RATIO = 0.2`, `MAX_RATIO = 0.8`, `clampRatio(r: number): number`.
  - `SPLIT_MAX_TOTAL_SHEETS = 6` — cap on primary-group-members + reference-members (tune in Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// web/test/splitView.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSplitView, normalizeSplitView, clampRatio, MIN_RATIO, MAX_RATIO } from "../src/lib/splitView.ts";

test("serialize→normalize round-trips a valid split", () => {
  const sv = { orientation: "v" as const, ratio: 0.5, refKey: "A101#2" };
  assert.deepEqual(normalizeSplitView(serializeSplitView(sv)), sv);
});

test("no split serializes to null (so the persisted key is omitted)", () => {
  assert.equal(serializeSplitView(null), null);
});

test("normalize rejects malformed input", () => {
  assert.equal(normalizeSplitView(undefined), null);
  assert.equal(normalizeSplitView({}), null);
  assert.equal(normalizeSplitView({ orientation: "x", ratio: 0.5, refKey: "A" }), null);
  assert.equal(normalizeSplitView({ orientation: "v", ratio: 0.5 }), null); // missing refKey
});

test("normalize clamps an out-of-range ratio instead of dropping the split", () => {
  const sv = normalizeSplitView({ orientation: "h", ratio: 0.99, refKey: "A" });
  assert.equal(sv?.ratio, MAX_RATIO);
});

test("clampRatio holds bounds", () => {
  assert.equal(clampRatio(0.01), MIN_RATIO);
  assert.equal(clampRatio(0.95), MAX_RATIO);
  assert.equal(clampRatio(0.5), 0.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --import tsx --test test/splitView.test.ts`
Expected: FAIL — cannot find module `../src/lib/splitView.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/splitView.ts
// The split-view data model + persistence codec. A "split" is the existing
// interactive stage (primary) beside ONE read-only reference pane.
// Persisted additively (omit-when-absent) so non-split projects round-trip
// byte-identically, matching buildPayload's sheet_group/sheet_tabs convention.

export type Orientation = "v" | "h"; // v = left/right, h = top/bottom
export interface SplitView {
  orientation: Orientation;
  ratio: number;  // primary pane's fraction of the split axis
  refKey: string; // sheetKey framed in the reference pane
}

export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;
// Cap on total live sheets across both panes (primary group members +
// reference members). Guards the tile-pool/LRU budget; tuned in Task 8.
export const SPLIT_MAX_TOTAL_SHEETS = 6;

export const clampRatio = (r: number): number =>
  Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

export const serializeSplitView = (sv: SplitView | null): object | null =>
  sv ? { orientation: sv.orientation, ratio: sv.ratio, refKey: sv.refKey } : null;

export const normalizeSplitView = (raw: unknown): SplitView | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.orientation !== "v" && r.orientation !== "h") return null;
  if (typeof r.refKey !== "string" || !r.refKey) return null;
  if (typeof r.ratio !== "number" || Number.isNaN(r.ratio)) return null;
  return { orientation: r.orientation, ratio: clampRatio(r.ratio), refKey: r.refKey };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && node --import tsx --test test/splitView.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the state + persistence into TakeoffCanvas**

Add the state near the other view state (e.g. beside `tf` at `TakeoffCanvas.jsx:354`):

```jsx
const [splitView, setSplitView] = useState(null); // null = single canvas; else { orientation, ratio, refKey }
```

Import at the top of `TakeoffCanvas.jsx` with the other `lib` imports:

```jsx
import { serializeSplitView, normalizeSplitView, clampRatio, SPLIT_MAX_TOTAL_SHEETS } from "../lib/splitView";
```

In `buildPayload` (`:2173`), add to the returned object (after `sheet_tabs: openTabs,`), preserving omit-when-absent:

```jsx
...(serializeSplitView(splitView) ? { split_view: serializeSplitView(splitView) } : {}),
```

In the hydrate/restore path where `sheet_tabs` is read (`:1547` and the equivalent mount hydrate), add:

```jsx
setSplitView(normalizeSplitView(a.split_view));
```

Note: `normalizeSplitView(undefined)` returns `null`, so a payload without the key correctly clears any pre-load split (the same else-clear discipline the surrounding restore code documents at `:1536`).

- [ ] **Step 6: Verify typecheck + round-trip**

Run: `cd web && npm run typecheck`
Expected: PASS (no type errors).

Run: `cd web && npm test`
Expected: PASS — all existing tests plus the new `splitView` suite.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/splitView.ts web/test/splitView.test.ts web/src/pages/TakeoffCanvas.jsx
git commit -m "feat(split): split-view data model + additive persistence codec"
```

---

### Task 2: Split layout shell + draggable divider + orientation flip

**Files:**
- Create: `web/src/components/SplitLayout.jsx`
- Modify: `web/src/pages/TakeoffCanvas.jsx` (wrap the stage viewport; render `SplitLayout` when `splitView` is set)

**Interfaces:**
- Consumes: `splitView` / `setSplitView` and `clampRatio` from Task 1.
- Produces: `<SplitLayout orientation ratio onRatioChange onFlip onCollapse primary={<…>} reference={<…>} />` — a flex container; `primary` and `reference` are the two surface nodes. Divider drag calls `onRatioChange(clampedRatio)`; a rotate button calls `onFlip()`; a ✕ button calls `onCollapse()`.

- [ ] **Step 1: Build the SplitLayout component**

```jsx
// web/src/components/SplitLayout.jsx
// The two-pane shell: a flex container whose direction is the split
// orientation, a resizable divider between the panes (default 50/50, min
// size clamped by the caller), plus divider affordances to flip V<->H and
// collapse back to a single canvas. Presentational — it owns geometry only.
import { useCallback, useRef } from "react";
import { clampRatio } from "../lib/splitView";

export default function SplitLayout({ orientation, ratio, onRatioChange, onFlip, onCollapse, primary, reference }) {
  const rootRef = useRef(null);
  const vertical = orientation === "v"; // panes left/right

  const onDividerDown = useCallback((e) => {
    e.preventDefault();
    const root = rootRef.current;
    const move = (ev) => {
      const r = root.getBoundingClientRect();
      const frac = vertical ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      onRatioChange(clampRatio(frac));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [vertical, onRatioChange]);

  const primaryPct = `${(ratio * 100).toFixed(3)}%`;
  const refPct = `${((1 - ratio) * 100).toFixed(3)}%`;

  return (
    <div ref={rootRef} style={{ position: "absolute", inset: 0, display: "flex", flexDirection: vertical ? "row" : "column" }}>
      <div style={{ position: "relative", flex: `0 0 ${primaryPct}`, minWidth: 0, minHeight: 0, overflow: "hidden" }}>{primary}</div>
      <div
        role="separator"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        onPointerDown={onDividerDown}
        style={{
          position: "relative", flex: "0 0 6px", background: "var(--rule, #d8d2c4)",
          cursor: vertical ? "col-resize" : "row-resize", touchAction: "none",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
        }}
      >
        {/* divider affordances — kept tiny/unobtrusive; hit target padded via ::before in CSS if needed */}
        <button title="Flip split orientation" onPointerDown={(e) => e.stopPropagation()} onClick={onFlip}
          style={dividerBtn}>⟳</button>
        <button title="Close split" onPointerDown={(e) => e.stopPropagation()} onClick={onCollapse}
          style={dividerBtn}>✕</button>
      </div>
      <div style={{ position: "relative", flex: `0 0 ${refPct}`, minWidth: 0, minHeight: 0, overflow: "hidden" }}>{reference}</div>
    </div>
  );
}

const dividerBtn = {
  width: 16, height: 16, lineHeight: "14px", fontSize: 11, padding: 0,
  border: "1px solid var(--rule, #d8d2c4)", background: "var(--paper-bright, #fff)",
  color: "var(--ink, #333)", borderRadius: 0, cursor: "pointer",
};
```

- [ ] **Step 2: Mount it in TakeoffCanvas around the stage viewport**

Find the stage viewport wrapper that contains `<div ref={stageRef} …>` (`:7847`). It sits inside the scroll/gesture viewport element that carries the `wheel` handler and `stageRef`. Wrap that whole viewport as the **primary** child of `SplitLayout` and render only when `splitView` is set; otherwise render the viewport directly (unchanged single-canvas path). Sketch:

```jsx
{splitView ? (
  <SplitLayout
    orientation={splitView.orientation}
    ratio={splitView.ratio}
    onRatioChange={(r) => setSplitView((s) => s && { ...s, ratio: r })}
    onFlip={() => setSplitView((s) => s && { ...s, orientation: s.orientation === "v" ? "h" : "v" })}
    onCollapse={() => setSplitView(null)}
    primary={PRIMARY_VIEWPORT_JSX}
    reference={<ReferencePane /* Task 4 wires props */ refKey={splitView.refKey} />}
  />
) : (
  PRIMARY_VIEWPORT_JSX
)}
```

For this task, use a placeholder for `reference`: `<div style={{position:"absolute",inset:0,display:"grid",placeItems:"center",color:"var(--ink-soft,#888)"}}>Drop a sheet here</div>`.

- [ ] **Step 3: Confirm the primary stage recomputes size to its half**

The stage sizing is driven by a `ResizeObserver`/measured viewport. Verify the observer is attached to the viewport element now constrained by the flex child (not to `window`). If it observes the viewport node, the half-width/height propagates automatically. If it reads `window.innerWidth`, change it to observe the viewport node's `getBoundingClientRect()`. Grep for the stage-size effect (search `ResizeObserver` and `stageRef` usages in `TakeoffCanvas.jsx`) and confirm.

- [ ] **Step 4: Verify in the running app (Playwright MCP)**

Run the app (`/run` or `cd web && npm run dev`), load a plan with at least 2 sheets open. Temporarily force a split from the devtools console via the exposed setter or by setting `split_view` in the persisted payload; OR proceed after Task 4 wiring. Using Playwright MCP:
1. `browser_navigate` to the dev URL, open a plan, open 2 tabs.
2. In console (`browser_evaluate`) set a split (once a debug hook exists) or drive it after Task 3.
3. `browser_take_screenshot` — confirm two panes with a divider, primary on the left/top showing the live canvas, reference showing "Drop a sheet here".
4. Drag the divider; screenshot — confirm the ratio changes and the primary stage re-lays-out to its new size (no clipped/blank canvas).
5. Click ⟳; screenshot — confirm orientation flips row↔column.

Expected screenshots saved as evidence (per repo convention: any "browser verified" claim ships the screenshot).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SplitLayout.jsx web/src/pages/TakeoffCanvas.jsx
git commit -m "feat(split): two-pane flex shell with resizable divider + orientation flip"
```

---

### Task 3: Reference pane base render (independent framing)

**Files:**
- Create: `web/src/components/ReferencePane.jsx`
- Modify: `web/src/pages/TakeoffCanvas.jsx` (pass the render inputs the reference pane needs)

**Interfaces:**
- Consumes: from TakeoffCanvas — `refKey` (sheetKey), the sheet's rendered bitmap dims (from `panelImgs`), and the shared render machinery for painting a sheet's base raster. The pane owns `refStageRef`, `refTfRef`, and its own `tf` mirror state.
- Produces: `<ReferencePane refKey panelImg renderBase … />`, an independently pan/zoomable surface showing the base raster of `refKey`. No detail, no shapes yet.

**Design note:** The base raster + tile machinery is keyed by `drawKey`/`sheetKey` in maps like `panelCanvasRefs` (`:7853`) and the compositor. To render the same sheet in the reference pane without colliding with the primary pane's caches, **prefix the reference pane's keys** with `ref::` (mirroring the existing stitch-member `${p.key}::${m.key}` convention). This task establishes that prefix discipline.

- [ ] **Step 1: Build ReferencePane with its own transform + gestures**

```jsx
// web/src/components/ReferencePane.jsx
// Read-only second surface. Owns its OWN display transform (refTfRef) and its
// OWN wheel/drag pan-zoom scoped to its element — never the primary pane's
// tfRef. Renders the referenced sheet's base raster now; shapes (Task 5) and
// detail (Task 6) layer on later. It NEVER handles measurement/keyboard.
import { useCallback, useEffect, useRef, useState } from "react";
import { MIN_SCALE, MAX_SCALE } from "../lib/canvasConstants";

export default function ReferencePane({ refKey, panelImg, paintBase, onFrame }) {
  const stageRef = useRef(null);
  const tfRef = useRef({ x: 0, y: 0, scale: 1 });
  const [, force] = useState(0);
  const viewportRef = useRef(null);

  const applyTf = useCallback(() => {
    const { x, y, scale } = tfRef.current;
    if (stageRef.current) stageRef.current.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
  }, []);

  // fit-to-view when the framed sheet changes
  useEffect(() => {
    const vp = viewportRef.current; const img = panelImg;
    if (!vp || !img) return;
    const r = vp.getBoundingClientRect();
    const scale = Math.min(r.width / img.w, r.height / img.h) * 0.95;
    tfRef.current = { scale, x: (r.width - img.w * scale) / 2, y: (r.height - img.h * scale) / 2 };
    applyTf();
  }, [refKey, panelImg, applyTf]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const vp = viewportRef.current.getBoundingClientRect();
    const t = tfRef.current;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale * factor));
    const k = next / t.scale;
    const cx = e.clientX - vp.left, cy = e.clientY - vp.top;
    tfRef.current = { scale: next, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k };
    applyTf();
  }, [applyTf]);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, tx: tfRef.current.x, ty: tfRef.current.y };
    const move = (ev) => {
      tfRef.current = { ...tfRef.current, x: start.tx + (ev.clientX - start.x), y: start.ty + (ev.clientY - start.y) };
      applyTf();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }, [applyTf]);

  // paint the base raster into our own canvas whenever the sheet changes
  const canvasRef = useRef(null);
  useEffect(() => { if (refKey && canvasRef.current) paintBase(`ref::${refKey}`, canvasRef.current); }, [refKey, paintBase]);

  if (!refKey) return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--ink-soft,#888)" }}>Drop a sheet here</div>
  );

  return (
    <div ref={viewportRef} onWheel={onWheel} onPointerDown={onPointerDown}
      style={{ position: "absolute", inset: 0, overflow: "hidden", touchAction: "none", background: "var(--paper, #f4f1ea)" }}>
      <div ref={stageRef} style={{ position: "absolute", transformOrigin: "0 0", width: panelImg?.w, height: panelImg?.h }}>
        <canvas ref={canvasRef} style={{ position: "absolute", left: 0, top: 0, boxShadow: "0 2px 20px rgba(0,0,0,.18)" }} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Provide `paintBase` and `panelImg` from TakeoffCanvas**

The primary pane already produces a base raster per sheet. Extract the base-raster paint step (the code that fills `panelCanvasRefs` entries in the base-layer effect near the `drawPanels` base map at `:7852`) into a callable `paintBase(drawKey, canvasEl)` that renders the referenced sheet's coarse base pyramid into the given canvas — the same `paintBase` the compositor already exposes (`tileCompositor.ts`). Pass it plus `panelImg={panelImgs[splitView.refKey]}` into `<ReferencePane>`.

If the referenced sheet is not among the currently opened/rendered sheets, request its render the same way opening a tab does (ensure its PDF page is parsed and a base pyramid exists), keyed `ref::${refKey}`.

- [ ] **Step 3: Verify independent framing (Playwright MCP)**

1. Load a plan, open sheet A in the primary pane, create a split with the reference pane framing sheet B (drive via debug hook / after Task 4).
2. Pan/zoom the **primary** pane. `browser_take_screenshot`. Pan/zoom the **reference** pane over its own area. Screenshot.
3. Confirm: the two panes show different content at different zooms; panning one does NOT move the other; the primary's measurement behavior is unchanged.
4. Set the reference pane to the SAME sheet as primary, zoom each differently. Screenshot — confirm the same sheet renders at two independent framings without the primary's canvas going blank (proves the `ref::` key prefix prevents cache collision).

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ReferencePane.jsx web/src/pages/TakeoffCanvas.jsx
git commit -m "feat(split): read-only reference pane base render with independent pan/zoom"
```

---

### Task 4: Drop-zone hit-testing + drag-a-tab-to-split gesture

**Files:**
- Create: `web/src/lib/dropZones.ts`, `web/src/components/DropZoneOverlay.jsx`
- Test: `web/test/dropZones.test.ts`
- Modify: `web/src/pages/TakeoffCanvas.jsx` (make tabs draggable; add pane drag handlers; wire drop → split)

**Interfaces:**
- Produces:
  - `type Zone = "left" | "right" | "top" | "bottom" | "center"`
  - `dropZoneAt(rect: {w: number; h: number}, x: number, y: number, opts?: { edgesDisabled?: boolean }): Zone` — `x`,`y` are pane-relative. Edge thirds → directional zone; middle → `center`. When `edgesDisabled` (already split), always returns `center`.
  - `zoneToOrientation(z: Zone): "v" | "h" | null` — left/right→"v", top/bottom→"h", center→null.
  - `SHEET_TAB_DND_MIME = "application/x-opentakeoff-tab"`.

- [ ] **Step 1: Write the failing test**

```ts
// web/test/dropZones.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dropZoneAt, zoneToOrientation } from "../src/lib/dropZones.ts";

const rect = { w: 900, h: 600 };

test("left third → left", () => { assert.equal(dropZoneAt(rect, 100, 300), "left"); });
test("right third → right", () => { assert.equal(dropZoneAt(rect, 800, 300), "right"); });
test("top third → top", () => { assert.equal(dropZoneAt(rect, 450, 60), "top"); });
test("bottom third → bottom", () => { assert.equal(dropZoneAt(rect, 450, 540), "bottom"); });
test("center → center", () => { assert.equal(dropZoneAt(rect, 450, 300), "center"); });
test("corner resolves to the nearer edge, not both", () => {
  // top-left corner: closer to left edge (100<60? no) — pick the axis with the smaller normalized distance
  const z = dropZoneAt(rect, 40, 40);
  assert.ok(z === "left" || z === "top");
});
test("edgesDisabled forces center (already split)", () => {
  assert.equal(dropZoneAt(rect, 100, 300, { edgesDisabled: true }), "center");
});
test("zoneToOrientation maps correctly", () => {
  assert.equal(zoneToOrientation("left"), "v");
  assert.equal(zoneToOrientation("right"), "v");
  assert.equal(zoneToOrientation("top"), "h");
  assert.equal(zoneToOrientation("bottom"), "h");
  assert.equal(zoneToOrientation("center"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --import tsx --test test/dropZones.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/dropZones.ts
// Pure hit-testing for the 5-zone tab-drop overlay. Edge thirds pick a split
// direction; the middle joins the pane's existing group (center). When the
// canvas is already split (only two panes allowed), edges are disabled and
// every drop resolves to center.
export type Zone = "left" | "right" | "top" | "bottom" | "center";
export const SHEET_TAB_DND_MIME = "application/x-opentakeoff-tab";

export const dropZoneAt = (
  rect: { w: number; h: number },
  x: number,
  y: number,
  opts: { edgesDisabled?: boolean } = {},
): Zone => {
  if (opts.edgesDisabled) return "center";
  const fx = x / rect.w, fy = y / rect.h;
  const inMidX = fx > 1 / 3 && fx < 2 / 3;
  const inMidY = fy > 1 / 3 && fy < 2 / 3;
  if (inMidX && inMidY) return "center";
  // distance (normalized) to the nearest of the four edges; smallest wins so a
  // corner picks one edge, never two.
  const dl = fx, dr = 1 - fx, dt = fy, db = 1 - fy;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return "left";
  if (m === dr) return "right";
  if (m === dt) return "top";
  return "bottom";
};

export const zoneToOrientation = (z: Zone): "v" | "h" | null =>
  z === "left" || z === "right" ? "v" : z === "top" || z === "bottom" ? "h" : null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && node --import tsx --test test/dropZones.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the overlay component**

```jsx
// web/src/components/DropZoneOverlay.jsx
// The ghost-half + label shown while a tab is dragged over a pane. `zone` is
// the live dropZoneAt() result; null hides the overlay.
import { zoneToOrientation } from "../lib/dropZones";

export default function DropZoneOverlay({ zone }) {
  if (!zone) return null;
  const orient = zoneToOrientation(zone);
  const half = {
    left:   { left: 0, top: 0, width: "50%", height: "100%" },
    right:  { right: 0, top: 0, width: "50%", height: "100%" },
    top:    { left: 0, top: 0, width: "100%", height: "50%" },
    bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
    center: { left: 0, top: 0, width: "100%", height: "100%" },
  }[zone];
  const label = zone === "center" ? "Add to group"
    : orient === "v" ? "◧ Split Vertical" : "⬓ Split Horizontal";
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20 }}>
      <div style={{ position: "absolute", ...half, background: "var(--cobalt, #2f6fed)", opacity: 0.18, transition: "all .08s ease" }} />
      <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", padding: "4px 10px",
        background: "var(--ink, #222)", color: "var(--paper-bright, #fff)", font: "12px var(--f-body, sans-serif)", borderRadius: 0 }}>{label}</div>
    </div>
  );
}
```

- [ ] **Step 6: Make tabs draggable and wire pane drop handlers in TakeoffCanvas**

In the tab strip render (`:7466`–`:7498`), make each tab `<span>` draggable and set the tab MIME on drag start:

```jsx
draggable
onDragStart={(e) => { e.dataTransfer.setData(SHEET_TAB_DND_MIME, key); e.dataTransfer.effectAllowed = "copy"; }}
```

On the pane viewport (the primary viewport wrapper, and later the reference pane), add drag handlers that (a) filter on the tab MIME and `stopPropagation` — mirroring the condition-chip discipline at `:7415`–`:7430`, so this does NOT fight the condition-chip DnD or the file-drop-onto-canvas handler (`:7181`) — and (b) compute the live zone:

```jsx
const [dragZone, setDragZone] = useState(null);
// on the pane wrapper:
onDragOver={(e) => {
  if (![...e.dataTransfer.types].includes(SHEET_TAB_DND_MIME)) return; // let non-tab drags pass
  e.preventDefault(); e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  setDragZone(dropZoneAt({ w: r.width, h: r.height }, e.clientX - r.left, e.clientY - r.top, { edgesDisabled: !!splitView }));
}}
onDragLeave={() => setDragZone(null)}
onDrop={(e) => {
  if (![...e.dataTransfer.types].includes(SHEET_TAB_DND_MIME)) return;
  e.preventDefault(); e.stopPropagation();
  const droppedKey = e.dataTransfer.getData(SHEET_TAB_DND_MIME);
  const zone = dragZone; setDragZone(null);
  if (zone === "center") { toggleInGroup(droppedKey); return; }        // join primary group (existing behavior)
  const orientation = zoneToOrientation(zone);                          // "v" | "h"
  // dropped sheet frames the reference pane; primary keeps its content
  setSplitView({ orientation, ratio: 0.5, refKey: droppedKey });
}}
```

Render `<DropZoneOverlay zone={dragZone} />` inside each pane wrapper.

Import at top: `import { dropZoneAt, zoneToOrientation, SHEET_TAB_DND_MIME } from "../lib/dropZones";` and `import DropZoneOverlay from "../components/DropZoneOverlay";`.

- [ ] **Step 7: Verify the gesture end-to-end (Playwright MCP)**

1. Load a plan, open sheets A and B in tabs.
2. Drag tab B toward the **right edge** of the canvas — `browser_take_screenshot` mid-drag: overlay shows a right half + "◧ Split Vertical". Drop. Screenshot: vertical split, reference pane frames B.
3. Undo the split (collapse), then drag tab B toward the **bottom edge**: overlay "⬓ Split Horizontal"; drop → horizontal split.
4. With a split active, drag tab A to a pane **center**: overlay shows "Add to group" and NO edge highlight (edges disabled); drop adds A to the primary group.
5. Drag a **condition chip** across the canvas: confirm NO split overlay appears (MIME filter works).

Save screenshots as evidence.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/dropZones.ts web/test/dropZones.test.ts web/src/components/DropZoneOverlay.jsx web/src/pages/TakeoffCanvas.jsx
git commit -m "feat(split): 5-zone drag-a-tab-to-split gesture with directional overlay"
```

---

### Task 5: Reference pane read-only shape overlay + pane-namespaced pattern ids

**Files:**
- Modify: `web/src/pages/TakeoffCanvas.jsx` (add `patId` prefix param; export the read-only shape-render for reuse), `web/src/components/ReferencePane.jsx` (render the SVG overlay)

**Interfaces:**
- Consumes: `shapes`, `conditions`, `condById`, `darkMode`, `stackedShapes` (the same shared state the primary SVG at `:7876`–`:7888` reads), the referenced panel's `img` dims.
- Produces: reference pane renders committed shapes/markups for `refKey` read-only (no `selectedId`, no vertex handles, `pointerEvents: none`), with all `<pattern>` ids prefixed so they never collide with the primary `<defs>`.

- [ ] **Step 1: Add a prefix parameter to `patId`**

At `TakeoffCanvas.jsx:6529`, change:

```jsx
const patId = (c, prefix = "") => `hx-${prefix}${c.id}-${c.hatch || "solid"}-${String(c.color).slice(1)}-${String(c.fill || "n").slice(1)}${darkMode ? "-d" : ""}`;
```

Existing call sites (`:6540`, `:7878`) keep the default empty prefix, so the primary overlay is byte-identical. The reference overlay passes `"ref-"`.

- [ ] **Step 2: Render the read-only overlay in ReferencePane**

Inside the reference stage `<div ref={stageRef}>`, add an SVG overlay mirroring the primary's structure (`:7876`) but read-only and `ref-`-prefixed. It renders `stackedShapes.filter(s => s.sheet_id === refKey)` with `pointerEvents: "none"`, no selection, no handles, and `<defs>` of `conditions.map(c => <HatchPattern id={patId(c, "ref-")} …/>)`; shape fills reference `url(#${patId(cond, "ref-")})`. Pass `shapes`/`conditions`/`condById`/`darkMode`/`patId`/`shapeFill` (curried with the prefix) into `<ReferencePane>` as props, or lift the read-only shape renderer into a shared presentational helper both panes call with a `prefix` and an `interactive` flag.

**Recommended:** extract the SVG shape group at `:7880`–`:7888`+ into a `renderSheetShapes({ panel, shapes, condById, darkMode, patId, prefix, interactive })` helper so primary (`interactive: true`, `prefix: ""`) and reference (`interactive: false`, `prefix: "ref-"`) share one implementation and can't drift.

- [ ] **Step 3: Verify live mirror + no id collision (Playwright MCP)**

1. Split with the reference pane framing the SAME sheet as primary.
2. In the primary pane, measure a room (area tool) under a hatched condition.
3. `browser_take_screenshot` — confirm the room appears in BOTH panes, correctly hatched in each (proves prefix prevents the `url(#…)` collision — if ids collided, one pane's fill would be wrong or empty).
4. Delete the shape in primary; screenshot — it disappears from both.
5. Confirm the reference pane's shapes have no drag handles and don't respond to clicks (read-only).

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/TakeoffCanvas.jsx web/src/components/ReferencePane.jsx
git commit -m "feat(split): read-only mirrored shape overlay with pane-namespaced pattern ids"
```

---

### Task 6: Reference pane detail view (crisp deep zoom)

**Files:**
- Modify: `web/src/pages/TakeoffCanvas.jsx` (parameterize the detail-view render), `web/src/components/ReferencePane.jsx`

**Interfaces:**
- Consumes: the existing detail-tile compositor (`tileCompositor.ts` / the detail-view effect that fills `detailCanvasRefs` at `:7860`).
- Produces: the reference pane's own detail canvas, engaging past `DETAIL_ENGAGE` on its own `refTfRef.scale`, keyed `ref::${refKey}` so its in-flight tile requests and cancels never collide with the primary pane's (`detailKeysRef`/`detailCancelsRef` are per-instance `useRef(Map)`, so the collision surface is only the shared module-level tile pool + DOM keys — the `ref::` prefix covers it).

- [ ] **Step 1: Read and extract the detail-view render**

Read the detail-view effect (search for `detailCanvasRefs`, `DETAIL_ENGAGE`, and the compositor usage in `TakeoffCanvas.jsx`). Extract a callable `renderDetail({ paneId, sheetKey, tf, viewportRect, canvasEl })` that composites the visible region for one surface. The primary effect calls it with `paneId: ""`; the reference pane calls it with `paneId: "ref"` and its own `refTfRef`/viewport.

- [ ] **Step 2: Wire a detail canvas into ReferencePane**

Add a second `<canvas>` (the detail layer, `display:none` until engaged, `pointerEvents:none`) inside the reference stage, and a `useEffect`/gesture-settle that calls `renderDetail` with `ref::${refKey}` when `refTfRef.scale * devicePixelRatio > DETAIL_ENGAGE`. Reuse the same gesture-quiet-window timing (`GESTURE_MS`) the primary uses so it re-renders on settle, not per frame.

- [ ] **Step 3: Verify crisp zoom in both panes (Playwright MCP)**

1. Split, reference frames a sheet.
2. Zoom the reference pane deep (past ~1:1). Wait for settle. `browser_take_screenshot` — text/lines are crisp (detail engaged), not GPU-blurred.
3. Zoom the primary pane deep on a different sheet; screenshot — also crisp, and the reference pane's detail did not disappear (no cache fight).

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/TakeoffCanvas.jsx web/src/components/ReferencePane.jsx
git commit -m "feat(split): reference pane detail-view render for crisp deep zoom"
```

---

### Task 7: Reference-pane tab bar + sheet-chip menu control

**Files:**
- Modify: `web/src/components/ReferencePane.jsx` (thin tab bar), `web/src/pages/TakeoffCanvas.jsx` (menu item; reference tab set state)

**Interfaces:**
- Consumes: the working set of open sheets (`openTabs`), `splitView.refKey`.
- Produces: a thin bar on the reference pane listing the sheets dropped there (its "reference set"), click to switch which one it frames; and a "Reference ▸ Split Vertical / Split Horizontal" item in the sheet-chip dropdown (`sheetMenuItems`, `:6994`) as the discoverable/accessible fallback for the drag gesture.

- [ ] **Step 1: Reference-pane tab bar**

Add a thin bar to `ReferencePane` (top edge for a vertical split / the appropriate outer edge for horizontal — the lower-pane bar placement is a known open item, see Notes). It shows the reference set (starts as `[refKey]`; more sheets added by dropping tabs onto the reference pane's center). Clicking a chip sets `splitView.refKey`. A chip ✕ removes it from the reference set (if it was the framed one, frame the next; if the set empties, collapse — Task 8).

Store the reference set as `splitView.refSet?: string[]` (extend the type + codec in `splitView.ts`; default `[refKey]` when absent for backward-compat loads). Update `serializeSplitView`/`normalizeSplitView` + their tests to carry `refSet`.

- [ ] **Step 2: Menu control**

In `sheetMenuItems` (`:6994`), add two items (enabled when there is a second sheet available to reference): "Reference ▸ Split Vertical" → `setSplitView({ orientation: "v", ratio: 0.5, refKey: <chosen>, refSet: [<chosen>] })`, and the "h" variant. The chosen sheet defaults to the most-recently-used non-active open tab.

- [ ] **Step 3: Verify (Playwright MCP)**

1. Create a split via the menu (not drag) → confirm it opens with the chosen sheet framed.
2. Drop a second sheet onto the reference pane center → confirm it joins the reference bar; click between chips → the framed sheet switches; each remembers nothing about zoom (re-fits on switch, matching persistence decision).
3. Screenshot each state.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ReferencePane.jsx web/src/pages/TakeoffCanvas.jsx web/src/lib/splitView.ts web/test/splitView.test.ts
git commit -m "feat(split): reference-pane tab bar + sheet-chip menu control"
```

---

### Task 8: Lifecycle guards — fold-back, empty pane, viewport/memory disable, total-sheet cap

**Files:**
- Modify: `web/src/pages/TakeoffCanvas.jsx`, `web/src/components/SplitLayout.jsx`, `web/src/components/ReferencePane.jsx`, `web/src/lib/splitView.ts`
- Test: `web/test/splitView.test.ts` (extend for the cap helper)

**Interfaces:**
- Produces: `canSplit(env): boolean` and `wouldExceedSheetCap(primaryCount, refCount): boolean` in `splitView.ts`; lifecycle wiring in the component.

- [ ] **Step 1: Write the failing test for the cap helper**

```ts
// append to web/test/splitView.test.ts
import { wouldExceedSheetCap, SPLIT_MAX_TOTAL_SHEETS } from "../src/lib/splitView.ts";
test("sheet cap trips when primary + reference exceed the budget", () => {
  assert.equal(wouldExceedSheetCap(4, 2), 4 + 2 > SPLIT_MAX_TOTAL_SHEETS); // 6 > 6 = false
  assert.equal(wouldExceedSheetCap(4, 3), true);
  assert.equal(wouldExceedSheetCap(1, 1), false);
});
```

- [ ] **Step 2: Run it, watch it fail, then implement**

Run: `cd web && node --import tsx --test test/splitView.test.ts` → FAIL (no `wouldExceedSheetCap`). Add:

```ts
// web/src/lib/splitView.ts
export const wouldExceedSheetCap = (primaryCount: number, refCount: number): boolean =>
  primaryCount + refCount > SPLIT_MAX_TOTAL_SHEETS;
```

Run again → PASS.

- [ ] **Step 3: Fold-back on collapse**

`onCollapse` (SplitLayout ✕ / divider dragged fully to an edge) sets `splitView(null)`. Ensure the reference set's sheets remain in `openTabs` (they already are — the reference set only *references* open tabs, never owns them), so nothing is lost. Add: dragging the divider past `MIN_RATIO`/`MAX_RATIO` snaps to collapse (call `onCollapse`).

- [ ] **Step 4: Empty-pane guard**

If the reference set becomes empty (last chip removed), auto-collapse (`setSplitView(null)`). This prevents the reference pane from ever hitting the `panelByKey`/`focusPanel` `|| panels[0]` fallback (`panelGeometry.js:18`, `:1060`) that would otherwise silently frame the wrong sheet. The reference pane's own render already returns the "Drop a sheet here" empty state for a null `refKey`, but the pane should not persist in that state — collapse instead.

- [ ] **Step 5: Viewport + memory disable**

Add `canSplit`:

```ts
// web/src/lib/splitView.ts
export const canSplit = (env: { narrow: boolean; lowMemory: boolean }): boolean =>
  !env.narrow && !env.lowMemory;
```

Wire it: gate the drag-drop split creation and the menu items on `canSplit({ narrow: isNarrow, lowMemory: LOW_MEMORY_DEVICE })` (import `LOW_MEMORY_DEVICE` from wherever `tilePool.ts` exposes it; if it isn't exported, export it). When a saved `split_view` loads on a too-narrow/low-memory client, render the primary pane single and show a small "Restore split" affordance (a button in the sheet-chip menu) instead of forcing two cramped panes — do NOT discard the persisted `split_view` (keep it in state, just don't mount `SplitLayout` until `canSplit`).

- [ ] **Step 6: Enforce the total-sheet cap at drop/add**

Before creating a split or adding a sheet to the reference set, compute `primaryCount` (the primary group's member count, expanding stitches to members) and `refCount` (reference set members). If `wouldExceedSheetCap(primaryCount, refCount)`, refuse and surface a brief toast/inline note ("Too many sheets open at once to split — close a sheet first"). Do not silently drop the sheet.

- [ ] **Step 7: Verify each guard (Playwright MCP + resize)**

1. Fold-back: split, then ✕ → single canvas; confirm both sheets still in the tab strip.
2. Divider-to-edge collapse: drag divider fully left → collapses.
3. Empty pane: remove the last reference chip → auto-collapses.
4. Narrow: `browser_resize` to a narrow width with a saved split → confirm one pane + "Restore split", not two cramped panes; screenshot.
5. Cap: open a 4-sheet primary group, try to add 3 to reference → refused with the note; screenshot.

- [ ] **Step 8: Full gate + commit**

Run: `cd web && npm run check`
Expected: typecheck + lint + tests + bench + build all PASS.

```bash
git add web/src/lib/splitView.ts web/test/splitView.test.ts web/src/pages/TakeoffCanvas.jsx web/src/components/SplitLayout.jsx web/src/components/ReferencePane.jsx
git commit -m "feat(split): lifecycle guards — fold-back, empty-pane, viewport/memory disable, sheet cap"
```

---

## Notes / Known Open Items (decide on sight, do not block)

- **Horizontal-split lower-pane tab-bar placement.** For a top/bottom split, the lower pane's tab bar sits against the divider; likely move it to the lower pane's bottom edge. Decide visually during Task 7 verification.
- **The exact `SPLIT_MAX_TOTAL_SHEETS` value (6).** Tune against the tile-pool worker count and LRU byte-budget once two panes render real hi-res sheets. If two panes each with a hi-res sheet already strain memory on a mid-range machine, lower it (even to "reference = single sheet only, no reference group").
- **`renderDetail`/`paintBase` extraction risk (Tasks 3 & 6).** These reuse the most intricate part of the canvas (the tile compositor + detail-view effect). If extraction proves too entangled to do cleanly, fall back to: reference pane renders base raster only (Task 3) and a lower-fidelity detail (or a "click to open this sheet in the primary pane to measure at full crispness"). The read-only base render is the load-bearing 80%; crisp detail is a refinement.

## Self-Review

**Spec coverage** (each resolved decision → task):
- Independent content + viewport per pane → Tasks 3, 6. ✔
- Read-only reference pane (no measuring/keyboard/undo) → Global Constraints + Task 5 (read-only overlay). ✔
- Exactly two panes, no nesting → enforced by the single `splitView` shape (one `refKey`/`refSet`). ✔
- Vertical + horizontal split, V↔H flip → Task 2. ✔
- Per-pane tab bars, only when split → Task 7 (reference bar) + existing primary bar. ✔
- Primary owns tools/keyboard/scale; shapes+scale mirror per-sheet → Global Constraints + Task 5. ✔
- 5-zone drag (edges split, center add-to-group) + menu fallback → Tasks 4, 7. ✔
- Divider 50/50 resizable + min; collapse folds back; once split, edges disabled → Tasks 2, 4 (`edgesDisabled`), 8. ✔
- Persist layout not zoom; focused pane (=primary) drives single-sheet actions → Task 1 + Global Constraints. ✔
- Disable below width threshold + low-memory; orientation flip in v1 → Tasks 2, 8. ✔
- Same-sheet cache collision → `ref::` key prefix (Tasks 3, 6) + `ref-` id prefix (Task 5). ✔
- Tab-drag vs condition-chip MIME collision → Task 4 Step 6 (MIME filter + stopPropagation). ✔
- Empty-pane silent mis-target → Task 8 Step 4. ✔
- Total-sheet render ceiling → Task 8 Steps 1–2, 6. ✔

**Placeholder scan:** No "TBD"/"handle edge cases"/"write tests for the above" left in code steps; pure modules carry full code; integration steps give exact snippets + anchor line numbers. The two genuinely-uncertain reuse points (`renderDetail`/`paintBase` extraction) are called out explicitly in Notes with a concrete fallback, not hidden.

**Type consistency:** `SplitView` fields (`orientation`/`ratio`/`refKey`/`refSet`) used consistently across `splitView.ts`, `SplitLayout`, `ReferencePane`, and the component wiring. `Zone`/`zoneToOrientation`/`SHEET_TAB_DND_MIME` consistent between `dropZones.ts`, `DropZoneOverlay`, and the drop handler. `patId(c, prefix)` signature back-compatible (default `""`).
