// ConditionsDock — the Premium-style conditions panel on the canvas's right edge.
// Top: the condition list (swatch, hotkey number, name, eye / pin / remove on
// hover) under a trade segment (this trade · All). Bottom: the active
// condition's settings card — tag, line and fill palettes, hatch, the repeat
// multiplier and waste, an assembly to price it with, supporting materials,
// Duplicate and Delete. Everything else a condition carries (trade, heights,
// roll goods, custom columns, transitions) sits one click away under "More".
//
// Rebuilt for the open-source canvas; it drives the same handler registry the
// classic TakeoffsPanel does, so every edit is the same undoable command.

import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { HATCHES, PALETTE, NO_FILL, HatchSwatch } from "./hatches.jsx";
import { ConditionAppearanceEditor, MaterialsEditor, useAssemblyLibrary } from "./TakeoffsPanel.jsx";
import { areaVal, areaUnit, lenVal, lenUnit } from "../lib/units";
import { baseTagOf } from "../lib/variants.ts";
import { localizeText as uiText } from "../lib/i18n/core.js";
import { useTranslation } from "../lib/i18n/index.jsx";
import "./conditionsDock.css";

// the row's quantity: area first, then linear, then count (a condition can carry
// several kinds; the full split lives in the Report)
const fmtQty = (row, units) => {
  if (!row || !(row.shape_count > 0)) return "";
  if (row.total_sf > 0) return `${Math.round(areaVal(row.total_sf, units)).toLocaleString()} ${areaUnit(units)}`;
  if (row.lf > 0) return `${Math.round(lenVal(row.lf, units)).toLocaleString()} ${lenUnit(units)}`;
  if (row.ea > 0) return `${Math.round(row.ea).toLocaleString()} EA`;
  return "";
};

function Swatches({ value, onPick, dim = false, none = false, label }) {
  return (
    <div className="cd-swatches" role="group" aria-label={uiText(label)}>
      {none && <button type="button" className={`cd-sw cd-sw-none${value === NO_FILL ? " is-on" : ""}`} title={uiText("No fill")} aria-label={uiText("No fill")} onClick={() => onPick(NO_FILL)}><Icon name="noFill" size={14} /></button>}
      {PALETTE.map((p) => <button type="button" key={p} className={`cd-sw${value === p ? " is-on" : ""}`} title={p} aria-label={`${uiText(label)} ${p}`} onClick={() => onPick(p)} style={{ background: p, opacity: dim ? 0.6 : 1 }} />)}
    </div>
  );
}

