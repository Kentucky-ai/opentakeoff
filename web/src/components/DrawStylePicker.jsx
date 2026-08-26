// DrawStylePicker — the drawing-style control for the ⋯ overflow menu. A
// select-style face (active style's mini preview + name) that opens a checked
// list of the four styles, each with the same two-bend preview the swatches
// drew. Modeled on the toolbar's Line-Style / Label selects so it reads as one
// more dropdown, not a panel. Lives as a `custom` ToolMenu row, so picking a
// style repaints the canvas live and never closes the ⋯ menu behind it.
import React, { useEffect, useRef, useState } from "react";
import { markerPath } from "../lib/drawStyles.js";

// The swatch preview, value-for-value with the old tile grid: a two-bend
// polyline in the style's accent / dash, its vertex marks (last one hollow).
function StylePreview({ t, w = 30, h = 18 }) {
  const vp = [[5, 20], [20, 7], [35, 17]];
  return (
    <svg width={w} height={h} viewBox="0 0 40 26" style={{ display: "block", flex: "0 0 auto" }} aria-hidden="true">
      <path d={`M${vp[0][0]} ${vp[0][1]} L${vp[1][0]} ${vp[1][1]} L${vp[2][0]} ${vp[2][1]}`} fill="none"
        stroke={t.accent} strokeWidth={Math.min(t.draft.width, 2.5)}
        strokeDasharray={t.draft.dash ? t.draft.dash.map((n) => n * 0.75).join(" ") : undefined}
        strokeLinecap="round" strokeLinejoin="round" />
      {t.vertex.shape !== "none" && vp.map(([x, y], i) => (
        <path key={i} d={markerPath(t.vertex.shape, x, y, 2.6)} fill={i === vp.length - 1 ? "#fff" : t.accent} stroke={t.accent} strokeWidth={1} />
      ))}
    </svg>
  );
}

export default function DrawStylePicker({ styles, ids, activeId, onPick }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Close on click-outside / Escape — same idiom as ToolMenu. The listeners
  // live only while open, and rootRef scopes them to THIS control so clicking
  // elsewhere in the ⋯ menu dismisses the list without touching the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const active = styles[activeId] || styles[ids[0]];

  return (
    <div ref={rootRef} style={{ padding: "8px 12px", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>Style</span>
        <button type="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}
          title="Drawing style — the look of the measuring draft (stroke, vertices, readout chip). Applies to the canvas live."
          style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", cursor: "pointer", border: `1px solid ${open ? "var(--cobalt)" : "var(--ink-faint)"}`, background: "var(--paper-cream)", color: "var(--ink)", fontSize: 12.5 }}>
          <StylePreview t={active} />
          <span style={{ flex: 1, textAlign: "left" }}>{active.label}</span>
          <span style={{ color: "var(--ink-muted)", fontSize: 11, transform: open ? "rotate(180deg)" : "none" }}>▾</span>
        </button>
      </div>
      {open && (
        <div aria-label="Drawing style"
          style={{ position: "absolute", left: 12, right: 12, top: "100%", marginTop: 2, zIndex: 70, background: "var(--paper-cream)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-2)", padding: "4px 0" }}>
          {ids.map((id) => {
            const t = styles[id];
            const on = id === activeId;
            return (
              <button key={id} type="button" aria-pressed={on} data-ds={id}
                onClick={() => { onPick(id); setOpen(false); }}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "7px 10px", border: "none", textAlign: "left", cursor: "pointer", background: on ? "var(--tint-select)" : "transparent", color: "var(--ink)", fontSize: 12.5, fontWeight: on ? 600 : 400 }}
                onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--paper-shadow)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = on ? "var(--tint-select)" : "transparent"; }}>
                <StylePreview t={t} />
                <span style={{ flex: 1 }}>{t.label}</span>
                <span style={{ display: "inline-flex", width: 14, justifyContent: "center", color: "var(--cobalt)", visibility: on ? "visible" : "hidden" }} aria-hidden="true">✓</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
