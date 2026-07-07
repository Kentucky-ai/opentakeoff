// ReportPanel — the takeoff deliverable. A STACK-style breakdown by condition
// (finish): measured quantity, waste %, and waste-adjusted order quantity, with
// a grand total. Exports to CSV / JSON, prints, and hosts the opt-in
// "Contribute to the open flooring model" flow.
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { conditionTotals, grandTotals, sheetTotals, round2, totalsToCsv, downloadText, materialsSummary } from "../lib/totals.js";
import { GETTERS, TABLE_PROFILE, CSV_PROFILE, loadColPrefs, saveColPrefs, visibleCols, floorPerimeterLf } from "../lib/reportColumns.js";
import { shapesDetail, shapesToCsv, shapesToJson } from "../lib/shapesExport.js";
import { buildContribution, sendContribution, isContributeConfigured } from "../lib/contribute.js";
import { loadCompany, saveCompany, normalizeLogoToPng } from "../lib/identity.js";

const num = (v, d = 1) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });

// one-line hints for the opt-in columns in the picker (waste hint sits under
// the second waste checkbox so it reads once for the pair)
const COL_HINTS = {
  waste_lf: "Waste SF/LF = order − measured",
  perimeter_ref: "Perimeter is reference only — includes openings; not totaled",
};

const sheetNum = (v, d = 1) => {
  const r = round2(v);
  // zero-gate at the DISPLAY precision, so a ±0.02 sliver shows "—", not "(0)"
  if (!Math.round(Math.abs(r) * 10 ** d)) return "—";
  if (r < 0) return <span style={{ color: "var(--c-danger)" }}>({num(-r, d)})</span>;
  return num(r, d);
};

