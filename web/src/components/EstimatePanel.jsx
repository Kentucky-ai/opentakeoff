import { createExportPresentation } from "../lib/exportPresentation.js";
import { formatMessage, formatEstimateMoney as money, getLanguage, localizeText as uiText } from "../lib/i18n/core.js";
// Estimate — price the takeoff by hand: one line per quantity kind each
// condition carries (its area, its LF, its EA — whatever was drawn under it),
// material / labor $ per unit on each line, material and optional labor $ per
// unit on its assembly items, then the project's markups. Every number comes from lib/estimate.js (the same engine
// the Excel export, the bid proposal and the MCP tools use); this panel only
// edits prices and shows the result. Nothing is ever pre-priced: an empty box
// is "not entered" and the line says so.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { Z } from "../lib/ui.js";
import { inOtherModal, otherModalOpen } from "../lib/modalKeys";
import { conditionTotals, downloadText } from "../lib/totals.js";
import { seamLfByShape } from "../lib/rollTakeoff.js";
import { priceEstimate, priceValue, sanitizePricing, lineLabel, PRICE_UNITS } from "../lib/estimate.js";
import { estimateWorkbook, estimateFileName } from "../lib/estimateExport.js";
import { buildXlsx } from "../lib/xlsx.js";
import { loadEstimatingDefaults } from "../lib/companySetup.js";
import { loadProfiles, activeProfile } from "../lib/identity.js";
import { OT_WATERMARK } from "../lib/branding.js";
import { bidProposalFromDefaults } from "../lib/bidProposal.js";
import BidProposalDialog from "./BidProposalDialog.jsx";

import MaterialUnitSelector, { useMaterialUnit } from './MaterialUnitSelector.jsx';
import { estimateForDisplay, pricingDisplay } from '../lib/estimatePresentation.js';
import { liquidFactor } from '../lib/materialUnits.js';
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const qty = (v) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const STATUS_LABEL = { partial: "PARTLY PRICED", unpriced: "UNPRICED" };
const MARKUPS = [["overhead_pct", "Overhead"], ["profit_pct", "Profit"], ["tax_pct", "Sales tax"]];

// A price box keeps what is typed ("1." mid-entry, an emptied box) and commits
// the parsed value — null for empty or unusable, which the engine reports as
// missing rather than $0.
function PriceInput({ value, onCommit, label, name }) {
  const [text, setText] = useState(value === null || value === undefined ? "" : String(value));
  const committed = useRef(value);
  useEffect(() => {
    // follow outside changes (undo, a project load) without clobbering typing
    if (value !== committed.current) { committed.current = value; setText(value === null || value === undefined ? "" : String(value)); }
  }, [value]);
  return (
    <input name={name} aria-label={label} inputMode="decimal" value={text} placeholder={uiText("—")}
      onChange={(e) => { setText(e.target.value); const v = priceValue(getLanguage() === 'ru' ? e.target.value.replace(',', '.') : e.target.value); committed.current = v; onCommit(v); }}
      className="field-input mono" style={{ width: 84, padding: "3px 6px", textAlign: "right" }} />
  );
}

