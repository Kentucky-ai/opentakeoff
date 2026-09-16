import React, { useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { Z } from "../lib/ui.js";
import "./ReferencePins.css";

export function PinButton({ armed, disabled, onCapture, count, onShow }) {
  return <span className="reference-pin-buttons">
    <button type="button" aria-label="Pin" aria-pressed={armed} disabled={disabled} onClick={onCapture}
      title="Pin any part of this sheet — click two corners to keep a reference beside your takeoff">
      <Icon name="pin" size={16} />Pin
    </button>
    {count > 0 && <button type="button" aria-label={`Show pins (${count})`} title="Show saved pins" onClick={onShow}>{count}<Icon name="chevronDown" size={12} /></button>}
  </span>;
}

// Pins share the project's existing image-capture persistence and source trace.
// Window state is local: moving/zooming a reference never changes plan geometry.
export default function ReferencePins({ pins, selectedId, onSelect, onClose, onSource, onRename }) {
  const frame = useRef(null), drag = useRef(null);
  const [position, setPosition] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [collapsed, setCollapsed] = useState(false);
  const pin = pins.find(p => p.id === selectedId) || pins.at(-1);
  if (!pin) return null;
  const move = (x, y) => {
    const rect = frame.current?.getBoundingClientRect();
    setPosition({ x: Math.max(0, Math.min(window.innerWidth - (rect?.width || 320), x)), y: Math.max(0, Math.min(window.innerHeight - (rect?.height || 80), y)) });
  };
  const startDrag = e => {
    if (e.button !== 0) return;
    const rect = frame.current.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  return <section ref={frame} className={`reference-pin-window${collapsed ? " is-collapsed" : ""}`} aria-label="Pinned reference"
    style={{ zIndex: Z.drawer, ...(position ? { left: position.x, top: position.y, right: "auto" } : {}) }}
    onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
    onWheel={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <header>
      <button className="reference-pin-grip" type="button" aria-label="Move pinned reference" title="Drag to move; arrow keys also move the window"
        onPointerDown={startDrag} onPointerMove={e => { const d = drag.current; if (d) move(d.left + e.clientX - d.x, d.top + e.clientY - d.y); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onKeyDown={e => { const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[e.key]; if (delta) { e.preventDefault(); const r = frame.current.getBoundingClientRect(); move(r.left + delta[0], r.top + delta[1]); } }}>
        <Icon name="pin" size={15} /><span>Pin</span>
      </button>
      <select aria-label="Pinned reference" value={pin.id} onChange={e => { onSelect(e.target.value); setZoom(1); }}>
        {pins.map(p => <option key={p.id} value={p.id}>{p.text || p.src_label || "Reference"}</option>)}
      </select>
      <button type="button" aria-label={collapsed ? "Expand pin" : "Collapse pin"} onClick={() => setCollapsed(v => !v)}>{collapsed ? "+" : "−"}</button>
      <button type="button" aria-label="Close pin" title="Close window — the pin stays saved" onClick={onClose}>×</button>
    </header>
    {!collapsed && <>
      <div className="reference-pin-controls">
        <input key={pin.id} aria-label="Pin name" defaultValue={pin.text || ""} placeholder="Name this reference"
          onBlur={e => { if (e.target.value.trim() !== pin.text) onRename(pin.id, e.target.value.trim()); }}
          onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        <button type="button" disabled={zoom <= 1} aria-label="Zoom pin out" onClick={() => setZoom(v => Math.max(1, v - .25))}>−</button>
        <button type="button" aria-label="Fit pin" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button type="button" disabled={zoom >= 4} aria-label="Zoom pin in" onClick={() => setZoom(v => Math.min(4, v + .25))}>+</button>
      </div>
      <div className="reference-pin-image">
        {/^data:image\/(png|jpeg);base64,/i.test(pin.src || "")
          ? <img draggable="false" src={pin.src} alt={pin.text || "Pinned region of drawing"} style={{ width: `${zoom * 100}%` }} />
          : <p>This reference image is unavailable.</p>}
      </div>
      <footer><button type="button" disabled={!pin.src_sheet_id || !pin.src_rect} onClick={() => onSource(pin)} title="Open the source sheet and highlight the captured region">Source: {pin.src_label || pin.src_sheet_id || "Image"}</button><span>Resize ↘</span></footer>
    </>}
  </section>;
}