export default function ReportPanel({ projectName, onProjectName, conditions, shapes, sheetLabel, onMarkedSet, markedSetDark, onClose, markups = [], scaleInfo = [], clientInfo = {}, onClientInfo }) {
  const rows = conditionTotals(conditions, shapes).filter((r) => r.shape_count > 0);
  const g = grandTotals(rows);
  const matSummary = materialsSummary(rows);
  const bySheet = sheetTotals(conditions, shapes);
  const [showContribute, setShowContribute] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  // bumped by the Project info modal on every company save, so the print
  // masthead's loadCompany() below re-reads (a cheap localStorage parse)
  const [identityRev, setIdentityRev] = useState(0); // eslint-disable-line no-unused-vars
  const company = loadCompany();
  const hasClient = Boolean(clientInfo.client_name || clientInfo.client_address || clientInfo.reference || clientInfo.date);
  const [colPrefs, setColPrefs] = useState(loadColPrefs);
  const [showCols, setShowCols] = useState(false);
  const colsRef = useRef(null);
  const tableCols = visibleCols(TABLE_PROFILE, colPrefs);
  const csvCols = visibleCols(CSV_PROFILE, colPrefs);
  const perimByCond = floorPerimeterLf(shapes);
  const ctx = { perimByCond };

  // while the report is up, the print stylesheet (app.css @media print) hides
  // the canvas chrome behind it and lets the report flow across pages
  useEffect(() => {
    document.body.classList.add("report-open");
    return () => document.body.classList.remove("report-open");
  }, []);

  // columns popover closes on any click outside it
  useEffect(() => {
    if (!showCols) return;
    const onDown = (e) => { if (colsRef.current && !colsRef.current.contains(e.target)) setShowCols(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showCols]);

  // store only diffs from defaultVisible — a key toggled back to default is dropped
  const toggleCol = (col) => {
    const next = { ...colPrefs };
    const want = !(colPrefs[col.key] ?? col.defaultVisible);
    if (want === col.defaultVisible) delete next[col.key]; else next[col.key] = want;
    setColPrefs(next);
    saveColPrefs(next);
  };

  const baseName = (projectName || "takeoff").replace(/[^\w.-]+/g, "_");
  const exportCsv = () => downloadText(`${baseName}.csv`, totalsToCsv(rows, projectName, bySheet, sheetLabel, csvCols, ctx), "text/csv");
  const exportJson = () => downloadText(`${baseName}.json`,
    JSON.stringify({
      schema: "opentakeoff.report.v1",
      project_name: projectName || null, generated_with: "OpenTakeoff",
      sheets: scaleInfo.map((si) => ({ ...si, sheet: sheetLabel ? sheetLabel(si.sheet_id) : si.sheet_id })),
      conditions: rows,
      by_sheet: bySheet.map((gp) => ({
        sheet_id: gp.sheet_id,
        sheet: sheetLabel ? sheetLabel(gp.sheet_id) : gp.sheet_id,
        rows: gp.rows.map((r) => ({ ...r, floor_sf: round2(r.floor_sf), wall_sf: round2(r.wall_sf), border_sf: round2(r.border_sf), lf: round2(r.lf) })),
      })),
      totals: g, materials: matSummary,
      markups: markups.map((m) => ({ type: m.type, sheet_id: m.sheet_id, sheet: sheetLabel ? sheetLabel(m.sheet_id) : m.sheet_id, text: m.text || "" })),
    }, null, 2),
    "application/json");
  const exportShapesCsv = () => downloadText(`${baseName}_shapes.csv`, shapesToCsv(shapesDetail(conditions, shapes, sheetLabel), projectName), "text/csv");
  const exportShapesJson = () => downloadText(`${baseName}_shapes.json`,
    JSON.stringify(shapesToJson(shapesDetail(conditions, shapes, sheetLabel), projectName), null, 2),
    "application/json");

  const th = { textAlign: "right", padding: "7px 10px", fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)", borderBottom: "1px solid var(--ink)", whiteSpace: "nowrap" };
  const td = { textAlign: "right", padding: "8px 10px", fontVariantNumeric: "tabular-nums", borderBottom: "1px solid var(--ink-faint)", whiteSpace: "nowrap" };

  // one condition-table cell, keyed off the column profile; values come
  // through GETTERS so the table and the CSV read the same numbers
  const renderCell = (col, r) => {
    const v = GETTERS[col.key] ? GETTERS[col.key](r, ctx) : r[col.key];
    switch (col.key) {
      case "finish":
        return (
          <td key={col.key} style={{ ...td, textAlign: "left" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 12, height: 12, background: r.color, display: "inline-block", border: "1px solid var(--ink-faint)" }} />
              <strong style={{ fontFamily: "var(--f-mono)", fontWeight: 600 }}>{r.finish_tag}</strong>
              {r.multiplier > 1 && <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>×{r.multiplier}</span>}
            </span>
          </td>
        );
      case "shapes":
        return <td key={col.key} style={td}>{v}</td>;
      case "waste_pct":
        return <td key={col.key} style={td}>{v ? `${num(v, 0)}%` : "—"}</td>;
      case "ea":
        return <td key={col.key} style={td}>{v ? num(v, 0) : "—"}</td>;
      case "total_sf_net":
        return <td key={col.key} style={{ ...td, fontWeight: 700, color: "var(--cobalt)" }}>{r.total_sf ? num(v) : "—"}</td>;
      case "sy_net":
        return <td key={col.key} style={{ ...td, color: "var(--cobalt)" }}>{r.total_sf ? num(v) : "—"}</td>;
      case "perimeter_ref":
        return <td key={col.key} style={{ ...td, color: "var(--ink-muted)" }}>{v ? num(v) : "—"}</td>;
      default: // floor_sf, wall_sf, border_sf, lf, waste_sf, waste_lf, …
        return <td key={col.key} style={td}>{v ? num(v) : "—"}</td>;
    }
  };

  // picker row — finish is locked (filtered out of the lists below)
  const colCheckbox = (c) => (
    <React.Fragment key={c.key}>
      <label style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0", cursor: "pointer" }}>
        <input type="checkbox" checked={colPrefs[c.key] ?? c.defaultVisible} onChange={() => toggleCol(c)} />
        <span>{c.header}</span>
      </label>
      {COL_HINTS[c.key] && (
        <div style={{ margin: "0 0 4px 24px", fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1.5 }}>{COL_HINTS[c.key]}</div>
      )}
    </React.Fragment>
  );

  return (
    <div className="report-panel" style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", background: "var(--paper-cream)" }}>
      <div className="report-toolbar" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: "1px solid var(--ink)", background: "var(--paper-bright)" }}>
        <Icon name="takeoffs" size={18} />
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)" }}>Takeoff report</strong>
        <input value={projectName} onChange={(e) => onProjectName(e.target.value)} placeholder="Project name (optional)"
          className="field-input" style={{ width: 260, padding: "5px 9px", fontSize: 13 }} />
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={() => setShowInfo(true)}
          title="Your company identity and the client/job details for the print header and marked-set cover">Project info</button>
        <div ref={colsRef} style={{ position: "relative" }}>
          <button className="btn-ghost" onClick={() => setShowCols((s) => !s)} title="Choose which columns the table and CSV show">Columns</button>
          {showCols && (
            <div className="report-modal" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 70, width: 272, background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-2)", padding: "10px 12px", fontSize: 12.5, color: "var(--ink)" }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                <strong style={{ fontFamily: "var(--f-display)", fontSize: 13 }}>Columns</strong>
                <div style={{ flex: 1 }} />
                <button onClick={() => { setColPrefs({}); saveColPrefs({}); }} title="Back to the default column set"
                  style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11.5, padding: "0 10px 0 0" }}>Reset</button>
                <button onClick={() => setShowCols(false)} title="Close"
                  style={{ border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
              </div>
              {TABLE_PROFILE.filter((c) => c.key !== "finish" && c.defaultVisible).map(colCheckbox)}
              <div style={{ borderTop: "1px solid var(--ink-faint)", margin: "8px 0 4px", paddingTop: 6, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>Optional</div>
              {TABLE_PROFILE.filter((c) => c.key !== "finish" && !c.defaultVisible).map(colCheckbox)}
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--ink-muted)" }}>Also applies to the CSV export.</p>
            </div>
          )}
        </div>
        <button className="btn-ghost" onClick={exportCsv} disabled={!rows.length}><Icon name="document" size={13} />CSV</button>
        <button className="btn-ghost" onClick={exportJson} disabled={!rows.length}><Icon name="document" size={13} />JSON</button>
        <button className="btn-ghost" onClick={exportShapesCsv} disabled={!shapes.length}
          title="Per-shape measured quantities — no multiplier, no waste"><Icon name="document" size={13} />Shapes CSV</button>
        <button className="btn-ghost" onClick={exportShapesJson} disabled={!shapes.length}
          title="Per-shape measured quantities — no multiplier, no waste"><Icon name="document" size={13} />Shapes JSON</button>
        <button className="btn-ghost" onClick={() => window.print()} disabled={!rows.length}>Print</button>
        {onMarkedSet && (
          <button className="btn-ghost" onClick={onMarkedSet} disabled={!rows.length}
            title={`Distribution PDF — marked sheets with the takeoff burned in, plus a legend cover${markedSetDark ? " (dark, following your view)" : ""}`}>
            <Icon name="document" size={13} />Marked set{markedSetDark ? " ☾" : ""}
          </button>
        )}
        <button className="btn-primary" onClick={() => setShowContribute(true)} disabled={!rows.length}
          title="Optionally contribute this takeoff's derived data to the open flooring model">
          <Icon name="oneClick" size={13} />Contribute
        </button>
        <button onClick={onClose} title="Back to the canvas (Esc)"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12.5 }}>
          <Icon name="close" size={12} />Close
        </button>
      </div>

      <div className="report-scroll" style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>
        {/* print pagination: the flow-table's thead repeats this one-line strip at
            the top of every printed page (screen hides it) — a fixed footer would
            overlap the last row of intermediate pages */}
        <table className="report-flow"><thead><tr><td>
          {projectName || "Untitled project"} — Quantities derived from drawings at stated scales; verify in field.
        </td></tr></thead><tbody><tr><td>
        {/* print-only masthead — hidden on screen via app.css */}
        <div className="report-print-header">
          {(company.logo || company.name || company.address) && (
            <div style={{ marginBottom: 10 }}>
              {company.logo && <img src={company.logo} alt="" style={{ maxHeight: 48, maxWidth: 200, display: "block", marginBottom: 4 }} />}
              {company.name && <div style={{ fontWeight: 700, fontSize: 12 }}>{company.name}</div>}
              {company.address && <div style={{ fontSize: 10.5, whiteSpace: "pre-line" }}>{company.address}</div>}
            </div>
          )}
          <div style={{ fontFamily: "var(--f-display)", fontSize: 20, fontWeight: 700 }}>{projectName || "Untitled project"}</div>
          {hasClient && (
            <div style={{ fontSize: 10.5, marginTop: 2, lineHeight: 1.5 }}>
              {clientInfo.client_name && <div>Prepared for: {clientInfo.client_name}</div>}
              {clientInfo.client_address && <div style={{ whiteSpace: "pre-line" }}>{clientInfo.client_address}</div>}
              {clientInfo.reference && <div>Ref: {clientInfo.reference}</div>}
              {clientInfo.date && <div>Date: {clientInfo.date}</div>}
            </div>
          )}
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, margin: "2px 0 0" }}>Generated {new Date().toLocaleDateString()}</div>
          {scaleInfo.length > 0 && (
            <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, lineHeight: 1.6, marginTop: 6 }}>
              {scaleInfo.map((si) => (
                <div key={si.sheet_id}>{sheetLabel ? sheetLabel(si.sheet_id) : si.sheet_id} — {si.source}</div>
              ))}
            </div>
          )}
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, marginTop: 6 }}>OpenTakeoff — opentakeoff.netlify.app</div>
          <div style={{ fontSize: 10.5, marginTop: 2, borderBottom: "1px solid var(--ink-faint)", paddingBottom: 8, marginBottom: 12 }}>
            Quantities derived from drawings at stated scales; verify in field.
          </div>
        </div>
        {!rows.length ? (
          <div style={{ padding: 48, textAlign: "center", color: "var(--ink-muted)" }}>
            Nothing measured yet — trace some areas, then come back for the breakdown.
          </div>
        ) : (
          <table style={{ width: "100%", maxWidth: 980, margin: "0 auto", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
            <thead>
              <tr>
                {tableCols.map((c) => (
                  <th key={c.key} style={c.key === "finish" ? { ...th, textAlign: "left" } : c.accent ? { ...th, color: "var(--cobalt)" } : th}>{c.header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {tableCols.map((c) => renderCell(c, r))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ ...td, textAlign: "left", borderTop: "2px solid var(--ink)", fontWeight: 700 }}>Total</td>
                {/* finish is always first & locked; every other visible column gets its
                    own td — footed columns render foot(g), ref columns never foot */}
                {tableCols.slice(1).map((c) => (
                  c.foot && !c.ref ? (
                    <td key={c.key} style={{ ...td, borderTop: "2px solid var(--ink)", ...(c.accent ? { color: "var(--cobalt)", ...(c.key === "total_sf_net" ? { fontWeight: 700 } : {}) } : {}) }}>{num(c.foot(g))}</td>
                  ) : (
                    <td key={c.key} style={{ ...td, borderTop: "2px solid var(--ink)" }}></td>
                  )
                ))}
              </tr>
            </tfoot>
          </table>
        )}
        {rows.length > 0 && (
          <p style={{ maxWidth: 980, margin: "14px auto 0", fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.6 }}>
            <strong>SF ordered</strong> = measured quantity × waste %. Waste is set per condition in the canvas. Wall SF comes from Surface-Area
            traces (run × height); Border SF from Linear runs with a thickness.
            {tableCols.some((c) => c.key === "perimeter_ref") && (
              <> Perim LF (ref) sums floor-trace perimeters — includes door openings and shared walls; reference only, never totaled or waste-adjusted.</>
            )}
          </p>
        )}
        {rows.length > 0 && bySheet.length > 0 && (
          <div style={{ maxWidth: 980, margin: "26px auto 0" }}>
            <h3 style={{ fontFamily: "var(--f-display)", fontSize: 14, color: "var(--ink)", margin: "0 0 8px" }}>By sheet</h3>
            {bySheet.map((gp) => (
              <div key={gp.sheet_id} style={{ margin: "0 0 14px" }}>
                <h3 style={{ fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: "0.06em", color: "var(--ink-muted)", margin: "0 0 6px" }}>{sheetLabel ? sheetLabel(gp.sheet_id) : gp.sheet_id}</h3>
                <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: "left" }}>Finish</th>
                      <th style={th}>Floor SF</th>
                      <th style={th}>Wall SF</th>
                      <th style={th}>Border SF</th>
                      <th style={th}>LF</th>
                      <th style={th}>EA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gp.rows.map((r) => (
                      <tr key={r.id}>
                        <td style={{ ...td, textAlign: "left" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <span style={{ width: 12, height: 12, background: r.color, display: "inline-block", border: "1px solid var(--ink-faint)" }} />
                            <strong style={{ fontFamily: "var(--f-mono)", fontWeight: 600 }}>{r.finish_tag}</strong>
                            {r.multiplier > 1 && <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>×{r.multiplier}</span>}
                          </span>
                        </td>
                        <td style={td}>{sheetNum(r.floor_sf)}</td>
                        <td style={td}>{sheetNum(r.wall_sf)}</td>
                        <td style={td}>{sheetNum(r.border_sf)}</td>
                        <td style={td}>{sheetNum(r.lf)}</td>
                        <td style={td}>{sheetNum(r.ea, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <p style={{ margin: "10px auto 0", fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.6 }}>
              Base quantities as measured per sheet — waste not applied.
              {bySheet.some((gp) => gp.rows.some((r) => r.multiplier > 1)) && (
                <> By-sheet rows show measured (base) quantities; ×N multipliers apply at the condition level — sheet subtotals × multiplier reconcile to the condition table.</>
              )}
            </p>
          </div>
        )}
        {markups.length > 0 && (
          <div style={{ maxWidth: 980, margin: "26px auto 0" }}>
            <h3 style={{ fontFamily: "var(--f-display)", fontSize: 14, color: "var(--ink)", margin: "0 0 8px" }}>Revisions noted</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>Type</th>
                  <th style={{ ...th, textAlign: "left" }}>Sheet</th>
                  <th style={{ ...th, textAlign: "left" }}>Note</th>
                </tr>
              </thead>
              <tbody>
                {markups.map((m) => (
                  <tr key={m.id}>
                    <td style={{ ...td, textAlign: "left" }}>
                      <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: "0.08em", border: "1px solid var(--ink-faint)", padding: "1px 6px", color: "var(--ink-soft)" }}>
                        {m.type === "cloud" ? "CLOUD" : m.type === "callout" ? "CALLOUT" : "NOTE"}
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: "left", fontFamily: "var(--f-mono)", fontSize: 11.5 }}>{sheetLabel ? sheetLabel(m.sheet_id) : m.sheet_id}</td>
                    <td style={{ ...td, textAlign: "left", whiteSpace: "normal", width: "60%" }}>{m.text || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ margin: "10px auto 0", fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.6 }}>
              Markups are annotations, not measurements — quantities above are unaffected.
            </p>
          </div>
        )}
        {matSummary.length > 0 && (
          <div style={{ maxWidth: 980, margin: "26px auto 0" }}>
            <h3 style={{ fontFamily: "var(--f-display)", fontSize: 14, color: "var(--ink)", margin: "0 0 8px" }}>Supporting materials — buy list</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>Material</th>
                  <th style={th}>Quantity</th>
                  <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>Unit</th>
                </tr>
              </thead>
              <tbody>
                {matSummary.map((m, i) => (
                  <tr key={i}>
                    <td style={{ ...td, textAlign: "left" }}>{m.name}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{num(m.qty, 2)}</td>
                    <td style={{ ...td, textAlign: "left", paddingLeft: 16, color: "var(--ink-muted)" }}>{m.unit || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ maxWidth: 980, margin: "10px auto 0", fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.7 }}>
              <strong>By finish:</strong>{" "}
              {rows.filter((r) => r.materials?.length).map((r) => (
                <span key={r.id} style={{ marginRight: 14, whiteSpace: "nowrap" }}>
                  <strong style={{ fontFamily: "var(--f-mono)" }}>{r.finish_tag}</strong>{" "}
                  {r.materials.map((m) => `${m.name} ${num(m.qty, 2)}${m.unit ? " " + m.unit : ""}${m.note ? ` (${m.note})` : ""}`).join(" · ")}
                </span>
              ))}
              <br />Each quantity = measured {`{area / linear / count}`} ÷ your coverage rate, rounded up to whole units.
            </p>
          </div>
        )}
        </td></tr></tbody></table>
      </div>

      {showContribute && (
        <ContributeModal conditions={conditions} shapes={shapes} onClose={() => setShowContribute(false)} />
      )}
      {showInfo && (
        <ProjectInfoModal clientInfo={clientInfo} onClientInfo={onClientInfo}
          onSaved={() => setIdentityRev((r) => r + 1)} onClose={() => setShowInfo(false)} />
      )}
    </div>
  );
}

// Project info — two homes: company identity is per-device (identity.js /
// localStorage), client/job fields are per-project (onClientInfo → autosave).
// Company edits save on every change, so an overlay-click close loses nothing;
// onSaved bumps identityRev so the print masthead re-reads immediately.
function ProjectInfoModal({ clientInfo = {}, onClientInfo, onSaved, onClose }) {
  const [company, setCompany] = useState(loadCompany);
  const [logoErr, setLogoErr] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);

  // functional form: the merge must land on whatever company is CURRENT — the
  // logo path awaits a slow normalize, and name/address typed meanwhile must
  // not be reverted by a stale snapshot
  const setAndSave = (updater) => {
    setCompany((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const ok = saveCompany(next);
      setSaveFailed(!ok);
      if (ok && onSaved) onSaved();
      return next;
    });
  };

  const onLogoFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // re-picking the same file must still fire onChange
    if (!file) return;
    setLogoErr("");
    try {
      const logo = await normalizeLogoToPng(file);
      setAndSave((prev) => ({ ...prev, logo }));
    } catch (err) {
      setLogoErr(err.message || String(err));
    }
  };
  const removeLogo = () => setAndSave(({ logo, ...rest }) => rest);
  const client = (field) => (e) => onClientInfo && onClientInfo({ ...clientInfo, [field]: e.target.value });

  const section = { fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" };
  const row = { display: "block", margin: "8px 0" };
  const err = { margin: "6px 0 0", fontSize: 11.5, color: "var(--c-danger)" };

  return (
    <div onClick={onClose} className="report-modal" style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(14,26,46,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: 520, maxWidth: "100%", maxHeight: "90%", overflow: "auto", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--ink)" }}>
          <Icon name="document" size={16} />
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 15 }}>Project info</strong>
        </div>
        <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          <div style={section}>Company — yours, saved on this device</div>
          <label style={row}>
            <span className="field-label">Name</span>
            <input value={company.name || ""} onChange={(e) => setAndSave((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="Your company" className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={row}>
            <span className="field-label">Address</span>
            <textarea value={company.address || ""} onChange={(e) => setAndSave((prev) => ({ ...prev, address: e.target.value }))}
              rows={2} placeholder={"Street\nCity, ST"} className="field-input" style={{ marginTop: 4, resize: "vertical" }} />
          </label>
          <div style={row}>
            <span className="field-label">Logo</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
              <input type="file" accept="image/*" onChange={onLogoFile} style={{ fontSize: 12, minWidth: 0 }} />
              {company.logo && (
                <>
                  <img src={company.logo} alt="Company logo" style={{ width: 120, height: "auto", flex: "none", border: "1px solid var(--ink-faint)", background: "#fff" }} />
                  <button onClick={removeLogo}
                    style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11.5, padding: 0, whiteSpace: "nowrap" }}>Remove logo</button>
                </>
              )}
            </div>
            {logoErr && <p style={err}>{logoErr}</p>}
          </div>
          {saveFailed && <p style={err}>Couldn't save on this device</p>}
          <div style={{ ...section, borderTop: "1px solid var(--ink-faint)", marginTop: 14, paddingTop: 12 }}>Client / job — saved with this project</div>
          <label style={row}>
            <span className="field-label">Client name</span>
            <input value={clientInfo.client_name || ""} onChange={client("client_name")} className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={row}>
            <span className="field-label">Client address</span>
            <textarea value={clientInfo.client_address || ""} onChange={client("client_address")} rows={2}
              className="field-input" style={{ marginTop: 4, resize: "vertical" }} />
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ ...row, flex: 1 }}>
              <span className="field-label">PO / reference</span>
              <input value={clientInfo.reference || ""} onChange={client("reference")} className="field-input" style={{ marginTop: 4 }} />
            </label>
            <label style={{ ...row, flex: 1 }}>
              <span className="field-label">Date</span>
              <input value={clientInfo.date || ""} onChange={client("date")} placeholder={'e.g. "Bid 7/12"'}
                className="field-input" style={{ marginTop: 4 }} />
            </label>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 16px", borderTop: "1px solid var(--ink-faint)" }}>
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function ContributeModal({ conditions, shapes, onClose }) {
  const [attest, setAttest] = useState(false);
  const [contributor, setContributor] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | done | error
  const [msg, setMsg] = useState("");
  const configured = isContributeConfigured();

  const send = async () => {
    if (!attest || !configured) return;
    setState("sending"); setMsg("");
    try {
      await sendContribution(buildContribution({ conditions, shapes }), contributor.trim());
      setState("done"); setMsg("Thank you — your takeoff is now helping train the open flooring model.");
    } catch (e) {
      setState("error"); setMsg(e.message || String(e));
    }
  };

  return (
    <div onClick={onClose} className="report-modal" style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(14,26,46,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: 520, maxWidth: "100%", maxHeight: "90%", overflow: "auto", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--ink)" }}>
          <Icon name="oneClick" size={16} />
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 15 }}>Contribute to the open flooring model</strong>
        </div>
        <div style={{ padding: "16px", fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          <p style={{ marginTop: 0 }}>Help grow a shared, flooring-tuned open model. We send only the <strong>derived takeoff</strong>:</p>
          <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
            <li>condition labels, shape types, and quantities (SF / LF / EA)</li>
            <li>normalized room geometry (shape only — no scale, no location)</li>
          </ul>
          <p style={{ margin: "0 0 10px", color: "var(--c-positive)", fontWeight: 600 }}>
            Never sent: the PDF itself, file names, project or client names, your markups, or any absolute coordinates.
          </p>
          {!configured && (
            <p style={{ background: "var(--paper-shadow)", padding: "8px 10px", fontSize: 12.5, color: "var(--ink)" }}>
              This build has no contribution endpoint configured, so nothing can be sent. (Set <code>VITE_CONTRIBUTE_ENDPOINT</code> at build time, or
              <code> localStorage.opentakeoff_contribute_endpoint</code> in your browser.)
            </p>
          )}
          <label style={{ display: "block", margin: "6px 0" }}>
            <span className="field-label">Credit (optional)</span>
            <input value={contributor} onChange={(e) => setContributor(e.target.value)} placeholder="Name or company to credit"
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "12px 0", cursor: "pointer" }}>
            <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} style={{ marginTop: 3 }} />
            <span>I have the right to share this takeoff data and am contributing it to the open flooring model.</span>
          </label>
          {msg && <p style={{ fontSize: 12.5, color: state === "error" ? "var(--c-danger)" : "var(--c-positive)" }}>{msg}</p>}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: "12px 16px", borderTop: "1px solid var(--ink-faint)" }}>
          <button className="btn-ghost" onClick={onClose}>{state === "done" ? "Close" : "Cancel"}</button>
          <button className="btn-primary" onClick={send} disabled={!attest || !configured || state === "sending" || state === "done"}>
            {state === "sending" ? "Sending…" : "Contribute"}
          </button>
        </div>
      </div>
    </div>
  );
}
