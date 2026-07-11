// ReportPanel — the takeoff deliverable. A STACK-style breakdown by condition
// (finish): measured quantity, waste %, and waste-adjusted order quantity, with
// a grand total. Exports to CSV / JSON, prints, and hosts the opt-in
// "Contribute to the open flooring model" flow.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import ToolMenu from "./ToolMenu.jsx";
import { conditionTotals, grandTotals, sheetTotals, sheetGroupedRows, labelGroupedRows, round2, totalsToCsv, downloadText, materialsSummary, reportJson, hasMultipliers, BY_SHEET_BASE_NOTE } from "../lib/totals.js";
import { TABLE_PROFILE, CSV_PROFILE, colGetter, customColProfile, specColProfile, partitionRowsBy, forceIncludeGroupCol, loadColPrefs, saveColPrefs, loadGroupBy, saveGroupBy, visibleCols, floorPerimeterLf } from "../lib/reportColumns.js";
import { columnLabel } from "../lib/conditionColumns.js";
import { shapeLabelValue } from "../lib/shapeLabels.js";
import { loadTemplates, saveTemplate, deleteTemplate, renameTemplate, mergeTemplates, overwriteTemplates } from "../lib/reportTemplates.js";
import { canSyncTemplates, pushTemplatesToDrive, loadTemplatesFromDrive } from "../lib/reportTemplatesSync.js";
import { useGoogleAuth } from "../lib/google/AuthContext.jsx";
import { projectHomeFolderId } from "../lib/projectHome.js";
import { getAccessToken } from "../lib/google/auth.js";
import { shapesDetail, shapesToCsv, shapesToJson } from "../lib/shapesExport.js";
import { rfisToCsv, rfisToJson } from "../lib/rfi.js";
import { reportWorkbook, buildXlsx } from "../lib/xlsx.js";
import { buildContribution, sendContribution, isContributeConfigured } from "../lib/contribute.js";
import { loadCompany, saveCompany, normalizeLogoToPng } from "../lib/identity.js";

const num = (v, d = 1) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });

// the report's one caveat line — page-strip on every printed page + masthead
const DISCLAIMER = "Quantities derived from drawings at stated scales; verify in field.";

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

