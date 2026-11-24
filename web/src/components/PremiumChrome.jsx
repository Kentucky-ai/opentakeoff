// Premium canvas chrome, rebuilt for the open-source canvas:
//   · PremiumRail     — the narrow icon rail on the far left (brand, find, sheets, open, help)
//   · PremiumTopBar   — one quiet bar: project, centred sheet switcher, scale, $ total, ⋯, notices
//   · CanvasSideTabs  — the floating Conditions / Assistant tabs at the canvas's right edge
// Every action is supplied by the canvas; these components own no takeoff state.

import React, { useState, useRef, useEffect, useCallback } from "react";
import { localizeText as uiText, formatEstimateMoney } from "../lib/i18n/core.js";
import { useTranslation } from "../lib/i18n/index.jsx";
import { Icon } from "../brand/icons.jsx";
import { OtMark, ScanStar } from "../brand/marks.jsx";
import { keyText } from "../lib/keys.ts";
import ToolMenu from "./ToolMenu.jsx";
import "./premiumChrome.css";

export function PremiumRail({ onSearch, onSheets, sheetsOpen, onOpenPlans, helpItems, onMenuDepth, onCollapse, onLayout, running }) {
  useTranslation(); // re-render on a language switch
  return (
    <nav className="pc-rail" aria-label={uiText("Workspace")}>
      <span className="pc-rail-brand" title={uiText("OpenTakeoff")}>{running ? <ScanStar size={22} working reach={1.4} style={{ color: "var(--cobalt)" }} title={uiText("The agent is working")} /> : <OtMark size={24} />}</span>
      <span className="pc-rail-sep" />
      <button type="button" className="pc-rail-btn" onClick={onSearch} title={uiText(`Find a tool, sheet, or action (${keyText("⌘K")})`)} aria-label={uiText("Find an action")}><Icon name="search" size={19} /></button>
      <button type="button" className="pc-rail-btn" aria-pressed={!!sheetsOpen} onClick={onSheets} title={uiText("Sheets")} aria-label={uiText("Sheets")}><Icon name="sheets" size={19} /></button>
      <button type="button" className="pc-rail-btn" onClick={onOpenPlans} title={uiText("Open plans: PDF, image, or a .zip plan set")} aria-label={uiText("Open plans")}><Icon name="folder" size={19} /></button>
      <span className="pc-rail-sep" />
      <span className="pc-rail-menu"><ToolMenu title={uiText("Learn OpenTakeoff, or connect an AI agent")} flyout="right" onOpenChange={onMenuDepth} items={helpItems}
        face={<Icon name="help" size={19} />} faceStyle={{ border: 0, background: "transparent", padding: 0, width: 38, height: 38, justifyContent: "center", color: "var(--ink-muted)" }} /></span>
      <span className="pc-rail-grow" />
      <button type="button" className="pc-rail-btn" onClick={onCollapse} title={uiText("Focus: hide the chrome, keep measuring (F)")} aria-label={uiText("Focus mode")}><Icon name="chevronLeft" size={18} /></button>
      <button type="button" className="pc-rail-btn" onClick={onLayout} title={uiText("Arrange panels, lock positions, and save layouts")} aria-label={uiText("Layout")}><Icon name="sidebar" size={18} /></button>
    </nav>
  );
}

// "A101 FLOOR PLAN" → number + title; a label with no sheet number stays whole.
function splitSheetLabel(label = "") {
  const m = /^\s*([A-Z]{1,3}-?\d{1,4}(?:\.\d{1,3})?[A-Z]?)\b[\s·:–-]*(.*)$/i.exec(label);
  return m ? { num: m[1], title: m[2] } : { num: "", title: label };
}

