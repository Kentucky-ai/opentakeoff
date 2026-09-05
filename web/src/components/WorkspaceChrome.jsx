import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { keyText } from "../lib/keys.ts";
import "./workspaceChrome.css";

// Optional workspace chrome. All actions are supplied by the existing canvas;
// this component owns only navigation, search and disclosure state.
export function WorkspaceChrome({ title, onOpen, onNavigate, navigationOpen, onTakeoffs, takeoffsOpen,
  onWork, workOpen, workButtonRef, pending, running, onReport, onFocus, onClassic,
  onControls, controlsOpen, onSearch, layoutMenu, fileMenu, scaleMenu, conditionControl, aids, history, action }) {
  return <>
    <header className="calm-header">
      <strong className="calm-brand">open<span>takeoff</span></strong>
      <div className="calm-project" title={title}><span>{title || "Untitled workspace"}</span><small>Workspace preview</small></div>
      <div className="calm-header-actions">
        <button type="button" onClick={onOpen} title="Open plans"><Icon name="plus" size={16} /><span>Open</span></button>
        {fileMenu}
        <button type="button" aria-pressed={navigationOpen} onClick={onNavigate}><Icon name="sheets" size={16} />Sheets</button>
        <button type="button" onClick={onSearch} className="calm-search-trigger" title="Find a tool or action"><Icon name="search" size={16} /><span>Find an action</span><kbd>{keyText("⌘K")}</kbd></button>
        <button type="button" aria-pressed={takeoffsOpen} onClick={onTakeoffs}>Takeoffs</button>
        <button type="button" ref={workButtonRef} aria-expanded={workOpen} onClick={onWork} className="calm-work">Work{running ? <span className="calm-badge">Running</span> : pending > 0 ? <span className="calm-badge">{pending}</span> : null}</button>
        <button type="button" onClick={onReport} className="calm-report"><Icon name="document" size={16} />Report</button>
        {layoutMenu}<button type="button" onClick={onClassic} className="calm-classic" title="Return to the current layout without reloading the plan">Classic layout</button>
      </div>
    </header>
    <div className="calm-context" aria-label="Current drawing settings">
      <div className="calm-context-scroll">{conditionControl}<span className="calm-separator" />{history}<span className="calm-separator" />{aids}</div>
      <div className="calm-context-pinned">{action}{scaleMenu}
        <button type="button" onClick={onFocus} title="Focus — hide chrome, keep measuring tools (F)"><Icon name="focus" size={16} /><span className="calm-focus-label">Focus</span></button>
        <button type="button" onClick={onControls} aria-expanded={controlsOpen} title="All existing toolbar controls and settings">{controlsOpen ? "Close controls" : "All controls"}</button>
      </div>
    </div>
  </>;
}

export function WorkspaceNavigator({ open, items, current, onSelect, onClose, onGallery, dockSide, width, dockHandle }) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => items.filter((s) => `${s.label} ${s.file}`.toLowerCase().includes(query.trim().toLowerCase())), [items, query]);
  return <aside className="calm-navigator" data-dock-side={dockSide} style={{ width, order: dockSide === "right" ? 20 : -20 }} hidden={!open} aria-label="Sheet navigator" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
    <header>{dockHandle}<strong>Sheets <small>{items.length}</small></strong><button type="button" aria-label="Close sheet navigator" onClick={onClose}>×</button></header>
    <label><Icon name="search" size={15} /><input name="workspace-sheet-search" aria-label="Find a sheet" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a sheet…" /></label>
    <div className="calm-sheet-list">{matches.map((s) => <button type="button" key={s.key} aria-current={s.key === current ? "page" : undefined} onClick={() => onSelect(s.key)} title={`${s.label} · ${s.file}`}>
      <Icon name="document" size={19} /><span><strong>{s.label}</strong><small>{s.file}</small></span>{s.count > 0 && <em>{s.count}</em>}
    </button>)}{!matches.length && <p>{items.length ? "No sheets match your search." : "Open a plan to see its sheets here."}</p>}</div>
    <footer><button type="button" onClick={onGallery}><Icon name="sheets" size={16} />Open visual gallery</button></footer>
  </aside>;
}

export function WorkspaceCommandMenu({ open, onClose, actions, onOpenChange }) {
  const dialogRef = useRef(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const rows = actions.filter((a) => `${a.label} ${a.group || ""} ${a.shortcut || ""}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 50);
  useEffect(() => {
    if (!open) return;
    setQuery(""); setIndex(0);
    const dialog = dialogRef.current;
    dialog?.showModal();
    onOpenChange(true);
    return () => { dialog?.close(); onOpenChange(false); };
  }, [open, onOpenChange]);
  useEffect(() => { dialogRef.current?.querySelector(".is-highlighted")?.scrollIntoView({ block: "nearest" }); }, [index]);
  const run = (row) => { if (row && !row.disabled) { onClose(); row.run(); } };
  return <dialog ref={dialogRef} className="calm-command-menu" onKeyDown={(e) => e.stopPropagation()} aria-label="Find an action" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <header><Icon name="search" size={18} /><input name="workspace-action-search" role="combobox" aria-autocomplete="list" aria-expanded={true} aria-controls="workspace-action-results" aria-activedescendant={rows[index] ? `workspace-action-${rows[index].id}` : undefined} aria-label="Search actions" autoFocus value={query} placeholder="Find a tool, sheet, or action…" onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
      onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); } else if (e.key === "Enter") { e.preventDefault(); run(rows[index]); } }} /><button type="button" aria-label="Close action search" onClick={onClose}>Esc</button></header>
    <div className="calm-command-results" id="workspace-action-results" role="listbox" aria-label="Actions">{rows.map((row, i) => <button type="button" role="option" tabIndex={-1} aria-selected={i === index} id={`workspace-action-${row.id}`} key={row.id} className={i === index ? "is-highlighted" : ""} disabled={row.disabled} onMouseEnter={() => setIndex(i)} onClick={() => run(row)}><span>{row.label}<small>{row.group}</small></span>{row.shortcut && <kbd>{keyText(row.shortcut)}</kbd>}</button>)}{!rows.length && <p>No matching action. Try “scale”, “import”, or a tool name.</p>}</div>
    <footer>↑ ↓ to choose · Enter to run · Esc to close</footer>
  </dialog>;
}
