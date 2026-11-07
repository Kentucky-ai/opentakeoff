// Premium canvas chrome, rebuilt for the open-source canvas:
//   · PremiumRail     — the narrow icon rail on the far left (brand, find, sheets, open, help)
//   · PremiumTopBar   — one quiet bar: project, centred sheet switcher, scale, $ total, ⋯, notices
//   · CanvasSideTabs  — the floating Conditions / Assistant tabs at the canvas's right edge
// Every action is supplied by the canvas; these components own no takeoff state.

import React from "react";
import { Icon } from "../brand/icons.jsx";
import { OtMark, ScanStar } from "../brand/marks.jsx";
import { keyText } from "../lib/keys.ts";
import ToolMenu from "./ToolMenu.jsx";
import "./premiumChrome.css";

export function PremiumRail({ onSearch, onSheets, sheetsOpen, onOpenPlans, helpItems, onMenuDepth, onCollapse, onLayout, running }) {
  return (
    <nav className="pc-rail" aria-label="Workspace">
      <span className="pc-rail-brand" title="OpenTakeoff">{running ? <ScanStar size={22} working reach={1.4} style={{ color: "var(--cobalt)" }} title="The agent is working" /> : <OtMark size={24} />}</span>
      <span className="pc-rail-sep" />
      <button type="button" className="pc-rail-btn" onClick={onSearch} title={`Find a tool, sheet, or action (${keyText("⌘K")})`} aria-label="Find an action"><Icon name="search" size={19} /></button>
      <button type="button" className="pc-rail-btn" aria-pressed={!!sheetsOpen} onClick={onSheets} title="Sheets" aria-label="Sheets"><Icon name="sheets" size={19} /></button>
      <button type="button" className="pc-rail-btn" onClick={onOpenPlans} title="Open plans: PDF, image, or a .zip plan set" aria-label="Open plans"><Icon name="folder" size={19} /></button>
      <span className="pc-rail-sep" />
      <span className="pc-rail-menu"><ToolMenu title="Learn OpenTakeoff, or connect an AI agent" flyout="right" onOpenChange={onMenuDepth} items={helpItems}
        face={<Icon name="help" size={19} />} faceStyle={{ border: 0, background: "transparent", padding: 0, width: 38, height: 38, justifyContent: "center", color: "var(--ink-muted)" }} /></span>
      <span className="pc-rail-grow" />
      <button type="button" className="pc-rail-btn" onClick={onCollapse} title="Focus: hide the chrome, keep measuring (F)" aria-label="Focus mode"><Icon name="chevronLeft" size={18} /></button>
      <button type="button" className="pc-rail-btn" onClick={onLayout} title="Arrange panels, lock positions, and save layouts" aria-label="Layout"><Icon name="sidebar" size={18} /></button>
    </nav>
  );
}

// "A101 FLOOR PLAN" → number + title; a label with no sheet number stays whole.
function splitSheetLabel(label = "") {
  const m = /^\s*([A-Z]{1,3}-?\d{1,4}(?:\.\d{1,3})?[A-Z]?)\b[\s·:–-]*(.*)$/i.exec(label);
  return m ? { num: m[1], title: m[2] } : { num: "", title: label };
}

export function PremiumTopBar({ title, subtitle, onBack, onGallery, sheets, current, onSheet, onMenuDepth, scaleMenu, action,
  onList, total, onEstimate, moreItems, onBell, pending }) {
  const i = sheets.findIndex((s) => s.key === current);
  const cur = sheets[i] || null;
  const { num, title: sheetTitle } = splitSheetLabel(cur?.label || "");
  const go = (d) => { const n = sheets[i + d]; if (n) onSheet(n.key); };
  const money = Number.isFinite(total) ? total.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "$0.00";
  return (
    <header className="pc-top">
      <div className="pc-top-left">
        <button type="button" className="pc-icon" onClick={onBack} title="Plan set" aria-label="Back to the plan set"><Icon name="chevronLeft" size={17} /></button>
        <div className="pc-project" title={title}>
          <strong>{title || "Untitled workspace"}</strong>
          <small>{subtitle}</small>
        </div>
        <span className="pc-vsep" />
        <button type="button" className="pc-icon" onClick={onGallery} title="Visual gallery of every sheet (G)" aria-label="Sheet gallery"><Icon name="sheets" size={17} /></button>
      </div>

      <div className="pc-top-center">
        <button type="button" className="pc-icon" onClick={() => go(-1)} disabled={i <= 0} title="Previous sheet" aria-label="Previous sheet"><Icon name="chevronLeft" size={16} /></button>
        <span className="pc-sheet">
          <ToolMenu title="Switch sheet" onOpenChange={onMenuDepth} menuStyle={{ minWidth: 320, borderRadius: 10, border: "1px solid var(--ink-faint)" }}
            faceStyle={{ width: "100%", justifyContent: "space-between", border: 0, background: "transparent", padding: "0 12px", height: 36, fontSize: 15 }}
            face={<span className="pc-sheet-face">{num && <b>{num}</b>}<span>{sheetTitle || (cur ? "" : "No sheet open")}</span></span>}
            items={sheets.length ? sheets.map((s) => ({ id: s.key, label: s.label + (s.count ? `  ·  ${s.count}` : ""), active: s.key === current, onSelect: () => onSheet(s.key) })) : [{ note: "Open plans to add sheets." }]} />
        </span>
        <button type="button" className="pc-icon" onClick={() => go(1)} disabled={i < 0 || i >= sheets.length - 1} title="Next sheet" aria-label="Next sheet"><Icon name="chevronRight" size={16} /></button>
        <span className="pc-scale">{scaleMenu}</span>
        {action}
      </div>

      <div className="pc-top-right">
        <span className="pc-pill">
          <button type="button" onClick={onList} title="Quantities report" aria-label="Quantities report" data-tour="report"><Icon name="list" size={17} /></button>
          <button type="button" onClick={onEstimate} title="Estimate: price the takeoff" className="pc-money">{money}</button>
        </span>
        <span className="pc-more"><ToolMenu title="Everything else" onOpenChange={onMenuDepth} items={moreItems} menuStyle={{ minWidth: 260, borderRadius: 10, border: "1px solid var(--ink-faint)" }}
          face={<Icon name="more" size={17} />} faceStyle={{ border: "1px solid var(--ink-faint)", borderRadius: 8, background: "transparent", height: 36, padding: "0 12px", gap: 10 }} /></span>
        <button type="button" className="pc-icon pc-bell" onClick={onBell} title={pending ? `${pending} AI proposal${pending === 1 ? "" : "s"} to review` : "Work and review"} aria-label="Work and review">
          <Icon name="bell" size={18} />{pending > 0 && <span className="pc-dot">{pending > 99 ? "99+" : pending}</span>}
        </button>
      </div>
    </header>
  );
}

export function CanvasSideTabs({ conditionsOpen, conditionCount, onConditions, assistantOpen, onAssistant, working }) {
  return (
    <div className="pc-sidetabs" role="tablist" aria-label="Side panels">
      <button type="button" role="tab" aria-selected={!!conditionsOpen} onClick={onConditions} title="Conditions">
        <span className="pc-sidetab-ico"><Icon name="list" size={20} />{conditionCount > 0 && <span className="pc-badge">{conditionCount}</span>}</span>
        <span>Conditions</span>
      </button>
      <button type="button" role="tab" aria-selected={!!assistantOpen} onClick={onAssistant} title="Assistant: talk to your own AI here">
        <span className="pc-sidetab-ico"><ScanStar size={20} working={working} /></span>
        <span>Assistant</span>
      </button>
    </div>
  );
}