export function PremiumTopBar({ title, subtitle, onBack, onGallery, sheets, current, onSheet, onMenuDepth, scaleMenu, action,
  onList, total, onEstimate, moreItems, onBell, pending, languageControl = null }) {
  const { language } = useTranslation(); // re-render on a language switch
  const getLang = () => language;
  const i = sheets.findIndex((s) => s.key === current);
  const cur = sheets[i] || null;
  const { num, title: sheetTitle } = splitSheetLabel(cur?.label || "");
  const go = (d) => { const n = sheets[i + d]; if (n) onSheet(n.key); };
  const money = getLang() === "ru" ? formatEstimateMoney(Number.isFinite(total) ? total : 0) : Number.isFinite(total) ? total.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "$0.00";
  return (
    <header className="pc-top">
      <div className="pc-top-left">
        <button type="button" className="pc-icon" onClick={onBack} title={uiText("Plan set")} aria-label={uiText("Back to the plan set")}><Icon name="chevronLeft" size={17} /></button>
        <div className="pc-project" title={title}>
          <strong>{title || uiText("Untitled workspace")}</strong>
          <small>{uiText(subtitle)}</small>
        </div>
        <span className="pc-vsep" />
        <button type="button" className="pc-icon" onClick={onGallery} title={uiText("Visual gallery of every sheet (G)")} aria-label={uiText("Sheet gallery")}><Icon name="sheets" size={17} /></button>
      </div>

      <div className="pc-top-center">
        <button type="button" className="pc-icon" onClick={() => go(-1)} disabled={i <= 0} title={uiText("Previous sheet")} aria-label={uiText("Previous sheet")}><Icon name="chevronLeft" size={16} /></button>
        <span className="pc-sheet">
          <ToolMenu title={uiText("Switch sheet")} onOpenChange={onMenuDepth} menuStyle={{ minWidth: 320, borderRadius: 10, border: "1px solid var(--ink-faint)" }}
            faceStyle={{ width: "100%", justifyContent: "space-between", border: 0, background: "transparent", padding: "0 12px", height: 36, fontSize: 15 }}
            face={<span className="pc-sheet-face">{num && <b>{num}</b>}<span>{sheetTitle || (cur ? "" : uiText("No sheet open"))}</span></span>}
            items={sheets.length ? sheets.map((s) => ({ id: s.key, label: s.label + (s.count ? `  ·  ${s.count}` : ""), active: s.key === current, onSelect: () => onSheet(s.key) })) : [{ note: "Open plans to add sheets." }]} />
        </span>
        <button type="button" className="pc-icon" onClick={() => go(1)} disabled={i < 0 || i >= sheets.length - 1} title={uiText("Next sheet")} aria-label={uiText("Next sheet")}><Icon name="chevronRight" size={16} /></button>
        <span className="pc-scale">{scaleMenu}</span>
        {action}
      </div>

      <div className="pc-top-right">
        <span className="pc-pill">
          <button type="button" onClick={onList} title={uiText("Quantities report")} aria-label={uiText("Quantities report")} data-tour="report"><Icon name="list" size={17} /></button>
          <button type="button" onClick={onEstimate} title={uiText("Estimate: price the takeoff")} className="pc-money">{money}</button>
        </span>
        {languageControl}
        <span className="pc-more"><ToolMenu title={uiText("Everything else")} onOpenChange={onMenuDepth} items={moreItems} menuStyle={{ minWidth: 260, borderRadius: 10, border: "1px solid var(--ink-faint)" }}
          face={<Icon name="more" size={17} />} faceStyle={{ border: "1px solid var(--ink-faint)", borderRadius: 8, background: "transparent", height: 36, padding: "0 12px", gap: 10 }} /></span>
        <button type="button" className="pc-icon pc-bell" onClick={onBell} title={uiText(pending ? `${pending} AI proposal${pending === 1 ? "" : "s"} to review` : "Work and review")} aria-label={uiText("Work and review")}>
          <Icon name="bell" size={18} />{pending > 0 && <span className="pc-dot">{pending > 99 ? "99+" : pending}</span>}
        </button>
      </div>
    </header>
  );
}

