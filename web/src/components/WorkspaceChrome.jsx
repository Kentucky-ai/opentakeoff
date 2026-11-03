import { localizeText as uiText } from "../lib/i18n/core.js";
import { useTranslation } from "../lib/i18n/index.jsx";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { ScanStar } from "../brand/marks.jsx";
import { keyText } from "../lib/keys.ts";
import { SheetTree } from "./SheetTree.jsx";
import "./workspaceChrome.css";

// Workspace chrome. All actions are supplied by the existing canvas;
// this component owns only navigation, search and disclosure state.
export function WorkspaceChrome({ title, onOpen, onNavigate, navigationOpen, onTakeoffs, takeoffsOpen,
  onPremium, onWork, workOpen, workButtonRef, pending, running, onReport, onEstimate, onFocus, onClassic,
  languageControl, onControls, controlsOpen, onSearch, pinControl, panelTools, layoutMenu, helpMenu, fileMenu, scaleMenu, conditionControl, aids, history, action }) {
  const { t: tr } = useTranslation();
  return <>
    <header className="calm-header">
      <strong className="calm-brand"><ScanStar size={15} reach={1.6} working={running} />open<span>takeoff</span></strong>
      <div className="calm-project" title={title}><span>{title || tr("Untitled workspace")}</span><small>{tr("Premium workspace")}</small></div>
      <div className="calm-header-actions">

        <button type="button" onClick={onOpen} title={tr("Open plans")}><Icon name="plus" size={16} /><span>{tr("Open")}</span></button>
        {uiText(fileMenu)}
        <button type="button" aria-pressed={navigationOpen} onClick={onNavigate}><Icon name="sheets" size={16} />{tr("Sheets")}</button>
        {uiText(pinControl)}
        <button type="button" onClick={onSearch} className="calm-search-trigger" title={tr("Find a tool or action")}><Icon name="search" size={16} /><span>{tr("Find an action")}</span><kbd>{keyText(uiText("⌘K"))}</kbd></button>
        <button type="button" aria-pressed={takeoffsOpen} onClick={onTakeoffs} title={tr("Measured quantities, conditions, and supporting materials")}><Icon name="product" size={16} />{tr("Quantities")}</button>
        <button type="button" ref={workButtonRef} aria-expanded={workOpen} onClick={onWork} className="calm-work"><ScanStar size={13} working={running} />{tr("Work")}{running ? <span className="calm-badge">{tr("Running")}</span> : pending > 0 ? <span className="calm-badge">{uiText(pending)}</span> : null}</button>
        {uiText(panelTools)}
        {onEstimate && <button type="button" onClick={onEstimate} title={tr("Price the takeoff: material and labor per unit, markups, Excel")}>{tr("Estimate")}</button>}
        <button type="button" onClick={onReport} className="calm-report" data-tour="report"><Icon name="document" size={16} />{tr("Report")}</button>
        {uiText(layoutMenu)}{uiText(helpMenu)}{uiText(languageControl)}<button type="button" className="calm-premium" data-premium-trigger onClick={onPremium}>{tr("Premium plans")}</button><button type="button" onClick={onClassic} className="calm-classic" title={tr("Return to the current layout without reloading the plan")}>{tr("Classic layout")}</button>
      </div>
    </header>
    <div className="calm-context" aria-label={tr("Current drawing settings")}>
      <div className="calm-context-scroll">{uiText(conditionControl)}<span className="calm-separator" />{uiText(history)}<span className="calm-separator" />{uiText(aids)}</div>
      <div className="calm-context-pinned">{uiText(action)}{uiText(scaleMenu)}
        <button type="button" onClick={onFocus} title={tr("Focus — hide chrome, keep measuring tools (F)")}><Icon name="focus" size={16} /><span className="calm-focus-label">{tr("Focus")}</span></button>
        <button type="button" onClick={onControls} aria-expanded={controlsOpen} title={tr("All existing toolbar controls and settings")}>{uiText(controlsOpen ? tr("Close controls") : tr("All controls"))}</button>
      </div>
    </div>
  </>;
}

export function WorkspaceNavigator({ open, items, current, onSelect, onClose, onGallery, dockSide, width, dockHandle, namer = null, countKnown = () => true, hold }) {
  const { t: tr } = useTranslation();
  const [query, setQuery] = useState("");
  return <aside className="calm-navigator" data-dock-side={dockSide} style={{ width, order: dockSide === "right" ? 20 : -20 }} hidden={!open} aria-label={tr("Sheet navigator")} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
    <header>{uiText(dockHandle)}<strong>{tr("Sheets")} <small>{uiText(items.length)}</small></strong><button type="button" aria-label={tr("Close sheet navigator")} onClick={onClose}>×</button></header>
    <label><Icon name="search" size={15} /><input name="workspace-sheet-search" aria-label={tr("Find a sheet")} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr("Find a sheet…")} /></label>
    <SheetTree items={items} current={current} onSelect={onSelect} namer={namer} countKnown={countKnown} query={query} hold={hold} onSearchAll={onGallery} />
    <footer><button type="button" onClick={onGallery}><Icon name="sheets" size={16} />{tr("Open visual gallery")}</button></footer>
  </aside>;
}

export function WorkspaceCommandMenu({ open, onClose, actions, onOpenChange }) {
  const { t: tr } = useTranslation();
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
  return <dialog ref={dialogRef} className="calm-command-menu" onKeyDown={(e) => e.stopPropagation()} aria-label={tr("Find an action")} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <header><Icon name="search" size={18} /><input name="workspace-action-search" role="combobox" aria-autocomplete="list" aria-expanded={true} aria-controls="workspace-action-results" aria-activedescendant={rows[index] ? `workspace-action-${rows[index].id}` : undefined} aria-label={tr("Search actions")} autoFocus value={query} placeholder={tr("Find a tool, sheet, or action…")} onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
      onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); } else if (e.key === "Enter") { e.preventDefault(); run(rows[index]); } }} /><button type="button" aria-label={tr("Close action search")} onClick={onClose}>{uiText("Esc")}</button></header>
    <div className="calm-command-results" id="workspace-action-results" role="listbox" aria-label={tr("Actions")}>{rows.map((row, i) => <button type="button" role="option" tabIndex={-1} aria-selected={i === index} id={`workspace-action-${row.id}`} key={row.id} className={i === index ? "is-highlighted" : ""} disabled={row.disabled} onMouseEnter={() => setIndex(i)} onClick={() => run(row)}><span>{uiText(row.label)}<small>{uiText(row.group)}</small></span>{row.shortcut && <kbd>{keyText(uiText(row.shortcut))}</kbd>}</button>)}{!rows.length && <p>{tr("No matching action. Try “scale”, “import”, or a tool name.")}</p>}</div>
    <footer>{tr("↑ ↓ to choose · Enter to run · Esc to close")}</footer>
  </dialog>;
}
