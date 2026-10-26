// Live counter — a floating running-totals readout the estimator parks
// anywhere on the canvas. Shows every condition that carries shapes, its
// measured quantities updating as work commits; the active condition leads.
// Drag the header to move it (position persists per browser); ⌖ re-docks it
// to the default corner; — collapses it to a one-line chip. Clicking a row
// activates that condition, same as clicking it in the Takeoffs panel.
//
// Deliberately a READOUT, not a panel: no settings, no charts, no scroll of
// its own beyond a max height. The pure half (row shaping, formatting,
// clamping, storage) lives in lib/liveCounter.js and is node-tested.
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { COUNTER_POS_KEY, COUNTER_MIN_KEY, fmtQty, clampPos, loadStored, saveStored } from "../lib/liveCounter.js";

export default function LiveCounter({ rows, onActivate }) {
  // pos === null → docked in the default corner via right/bottom CSS; a drag
  // switches to explicit left/top and persists it.
  const [pos, setPos] = useState(() => loadStored(COUNTER_POS_KEY, null));
  const [min, setMin] = useState(() => loadStored(COUNTER_MIN_KEY, false) === true);
  const boxRef = useRef(null);
  const dragRef = useRef(null); // { dx, dy } while a header drag is live

  // keep a dragged position reachable after a window resize
  useEffect(() => {
    const onResize = () => setPos((p) => {
      if (!p) return p;
      const el = boxRef.current;
      const next = clampPos(p, { w: el?.offsetWidth, h: el?.offsetHeight }, window.innerWidth, window.innerHeight);
      saveStored(COUNTER_POS_KEY, next);
      return next;
    });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!rows.length) return null;
  const active = rows.find((r) => r.active) || rows[0];
  const others = rows.filter((r) => r !== active);

  // Window-level move/up listeners for the duration of the gesture — sturdier
  // than pointer capture here: a fast drag can outrun the widget's re-render,
  // and capture on a child retargets events away from these handlers. Window
  // listeners see the gesture wherever the cursor is.
  const startDrag = (e) => {
    if (e.button !== 0 || dragRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    const d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    const move = (ev) => {
      const el = boxRef.current;
      if (!el) return;
      setPos(clampPos({ x: ev.clientX - d.dx, y: ev.clientY - d.dy }, { w: el.offsetWidth, h: el.offsetHeight }, window.innerWidth, window.innerHeight));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      dragRef.current = null;
      setPos((p) => { if (p) saveStored(COUNTER_POS_KEY, p); return p; });
    };
    dragRef.current = d;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    e.preventDefault();
  };
  const redock = () => { setPos(null); saveStored(COUNTER_POS_KEY, null); };
  const toggleMin = () => setMin((m) => { saveStored(COUNTER_MIN_KEY, !m); return !m; });

  const place = pos ? { left: pos.x, top: pos.y } : { right: 16, bottom: 56 };
  const qtyLine = (r, big) => (
    <span style={{ display: "inline-flex", gap: 10, alignItems: "baseline" }}>
      {r.qtys.map((q) => (
        <span key={q.unit} style={{ fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: big ? 22 : 12.5, color: "var(--ink)" }}>
          {fmtQty(q.qty)}<span style={{ fontWeight: 500, fontSize: big ? 12 : 10, color: "var(--ink-muted)" }}> {q.unit}</span>
        </span>
      ))}
    </span>
  );

  return (
    <div ref={boxRef} data-live-counter style={{ position: "fixed", zIndex: 60, ...place, minWidth: min ? 0 : 208, maxWidth: 300, border: "1px solid var(--ink-faint)", borderTop: `2px solid ${active.color || "var(--cobalt)"}`, background: "var(--paper-bright)", boxShadow: "0 4px 18px rgba(0,0,0,0.18)", userSelect: "none" }}>
      <div onPointerDown={startDrag}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: min ? "4px 8px" : "5px 10px", cursor: "grab", touchAction: "none", borderBottom: min ? "none" : "1px solid var(--ink-faint)" }}>
        <span style={{ width: 8, height: 8, background: active.color || "var(--cobalt)", flexShrink: 0 }} />
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--ink-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {min ? active.tag : "Live count"}
        </span>
        {min && qtyLine(active, false)}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center" }}>
          {pos && (
            <button type="button" onClick={redock} title="Return to the default corner" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: 0, display: "inline-flex" }}><Icon name="target" size={11} /></button>
          )}
          <button type="button" onClick={toggleMin} title={min ? "Expand the live counter" : "Collapse to a chip"} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: 0, fontFamily: "var(--f-mono)", fontSize: 12, lineHeight: 1 }}>{min ? "▢" : "—"}</button>
        </span>
      </div>
      {!min && (
        <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{active.tag}</span>
            {qtyLine(active, true)}
            <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>{active.shapes} shape{active.shapes === 1 ? "" : "s"}</span>
          </div>
          {others.map((r) => (
            <button key={r.id} type="button" onClick={() => onActivate?.(r.id)} title="Make this the active condition"
              style={{ display: "flex", alignItems: "center", gap: 7, border: "none", background: "none", cursor: "pointer", padding: "2px 0", textAlign: "left" }}>
              <span style={{ width: 7, height: 7, background: r.color || "var(--ink-faint)", flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{r.tag}</span>
              {qtyLine(r, false)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