export function CanvasSideTabs({ conditionsOpen, conditionCount, onConditions, assistantOpen, onAssistant, working }) {
  useTranslation(); // re-render on a language switch
  const frameRef = useRef(null);
  const pointerStartRef = useRef(null);
  const didDragRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [topPos, setTopPos] = useState(() => {
    try {
      const saved = localStorage.getItem("opentakeoff:sidetabs-top");
      if (saved != null) {
        const n = parseFloat(saved);
        if (Number.isFinite(n)) {
          const minTop = 48;
          const maxTop = Math.max(minTop, (typeof window !== "undefined" ? window.innerHeight : 800) - 132 - 16);
          return Math.max(minTop, Math.min(maxTop, n));
        }
      }
    } catch { /* ignore */ }
    return null;
  });

  const clampTop = useCallback((rawTop) => {
    const height = frameRef.current?.offsetHeight || 132;
    const minTop = 48;
    const maxTop = Math.max(minTop, (typeof window !== "undefined" ? window.innerHeight : 800) - height - 16);
    return Math.max(minTop, Math.min(maxTop, rawTop));
  }, []);

  useEffect(() => {
    setTopPos((prev) => (prev == null ? null : clampTop(prev)));
    const onResize = () => {
      setTopPos((prev) => (prev == null ? null : clampTop(prev)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampTop]);

  const handlePointerDown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    pointerStartRef.current = {
      startY: e.clientY,
      startTop: rect.top,
      pointerId: e.pointerId,
    };
    didDragRef.current = false;
  };

  const handlePointerMove = (e) => {
    const p = pointerStartRef.current;
    if (!p) return;
    const deltaY = e.clientY - p.startY;
    if (!didDragRef.current) {
      if (Math.abs(deltaY) > 4) {
        didDragRef.current = true;
        setIsDragging(true);
        try { frameRef.current?.setPointerCapture(p.pointerId); } catch { /* gone */ }
      } else {
        return;
      }
    }
    const nextTop = clampTop(p.startTop + deltaY);
    setTopPos(nextTop);
  };

  const handlePointerUp = (_e) => {
    const p = pointerStartRef.current;
    if (p) {
      try { frameRef.current?.releasePointerCapture(p.pointerId); } catch { /* gone */ }
      pointerStartRef.current = null;
    }
    if (didDragRef.current) {
      setIsDragging(false);
      if (topPos != null) {
        try { localStorage.setItem("opentakeoff:sidetabs-top", String(topPos)); } catch { /* quota/private */ }
      }
    }
  };

  const handleClickCapture = (e) => {
    if (didDragRef.current) {
      e.preventDefault();
      e.stopPropagation();
      didDragRef.current = false;
    }
  };

  const resetPos = (e) => {
    e.stopPropagation();
    setTopPos(null);
    try { localStorage.removeItem("opentakeoff:sidetabs-top"); } catch { /* quota/private */ }
  };

  const handleKeyDown = (e) => {
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey) {
      e.preventDefault();
      const step = e.shiftKey ? 40 : 15;
      const rect = frameRef.current?.getBoundingClientRect();
      const currentTop = topPos ?? (rect?.top || 200);
      const nextTop = clampTop(currentTop + (e.key === "ArrowUp" ? -step : step));
      setTopPos(nextTop);
      try { localStorage.setItem("opentakeoff:sidetabs-top", String(nextTop)); } catch { /* quota/private */ }
    } else if (e.key === "Escape" && topPos != null) {
      resetPos(e);
    }
  };

  return (
    <div
      ref={frameRef}
      className={`pc-sidetabs${isDragging ? " is-dragging" : ""}`}
      role="tablist"
      aria-label={uiText("Side panels")}
      style={{
        ...(topPos != null ? { top: `${topPos}px`, transform: "none" } : {}),
        zIndex: isDragging ? 35 : 28,
      }}
      title={uiText("Side tabs — drag up or down to reposition; double-click to reset")}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClickCapture={handleClickCapture}
      onDoubleClick={resetPos}
      onKeyDown={handleKeyDown}
    >
      <button type="button" role="tab" aria-selected={!!conditionsOpen} onClick={onConditions} title={uiText("Conditions")}>
        <span className="pc-sidetab-ico"><Icon name="list" size={20} />{conditionCount > 0 && <span className="pc-badge">{conditionCount}</span>}</span>
        <span>{uiText("Conditions")}</span>
      </button>
      <button type="button" role="tab" aria-selected={!!assistantOpen} onClick={onAssistant} title={uiText("Assistant: talk to your own AI here")}>
        <span className="pc-sidetab-ico"><ScanStar size={20} working={working} /></span>
        <span>{uiText("Assistant")}</span>
      </button>
    </div>
  );
}