export default function ReportPanel({ projectName, onProjectName, conditions, shapes, sheetLabel, onMarkedSet, markedSetDark, onClose, markups = [], rfis = [], scaleInfo = [], clientInfo = {}, onClientInfo, conditionColumns = [], shapeLabels = [] }) {
  // memoized on the source arrays: project-name/client-info keystrokes re-render
  // the panel without touching conditions/shapes, so the totaling passes skip
  const rows = useMemo(() => conditionTotals(conditions, shapes).filter((r) => r.shape_count > 0), [conditions, shapes]);
  const bySheet = useMemo(() => sheetTotals(conditions, shapes), [conditions, shapes]);
  const g = useMemo(() => grandTotals(rows), [rows]);
  const matSummary = useMemo(() => materialsSummary(rows), [rows]);
  const [showContribute, setShowContribute] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  // whether the Marked Set PDF carries the markups. Default on; ORTHOGONAL to the
  // canvas markup-layer hide — that never changes the export, only this does.
  const [includeMarkups, setIncludeMarkups] = useState(true);
  // bumped by the Project info modal on every company save, so the print
  // masthead's loadCompany() below re-reads (a cheap localStorage parse)
  const [identityRev, setIdentityRev] = useState(0); // eslint-disable-line no-unused-vars
  const company = loadCompany();
  const hasClient = Boolean(clientInfo.client_name || clientInfo.client_address || clientInfo.reference || clientInfo.date);
  const [colPrefs, setColPrefs] = useState(loadColPrefs);
  const [showCols, setShowCols] = useState(false);
  const colsRef = useRef(null);
  // saved report templates (#114) — named column-visibility + grouping bundles
  const [templates, setTemplates] = useState(loadTemplates);
  const [showTemplates, setShowTemplates] = useState(false);
  const [tplName, setTplName] = useState("");
  const templatesRef = useRef(null);
  // optional Drive sync of templates (#115) — offered only when signed in AND a
  // Projects root is configured. googleUser/driveRoot are also the push/load args.
  const { user: googleUser } = useGoogleAuth();
  const driveRoot = projectHomeFolderId();
  const canSync = canSyncTemplates(googleUser, driveRoot);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  // custom columns append after each profile (frozen 13 → built-in opt-ins →
  // custom), so toggling one can never disturb the frozen CSV prefix
  const customCols = customColProfile(conditionColumns);
  // read-only product-spec columns (mfr/style/color/size) from "Import from
  // schedule" — appended AFTER the custom columns, present only when at least
  // one condition carries that spec field, so a no-spec project is byte-for-
  // byte unchanged (frozen 13 → built-in opt-ins → custom → spec)
  const specCols = specColProfile(conditions);
  const tableCols = visibleCols([...TABLE_PROFILE, ...customCols, ...specCols], colPrefs);
  // group-by choice: "" (none) | "sheet" | a custom column id; normalized
  // ONCE per render and used everywhere (select value AND partitioning) — a
  // stale colId must fall back to None, never reach the select or the
  // partitioner.
  const [groupByRaw, setGroupByRaw] = useState(loadGroupBy);
  // "label" is gated on the vocab existing — the group-by pref is one device-
  // global string, so a leftover "label" opened on a label-less project (or a
  // template carrying it) must fall back to ungrouped, exactly as a stale
  // custom-column id does.
  const groupBy = groupByRaw === "sheet" || (groupByRaw === "label" && shapeLabels.length > 0) || conditionColumns.some((cc) => cc.id === groupByRaw) ? groupByRaw : "";
  // grouping force-includes its column in the CSV/XLSX even when hidden in
  // the picker (D7) — a grouped report's export always carries its grouping
  const csvCols = forceIncludeGroupCol(visibleCols([...CSV_PROFILE, ...customCols, ...specCols], colPrefs), customCols, groupBy);
  const perimByCond = useMemo(() => floorPerimeterLf(shapes), [shapes]);
  // custom-column values reach the getters through ctx, never as row fields
  // (conditionTotals rows are spread into the contribution payload)
  const attrsByCond = useMemo(() => new Map(conditions.map((c) => [c.id, c.attrs])), [conditions]);
  // spec columns read the imported product spec off the same ctx seam
  const specByCond = useMemo(() => new Map(conditions.map((c) => [c.id, c.spec])), [conditions]);
  const ctx = { perimByCond, attrsByCond, specByCond };
  // grouped view. Custom-column mode partitions the already-computed rows
  // (no recompute); sheet mode re-runs conditionTotals per sheet's shapes —
  // ORDERED quantities per slice (waste + ×N applied), each group carrying
  // its own per-sheet perimByCond for that group's cells. sheetLabel is an
  // inline arrow recreated per parent render — apply it at render time,
  // never in the memo deps.
  //
  // Degenerate single-group partitions: a lone Unassigned group (nothing
  // assigned) and a lone sheet (single-sheet project) render exactly as
  // ungrouped — the chrome would say nothing. But a lone NAMED group (every
  // condition shares one real value) keeps the caption + header: the user
  // grouped precisely to put that value on the printed page, and the CSV
  // force-includes the column, so the two outputs must agree. Its subtotal is
  // still suppressed — it would duplicate the grand TOTAL directly below it.
  const groupCol = groupBy && groupBy !== "sheet" ? conditionColumns.find((cc) => cc.id === groupBy) : null;
  const colGroups = useMemo(() => (groupCol ? partitionRowsBy(rows, groupCol, attrsByCond) : null), [rows, groupCol, attrsByCond]);
  const sheetGroups = useMemo(() => (groupBy === "sheet" ? sheetGroupedRows(conditions, shapes) : null), [groupBy, conditions, shapes]);
  // label mode: ORDERED per-bucket rows (waste + ×N per slice), already shaped
  // { value, label, rows, perimByCond } like the sheet groups after mapping.
  const labelGroups = useMemo(() => (groupBy === "label" ? labelGroupedRows(conditions, shapes, shapeLabels) : null), [groupBy, conditions, shapes, shapeLabels]);
  const groups = sheetGroups
    ? sheetGroups.map((gp) => ({ value: gp.sheet_id, label: sheetLabel ? sheetLabel(gp.sheet_id) : gp.sheet_id, rows: gp.rows, perimByCond: gp.perimByCond }))
    : labelGroups || colGroups;
  const grouped = Boolean(groups && (groups.length > 1 || ((groupCol || groupBy === "label") && groups.length === 1 && groups[0].value !== null)));
  // exports always carry the by-label breakdown when any shape is labeled,
  // independent of the current group-by view; empty (→ CSV/JSON byte-unchanged)
  // for label-less projects.
  const byLabelExport = useMemo(() => (shapes.some((s) => shapeLabelValue(s)) ? labelGroupedRows(conditions, shapes, shapeLabels) : []), [conditions, shapes, shapeLabels]);

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

  // templates popover — same outside-click close as columns
  useEffect(() => {
    if (!showTemplates) return;
    const onDown = (e) => { if (templatesRef.current && !templatesRef.current.contains(e.target)) setShowTemplates(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showTemplates]);

  // Apply a template: set BOTH the column prefs and the grouping mode, and write
  // them through to the sticky defaults so the layout persists (and #14's "By
  // label" mode, captured as a string, self-heals via the group-by normalizer on
  // a label-less project). Save-as snapshots the CURRENT layout under a name;
  // groupByRaw (not the normalized groupBy) is captured so the user's real choice
  // round-trips even when momentarily invalid.
  const applyTemplate = (t) => {
    setColPrefs(t.cols); saveColPrefs(t.cols);
    setGroupByRaw(t.groupBy); saveGroupBy(t.groupBy);
    setShowTemplates(false);
  };
  const saveAsTemplate = () => {
    const nm = tplName.trim();
    if (!nm) return;
    setTemplates(saveTemplate(nm, colPrefs, groupByRaw));
    setTplName("");
  };
  const renameTpl = (t) => {
    const nm = (window.prompt("Rename template:", t.name) || "").trim();
    if (!nm || nm === t.name) return;
    setTemplates(renameTemplate(t.id, nm));
  };

  // Push/Load — Drive sync (#115). drive.js is a DYNAMIC import so the Drive
  // client never lands in the anonymous bundle (mirrors ProjectHome.jsx);
  // getAccessToken is safe to import statically (auth.js already ships).
  const pushToDrive = async () => {
    if (!canSync || syncBusy) return;
    setSyncBusy(true); setSyncMsg("Pushing…");
    try {
      const { createDrive } = await import("../lib/google/drive.js");
      const { count } = await pushTemplatesToDrive(createDrive({ getToken: getAccessToken }), driveRoot, googleUser.email, templates);
      setSyncMsg(`Pushed ${count} to Drive.`);
    } catch (e) {
      setSyncMsg(`Push failed: ${String(e?.message || e)}`);
    } finally { setSyncBusy(false); }
  };
  const loadFromDrive = async () => {
    if (!canSync || syncBusy) return;
    setSyncBusy(true); setSyncMsg("Loading…");
    try {
      const { createDrive } = await import("../lib/google/drive.js");
      const remote = await loadTemplatesFromDrive(createDrive({ getToken: getAccessToken }), driveRoot, googleUser.email);
      // Merge against the IN-MEMORY set (the source of truth the popover shows),
      // not a fresh localStorage read — a blocked-storage read would look empty
      // and drop templates that are live in state.
      const before = templates.length;
      const merged = overwriteTemplates(mergeTemplates(templates, remote));
      setTemplates(merged);
      const added = merged.length - before;
      // Disambiguate a zero result: an empty Drive file reads differently to a
      // user than "you already have everything on Drive."
      setSyncMsg(added > 0 ? `Loaded ${added} from Drive.` : remote.length === 0 ? "Nothing saved on Drive yet." : "Already up to date — no new templates.");
    } catch (e) {
      setSyncMsg(`Load failed: ${String(e?.message || e)}`);
    } finally { setSyncBusy(false); }
  };

  // store only diffs from defaultVisible — a key toggled back to default is dropped
  const toggleCol = (col) => {
    const next = { ...colPrefs };
    const want = !(colPrefs[col.key] ?? col.defaultVisible);
    if (want === col.defaultVisible) delete next[col.key]; else next[col.key] = want;
    setColPrefs(next);
    saveColPrefs(next);
  };

  const baseName = (projectName || "takeoff").replace(/[^\w.-]+/g, "_");
  const exportCsv = () => downloadText(`${baseName}.csv`, totalsToCsv(rows, projectName, bySheet, sheetLabel, csvCols, ctx, byLabelExport.length ? byLabelExport : null), "text/csv");
  const exportJson = () => downloadText(`${baseName}.json`,
    JSON.stringify(reportJson({ projectName, rows, bySheet, scaleInfo, markups, rfis, sheetLabel, conditionColumns, attrsByCond, shapeLabels, byLabel: byLabelExport }), null, 2),
    "application/json");
  const exportRfisCsv = () => downloadText(`${baseName}_rfis.csv`, rfisToCsv(rfis, markups, projectName, sheetLabel), "text/csv");
  const exportRfisJson = () => downloadText(`${baseName}_rfis.json`,
    JSON.stringify(rfisToJson(rfis, projectName), null, 2), "application/json");
  // Excel workbook — same sources as the CSV/JSON (Conditions tab follows the
  // column picker like the CSV); buildXlsx lazy-loads fflate on first use
  const exportXlsx = async () => {
    const sheets = reportWorkbook({ rows, bySheet, shapeRows: shapesDetail(conditions, shapes, sheetLabel), cols: csvCols, ctx, sheetLabel });
    const bytes = await buildXlsx(sheets);
    downloadText(`${baseName}.xlsx`, bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  };
  const exportShapesCsv = () => downloadText(`${baseName}_shapes.csv`, shapesToCsv(shapesDetail(conditions, shapes, sheetLabel), projectName), "text/csv");
  const exportShapesJson = () => downloadText(`${baseName}_shapes.json`,
    JSON.stringify(shapesToJson(shapesDetail(conditions, shapes, sheetLabel), projectName), null, 2),
    "application/json");

  const th = { textAlign: "right", padding: "7px 10px", fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)", borderBottom: "1px solid var(--ink)", whiteSpace: "nowrap" };
  const td = { textAlign: "right", padding: "8px 10px", fontVariantNumeric: "tabular-nums", borderBottom: "1px solid var(--ink-faint)", whiteSpace: "nowrap" };

  // one condition-table cell, keyed off the column profile; values come
  // through the shared colGetter so the table and the CSV read the same
  // numbers. Sheet groups pass their own ctx (per-sheet perimByCond).
  const renderCell = (col, r, cellCtx) => {
    const get = colGetter(col);
    const v = get ? get(r, cellCtx) : r[col.key];
    // custom columns and read-only spec columns: plain left-aligned text
    // (already coerced to string by their getter); TOTAL cells stay blank (no foot).
    // spec cells can hold sentence-length values (esp. Description) — let them WRAP
    // and cap the width so one long value can't push report/print columns off the
    // page edge (mirrors the notes cell below). Custom columns stay nowrap.
    if (col.custom || col.spec) {
      const cell = col.spec ? { ...td, textAlign: "left", whiteSpace: "normal", maxWidth: 240 } : { ...td, textAlign: "left" };
      return <td key={col.key} style={cell}>{v || "—"}</td>;
    }
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

  // picker row — locked columns (finish) are filtered out of the lists below
  const colCheckbox = (c) => (
    <React.Fragment key={c.key}>
      <label style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0", cursor: "pointer" }}>
        <input name="report-column-toggle" type="checkbox" checked={colPrefs[c.key] ?? c.defaultVisible} onChange={() => toggleCol(c)} />
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
        <input name="project-name" value={projectName} onChange={(e) => onProjectName(e.target.value)} placeholder="Project name (optional)"
          className="field-input" style={{ width: 260, padding: "5px 9px", fontSize: 13 }} />
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={() => setShowInfo(true)}
          title="Your company identity and the client/job details for the print header and marked-set cover">Project info</button>
        {/* always rendered, even with zero custom columns — Sheet grouping
            is useful on its own */}
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink)", whiteSpace: "nowrap" }}
          title="Break the condition table into sections with subtotals">
          Group:
          <select name="report-group-by" value={groupBy} onChange={(e) => { setGroupByRaw(e.target.value); saveGroupBy(e.target.value); }}
            style={{ padding: "5px 6px", border: "1px solid var(--ink-faint)", background: "transparent", fontSize: 12, maxWidth: 160 }}>
            <option value="">None</option>
            <option value="sheet">Sheet</option>
            {shapeLabels.length > 0 && <option value="label">Label</option>}
            {conditionColumns.map((cc) => (
              <option key={cc.id} value={cc.id}>{columnLabel(cc)}</option>
            ))}
          </select>
        </label>
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
              {TABLE_PROFILE.filter((c) => !c.locked && c.defaultVisible).map(colCheckbox)}
              <div style={{ borderTop: "1px solid var(--ink-faint)", margin: "8px 0 4px", paddingTop: 6, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>Optional</div>
              {TABLE_PROFILE.filter((c) => !c.locked && !c.defaultVisible).map(colCheckbox)}
              <div style={{ borderTop: "1px solid var(--ink-faint)", margin: "8px 0 4px", paddingTop: 6, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>Custom columns</div>
              {customCols.length ? customCols.map(colCheckbox) : (
                <div style={{ fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1.5 }}>No custom columns yet — define them from the condition bar in the canvas.</div>
              )}
              {/* read-only product-spec columns — only shown when a schedule
                  import attached spec data to at least one condition */}
              {specCols.length > 0 && (
                <>
                  <div style={{ borderTop: "1px solid var(--ink-faint)", margin: "8px 0 4px", paddingTop: 6, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>Product spec (imported)</div>
                  {specCols.map(colCheckbox)}
                </>
              )}
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--ink-muted)" }}>Also applies to the CSV export. Grouping by a custom column always exports that column.</p>
            </div>
          )}
        </div>
        <div ref={templatesRef} style={{ position: "relative" }}>
          <button className="btn-ghost" onClick={() => setShowTemplates((s) => !s)} title="Save and recall report layouts (columns + grouping)">Templates{templates.length ? ` (${templates.length})` : ""}</button>
          {showTemplates && (
            <div className="report-modal" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 70, width: 260, background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-2)", padding: "10px 12px", fontSize: 12.5, color: "var(--ink)" }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                <strong style={{ fontFamily: "var(--f-display)", fontSize: 13 }}>Templates</strong>
                <div style={{ flex: 1 }} />
                <button onClick={() => setShowTemplates(false)} title="Close"
                  style={{ border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1.4, marginBottom: 6 }}>Saved column + grouping layouts (this device). Click one to apply.</div>
              {templates.length === 0 && <div style={{ fontSize: 10.5, color: "var(--ink-muted)", marginBottom: 6 }}>No saved templates yet.</div>}
              {templates.map((t) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 0" }}>
                  <button onClick={() => applyTemplate(t)} title="Apply this layout"
                    style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12, padding: "3px 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</button>
                  <button onClick={() => renameTpl(t)} title="Rename"
                    style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                  <button onClick={() => setTemplates(deleteTemplate(t.id))} title="Delete this template"
                    style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 6, borderTop: "1px solid var(--ink-faint)", marginTop: 6, paddingTop: 8 }}>
                <input name="template-name" value={tplName} onChange={(e) => setTplName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && saveAsTemplate()}
                  placeholder="Name this layout" style={{ flex: 1, minWidth: 0, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
                <button onClick={saveAsTemplate} disabled={!tplName.trim()} title="Save the current columns + grouping under this name"
                  style={{ padding: "3px 8px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>Save</button>
              </div>
              {/* Optional Drive sync — only when signed in and a Projects root is
                  configured. Load MERGES (this device wins on a name clash); it
                  does not pull remote deletes/edits, so the copy stays "Load," not
                  "Sync," to avoid over-promising two-way behavior. */}
              {canSync && (
                <div style={{ borderTop: "1px solid var(--ink-faint)", marginTop: 8, paddingTop: 8 }}>
                  <div style={{ fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1.4, marginBottom: 6 }}>Carry these across your own devices via Drive. Load only adds templates this device doesn't have — a same-name template is never overwritten (rename or delete it here first to pull a newer copy).</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={pushToDrive} disabled={syncBusy} title="Write your saved templates to your private Drive file"
                      style={{ flex: 1, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--cobalt)", cursor: syncBusy ? "default" : "pointer", fontSize: 12 }}>Push to Drive</button>
                    <button onClick={loadFromDrive} disabled={syncBusy} title="Merge templates from your Drive file into this device"
                      style={{ flex: 1, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--cobalt)", cursor: syncBusy ? "default" : "pointer", fontSize: 12 }}>Load from Drive</button>
                  </div>
                  {syncMsg && <div style={{ fontSize: 10.5, color: "var(--ink-muted)", marginTop: 6 }}>{syncMsg}</div>}
                </div>
              )}
            </div>
          )}
        </div>
        {/* Exports consolidated into Export ▾; browser print + marked set into
            Print ▾. JSON / Print / Marked set intentionally work markups-only
            ("Revisions noted" renders from markups alone); CSV stays rows-only.
            Every item keeps the exact disabled condition + tooltip its button
            carried. RFI exports stay their own controls, shown only when RFIs exist. */}
        <ToolMenu
          title="Download the report and shape data"
          disabled={!rows.length && !shapes.length && !markups.length && !rfis.length}
          face={<><Icon name="document" size={13} />Export</>}
          items={[
            { section: "Report" },
            { id: "csv", icon: "document", label: "CSV", disabled: !rows.length, onSelect: exportCsv },
            { id: "xlsx", icon: "document", label: "Excel", disabled: !rows.length, title: "Excel workbook — Conditions / By sheet / Materials / Shapes", onSelect: exportXlsx },
            { id: "json", icon: "document", label: "JSON", disabled: !rows.length && !markups.length && !rfis.length, title: "JSON — works markups-only / RFI-only too", onSelect: exportJson },
            { section: "Shapes" },
            { id: "shapes-csv", icon: "document", label: "Shapes CSV", disabled: !shapes.length, title: "Per-shape measured quantities — no multiplier, no waste", onSelect: exportShapesCsv },
            { id: "shapes-json", icon: "document", label: "Shapes JSON", disabled: !shapes.length, title: "Per-shape measured quantities — no multiplier, no waste", onSelect: exportShapesJson },
          ]}
        />
        <ToolMenu
          title="Print the report, or generate the marked-set PDF"
          disabled={!rows.length && !markups.length && !rfis.length /* both items are disabled exactly here: with no rows/rfis, the marked-set condition also collapses to true */}
          face={<span>Print</span>}
          items={[
            { id: "print", label: "Print report", disabled: !rows.length && !markups.length && !rfis.length, title: "Print the on-screen report (browser print / save as PDF)", onSelect: () => window.print() },
            ...(onMarkedSet ? [
              "divider",
              { section: "Marked set" },
              ...(markups.length > 0 ? [{ id: "inc-markups", label: "Include markups", checked: includeMarkups, stayOpen: true, title: "Include your markups (clouds, callouts, notes, highlights) in the Marked Set PDF. Independent of the canvas layer toggle.", onSelect: () => setIncludeMarkups((v) => !v) }] : []),
              { id: "marked-set", icon: "document", label: `Download marked set${markedSetDark ? " ☾" : ""}`, disabled: !rows.length && (!includeMarkups || !markups.length) && !rfis.length, title: `Distribution PDF — marked sheets with the takeoff burned in, plus a legend cover${markedSetDark ? " (dark, following your view)" : ""}`, onSelect: () => onMarkedSet(includeMarkups) },
            ] : []),
          ]}
        />
        {rfis.length > 0 && (
          <>
            <button className="btn-ghost" onClick={exportRfisCsv}
              title="RFI log — one row per RFI with linked markups/sheets derived"><Icon name="rfi" size={13} />RFI CSV</button>
            <button className="btn-ghost" onClick={exportRfisJson}
              title="RFI log as JSON"><Icon name="rfi" size={13} />RFI JSON</button>
          </>
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
          {projectName || "Untitled project"} — {DISCLAIMER}
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
              {/* print-overflow guard: a pasted 40-line address must not eat the
                  page (the PDF cover caps its whole client block at 6 lines) */}
              {clientInfo.client_address && <div style={{ whiteSpace: "pre-line" }}>{clientInfo.client_address.split("\n").slice(0, 6).join("\n")}</div>}
              {clientInfo.reference && <div>Ref: {clientInfo.reference}</div>}
              {clientInfo.date && <div>Date: {clientInfo.date}</div>}
            </div>
          )}
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, margin: "2px 0 0" }}>Generated {new Date().toLocaleDateString()}</div>
          {scaleInfo.length > 0 && (
            <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, lineHeight: 1.6, marginTop: 6 }}>
              {/* pre-provenance projects have a scale but no record of HOW it was
                  set — say so in words; the machine JSON keeps the raw "unknown" */}
              {scaleInfo.map((si) => (
                <div key={si.sheet_id}>{sheetLabel ? sheetLabel(si.sheet_id) : si.sheet_id} — {!si.scale_source || si.scale_source === "unknown" ? "scale set — provenance unrecorded" : si.scale_source}</div>
              ))}
            </div>
          )}
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, marginTop: 6 }}>OpenTakeoff — opentakeoff.netlify.app</div>
          <div style={{ fontSize: 10.5, marginTop: 2, borderBottom: "1px solid var(--ink-faint)", paddingBottom: 8, marginBottom: 12 }}>
            {DISCLAIMER}
          </div>
        </div>
        {/* the empty-state hides once markups exist — "Revisions noted" below
            renders from markups alone, and "Nothing measured yet" reading as a
            headline above a populated table was a lie */}
        {!rows.length ? (
          markups.length ? null : (
            <div style={{ padding: 48, textAlign: "center", color: "var(--ink-muted)" }}>
              Nothing measured yet — trace some areas, then come back for the breakdown.
            </div>
          )
        ) : (
          <>
          {/* print-visible grouping caption — the Group select lives in
              .report-toolbar (display:none in print), so the printed page
              must say what the sections are. Kept on screen too (cheap,
              consistent). Suppressed with the rest of the group chrome when
              the partition degenerates to one group. */}
          {grouped && (
            <p style={{ maxWidth: 980, margin: "0 auto 8px", fontSize: 11.5, color: "var(--ink-muted)" }}>
              Grouped by <strong>{groupCol ? columnLabel(groupCol) : groupBy === "label" ? "label" : "sheet"}</strong>
            </p>
          )}
          <table style={{ width: "100%", maxWidth: 980, margin: "0 auto", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
            <thead>
              <tr>
                {tableCols.map((c) => (
                  // custom and spec columns are text — header left-aligns with the cells
                  <th key={c.key} style={c.key === "finish" || c.custom || c.spec ? { ...th, textAlign: "left" } : c.accent ? { ...th, color: "var(--cobalt)" } : th}>{c.header}</th>
                ))}
              </tr>
            </thead>
            {/* ONE render path: the ungrouped view is a degenerate single group
                (no header/subtotal chrome). One tbody PER GROUP — in sheet mode
                the same condition repeats across groups, so r.id is only unique
                within a group's tbody. thead + grand-total tfoot stay exactly
                as ungrouped, so print pagination is untouched. */}
            {(grouped ? groups : [{ rows }]).map((gp) => {
              // key in a disjoint keyspace: a vocabulary value literally named
              // "∅" must not collide with the Unassigned group's sentinel
              const key = !grouped ? "rows" : gp.value === null ? "∅" : "v:" + gp.value;
              const sub = grouped && groups.length > 1 && gp.rows.length > 1 ? grandTotals(gp.rows) : null;
              // sheet groups carry a per-sheet perimByCond — the panel-wide
              // map would show whole-project perimeter next to per-slice
              // quantities
              const gctx = gp.perimByCond ? { perimByCond: gp.perimByCond, attrsByCond, specByCond } : ctx;
              return (
                <tbody key={key}>
                  {/* breakAfter is a print nicety only — unreliable on table
                      rows in Chromium, unimplemented in Gecko; occasional
                      header stranding at a page bottom is accepted in v1 */}
                  {grouped && (
                    <tr style={{ breakAfter: "avoid" }}>
                      <td colSpan={tableCols.length} style={{ ...td, textAlign: "left", fontFamily: "var(--f-display)", fontSize: 13, fontWeight: 700, paddingTop: 14, ...(gp.value === null ? { fontStyle: "italic" } : {}) }}>
                        {gp.label}
                      </td>
                    </tr>
                  )}
                  {gp.rows.map((r) => (
                    <tr key={r.id}>
                      {tableCols.map((c) => renderCell(c, r, gctx))}
                    </tr>
                  ))}
                  {/* single-row group: no subtotal — it would repeat the row verbatim */}
                  {sub && (
                    <tr>
                      <td style={{ ...td, textAlign: "left", borderTop: "1px solid var(--ink-soft)", color: "var(--ink-muted)", fontWeight: 600 }}>Subtotal</td>
                      {/* lighter than the grand-total tfoot: thin border,
                          muted color; same foot mechanism on the group's
                          own grandTotals */}
                      {tableCols.slice(1).map((c) => (
                        <td key={c.key} style={{ ...td, borderTop: "1px solid var(--ink-soft)", color: "var(--ink-muted)" }}>
                          {c.foot && !c.ref ? num(c.foot(sub)) : ""}
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              );
            })}
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
          </>
        )}
        {rows.length > 0 && (
          <p style={{ maxWidth: 980, margin: "14px auto 0", fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.6 }}>
            <strong>SF ordered</strong> = measured quantity × waste %. Waste is set per condition in the canvas. Wall SF comes from Surface-Area
            traces (run × height); Border SF from Linear runs with a thickness.
            {tableCols.some((c) => c.key === "perimeter_ref") && (
              <> Perim LF (ref) sums floor-trace perimeters — includes door openings and shared walls; reference only, never totaled or waste-adjusted.</>
            )}
            {/* bridge to the base-quantity By-sheet section below — the two
                slice the same shapes with different semantics */}
            {groupBy === "sheet" && grouped && (
              <> Groups show ordered quantities (waste and ×N applied per sheet); the By-sheet section below shows base measured quantities.</>
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
              {hasMultipliers(bySheet) && (
                // the shared note + a screen-only reconcile clause (CSV/PDF omit it)
                <> {BY_SHEET_BASE_NOTE} — sheet subtotals × multiplier reconcile to the condition table.</>
              )}
            </p>
          </div>
        )}
        {markups.some((m) => m.type !== "svg") && (
          <div style={{ maxWidth: 980, margin: "26px auto 0" }}>
            {/* svg symbols are decorative vector stamps, not revision notes — excluded */}
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
                {markups.filter((m) => m.type !== "svg").map((m) => (
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
                // inline-block + a trailing space outside the span: each finish
                // moves to the next line as a unit when it fits, and wraps
                // internally instead of running off the page edge when it
                // doesn't (#27)
                <React.Fragment key={r.id}>
                  <span style={{ marginRight: 14, display: "inline-block" }}>
                    <strong style={{ fontFamily: "var(--f-mono)" }}>{r.finish_tag}</strong>{" "}
                    {r.materials.map((m) => `${m.name} ${num(m.qty, 2)}${m.unit ? " " + m.unit : ""}${m.note ? ` (${m.note})` : ""}`).join(" · ")}
                  </span>{" "}
                </React.Fragment>
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
  // pick sequence: normalizeLogoToPng is async, so a slow first pick must not
  // clobber a faster second pick — resurrect a logo removed meanwhile — or
  // land after the modal closes (the modal unmounts on close, so a pick still
  // normalizing would otherwise pass its own instance's seq check and persist
  // via saveCompany from the dead fiber)
  const logoSeq = useRef(0);
  useEffect(() => () => { logoSeq.current++; }, []);   // unmount invalidates in-flight picks

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
    const seq = ++logoSeq.current;
    try {
      const logo = await normalizeLogoToPng(file);
      if (seq !== logoSeq.current) return;   // superseded by a later pick/remove/close
      setAndSave((prev) => ({ ...prev, logo }));
    } catch (err) {
      if (seq !== logoSeq.current) return;   // stale failure — don't flash its error
      setLogoErr(err.message || String(err));
    }
  };
  // bump the seq so an in-flight pick can't resurrect the removed logo
  const removeLogo = () => { logoSeq.current++; setAndSave(({ logo, ...rest }) => rest); };
  const client = (field) => (e) => onClientInfo && onClientInfo({ ...clientInfo, [field]: e.target.value });

  const section = { fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" };
  const row = { display: "block", margin: "8px 0" };
  const err = { margin: "6px 0 0", fontSize: 11.5, color: "var(--c-danger)" };

  return (
    <div onClick={onClose} className="report-modal" style={{ position: "absolute", inset: 0, zIndex: 60, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: 520, maxWidth: "100%", maxHeight: "90%", overflow: "auto", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--ink)" }}>
          <Icon name="document" size={16} />
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 15 }}>Project info</strong>
        </div>
        <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          <div style={section}>Company — yours, saved on this device</div>
          <label style={row}>
            <span className="field-label">Name</span>
            <input name="company-name" autoComplete="organization" value={company.name || ""} onChange={(e) => setAndSave((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="Your company" className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={row}>
            <span className="field-label">Address</span>
            <textarea name="company-address" autoComplete="street-address" value={company.address || ""} onChange={(e) => setAndSave((prev) => ({ ...prev, address: e.target.value }))}
              rows={2} placeholder={"Street\nCity, ST"} className="field-input" style={{ marginTop: 4, resize: "vertical" }} />
          </label>
          <div style={row}>
            <span className="field-label">Logo</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
              <input name="company-logo" type="file" accept="image/*" onChange={onLogoFile} style={{ fontSize: 12, minWidth: 0 }} />
              {company.logo && (
                <>
                  <img src={company.logo} alt="Company logo" style={{ width: 120, height: "auto", flex: "none", border: "1px solid var(--ink-faint)", background: "var(--well)" }} />
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
            <input name="client-name" autoComplete="off" value={clientInfo.client_name || ""} onChange={client("client_name")} className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={row}>
            <span className="field-label">Client address</span>
            <textarea name="client-address" autoComplete="off" value={clientInfo.client_address || ""} onChange={client("client_address")} rows={2}
              className="field-input" style={{ marginTop: 4, resize: "vertical" }} />
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ ...row, flex: 1 }}>
              <span className="field-label">PO / reference</span>
              <input name="client-reference" autoComplete="off" value={clientInfo.reference || ""} onChange={client("reference")} className="field-input" style={{ marginTop: 4 }} />
            </label>
            <label style={{ ...row, flex: 1 }}>
              <span className="field-label">Date</span>
              <input name="client-date" autoComplete="off" value={clientInfo.date || ""} onChange={client("date")} placeholder={'e.g. "Bid 7/12"'}
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
    <div onClick={onClose} className="report-modal" style={{ position: "absolute", inset: 0, zIndex: 60, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
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
            <input name="contributor" autoComplete="name" value={contributor} onChange={(e) => setContributor(e.target.value)} placeholder="Name or company to credit"
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "12px 0", cursor: "pointer" }}>
            <input name="attest" type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} style={{ marginTop: 3 }} />
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
