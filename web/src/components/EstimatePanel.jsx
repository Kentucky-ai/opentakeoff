// Estimate — price the takeoff by hand: a unit and material / labor $ per unit
// on each condition, $ per package on its supporting materials, then the
// project's markups. Every number comes from lib/estimate.js (the same engine
// the Excel export, the bid proposal and the MCP tools use); this panel only
// edits prices and shows the result. Nothing is ever pre-priced: an empty box
// is "not entered" and the line says so.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { Z } from "../lib/ui.js";
import { inOtherModal, otherModalOpen } from "../lib/modalKeys";
import { conditionTotals, downloadText } from "../lib/totals.js";
import { seamLfByShape } from "../lib/rollTakeoff.js";
import { priceEstimate, priceValue, sanitizePricing, PRICE_UNITS } from "../lib/estimate.js";
import { estimateWorkbook, estimateFileName } from "../lib/estimateExport.js";
import { buildXlsx } from "../lib/xlsx.js";
import { loadEstimatingDefaults } from "../lib/companySetup.js";
import { loadProfiles, activeProfile } from "../lib/identity.js";
import { OT_WATERMARK } from "../lib/branding.js";
import { bidProposalFromDefaults } from "../lib/bidProposal.js";
import BidProposalDialog from "./BidProposalDialog.jsx";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const money = (v) => `$${(Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
    <input name={name} aria-label={label} inputMode="decimal" value={text} placeholder="—"
      onChange={(e) => { setText(e.target.value); const v = priceValue(e.target.value); committed.current = v; onCommit(v); }}
      className="field-input mono" style={{ width: 84, padding: "3px 6px", textAlign: "right" }} />
  );
}

export default function EstimatePanel({ projectName, clientInfo = {}, conditions, shapes, rollByCond = null, settings, onSettings, onUpdateCondition, onClose, onOpenCompanySetup, companyRev = 0, onClientInfo = null, bidProposal = null, onBidProposal = null }) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(() => new Set());   // conditions whose material rows are expanded
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
  const est = useMemo(() => priceEstimate({ rows, conditions, settings }), [rows, conditions, settings]);
  const condById = useMemo(() => new Map(conditions.map((c) => [c.id, c])), [conditions]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const company = useMemo(() => activeProfile(loadProfiles()) || {}, [companyRev]);

  const setPricing = (c, patch) => {
    const next = { ...(sanitizePricing(c.pricing) || {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
    onUpdateCondition(c.id, { pricing: Object.keys(next).length ? next : undefined });
  };
  const setMaterialPrice = (c, index, price) => {
    // index is among the NAMED rows (isMaterialLine) — the same rows the engine priced
    let n = -1;
    const materials = (c.materials || []).map((m) => {
      if (!(m && m.name)) return m;
      n += 1;
      if (n !== index) return m;
      const { price: _old, ...rest } = m;
      return price === null ? rest : { ...rest, price };
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
      const sheets = estimateWorkbook({ est, projectName, companyName: company.name || "", clientName: clientInfo.client_name || "", date: clientInfo.date || "" });
      downloadText(estimateFileName(projectName), await buildXlsx(sheets), XLSX_MIME);
      setMsg(`Exported ${estimateFileName(projectName)}${est.complete ? "" : ` — ${est.unpriced.length} line${est.unpriced.length === 1 ? " is" : "s are"} not fully priced`}.`);
    } catch (e) { setMsg(`Couldn't export the estimate: ${e?.message || e}`); }
  };

  const th = { padding: "6px 8px", textAlign: "right", fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-muted)", borderBottom: "1px solid var(--ink)", whiteSpace: "nowrap", position: "sticky", top: 0, background: "var(--paper-cream)" };
  const td = { padding: "6px 8px", textAlign: "right", borderBottom: "1px solid var(--ink-faint)", whiteSpace: "nowrap", fontFamily: "var(--f-mono)", fontVariantNumeric: "tabular-nums" };
  const left = { textAlign: "left" };
  const sumRow = (label, v, strong = false) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 24, padding: "3px 0", fontWeight: strong ? 700 : 400, fontSize: strong ? 15 : 13, borderTop: strong ? "1px solid var(--ink)" : "none", marginTop: strong ? 6 : 0, paddingTop: strong ? 8 : 3 }}>
      <span>{label}</span><span className="mono" style={{ fontVariantNumeric: "tabular-nums" }}>{money(v)}</span>
    </div>
  );
  const margin = settings.profit_mode === "margin";

  return (
    <div ref={rootRef} role="dialog" aria-modal="true" aria-label="Estimate" className="estimate-panel"
      style={{ position: "absolute", inset: 0, zIndex: Z.modal, display: "flex", flexDirection: "column", background: "var(--paper-cream)", color: "var(--ink)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: "1px solid var(--ink)", background: "var(--paper-bright)" }}>
        <Icon name="document" size={18} />
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 16 }}>Estimate</strong>
        <span style={{ color: "var(--ink-muted)", fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{projectName || "Untitled project"}</span>
        <div style={{ flex: 1 }} />
        {MARKUPS.map(([k, label]) => (
          <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, whiteSpace: "nowrap" }}>
            {label}
            <input name={`markup-${k}`} type="number" min={0} step="any" value={settings[k]} onChange={(e) => setMarkup(k, e.target.value)}
              className="field-input mono" style={{ width: 64, padding: "3px 6px", textAlign: "right" }} />%
          </label>
        ))}
        <select name="profit-mode" aria-label="Profit is" value={settings.profit_mode} onChange={(e) => onSettings({ ...settings, profit_mode: e.target.value })}
          className="field-input" style={{ width: "auto", padding: "3px 6px", fontSize: 12.5 }}>
          <option value="markup">markup</option>
          <option value="margin">margin</option>
        </select>
        <button className="btn-ghost" onClick={resetToCompany} title="Replace this project's markups with your Company setup defaults">Company defaults</button>
        {onOpenCompanySetup && <button className="btn-ghost" onClick={onOpenCompanySetup} title="Your company, default markups and proposal terms">Company setup…</button>}
        <button className="btn-ghost" onClick={exportExcel} disabled={!est.lines.length} title="Download the priced estimate as an Excel workbook">Excel</button>
        {onBidProposal && <button className="btn-primary" onClick={openProposal} disabled={!est.lines.length} title="Your bid proposal as a PDF — letterhead, scope, base bid, terms, signature">Proposal PDF…</button>}
        <button type="button" onClick={onClose} title="Close (Esc)" aria-label="Close estimate"
          style={{ background: "none", border: "none", color: "var(--ink-soft)", fontSize: 20, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "12px 18px 24px" }}>
        {!est.lines.length && (
          <p style={{ color: "var(--ink-muted)" }}>Nothing measured yet. Trace a condition on the plan and it appears here to price.</p>
        )}
        {!est.complete && (
          <div role="status" style={{ margin: "0 0 12px", padding: "8px 12px", border: "1px solid var(--c-danger)", color: "var(--ink)", fontSize: 12.5 }}>
            <strong>{est.unpriced.length} line{est.unpriced.length === 1 ? " is" : "s are"} not fully priced.</strong>{" "}
            The total counts {est.unpriced.length === 1 ? "it" : "them"} at $0 for what is missing: {est.unpriced.map((u) => `${u.finish_tag} (${u.missing.join(", ")})`).join(" · ")}.
          </div>
        )}
        {est.warnings.map((w) => <p key={w} role="alert" style={{ color: "var(--c-danger)", fontSize: 12.5, margin: "0 0 8px" }}>{w}</p>)}
        {msg && <p role="status" style={{ color: "var(--ink-muted)", fontSize: 12.5, margin: "0 0 8px" }}>{msg}</p>}

        {est.lines.length > 0 && (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ ...th, ...left }}>Finish</th>
                <th style={th}>Unit</th>
                <th style={th}>Material qty</th>
                <th style={th}>Material $/unit</th>
                <th style={th}>Labor qty</th>
                <th style={th}>Labor $/unit</th>
                <th style={th}>Material</th>
                <th style={th}>Labor</th>
                <th style={th}>Supplies</th>
                <th style={th}>Total</th>
              </tr>
            </thead>
            <tbody>
              {est.lines.map((l) => {
                const c = condById.get(l.id) || {};
                const expanded = open.has(l.id);
                return (
                  <React.Fragment key={l.id}>
                    <tr data-estimate-line={l.finish_tag}>
                      <td style={{ ...td, ...left, fontFamily: "var(--f-body)" }}>
                        <span style={{ display: "inline-block", width: 10, height: 10, background: c.fill || c.color, border: `1px solid ${c.color}`, marginRight: 8, verticalAlign: "middle" }} />
                        <strong>{l.finish_tag}</strong>
                        {l.materials.length > 0 && (
                          <button onClick={() => setOpen((s) => { const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n; })}
                            aria-expanded={expanded} title="Price this condition's supporting materials"
                            style={{ marginLeft: 8, border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11.5, padding: 0 }}>
                            {expanded ? "▾" : "▸"} {l.materials.length} material{l.materials.length === 1 ? "" : "s"}
                          </button>
                        )}
                        {STATUS_LABEL[l.status] && (
                          <span title={`Missing: ${l.missing.join(", ")}`} style={{ marginLeft: 8, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.08em", color: "var(--c-danger)", border: "1px solid var(--c-danger)", padding: "0 4px" }}>{STATUS_LABEL[l.status]}</span>
                        )}
                      </td>
                      <td style={td}>
                        <select name="price-unit" aria-label={`${l.finish_tag} pricing unit`} value={l.unit} onChange={(e) => setPricing(c, { unit: e.target.value })}
                          className="field-input" style={{ width: "auto", padding: "2px 4px", fontSize: 12 }}>
                          {PRICE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </td>
                      <td style={td} title="Order quantity — waste applied">{qty(l.material_qty)}</td>
                      <td style={td}><PriceInput name="price-material" label={`${l.finish_tag} material $ per ${l.unit}`} value={l.material_rate} onCommit={(v) => setPricing(c, { material: v })} /></td>
                      <td style={td} title="Measured quantity — no waste">{qty(l.labor_qty)}</td>
                      <td style={td}><PriceInput name="price-labor" label={`${l.finish_tag} labor $ per ${l.unit}`} value={l.labor_rate} onCommit={(v) => setPricing(c, { labor: v })} /></td>
                      <td style={td}>{money(l.material_cost)}</td>
                      <td style={td}>{money(l.labor_cost)}</td>
                      <td style={td}>{money(l.materials_cost)}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{money(l.total)}</td>
                    </tr>
                    {expanded && l.materials.map((m, i) => (
                      <tr key={`${l.id}-m${i}`} style={{ background: "var(--paper-bright)" }}>
                        <td style={{ ...td, ...left, fontFamily: "var(--f-body)", paddingLeft: 36, color: "var(--ink-soft)" }}>
                          {m.name}
                          {!m.priced && <span style={{ marginLeft: 8, fontFamily: "var(--f-mono)", fontSize: 9.5, color: "var(--c-danger)" }}>UNPRICED</span>}
                        </td>
                        <td style={td}>{m.unit || "unit"}</td>
                        <td style={td} title="Whole packages — rounded up">{qty(m.qty)}</td>
                        <td style={td}><PriceInput name="price-supply" label={`${l.finish_tag} ${m.name} $ per ${m.unit || "unit"}`} value={m.price} onCommit={(v) => setMaterialPrice(c, i, v)} /></td>
                        <td style={td} colSpan={4} />
                        <td style={td}>{money(m.cost)}</td>
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
              {sumRow("Material + supplies", est.material)}
              {sumRow("Labor", est.labor)}
              {sumRow(`Sales tax on material (${settings.tax_pct}%)`, est.tax)}
              {sumRow(`Overhead (${settings.overhead_pct}%)`, est.overhead)}
              {sumRow(`Profit (${settings.profit_pct}% ${margin ? "margin" : "markup"})`, est.profit)}
              {sumRow(est.complete ? "Base bid" : "Base bid — priced so far", est.total, true)}
            </div>
          </div>
        )}
        <p style={{ margin: "24px 0 0", color: "var(--ink-muted)", fontSize: 11 }}>
          Material is priced on the order quantity (waste applied), labor on the measured quantity. Prices stay with this project. {OT_WATERMARK}
        </p>
      </div>
      {proposalOpen && onBidProposal && (
        <BidProposalDialog est={est} conditions={conditions} projectName={projectName}
          clientInfo={clientInfo} onClientInfo={onClientInfo}
          proposal={bidProposal} onProposal={onBidProposal}
          onOpenCompanySetup={onOpenCompanySetup} onClose={() => setProposalOpen(false)} />
      )}
    </div>
  );
}
