import { localizeText as uiText } from "../lib/i18n/core.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Z } from "../lib/ui.js";
import { DEFAULT_LAYOUT, WORKSPACE_LAYOUT_KEY, moveDock, normalizeLayout, readWorkspacePreferences } from "../lib/workspaceLayout.js";

export function useWorkspaceLayout() {
  const [prefs, setPrefs] = useState(() => {
    let raw = null;
    try { raw = localStorage.getItem(WORKSPACE_LAYOUT_KEY); } catch { /* session-only layout */ }
    const pref = readWorkspacePreferences(raw);
    if (["calm", "premium"].includes(new URLSearchParams(window.location.search).get("workspace"))) pref.enabled = true;
    return pref;
  });
  const [storageFailed, setStorageFailed] = useState(false);
  useEffect(() => { try { localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(prefs)); setStorageFailed(false); } catch { setStorageFailed(true); } }, [prefs]);
  const setEnabled = useCallback((enabled) => {
    setPrefs((p) => ({ ...p, enabled }));
    const url = new URL(window.location.href);
    url.searchParams.delete("workspace");
    window.history.replaceState(window.history.state, "", url);
  }, []);
  const update = useCallback((patch) => setPrefs((p) => ({ ...p, layout: normalizeLayout({ ...p.layout, ...patch }) })), []);
  const move = useCallback((dock, side) => setPrefs((p) => ({ ...p, layout: moveDock(p.layout, dock, side) })), []);
  const save = (name) => setPrefs((p) => {
    const clean = name.trim().slice(0, 40);
    if (!clean) return p;
    return { ...p, saved: [...p.saved.filter((s) => s.name !== clean), { name: clean, layout: { ...p.layout } }].slice(-8) };
  });
  const remove = (name) => setPrefs((p) => ({ ...p, saved: p.saved.filter((s) => s.name !== name) }));
  return { ...prefs, setEnabled, update, move, save, remove, storageFailed };
}

export function DockHandle({ dock, label, locked, onDrag, onMove }) {
  const startRef = useRef(null);
  const cancel = () => { startRef.current = null; onDrag(null); };
  if (locked) return null;
  return <button type="button" className="calm-dock-handle" aria-label={uiText(`Move ${label}`)} title={uiText(`Move ${label}: drag to either edge, or use Left/Right arrow keys. Layout also has position selectors.`)}
    onKeyDown={(e) => { if (["ArrowLeft", "ArrowRight", "Escape"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); if (e.key !== "Escape") onMove(dock, e.key === "ArrowLeft" ? "left" : "right"); cancel(); } }}
    onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); e.currentTarget.focus({ preventScroll: true }); startRef.current = { x: e.clientX, y: e.clientY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={(e) => { const start = startRef.current; if (!start) return; e.stopPropagation(); if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 6) { start.moved = true; onDrag(dock); } }}
    onPointerUp={(e) => {
      const start = startRef.current; if (!start) return; e.stopPropagation();
      const bounds = e.currentTarget.closest("[data-canvas-workspace]")?.getBoundingClientRect();
      if (start.moved && bounds && e.clientY >= bounds.top && e.clientY <= bounds.bottom) {
        const edge = Math.min(264, bounds.width * 0.3);
        if (e.clientX >= bounds.left && e.clientX <= bounds.left + edge) onMove(dock, "left");
        else if (e.clientX >= bounds.right - edge && e.clientX <= bounds.right) onMove(dock, "right");
      }
      cancel(); e.currentTarget.releasePointerCapture(e.pointerId);
    }} onPointerCancel={cancel} onLostPointerCapture={cancel}>⠿</button>;
}

export function DockTargets({ dragging }) {
  if (!dragging) return null;
  return <>{["left", "right"].map((side) => <div key={side} className={`calm-dock-target calm-dock-target-${side}`} style={{ zIndex: Z.modal }} aria-hidden="true">{uiText("Dock ")}{uiText(side)}</div>)}</>;
}

