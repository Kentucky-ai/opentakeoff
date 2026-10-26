// Read-only second surface (split screen, Task 3). Owns its OWN display
// transform (a local tfRef, NOT the primary pane's tfRef) and its OWN
// wheel/drag pan-zoom scoped to its element — panning/zooming this pane never
// touches the primary pane's transform, and vice versa. Renders the referenced
// sheet's BASE raster (Task 3) plus a read-only mirror of its committed shapes
// and markups (Task 5) plus a tile-composited detail layer (Task 6) that is the
// active raster path at EVERY zoom level on this pane's OWN scale — no
// DETAIL_ENGAGE gate, matching the primary pane's detail view. It NEVER handles
// measurement/keyboard/tools — no selection, no vertex handles, no markup
// halo, no click handlers reach the overlay below.
//
// `refKey` arrives already validated by the caller (TakeoffCanvas): a
// dangling/unresolvable refKey is reported as `null` here, not as a raw
// string that fails to paint — this component's only "no sheet" branch is
// "refKey is falsy", so validation lives entirely on the caller's side.
// `shapes` likewise arrives already filtered to this refKey and paint-order
// sorted (TakeoffCanvas's `refStackedShapes`, the reference-pane analog of
// the primary's `stackedShapes` — NOT scoped to the primary's sheetGroup, so
// a shape on a sheet the primary isn't even displaying still mirrors here).
// `markups` arrives the same way (TakeoffCanvas's `refMarkups`), plus the
// context its ink needs to render identically to the primary: `rfis` (linkage
// badge numbers), `noteQtyLabels` ({{qty}} fields in note text) and
// `sheetBaseLabel` (a capture's legacy source caption).
//
// Tab bar (Task 7): a thin strip of chips along the pane's top edge listing
// `refSet` — the sheets dropped here, `activeKey` included. Clicking a chip
// asks the caller to re-frame it (`onSelectRef`); a chip's ✕ asks the caller
// to drop it (`onRemoveRef`). `activeKey` is the RAW, unvalidated
// `splitView.refKey` (not the caller-sanitized `refKey` prop below) so a
// dangling reference still highlights the right chip while the content area
// shows "Drop a sheet here" — the bar must stay usable exactly when the
// content area can't render anything. Always rendered at the TOP edge
// regardless of split orientation (decide-on-sight: for a horizontal split
// this puts the bar directly under the divider's flip/collapse controls;
// for a vertical split it's the top of the right-hand pane — one code path,
// no orientation prop needed here). Dropping a sheet tab anywhere on this
// pane (`SHEET_TAB_DND_MIME`, same discipline as the primary pane's
// tab-to-split gesture) adds it to the reference set and frames it —
// `onDropSheet`.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MIN_SCALE, MAX_SCALE, SYNC_MS, GESTURE_MS } from "../lib/canvasConstants";
import { SHEET_TAB_DND_MIME } from "../lib/dropZones";
import { HatchPattern } from "./hatches.jsx";
import { renderShapeGlyph } from "./shapeGlyphs.jsx";
import { renderMarkupGlyph, readOnlyPremiumInk } from "./markupGlyphs.jsx";
import { Icon } from "../brand/icons.jsx";

