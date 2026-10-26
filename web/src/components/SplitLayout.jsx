// The two-pane shell: a flex container whose direction is the split
// orientation, a resizable divider between the panes (default 50/50, min
// size clamped by the caller), plus divider affordances to flip V<->H and
// collapse back to a single canvas. Presentational — it owns geometry only.
//
// ALWAYS mounted at its call site (TakeoffCanvas never swaps it out for a
// bare wrapper) so the primary viewport's element identity survives every
// split enter/exit — that's what keeps the canvas from unmounting/
// remounting on toggle. reference == null is how "no split" is expressed:
// render ONLY the primary pane, full-bleed, no divider, no second pane. The
// root itself sizes via `flex: 1` (a normal flex-row/column item) rather
// than `position:absolute; inset:0` — it sits as a direct flex child next
// to fixed-width siblings (tool rail, docked panels), and absolute+inset:0
// would paint over the whole flex row instead of just its own slot.
import { useCallback, useRef } from "react";
import { clampRatio, MIN_RATIO, MAX_RATIO } from "../lib/splitView";

export default function SplitLayout({ orientation, ratio, onRatioChange, onFlip, onCollapse, primary, reference }) {
  const rootRef = useRef(null);
  const vertical = orientation === "v"; // panes left/right
  const split = reference != null;

  const onDividerDown = useCallback((e) => {
    e.preventDefault();
    const root = rootRef.current;
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    // Task 8: dragging PAST the resizable range (not just to it — ratio is
    // already clamped to [MIN_RATIO, MAX_RATIO] on the way in) reads as "the
    // user wants this pane gone," the same idiom as dragging a native
    // split/pane divider fully to an edge. Collapsing here ends the drag
    // immediately (removes both listeners) rather than continuing to track
    // a pointer the pane no longer exists to follow.
    const move = (ev) => {
      const r = root.getBoundingClientRect();
      const frac = vertical ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      if (frac < MIN_RATIO || frac > MAX_RATIO) { up(); onCollapse(); return; }
      onRatioChange(clampRatio(frac));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [vertical, onRatioChange, onCollapse]);

  const primaryPct = `${(ratio * 100).toFixed(3)}%`;
  const refPct = `${((1 - ratio) * 100).toFixed(3)}%`;

  return (
    <div ref={rootRef} style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: vertical ? "row" : "column" }}>
      <div style={{ position: "relative", flex: split ? `0 0 ${primaryPct}` : "1 1 auto", minWidth: 0, minHeight: 0, overflow: "hidden" }}>{primary}</div>
      {split && (
        <>
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
        </>
      )}
    </div>
  );
}

const dividerBtn = {
  width: 16, height: 16, lineHeight: "14px", fontSize: 11, padding: 0,
  border: "1px solid var(--rule, #d8d2c4)", background: "var(--paper-bright, #fff)",
  color: "var(--ink, #333)", borderRadius: 0, cursor: "pointer",
};