export function WorkspaceLayoutDialog({ open, onClose, prefs, onOpenChange }) {
  const ref = useRef(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    dialog.showModal(); onOpenChange(true);
    return () => { dialog.close(); onOpenChange(false); };
  }, [open, onOpenChange]);
  const { layout, update } = prefs;
  return <dialog ref={ref} className="calm-layout-dialog" onKeyDown={(e) => e.stopPropagation()} aria-labelledby="workspace-layout-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <header><div><h2 id="workspace-layout-title">{uiText("Your workspace")}</h2><p>{uiText("Saved on this browser. Your team keeps its own arrangement.")}</p></div><button type="button" onClick={onClose} aria-label={uiText("Close layout settings")}>×</button></header>
    <section className="workspace-appearance"><h3>{uiText("Appearance")}</h3><label>{uiText("Surface")}<select aria-label={uiText("Workspace surface")} value={layout.look} onChange={(e) => update({ look: e.target.value })}><option value="graphite">{uiText("Backlit graphite")}</option><option value="light">{uiText("Studio light")}</option><option value="hud">{uiText("Instrument HUD")}</option></select></label><label>{uiText("Active icon backlight")}<input aria-label={uiText("Active icon backlight")} type="range" min="0" max="100" value={layout.backlight} onChange={(e) => update({ backlight: Number(e.target.value) })} /><output>{uiText(layout.backlight)}%</output></label></section>
    <label className="calm-lock"><input type="checkbox" checked={layout.locked} onChange={(e) => update({ locked: e.target.checked })} />{uiText("Lock panel positions and sizes")}</label>
    <p className="calm-layout-help">{uiText("Unlock to drag a panel’s grip to either edge, or choose its position below. Opening and closing panels always stays available.")}</p>
    <fieldset disabled={layout.locked}><legend>{uiText("Panel arrangement")}</legend>
      {[["tools", "Measuring tools"], ["sheets", "Sheets"], ["work", "Work and review"], ["takeoffs", "Takeoffs"]].map(([id, label]) => <label key={id}>{uiText(label)}<select aria-label={uiText(`${label} position`)} value={layout[id]} onChange={(e) => prefs.move(id, e.target.value)}><option value="left">{uiText("Left sidebar")}</option><option value="right">{uiText("Right sidebar")}</option></select></label>)}
      <label>{uiText("Work panel width ")}<input aria-label={uiText("Work panel width")} type="range" min="300" max="480" step="20" value={layout.workWidth} onChange={(e) => update({ workWidth: Number(e.target.value) })} /><output>{uiText(layout.workWidth)}{uiText("px")}</output></label>
      <label>{uiText("Sheets panel width ")}<input aria-label={uiText("Sheets panel width")} type="range" min="220" max="340" step="20" value={layout.sheetWidth} onChange={(e) => update({ sheetWidth: Number(e.target.value) })} /><output>{uiText(layout.sheetWidth)}{uiText("px")}</output></label>
    </fieldset>
    <div className="calm-layout-options"><label><input type="checkbox" checked={layout.readout} onChange={(e) => update({ readout: e.target.checked })} />{uiText("Show floating quantity box")}</label><label><input type="checkbox" checked={layout.palette} onChange={(e) => update({ palette: e.target.checked })} />{uiText("Show pinned condition palette")}</label><label><input type="checkbox" checked={layout.counter} onChange={(e) => update({ counter: e.target.checked })} />{uiText("Show project quantity counter")}</label></div>
    <section><h3>{uiText("Saved arrangements")}</h3><form onSubmit={(e) => { e.preventDefault(); prefs.save(name); setMessage(`Saved “${name.trim()}”.`); setName(""); }}><input aria-label={uiText("Arrangement name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={uiText("e.g. My estimating desk")} /><button disabled={!name.trim()}>{uiText("Save current")}</button></form>
      <p className="calm-layout-help">{uiText("Up to 8 arrangements. Saving the same name replaces it. Loading an arrangement also restores its lock setting.")}</p>
      {prefs.saved.map((s) => <div key={s.name} className="calm-saved-layout"><button type="button" onClick={() => { update(s.layout); setMessage(`Loaded “${s.name}”.`); }}>{s.name}</button><button type="button" aria-label={uiText(`Delete arrangement ${s.name}`)} onClick={() => { prefs.remove(s.name); setMessage(`Removed “${s.name}” from saved arrangements.`); }}>×</button></div>)}
      <p role="status">{uiText(prefs.storageFailed ? "Browser storage is unavailable. This layout will last for this session only." : message)}</p>
    </section>
    <footer><button type="button" onClick={() => { update(DEFAULT_LAYOUT); setMessage("Default arrangement restored. Saved arrangements kept."); }}>{uiText("Reset arrangement")}</button><button type="button" onClick={onClose}>{uiText("Done")}</button></footer>
  </dialog>;
}