export default function ReferencePane({
  refKey, panelImg, paintBase, paintDetail, epoch, shapes = [], conditions = [], condById = {}, darkMode = false, patId,
  markups = [], rfis = [], noteQtyLabels, sheetBaseLabel,
  refSet = [], activeKey = null, tabLabel = (k) => k, onSelectRef, onRemoveRef, onDropSheet,
}) {
  const stageRef = useRef(null);
  const tfRef = useRef({ x: 0, y: 0, scale: 1 });
  const viewportRef = useRef(null);
  // Throttled mirror of tfRef.current.scale — ONLY for the shape overlay's
  // screen-constant stroke widths below (dividing by scale keeps outlines a
  // constant screen size the way the primary pane's `tf` React-state mirror
  // does). A drag/wheel gesture calls applyTf many times a tick; syncing a
  // React state write on every one of those would reconcile the whole shape
  // overlay that often. ~11Hz (SYNC_MS) matches the primary's own tf-mirror
  // cadence (TakeoffCanvas's scheduleSync).
  const [scale, setScale] = useState(1);
  const scaleSyncRef = useRef({ timer: 0, last: 0, lastScale: 1 });

  const applyTf = useCallback(() => {
    const { x, y, scale: s } = tfRef.current;
    if (stageRef.current) stageRef.current.style.transform = `translate(${x}px,${y}px) scale(${s})`;
    const sync = scaleSyncRef.current;
    if (s === sync.lastScale || sync.timer) return;
    const wait = Math.max(0, SYNC_MS - (performance.now() - sync.last));
    sync.timer = setTimeout(() => {
      sync.timer = 0; sync.last = performance.now(); sync.lastScale = tfRef.current.scale;
      setScale(tfRef.current.scale);
    }, wait);
  }, []);
  useEffect(() => () => { if (scaleSyncRef.current.timer) clearTimeout(scaleSyncRef.current.timer); }, []);
  // Re-apply after every React render so an unrelated re-render (e.g. the
  // primary committing a shape, which re-renders this pane's new `shapes`
  // prop) can never strand the transform at a stale value mid-gesture — same
  // guard the primary pane's own stage keeps (TakeoffCanvas.jsx).
  useLayoutEffect(() => { applyTf(); });

  // crisp deep-zoom detail layer (Task 6) — the reference-pane analog of the
  // primary's tile-composited detail view (TakeoffCanvas.jsx's
  // syncTilePanelsRef), driven by THIS pane's OWN tfRef/viewport rather than
  // the primary's shared one. `paintDetail` is a TakeoffCanvas-owned callback
  // (same pattern as `paintBase` above) that does the actual compositor call
  // under the `ref::`-prefixed key — its own single-slot dedup/cancel state
  // and the primary's per-drawKey Maps never touch the same storage, so an
  // in-flight request here can't collide with or be cancelled by the
  // primary's own detail-view bookkeeping (Task 3's isolation note: the
  // `ref::` prefix is what makes them distinct opaque sheetKey strings).
  const detailCanvasRef = useRef(null);
  const detailTimerRef = useRef(0);
  const runDetailSync = useCallback(() => {
    const cv = detailCanvasRef.current;
    const vp = viewportRef.current;
    if (!cv || !vp || !refKey) return;
    paintDetail(`ref::${refKey}`, cv, tfRef.current, vp.getBoundingClientRect());
  }, [refKey, paintDetail]);
  // GESTURE_MS quiet window — same settle cadence the primary's detail view
  // waits for. A plain trailing debounce suffices here: unlike the primary's
  // self-polling scheduleSync (which also has to reposition tiles on every
  // tick for a pure pan), this pane's base layer rides its own CSS transform
  // and needs no per-tick work — only the detail CROP waits for quiet.
  const scheduleDetailSync = useCallback(() => {
    clearTimeout(detailTimerRef.current);
    detailTimerRef.current = setTimeout(runDetailSync, GESTURE_MS);
  }, [runDetailSync]);
  useEffect(() => () => clearTimeout(detailTimerRef.current), []);

  // fit-to-view when the framed sheet changes (or its dims resolve/change) —
  // deliberately NOT keyed on `epoch`: a repaint-only resync (the primary
  // pane's group changing under it, which tears down and reopens every
  // `ref::`-prefixed compositor entry) must not undo the user's own pan/zoom
  // on this pane. Declared BEFORE the structural detail-repaint effect below
  // (same [refKey, ...] dependency) so a brand-new refKey lands its fresh fit
  // scale/offset in tfRef before that effect reads it — the two fire in
  // source order within one commit, and reading the pre-fit tfRef would crop
  // the detail view against the WRONG (previous sheet's, or default) frame.
  useEffect(() => {
    const vp = viewportRef.current; const img = panelImg;
    if (!vp || !img) return;
    const r = vp.getBoundingClientRect();
    const fitScale = Math.min(r.width / img.w, r.height / img.h) * 0.95;
    tfRef.current = { scale: fitScale, x: (r.width - img.w * fitScale) / 2, y: (r.height - img.h * fitScale) / 2 };
    applyTf();
  }, [refKey, panelImg, applyTf]);

  // Structural changes — sheet swap, a freshly-reopened compositor entry
  // (epoch, after the primary's resetAll wiped every `ref::` entry), a
  // dark-mode toggle — repaint immediately; none of these are gestures, so
  // there's nothing worth debouncing.
  useEffect(() => { runDetailSync(); }, [refKey, epoch, darkMode, runDetailSync]);
  // A container resize (dragging the split ratio, docking a side panel)
  // changes the viewport rect without touching tfRef — resync so the crop
  // stays correctly bounded. Debounced like a gesture: a ratio drag fires
  // many resize ticks in a row.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => scheduleDetailSync());
    ro.observe(vp);
    return () => ro.disconnect();
  }, [scheduleDetailSync]);

  // Imperative addEventListener with { passive: false }, NOT the React
  // onWheel prop — React's synthetic wheel listener is registered passive
  // (matching the browser's own default for `wheel`), so e.preventDefault()
  // inside a JSX onWheel handler throws "Unable to preventDefault inside a
  // passive event listener invocation" instead of blocking page scroll. The
  // primary pane's own wheel handler (TakeoffCanvas.jsx) uses this exact
  // pattern for the same reason.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const vp = el.getBoundingClientRect();
      const t = tfRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale * factor));
      const k = next / t.scale;
      const cx = e.clientX - vp.left, cy = e.clientY - vp.top;
      tfRef.current = { scale: next, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k };
      applyTf();
      scheduleDetailSync(); // wheel-zoom is a gesture — wait for quiet, not per-tick
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyTf, refKey, scheduleDetailSync]);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, tx: tfRef.current.x, ty: tfRef.current.y };
    const move = (ev) => {
      tfRef.current = { ...tfRef.current, x: start.tx + (ev.clientX - start.x), y: start.ty + (ev.clientY - start.y) };
      applyTf();
      scheduleDetailSync(); // drag-pan is a gesture too — same quiet-window rule
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }, [applyTf, scheduleDetailSync]);

  // paint the base raster into our own canvas whenever the sheet changes OR
  // the caller signals a fresh compositor entry (epoch) — e.g. after the
  // primary pane's sheet/group change reset the shared tile compositor and
  // reopened this pane's `ref::`-prefixed entry. paintBase mutates the
  // canvas's pixels/backing store directly — no React re-render needed to
  // reflect it, so no local state tracks the paint itself.
  const canvasRef = useRef(null);
  useEffect(() => {
    if (refKey && canvasRef.current) paintBase(`ref::${refKey}`, canvasRef.current);
  }, [refKey, epoch, paintBase]);

  // Center-drop-to-add (Task 7): the reference pane is always the SECOND (and
  // last) pane once a split exists, so unlike the primary pane's 5-zone
  // hit-test (dropZoneAt), there's no edge/center distinction to make here —
  // any drop anywhere on this pane means "add to the reference set". Filter
  // on SHEET_TAB_DND_MIME + stopPropagation, same discipline as the primary
  // pane's tab-to-split gesture (TakeoffCanvas.jsx), so a dragged condition
  // chip or an OS file drag still falls through untouched.
  const onDragOverSheet = useCallback((e) => {
    if (![...e.dataTransfer.types].includes(SHEET_TAB_DND_MIME)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);
  const onDropSheetTab = useCallback((e) => {
    if (![...e.dataTransfer.types].includes(SHEET_TAB_DND_MIME)) return;
    e.preventDefault(); e.stopPropagation();
    const droppedKey = e.dataTransfer.getData(SHEET_TAB_DND_MIME);
    if (droppedKey) onDropSheet?.(droppedKey);
  }, [onDropSheet]);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}
      onDragOver={onDragOverSheet} onDrop={onDropSheetTab}>
      <ReferenceTabBar refSet={refSet} activeKey={activeKey} tabLabel={tabLabel} onSelect={onSelectRef} onRemove={onRemoveRef} />
      <div style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0 }}>
        {!refKey ? (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--ink-soft,#888)" }}>Drop a sheet here</div>
        ) : (
          <div ref={viewportRef} onPointerDown={onPointerDown}
            style={{ position: "absolute", inset: 0, overflow: "hidden", touchAction: "none", background: "var(--paper, #f4f1ea)" }}>
            <div ref={stageRef} style={{ position: "absolute", transformOrigin: "0 0", width: panelImg?.w, height: panelImg?.h }}>
              {/* CSS width/height stretch the (bounded, coarse-then-budget) base
                  backing store up to the sheet's full logical footprint — the same
                  "small backing store, CSS-stretched" contract the primary pane's
                  base canvases use (TakeoffCanvas's drawPanels base layer). Without
                  this the canvas would render at its raw pixel size instead of
                  filling the stage. */}
              <canvas ref={canvasRef}
                style={{ position: "absolute", left: 0, top: 0, width: panelImg?.w, height: panelImg?.h, boxShadow: "0 2px 20px rgba(0,0,0,.18)" }} />
              {/* detail layer (Task 6) — a crop of the visible region + margin
                  composited from cached tiles at the current zoom, exactly like the
                  primary pane's per-source detail canvases (TakeoffCanvas's
                  drawPanels detail layer); active at every zoom level, no
                  DETAIL_ENGAGE gate (paintReferenceDetail in TakeoffCanvas.jsx) —
                  only hidden when the crop reports the source is off-screen.
                  Position/size are set imperatively by the compositor's paintDetail
                  on each reveal, same as the primary's. */}
              <canvas ref={detailCanvasRef}
                style={{ position: "absolute", left: 0, top: 0, display: "none", pointerEvents: "none" }} />
              {/* Read-only shape mirror (Task 5). pointerEvents:none end to end —
                  no selection, no vertex handles, no click/drag reaches a shape
                  here. Sits in the SAME transformed stage as the base canvas above
                  (this div's CSS pan/zoom), in the sheet's own local px frame, so
                  shapes track the raster under this pane's independent transform
                  exactly like the primary's overlay tracks its own stage.
                  Every <pattern> id is "ref-"-prefixed (patId(c, "ref-")) so this
                  <defs> can NEVER collide with the primary's own <defs> — a
                  collision would make url(#…) resolution document-order-dependent
                  and corrupt one pane's fills (the reason this task exists). */}
              {panelImg && (
                <svg width={panelImg.w} height={panelImg.h} viewBox={`0 0 ${panelImg.w} ${panelImg.h}`}
                  style={{ position: "absolute", top: 0, left: 0, overflow: "visible", pointerEvents: "none" }}>
                  <defs>
                    {conditions.map((c) => <HatchPattern key={patId(c, "ref-")} id={patId(c, "ref-")} type={c.hatch || "solid"} line={c.color} fill={c.fill} dark={darkMode} />)}
                  </defs>
                  {shapes.map((s) => renderShapeGlyph(s, {
                    dn: (vn) => vn.map(([x, y]) => [x * panelImg.w, y * panelImg.h]),
                    cond: condById[s.condition_id], sel: false, z: scale, darkMode,
                    patId: (c) => patId(c, "ref-"),
                  }))}
                  {/* Read-only markup mirror — the SAME renderer the primary's markup
                      layer calls (markupGlyphs.jsx), so clouds, callouts, text notes,
                      dimensions, arrows, highlights, bubbles, captured images and vector
                      stamps all mirror without a second implementation to drift. Two
                      differences from the primary, both deliberate: `selected` is pinned
                      false (no halo, and none of the selection-only geometry exists on
                      this path), and premium ink comes from `readOnlyPremiumInk`, which
                      can never mint the annotation workbench's selection handles. Sits
                      inside the same pointerEvents:none <svg> as the shapes, so a click
                      or drag here still pans the pane — markups are never interactive.
                      `markups` arrives already scoped to this refKey and paint-ordered
                      (TakeoffCanvas's `refMarkups`, via lib/markupPaint). */}
                  {markups.map((m) => renderMarkupGlyph(m, {
                    img: panelImg, z: scale, darkMode, condById, rfis, noteQtyLabels, sheetBaseLabel,
                    selected: false, premiumInk: readOnlyPremiumInk,
                  }))}
                </svg>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Thin chip strip (Task 7) — the reference pane's own "which sheet is
// framed" affordance, the read-only-pane analog of the primary's open-tabs
// strip (TakeoffCanvas.jsx). Deliberately much plainer than that strip: no
// drag-out, no side-by-side toggle, no overflow scroller — a reference set
// is expected to stay small (a handful of comparison sheets, not the whole
// plan), and `overflowX:"auto"` on the strip covers the rare case it grows
// past the pane's width (a vertical split at MAX_RATIO leaves the reference
// pane just ~20% wide). Renders nothing for an empty `refSet` (defensive —
// TakeoffCanvas.jsx's empty-pane guard auto-collapses the whole split the
// instant refSet WOULD empty, so this pane unmounts before ever needing to
// render one, but this stays a no-op rather than crashing if that guard is
// ever bypassed).
//
// The ✕ shows on EVERY chip, solo included (Task 8): "remove my only
// reference sheet" is a legitimate way to ask for the split to close, not a
// state to fence off. onRemove (TakeoffCanvas.jsx's removeRefTab) auto-
// collapses the split when this empties the set — see its comment.
function ReferenceTabBar({ refSet, activeKey, tabLabel, onSelect, onRemove }) {
  if (!refSet.length) return null;
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "3px 6px", overflowX: "auto", minWidth: 0, flexShrink: 0, borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)", scrollbarWidth: "none" }}>
      {refSet.map((k) => {
        const on = k === activeKey;
        return (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, border: "1px solid var(--ink-faint)", borderBottom: on ? "2px solid var(--cobalt)" : "1px solid var(--ink-faint)", background: on ? "var(--paper-cream)" : "transparent", padding: "2px 5px 1px 7px", maxWidth: 140 }}>
            <button type="button" onClick={() => onSelect?.(k)} title={k}
              style={{ border: "none", background: "none", cursor: "pointer", fontWeight: on ? 700 : 500, fontSize: 10.5, color: "var(--ink)", fontFamily: "var(--f-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 105, padding: 0 }}>
              {tabLabel(k)}
            </button>
            <button type="button" onClick={() => onRemove?.(k)} title={refSet.length > 1 ? "Remove from reference" : "Remove — closes the split"}
              style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: 0, display: "inline-flex" }}>
              <Icon name="close" size={9} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