function ConditionsDock({
  open, onClose, sheetLabel, conditions, activeCond, hiddenConds, tradeHidden, palette,
  viewTrade, allTrades, tradeLabel, onTradeThis, onTradeAll, rowById, units, conditionColumns, rollByCond,
  matLib, matLibById,
  onActivate, onAddCondition, onDeleteCondition, onDuplicateCondition, onUpdateCond, onSetCondParam, onAssignAttr,
  onToggleHidden, onTogglePin, onApplyAssembly,
  onAddMaterial, onUpdateMaterial, onRemoveMaterial, matFieldOverridden, onRevertMatField, onAttachLibMaterial, onPromoteMaterial,
  onFollowFamilyRow, onRestoreDroppedRow,
}) {
  const { language } = useTranslation(); // memo component: re-render on a language switch
  const assemblies = useAssemblyLibrary();
  const [pickedAsm, setPickedAsm] = useState("");
  const [matOpen, setMatOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [twin, setTwin] = useState(null);   // duplicate label draft (inline, never window.prompt)
  const [asmMsg, setAsmMsg] = useState("");
  useEffect(() => { setPickedAsm(""); setTwin(null); setAsmMsg(""); }, [activeCond]);

  const visible = useMemo(() => conditions.filter((c) => !tradeHidden?.has(c.id)), [conditions, tradeHidden]);
  const hiddenByTrade = conditions.length - visible.length;
  const c = conditions.find((x) => x.id === activeCond) || null;
  if (!open) return null;

  const applyPicked = () => {
    const a = assemblies.find((x) => x.id === pickedAsm);
    if (!a || !c) return;
    onApplyAssembly(a);
    setAsmMsg(uiText(`Applied “${a.name}” to ${c.finish_tag}.`));
  };

  return (
    <aside className="cd-dock" aria-label={uiText("Conditions")} data-conditions-dock="">
      <header className="cd-head">
        <strong>{uiText("Conditions")}</strong>{sheetLabel && <span className="cd-head-sheet"> · {sheetLabel}</span>}
        <button type="button" className="cd-icon-btn cd-head-close" onClick={onClose} title={uiText("Hide conditions")} aria-label={uiText("Hide conditions")}><Icon name="chevronRight" size={16} /></button>
      </header>
      <div className="cd-seg" role="tablist" aria-label={uiText("Trade view")}>
        <button type="button" role="tab" aria-selected={viewTrade !== allTrades} onClick={onTradeThis} title={uiText("Show only this trade's conditions")}>{uiText(tradeLabel)}</button>
        <button type="button" role="tab" aria-selected={viewTrade === allTrades} onClick={onTradeAll} title={uiText("Show every trade's conditions")}>{uiText("All")}</button>
      </div>

      <div className="cd-list" role="listbox" aria-label={uiText("Conditions")}>
        {visible.map((cond) => {
          const i = conditions.indexOf(cond);
          const on = cond.id === activeCond;
          const hidden = hiddenConds?.has?.(cond.id);
          const pinned = palette?.includes(cond.id);
          const row = rowById?.get(cond.id);
          const qty = fmtQty(row, units);
          const fill = cond.fill && cond.fill !== NO_FILL ? cond.fill : cond.color;
          return (
            <div key={cond.id} role="option" aria-selected={on} className={`cd-row${on ? " is-on" : ""}${hidden ? " is-hidden" : ""}`}
              onClick={() => onActivate(cond.id)} title={qty ? uiText(`${cond.finish_tag} — ${qty} measured`) : cond.finish_tag} data-condition-row={cond.finish_tag} data-cond-id={cond.id}>
              <span className="cd-chip" style={{ background: fill, borderColor: cond.color }} aria-hidden="true" />
              <span className="cd-num">{i + 1}</span>
              <span className="cd-name">{cond.finish_tag}</span>
              {qty && <span className="cd-qty">{qty}</span>}
              <span className="cd-row-tools" onClick={(e) => e.stopPropagation()}>
                <button type="button" className={`cd-icon-btn${hidden ? " is-lit" : ""}`} aria-pressed={!!hidden} aria-label={uiText(`${hidden ? "Show" : "Hide"} ${cond.finish_tag}`)} title={uiText(hidden ? "Show on the plan" : "Hide on the plan (⌥-click to show only this one)")}
                  onClick={(e) => onToggleHidden(cond.id, e.altKey)}><Icon name={hidden ? "eyeOff" : "eye"} size={14} /></button>
                <button type="button" className={`cd-icon-btn${pinned ? " is-lit" : ""}`} aria-pressed={!!pinned} aria-label={uiText(`${pinned ? "Unpin" : "Pin"} ${cond.finish_tag}`)} title={uiText(pinned ? "Unpin from the quick palette" : "Pin to the quick palette")}
                  onClick={() => onTogglePin(cond.id)}><Icon name="pin" size={14} /></button>
                <button type="button" className="cd-icon-btn" aria-label={uiText(`Delete ${cond.finish_tag}`)} title={uiText("Delete condition")} onClick={() => onDeleteCondition(cond.id)}><Icon name="close" size={13} /></button>
              </span>
            </div>
          );
        })}
        {hiddenByTrade > 0 && <button type="button" className="cd-hidden-note" onClick={onTradeAll}>{uiText(`${hiddenByTrade} in other trades · show all`)}</button>}
        <button type="button" className="cd-add" onClick={onAddCondition}><Icon name="plus" size={14} />{uiText("Add condition")}</button>
      </div>

      {c && (
        <section className="cd-settings" aria-label={uiText(`${c.finish_tag} settings`)}>
          <h3><strong>{c.finish_tag}</strong> {uiText("settings")}</h3>
          <label className="cd-field-label" htmlFor="cd-tag">{uiText("Condition tag")}</label>
          <input id="cd-tag" name="condition-finish-tag" className="cd-input" value={c.finish_tag} onChange={(e) => onUpdateCond({ finish_tag: e.target.value })} />

          <div className="cd-grid">
            <span className="cd-k">{uiText("Line")}</span>
            <Swatches label="Line color" value={c.color} onPick={(p) => onUpdateCond({ color: p })} />
            <span className="cd-k cd-k-fill">{uiText("Fill")}<button type="button" className={`cd-sw cd-sw-none${c.fill === NO_FILL ? " is-on" : ""}`} title={uiText("No fill")} aria-label={uiText("No fill")} onClick={() => onUpdateCond({ fill: NO_FILL })}><Icon name="noFill" size={13} /></button></span>
            <Swatches label="Fill color" value={c.fill ?? c.color} onPick={(p) => onUpdateCond({ fill: p })} dim />
            <span className="cd-k">{uiText("Hatch")}</span>
            <div className="cd-hatch">
              <span className="cd-hatch-sw"><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill ?? c.color} /></span>
              <select name="condition-hatch" aria-label={uiText("Hatch")} value={c.hatch || "solid"} onChange={(e) => onUpdateCond({ hatch: e.target.value })}>
                {HATCHES.map((h) => <option key={h.id} value={h.id}>{uiText(h.label)}</option>)}
              </select>
            </div>
          </div>

          <div className="cd-inline">
            <label title={uiText("Repeating units: measure one identical unit and multiply every quantity on this condition by N")}>
              <span>×</span>
              <input name="condition-multiplier" type="number" min="1" step="1" value={c.multiplier || 1} onChange={(e) => onUpdateCond({ multiplier: Math.max(1, Math.round(parseFloat(e.target.value) || 1)) })} />
            </label>
            <label title={uiText("Waste %: an allowance added on top of the measured quantity in the Report and estimate")}>
              <span>{language === "ru" ? "Запас" : "Waste"}</span>
              <input name="condition-waste-pct" type="number" min="0" step="1" value={c.waste_pct ?? 0} onChange={(e) => onUpdateCond({ waste_pct: Math.max(0, parseFloat(e.target.value) || 0) })} />
              <span>%</span>
            </label>
          </div>

          <label className="cd-field-label" htmlFor="cd-asm">{uiText("Price with")}</label>
          <select id="cd-asm" name="apply-assembly" className="cd-input" value={pickedAsm} onChange={(e) => { setPickedAsm(e.target.value); setAsmMsg(""); }}>
            <option value="">{uiText(assemblies.length ? "Choose an assembly" : "No saved assemblies yet")}</option>
            {assemblies.map((a) => <option key={a.id} value={a.id}>{a.name} · {uiText(`${a.items.length} item${a.items.length === 1 ? "" : "s"}`)}</option>)}
          </select>
          <div className="cd-btn-row">
            <button type="button" className="cd-btn" disabled={!pickedAsm} onClick={applyPicked}>{uiText("Apply assembly")}</button>
            <button type="button" className="cd-btn cd-btn-icon" disabled={!pickedAsm} onClick={applyPicked} title={uiText("Apply again: adds any items this condition is missing, keeps the ones it has")} aria-label={uiText("Re-apply assembly")}><Icon name="refresh" size={15} /></button>
          </div>
          {asmMsg && <p className="cd-note" role="status">{asmMsg}</p>}

          <button type="button" className="cd-btn cd-btn-wide" aria-expanded={matOpen} onClick={() => setMatOpen((v) => !v)}>
            {uiText("Supporting materials")}{c.materials?.length ? <span className="cd-count">{c.materials.length}</span> : null}
          </button>
          {matOpen && (
            <div className="cd-materials">
              <MaterialsEditor materials={c.materials} onAdd={onAddMaterial} onUpdate={onUpdateMaterial} onRemove={onRemoveMaterial}
                library={matLib} libById={matLibById} overridden={matFieldOverridden} onRevert={onRevertMatField}
                onAttach={onAttachLibMaterial} onPromote={onPromoteMaterial}
                twin={!!c.variant_of} parentTag={(conditions.find((x) => x.id === c.variant_of) || {}).finish_tag || ""}
                dropped={c.materials_dropped || []} parentRows={(conditions.find((x) => x.id === c.variant_of) || {}).materials || []}
                onFollowFamilyRow={onFollowFamilyRow} onRestoreDroppedRow={onRestoreDroppedRow}
                heightFt={c.height_ft} />
            </div>
          )}

          <button type="button" className="cd-more" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
            <Icon name={moreOpen ? "chevronDown" : "chevronRight"} size={13} />{uiText("More: trade, heights, line style, columns")}
          </button>
          {moreOpen && <div className="cd-more-body"><ConditionAppearanceEditor cond={c} onUpdateCond={onUpdateCond} onSetCondParam={onSetCondParam} onAssignAttr={onAssignAttr} conditionColumns={conditionColumns} units={units} rollInfo={rollByCond?.get(c.id) || null} /></div>}

          {twin !== null ? (
            <div className="cd-twin">
              <input name="twin-label" autoFocus className="cd-input" value={twin} placeholder={uiText("Duplicate for… e.g. Level 2")}
                onChange={(e) => setTwin(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && twin.trim()) { onDuplicateCondition(c.id, twin.trim()); setTwin(null); } if (e.key === "Escape") setTwin(null); }} />
              <span className="cd-note">→ {twin.trim() ? `${baseTagOf(c.finish_tag)} – ${twin.trim()}` : "…"}</span>
              <div className="cd-btn-row">
                <button type="button" className="cd-btn" disabled={!twin.trim()} onClick={() => { onDuplicateCondition(c.id, twin.trim()); setTwin(null); }}>{uiText("Duplicate")}</button>
                <button type="button" className="cd-btn" onClick={() => setTwin(null)}>{uiText("Cancel")}</button>
              </div>
            </div>
          ) : (
            <div className="cd-btn-row cd-foot">
              <button type="button" className="cd-btn" onClick={() => setTwin("")}><Icon name="duplicate" size={15} />{uiText("Duplicate")}</button>
              <button type="button" className="cd-btn cd-btn-danger" onClick={() => onDeleteCondition(c.id)}>{uiText("Delete")}</button>
            </div>
          )}
        </section>
      )}
    </aside>
  );
}

export default React.memo(ConditionsDock);