export default function EstimatePanel({ projectName, clientInfo = {}, conditions, shapes, rollByCond = null, settings, onSettings, onUpdateCondition, onClose, onOpenCompanySetup, companyRev = 0, onClientInfo = null, bidProposal = null, onBidProposal = null }) {
  const rootRef = useRef(null);
  const liquidUnit = useMaterialUnit();
  const display = createExportPresentation({ language: getLanguage(), localize: uiText });
  const metric = getLanguage() === 'ru';
  const [open, setOpen] = useState(() => new Set());   // lines (key) whose assembly items are expanded
  const [msg, setMsg] = useState("");
  const [proposalOpen, setProposalOpen] = useState(false);
  // the project's proposal text is copied from Company setup the first time the
  // dialog opens, then belongs to the project (the estimate_settings rule)
  const openProposal = () => {
    if (!bidProposal && onBidProposal) onBidProposal(bidProposalFromDefaults(loadEstimatingDefaults()));
    setProposalOpen(true);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (inOtherModal(e.target, rootRef.current) || otherModalOpen(document, rootRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const seamCtx = useMemo(() => ({ seamByShape: seamLfByShape(rollByCond) }), [rollByCond]);
  const rows = useMemo(() => conditionTotals(conditions, shapes, seamCtx), [conditions, shapes, seamCtx]);
  const sourceEst = useMemo(() => priceEstimate({ rows, conditions, settings }), [rows, conditions, settings]);
  const est = useMemo(() => estimateForDisplay(sourceEst, metric, liquidUnit), [sourceEst, metric, liquidUnit]);
  // lineLabel's rule (estimate.js), with the finish shown the way this panel shows it
  const lineName = (l) => (lineLabel(est, l) === l.finish_tag ? display.finish(l.finish_tag) : `${display.finish(l.finish_tag)} ${uiText(l.unit)}`);
  const missingText = (missing) => missing.map(x => x.startsWith('material row: ') ? uiText('Supporting material') + ': ' + display.material(x.slice(14)) : uiText(x)).join(', ');
  const condById = useMemo(() => new Map(conditions.map((c) => [c.id, c])), [conditions]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const company = useMemo(() => activeProfile(loadProfiles()) || {}, [companyRev]);

  // A line's rates: the main line's live on pricing itself (unit / material /
  // labor — the shape older projects already have); every other line's under
  // pricing.by_unit[its unit]. sanitizePricing drops whatever went empty.
  const setPricing = (c, l, patch) => {
    const cur = sanitizePricing(c.pricing) || {};
    const u = l.source_unit || l.unit; // est is in display units; pricing keys stay in the engine's unit
    const next = l.main ? { ...cur, ...patch } : { ...cur, by_unit: { ...(cur.by_unit || {}), [u]: { ...(cur.by_unit?.[u] || {}), ...patch } } };
    onUpdateCondition(c.id, { pricing: sanitizePricing(next) });
  };
  const setItemField = (c, index, field, value) => {
    // index is among the NAMED rows (isMaterialLine) — the same rows the engine priced
    let n = -1;
    const materials = (c.materials || []).map((m) => {
      if (!(m && m.name)) return m;
      n += 1;
      if (n !== index) return m;
      const { [field]: _old, ...rest } = m;
      // the panel shows liquid items in the selected unit (L / gal); store the
      // price back per the row's own unit
      const factor = liquidFactor(m.unit, liquidUnit) || 1;
      return value === null ? rest : { ...rest, [field]: value * factor };
    });
    onUpdateCondition(c.id, { materials });
  };
  const setMarkup = (k, v) => onSettings({ ...settings, [k]: v === "" ? 0 : Number(v) });
  const resetToCompany = () => {
    const d = loadEstimatingDefaults();
    onSettings({ tax_pct: d.tax_pct, overhead_pct: d.overhead_pct, profit_pct: d.profit_pct, profit_mode: d.profit_mode });
    setMsg("Markups reset to your Company setup defaults.");
  };
  const exportExcel = async () => {
    try {
      const sheets = estimateWorkbook({ est, projectName, companyName: company.name || "", clientName: clientInfo.client_name || "", date: clientInfo.date || "", localize: uiText, language: getLanguage() });
      downloadText(estimateFileName(projectName, getLanguage()), await buildXlsx(sheets), XLSX_MIME);
      setMsg(getLanguage() === "ru" ? `Сохранён файл ${estimateFileName(projectName, "ru")}.${est.complete ? "" : " Не все цены заданы."}` : `Exported ${estimateFileName(projectName)}${est.complete ? "" : ` — ${est.unpriced.length} line${est.unpriced.length === 1 ? " is" : "s are"} not fully priced`}.`);
    } catch (e) { setMsg(`Couldn't export the estimate: ${e?.message || e}`); }
  };

  const th = { padding: "6px 8px", textAlign: "right", fontFamily: "var(--f-mono)", fontSize: metric ? 11 : 9.5, letterSpacing: "0.03em", textTransform: metric ? "none" : "uppercase", color: "var(--ink-muted)", borderBottom: "1px solid var(--ink)", whiteSpace: "normal", maxWidth: 130, position: "sticky", top: 0, background: "var(--paper-cream)" };
  const td = { padding: "6px 8px", textAlign: "right", borderBottom: "1px solid var(--ink-faint)", whiteSpace: "nowrap", fontFamily: "var(--f-mono)", fontVariantNumeric: "tabular-nums" };
  const left = { textAlign: "left", whiteSpace: "normal", width: 280, maxWidth: 320 };
  const sumRow = (label, v, strong = false) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 24, padding: "3px 0", fontWeight: strong ? 700 : 400, fontSize: strong ? 15 : 13, borderTop: strong ? "1px solid var(--ink)" : "none", marginTop: strong ? 6 : 0, paddingTop: strong ? 8 : 3 }}>
      <span>{uiText(label)}</span><span className="mono" style={{ fontVariantNumeric: "tabular-nums" }}>{uiText(money(v))}</span>
    </div>
  );
  const margin = settings.profit_mode === "margin";

  return (
    <div ref={rootRef} role="dialog" aria-modal="true" aria-label={uiText("Estimate")} className="estimate-panel"
      style={{ position: "absolute", inset: 0, zIndex: Z.modal, display: "flex", flexDirection: "column", background: "var(--paper-cream)", color: "var(--ink)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: "1px solid var(--ink)", background: "var(--paper-bright)" }}>
        <Icon name="document" size={18} />
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 16 }}>{uiText("Estimate")}</strong>
        <span style={{ color: "var(--ink-muted)", fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{projectName || uiText("Untitled project")}</span>
        <div style={{ flex: 1 }} />
        {MARKUPS.map(([k, label]) => (
          <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, whiteSpace: "nowrap" }}>
            {uiText(label)}
            <input name={`markup-${k}`} type="number" min={0} step="any" value={settings[k]} onChange={(e) => setMarkup(k, e.target.value)}
              className="field-input mono" style={{ width: 64, padding: "3px 6px", textAlign: "right" }} />%
          </label>
        ))}
        <select name="profit-mode" aria-label={uiText("Profit is")} value={settings.profit_mode} onChange={(e) => onSettings({ ...settings, profit_mode: e.target.value })}
          className="field-input" style={{ width: "auto", padding: "3px 6px", fontSize: 12.5 }}>
          <option value="markup">{uiText("markup")}</option>
          <option value="margin">{uiText("margin")}</option>
        </select>
        <button className="btn-ghost" onClick={resetToCompany} title={uiText("Replace this project's markups with your Company setup defaults")}>{uiText("Company defaults")}</button>
        {onOpenCompanySetup && <button className="btn-ghost" onClick={onOpenCompanySetup} title={uiText("Your company, default markups and proposal terms")}>{uiText("Company setup…")}</button>}
        <MaterialUnitSelector /><button className="btn-ghost" onClick={exportExcel} disabled={!est.lines.length} title={uiText("Download the priced estimate as an Excel workbook")}>{uiText("Excel")}</button>
        {onBidProposal && <button className="btn-primary" onClick={openProposal} disabled={!est.lines.length} title={uiText("Your bid proposal as a PDF — letterhead, scope, base bid, terms, signature")}>{uiText("Proposal PDF…")}</button>}
        <button className="estimate-close" type="button" onClick={onClose} title={uiText("Close (Esc)")} aria-label={uiText("Close estimate")}
          style={{ background: "none", border: "none", color: "var(--ink-soft)", fontSize: 20, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "12px 18px 24px" }}>
        {!est.lines.length && (
          <p style={{ color: "var(--ink-muted)" }}>{uiText("Nothing measured yet. Trace a condition on the plan and it appears here to price.")}</p>
        )}
        {!est.complete && (
          <div role="status" style={{ margin: "0 0 12px", padding: "8px 12px", border: "1px solid var(--c-danger)", color: "var(--ink)", fontSize: 12.5 }}>
            <strong>{formatMessage("Lines not fully priced: {0}.", [est.unpriced.length])}</strong>{" "}
            {uiText("Unentered prices count as zero in the total: ")}{est.unpriced.map((u) => `${lineName(u)} (${missingText(u.missing)})`).join(" · ")}.
          </div>
        )}
        {est.warnings.map((w) => <p key={w} role="alert" style={{ color: "var(--c-danger)", fontSize: 12.5, margin: "0 0 8px" }}>{uiText(w)}</p>)}
        {msg && <p role="status" style={{ color: "var(--ink-muted)", fontSize: 12.5, margin: "0 0 8px" }}>{uiText(msg)}</p>}

        {est.lines.length > 0 && (
          // fixed layout: with auto layout every column re-flowed when a status
          // badge (UNPRICED → PARTLY PRICED) changed width or an item row opened
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "24%" }} />
              <col style={{ width: "6%" }} />
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <col key={i} style={{ width: "8.75%" }} />)}
            </colgroup>
            <thead>
              <tr>
                <th style={{ ...th, ...left }}>{uiText("Finish")}</th>
                <th style={th}>{uiText("Unit")}</th>
                <th style={th}>{uiText("Material qty")}</th>
                <th style={th}>{uiText("Material $/unit")}</th>
                <th style={th}>{uiText("Labor qty")}</th>
                <th style={th}>{uiText("Labor $/unit")}</th>
                <th style={th}>{uiText("Material")}</th>
                <th style={th}>{uiText("Labor")}</th>
                <th style={th} title={uiText("Assembly items: material + their own labor")}>{uiText("Assembly")}</th>
                <th style={th}>{uiText("Total")}</th>
              </tr>
            </thead>
            <tbody>
              {est.lines.map((l) => {
                const c = condById.get(l.id) || {};
                const expanded = open.has(l.key);
                const name = lineName(l);
                return (
                  <React.Fragment key={l.key}>
                    <tr data-estimate-line={l.finish_tag} data-estimate-unit={l.unit}>
                      <td style={{ ...td, ...left, fontFamily: "var(--f-body)" }}>
                        <span style={{ display: "inline-block", width: 10, height: 10, background: c.fill || c.color, border: `1px solid ${c.color}`, marginRight: 8, verticalAlign: "middle" }} />
                        <strong>{l.main ? display.finish(l.finish_tag) : <span style={{ color: "var(--ink-soft)", fontWeight: 400 }}>{display.finish(l.finish_tag)}</span>}</strong>
                        {!l.main && <span style={{ marginLeft: 6, color: "var(--ink-muted)", fontSize: 11.5 }}>{uiText(`· its ${l.source_unit === "EA" ? "count" : l.source_unit === "LF" ? "linear" : "area"}`)}</span>}
                        {l.materials.length > 0 && (
                          <button onClick={() => setOpen((s) => { const n = new Set(s); n.has(l.key) ? n.delete(l.key) : n.add(l.key); return n; })}
                            aria-expanded={expanded} title={uiText("Price this condition's assembly items")}
                            style={{ marginLeft: 8, border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11.5, padding: 0 }}>
                            {uiText(expanded ? "▾" : "▸")} {metric ? 'Позиции комплекта: ' + l.materials.length : l.materials.length + ' item' + (l.materials.length === 1 ? '' : 's')}
                          </button>
                        )}
                        {l.status === "optional" && (
                          <span title={uiText(`Optional: this bordered run's ${l.unit} is carried in the ${lineName(est.lines.find((o) => o.id === l.id && o.main) || l)} price. Price it here only if it is bought or installed separately.`)}
                            style={{ marginLeft: 8, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.08em", color: "var(--ink-muted)", border: "1px solid var(--ink-faint)", padding: "0 4px" }}>{uiText("OPTIONAL")}</span>
                        )}
                        {STATUS_LABEL[l.status] && (
                          <span title={uiText(`Missing: ${missingText(l.missing)}`)} style={{ marginLeft: 8, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.08em", color: "var(--c-danger)", border: "1px solid var(--c-danger)", padding: "0 4px" }}>{uiText(STATUS_LABEL[l.status])}</span>
                        )}
                      </td>
                      <td style={td}>
                        {l.main ? (
                          <select name="price-unit" aria-label={formatMessage("{0} pricing unit", [name])} value={metric && l.source_unit === "SY" ? "SF" : l.source_unit} onChange={(e) => setPricing(c, l, { unit: e.target.value })}
                            className="field-input" style={{ width: "auto", padding: "2px 4px", fontSize: 12 }}>
                            {PRICE_UNITS.filter(u => !metric || u !== "SY").map((u) => <option key={u} value={u}>{uiText(pricingDisplay(u, metric).unit)}{metric && u === 'SY' ? uiText(' (source: sq yd)') : ''}</option>)}
                          </select>
                        ) : <span title={uiText("This line prices the condition's other measured quantity in its own unit")}>{uiText(l.unit)}</span>}
                      </td>
                      <td style={td} title={uiText("Order quantity — waste applied")}>{uiText(qty(l.material_qty))}</td>
                      <td style={td}><PriceInput name="price-material" label={formatMessage("{0}: material price, {1}/{2}", [name, metric ? "₽" : "$", display.unit(l.unit)])} value={l.material_rate} onCommit={(v) => setPricing(c, l, { material: v === null ? null : v * l.quantity_factor })} /></td>
                      <td style={td} title={uiText("Measured quantity — no waste")}>{uiText(qty(l.labor_qty))}</td>
                      <td style={td}><PriceInput name="price-labor" label={formatMessage("{0}: labor price, {1}/{2}", [name, metric ? "₽" : "$", display.unit(l.unit)])} value={l.labor_rate} onCommit={(v) => setPricing(c, l, { labor: v === null ? null : v * l.quantity_factor })} /></td>
                      <td style={td}>{uiText(money(l.material_cost))}</td>
                      <td style={td}>{uiText(money(l.labor_cost))}</td>
                      <td style={td}>{uiText(money(l.materials_cost + (l.materials_labor_cost || 0)))}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{uiText(money(l.total))}</td>
                    </tr>
                    {expanded && l.materials.map((m, i) => (
                      <tr key={`${l.key}-m${i}`} data-estimate-item={m.name} style={{ background: "var(--paper-bright)" }}>
                        <td style={{ ...td, ...left, fontFamily: "var(--f-body)", paddingLeft: 36, color: "var(--ink-soft)" }}>
                          {display.material(m.name)}
                          {m.waste_pct > 0 && <span style={{ marginLeft: 6, color: "var(--ink-muted)", fontSize: 11 }}>{formatMessage("+{0}% waste", [m.waste_pct])}</span>}
                          {!m.priced && <span style={{ marginLeft: 8, fontFamily: "var(--f-mono)", fontSize: 9.5, color: "var(--c-danger)" }}>{uiText("UNPRICED")}</span>}
                        </td>
                        <td style={td}>{uiText(m.unit || "unit")}</td>
                        <td style={td} title={uiText("Order quantity — the item's waste applied, whole packages")}>{uiText(qty(m.qty))}</td>
                        <td style={td}><PriceInput name="price-supply" label={formatMessage("{0}: {1}, price {2}/{3}", [l.finish_tag, display.material(m.name), metric ? "₽" : "$", display.unit(m.unit || "unit")])} value={m.price} onCommit={(v) => setItemField(c, i, "price", v)} /></td>
                        <td style={td} title={uiText("Measured quantity — no waste, not rounded up")}>{uiText(qty(m.labor_qty))}</td>
                        <td style={td} title={uiText("Optional: leave empty when the condition's labor line covers this item")}>
                          <PriceInput name="price-supply-labor" label={formatMessage("{0}: {1}, labor price {2}/{3}", [l.finish_tag, display.material(m.name), metric ? "₽" : "$", display.unit(m.unit || "unit")])} value={m.labor_rate} onCommit={(v) => setItemField(c, i, "labor_price", v)} />
                        </td>
                        {/* the item's own material and labor; together they make the line's Assembly figure */}
                        <td style={td}>{uiText(money(m.cost))}</td>
                        <td style={td}>{m.labor_rate === null ? "—" : uiText(money(m.labor_cost))}</td>
                        <td style={td} />
                        <td style={td} />
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {est.lines.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
            <div style={{ width: "min(360px, 100%)" }}>
              {uiText(sumRow("Material + assembly items", est.material))}
              {uiText(sumRow("Labor", est.labor))}
              {uiText(sumRow(`Sales tax on material (${settings.tax_pct}%)`, est.tax))}
              {uiText(sumRow(`Overhead (${settings.overhead_pct}%)`, est.overhead))}
              {uiText(sumRow(`Profit (${settings.profit_pct}% ${margin ? "margin" : "markup"})`, est.profit))}
              {uiText(sumRow(est.complete ? "Base bid" : "Base bid — priced so far", est.total, true))}
            </div>
          </div>
        )}
        <p style={{ margin: "24px 0 0", color: "var(--ink-muted)", fontSize: 11 }}>
          {uiText("Material is priced on the order quantity (waste applied), labor on the measured quantity. A condition gets a line for each quantity it carries (area, LF, EA). Prices stay with this project. ")}{uiText(OT_WATERMARK)}
        </p>
      </div>
      {proposalOpen && onBidProposal && (
        <BidProposalDialog est={sourceEst} conditions={conditions} projectName={projectName}
          clientInfo={clientInfo} onClientInfo={onClientInfo}
          proposal={bidProposal} onProposal={onBidProposal}
          onOpenCompanySetup={onOpenCompanySetup} onClose={() => setProposalOpen(false)} />
      )}
    </div>
  );
}
