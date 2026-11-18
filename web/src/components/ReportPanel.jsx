import { createExportPresentation } from "../lib/exportPresentation.js";
import { localizeText as uiText, getLanguage } from "../lib/i18n/core.js";
// ReportPanel — the takeoff deliverable. A STACK-style breakdown by condition
// (finish): measured quantity, waste %, and waste-adjusted order quantity, with
// a grand total. Exports to CSV / JSON, prints, and hosts the opt-in
// "Contribute to the open flooring model" flow.
import MaterialUnitSelector, { useMaterialUnit } from './MaterialUnitSelector.jsx';
import { materialRowsForDisplay } from '../lib/materialUnits.js';
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import ToolMenu from "./ToolMenu.jsx";
import { conditionTotals, grandTotals, sheetTotals, sheetGroupedRows, labelGroupedRows, authorGroupedRows, sheetLabelGroupedRows, round2, totalsToCsv, downloadText, materialsSummary, reportJson, hasMultipliers, BY_SHEET_BASE_NOTE } from "../lib/totals.js";
import { TABLE_PROFILE, CSV_PROFILE, colGetter, customColProfile, specColProfile, laborColProfile, rollColProfile, partitionRowsBy, forceIncludeGroupCol, loadColPrefs, saveColPrefs, loadGroupBy, saveGroupBy, visibleCols, floorPerimeterLf, applyUnits } from "../lib/reportColumns.js";
import { rollReportRows, seamLfByShape } from "../lib/rollTakeoff.js";
import { areaVal, areaUnit, lenVal, lenUnit } from "../lib/units";
import { columnLabel } from "../lib/conditionColumns.js";
import { shapeLabelValue } from "../lib/shapeLabels.js";
import { loadTemplates, saveTemplate, deleteTemplate, renameTemplate, mergeTemplates, overwriteTemplates } from "../lib/reportTemplates.js";
import { canSyncTemplates, pushTemplatesToDrive, loadTemplatesFromDrive } from "../lib/reportTemplatesSync.js";
import { useGoogleAuth } from "../lib/google/AuthContext.jsx";
import { projectHomeFolderId } from "../lib/projectHome.js";
import { getAccessToken } from "../lib/google/auth.js";
import { shapesDetail, shapesToCsv, shapesToJson } from "../lib/shapesExport.js";
import { buildSheetDxf, dxfFileName, DXF_MIME } from "../lib/dxf.js";
import { rfisToCsv, rfisToJson } from "../lib/rfi.js";
import { reportWorkbook, buildXlsx } from "../lib/xlsx.js";
import { buildContribution, sendContribution, isContributeConfigured } from "../lib/contribute.js";
import { activeTheme, saveActiveThemeFile, clearActiveTheme } from "../lib/reportTheme.js";
import { activeProfile, loadProfiles } from "../lib/identity.js";
import { useCompanyProfiles, CompanyIdentityFields } from "./CompanyIdentity.jsx";
import { resolveBranding, loadBrandingSelection, saveBrandingSelection, OT_WATERMARK } from "../lib/branding.js";
import { projectIdFromUrl } from "../lib/store.js";
import { describeConditionEdit, proposedConditionEditRows } from "../lib/proposals.js";
import { qtyLabels, resolveNote } from "../lib/noteFields.ts";

const num = (v, d = 1) => (Number(v) || 0).toLocaleString(getLanguage() === "ru" ? "ru-RU" : undefined, { maximumFractionDigits: d });

// the report's one caveat line — page-strip on every printed page + masthead
const DISCLAIMER = "Quantities derived from drawings at stated scales; verify in field.";

// one-line hints for the opt-in columns in the picker (waste hint sits under
// the second waste checkbox so it reads once for the pair)
const COL_HINTS = {
  waste_lf: "Waste SF/LF = (w/Waste) − measured",
  perimeter_ref: "Perimeter is reference only — includes openings; not totaled",
};

const sheetNum = (v, d = 1) => {
  const r = round2(v);
  // zero-gate at the DISPLAY precision, so a ±0.02 sliver shows "—", not "(0)"
  if (!Math.round(Math.abs(r) * 10 ** d)) return "—";
  if (r < 0) return <span style={{ color: "var(--c-danger)" }}>({uiText(num(-r, d))})</span>;
  return num(r, d);
};

export default function ReportPanel({ projectName, onProjectName, conditions, shapes, sheetLabel, sheetDims, onMarkedSet, markedSetDark, onClose, markups = [], rfis = [], scaleInfo = [], provenanceCounters = null, clientInfo = {}, onClientInfo, conditionColumns = [], shapeLabels = [], units = "imperial", rollByCond = null, conditionEditProposals = [], onOpenCompanySetup = null, companyRev = 0, onEstimate = null }) {
  // proposals (#365): a pending condition-edit diff prints BESIDE the current
  // values — the row's numbers are always the current knobs; the chip says
  // what the agent proposed, and the JSON export carries the same rows.
  const editProposalByCond = useMemo(() => new Map((Array.isArray(conditionEditProposals) ? conditionEditProposals : []).filter((p) => p && p.condition_id).map((p) => [p.condition_id, p])), [conditionEditProposals]);
  const proposedEditRows = useMemo(() => proposedConditionEditRows(conditions, conditionEditProposals), [conditions, conditionEditProposals]);
  // memoized on the source arrays: project-name/client-info keystrokes re-render
  // the panel without touching conditions/shapes, so the totaling passes skip
  // imported report theme → { vars, name, warnings }. vars are spread onto this
  // panel's root so the theme scopes to the document subtree (screen + print +
  // masthead) without touching app chrome. Held in state so an import applies live.
  const [theme, setTheme] = useState(() => activeTheme());
  const [showTheme, setShowTheme] = useState(false);
  const themeRef = useRef(null);
  const themeFileRef = useRef(null);
  const importThemeFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // let the same file re-trigger onChange next time
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      try {
        JSON.parse(raw); // reject non-JSON before storing
        saveActiveThemeFile(raw);
        setTheme(activeTheme());
      } catch {
        setTheme((t) => ({ ...t, warnings: ["That file isn't valid JSON — expected a design-token file."] }));
      }
    };
    reader.readAsText(f);
  };
  const resetTheme = () => { clearActiveTheme(); setTheme({ vars: {}, name: null, warnings: [] }); };

  // Figured seam LF per shape (#147) — what a materials row with basis
  // "seam_lf" (weld rod, seam tape) divides against. Per SHAPE, so the grouped
  // views below slice it for free instead of repeating the whole condition's
  // welding on every sheet. Empty map for a project with no roll goods, which
  // makes every seam_lf row read 0 — the honest answer before a layout exists.
  const seamCtx = useMemo(() => ({ seamByShape: seamLfByShape(rollByCond) }), [rollByCond]);
  const liquidUnit = useMaterialUnit();
  const sourceRows = useMemo(() => conditionTotals(conditions, shapes, seamCtx).filter((r) => r.shape_count > 0), [conditions, shapes, seamCtx]);
  const rows = useMemo(() => materialRowsForDisplay(sourceRows, liquidUnit), [sourceRows, liquidUnit]);
  const noteQty = useMemo(() => qtyLabels(rows, units), [rows, units]);   // {{qty}} in the annotations table (#474)
  const bySheet = useMemo(() => sheetTotals(conditions, shapes), [conditions, shapes]);
  const g = useMemo(() => grandTotals(rows), [rows]);
  const matSummary = useMemo(() => materialsSummary(rows), [rows]);
  const [showContribute, setShowContribute] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  // whether the Marked Set PDF carries the markups. Default on; ORTHOGONAL to the
  // canvas markup-layer hide — that never changes the export, only this does.
  const [includeMarkups, setIncludeMarkups] = useState(true);
  // bumped by the Project info modal on every company/branding save, so the
  // print masthead re-reads (a cheap localStorage parse + one meta-KV load)
  const [identityRev, setIdentityRev] = useState(0);
  // per-project branding selection (async meta KV); reloads when the modal saves
  // OR when the project id changes (a switch while the report stays mounted)
  const projectId = projectIdFromUrl();
  const [brandSel, setBrandSel] = useState({ mode: "default", profileId: null });
  useEffect(() => {
    let alive = true;
    loadBrandingSelection(projectId).then((s) => { if (alive) setBrandSel(s); });
    return () => { alive = false; };
  }, [identityRev, companyRev, projectId]);   // companyRev: Company setup (opened from the canvas) saved
  // resolveBranding decides the masthead identity, the export title tag, and the
  // end credit. company is null in default mode → the firm block renders the
  // OpenTakeoff brand name instead of a trade-name identity (read only inside the
  // brand.clear branch below, so it is never dereferenced when null).
  const brand = resolveBranding({ ...brandSel, profiles: loadProfiles().profiles });
  const company = brand.company;
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
  // labor/subfloor-type columns, typed directly on the condition in the
  // Supporting Materials panel — appended after spec (frozen 13 → built-in
  // opt-ins → custom → spec → labor), present only when at least one
  // condition carries a laborType/subfloorType value.
  const laborCols = laborColProfile(conditions);
  // roll-goods columns (#136) — the figured order (Roll Order LF / Rolls)
  // beside the measured quantities, appended after labor (frozen 13 →
  // built-in opt-ins → custom → spec → labor → roll), present only when at
  // least one condition figures a roll layout.
  const rollCols = rollColProfile(rollByCond);
  // metric display converts AT THE DESCRIPTOR (applyUnits): headers swap to
  // m²/m, the SY column retires, and every dimensioned getter/foot wraps in
  // the converter — renderCell and the tfoot below need no unit awareness.
  // The CSV/XLSX exports get RAW descriptors + `units`; conversion happens
  // inside totalsToCsv/reportWorkbook so each output has ONE conversion site.
  const M = units === "metric";
  const AU = areaUnit(units), LU = lenUnit(units);
  const tableCols = applyUnits(visibleCols([...TABLE_PROFILE, ...customCols, ...specCols, ...laborCols, ...rollCols], colPrefs), units);
  // group-by choice: "" (none) | "sheet" | a custom column id; normalized
  // ONCE per render and used everywhere (select value AND partitioning) — a
  // stale colId must fall back to None, never reach the select or the
  // partitioner.
  const [groupByRaw, setGroupByRaw] = useState(loadGroupBy);
  // "label" is gated on the vocab existing — the group-by pref is one device-
  // global string, so a leftover "label" opened on a label-less project (or a
  // template carrying it) must fall back to ungrouped, exactly as a stale
  // custom-column id does.
  const hasAuthors = shapes.some((s) => typeof s.author === "string" && s.author.trim());
  const groupBy = groupByRaw === "sheet" || (groupByRaw === "label" && shapeLabels.length > 0) || (groupByRaw === "author" && hasAuthors) || conditionColumns.some((cc) => cc.id === groupByRaw) ? groupByRaw : "";
  // grouping force-includes its column in the CSV/XLSX even when hidden in
  // the picker (D7) — a grouped report's export always carries its grouping
  const csvCols = forceIncludeGroupCol(visibleCols([...CSV_PROFILE, ...customCols, ...specCols, ...laborCols, ...rollCols], colPrefs), customCols, groupBy);
  const perimByCond = useMemo(() => floorPerimeterLf(shapes), [shapes]);
  // custom-column values reach the getters through ctx, never as row fields
  // (conditionTotals rows are spread into the contribution payload)
  const attrsByCond = useMemo(() => new Map(conditions.map((c) => [c.id, c.attrs])), [conditions]);
  // spec columns read the imported product spec off the same ctx seam
  const specByCond = useMemo(() => new Map(conditions.map((c) => [c.id, c.spec])), [conditions]);
  // labor columns read the hand-typed labor/subfloor type off the same ctx seam
  const laborByCond = useMemo(() => new Map(conditions.map((c) => [c.id, { laborType: c.laborType, subfloorType: c.subfloorType }])), [conditions]);
  const ctx = { perimByCond, attrsByCond, specByCond, laborByCond, rollByCond };
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
  const sheetGroups = useMemo(() => (groupBy === "sheet" ? sheetGroupedRows(conditions, shapes, seamCtx) : null), [groupBy, conditions, shapes, seamCtx]);
  // label mode: ORDERED per-bucket rows (waste + ×N per slice), already shaped
  // { value, label, rows, perimByCond } like the sheet groups after mapping.
  const labelGroups = useMemo(() => (groupBy === "label" ? labelGroupedRows(conditions, shapes, shapeLabels, seamCtx) : null), [groupBy, conditions, shapes, shapeLabels, seamCtx]);
  // per-author rollups (#314) — same contract as the label groups
  const authorGroups = useMemo(() => (groupBy === "author" ? authorGroupedRows(conditions, shapes, seamCtx) : null), [groupBy, conditions, shapes, seamCtx]);
  const groups = sheetGroups
    ? sheetGroups.map((gp) => ({ value: gp.sheet_id, label: sheetLabel ? sheetLabel(gp.sheet_id) : gp.sheet_id, rows: gp.rows, perimByCond: gp.perimByCond }))
    : labelGroups || authorGroups || colGroups;
  const grouped = Boolean(groups && (groups.length > 1 || ((groupCol || groupBy === "label" || groupBy === "author") && groups.length === 1 && groups[0].value !== null)));
  // exports always carry the by-label breakdown when any shape is labeled,
  // independent of the current group-by view; empty (→ CSV/JSON byte-unchanged)
  // for label-less projects.
  const byLabelExport = useMemo(() => (shapes.some((s) => shapeLabelValue(s)) ? labelGroupedRows(conditions, shapes, shapeLabels, seamCtx) : []), [conditions, shapes, shapeLabels, seamCtx]);
  // The workbook's floor × room tab. Unlike byLabelExport this is NOT gated on
  // a label existing: an unlabeled project's tab is one Unlabeled roll-up per
  // floor, which still reconciles to By sheet — and the workbook's tab list
  // stays fixed whatever the project carries.
  const byFloorRoom = useMemo(() => sheetLabelGroupedRows(conditions, shapes, shapeLabels, seamCtx), [conditions, shapes, shapeLabels, seamCtx]);

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

  useEffect(() => {
    if (!showTheme) return;
    const onDown = (e) => { if (themeRef.current && !themeRef.current.contains(e.target)) setShowTheme(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showTheme]);

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
    const nm = (window.prompt(uiText("Rename template:"), t.name) || "").trim();
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

  // no-waste actuals view for labor: hides the waste-baked columns, surfaces
  // the raw Total SF opt-in — same diff-from-default shape applyTemplate uses.
  // No rate/cost math — the user attaches labor $ externally.
  const applyLaborPreset = () => {
    const cols = { waste_pct: false, total_sf_net: false, sy_net: false, total_sf: true };
    setColPrefs(cols); saveColPrefs(cols);
  };

  // store only diffs from defaultVisible — a key toggled back to default is dropped
  const toggleCol = (col) => {
    const next = { ...colPrefs };
    const want = !(colPrefs[col.key] ?? col.defaultVisible);
    if (want === col.defaultVisible) delete next[col.key]; else next[col.key] = want;
    setColPrefs(next);
    saveColPrefs(next);
  };

  const exportOptions = { language: getLanguage(), localize: uiText };
  const display = createExportPresentation(exportOptions);
  const baseName = (projectName || "takeoff").replace(/[^\p{L}\p{N}_.-]+/gu, "_");
  const exportCsv = () => downloadText(`${baseName}.csv`, totalsToCsv(rows, projectName, bySheet, sheetLabel, csvCols, ctx, byLabelExport.length ? byLabelExport : null, brand.brandName, units, exportOptions), "text/csv");
  const exportJson = () => downloadText(`${baseName}.json`,
    JSON.stringify(reportJson({ projectName, rows: sourceRows, bySheet, scaleInfo, markups, rfis, sheetLabel, conditionColumns, attrsByCond, shapeLabels, byLabel: byLabelExport, displayUnits: units, rollGoods: rollReportRows(rollByCond, rows), proposedConditionEdits: proposedEditRows }), null, 2),
    "application/json");
  const exportRfisCsv = () => downloadText(`${baseName}_rfis.csv`, rfisToCsv(rfis, markups, projectName, sheetLabel, brand.brandName, exportOptions), "text/csv");
  const exportRfisJson = () => downloadText(`${baseName}_rfis.json`,
    JSON.stringify(rfisToJson(rfis, projectName), null, 2), "application/json");
  // Excel workbook — same sources as the CSV/JSON (Conditions tab follows the
  // column picker like the CSV); buildXlsx lazy-loads fflate on first use
  const exportXlsx = async () => {
    const sheets = reportWorkbook({ rows, bySheet, shapeRows: shapesDetail(conditions, shapes, sheetLabel), cols: csvCols, ctx, sheetLabel, units, byFloorRoom, presentation: exportOptions });
    const bytes = await buildXlsx(sheets.map((sheet) => ({ ...sheet, ...(getLanguage() === 'ru' ? {columnWidths:[44,26,24,22,22,22,22,22,22,22,22,22,22,22]} : {}) })));
    downloadText(`${baseName}.xlsx`, bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  };
  const exportShapesCsv = () => downloadText(`${baseName}_shapes.csv`, shapesToCsv(shapesDetail(conditions, shapes, sheetLabel), projectName, brand.brandName, units, exportOptions), "text/csv");
  const exportShapesJson = () => downloadText(`${baseName}_shapes.json`,
    JSON.stringify(shapesToJson(shapesDetail(conditions, shapes, sheetLabel), projectName), null, 2),
    "application/json");
  // DXF (CAD): one drawing per sheet — a sheet IS a drawing — so a multi-sheet
  // takeoff downloads as a zip of per-sheet DXFs and a single sheet as the
  // .dxf itself. Only calibrated sheets that carry shapes qualify; the skip
  // list is spoken, never swallowed (a CAD file missing a ring is a lie).
  const dxfSheets = useMemo(() => {
    const upp = Object.fromEntries(scaleInfo.map((s) => [s.sheet_id, s.units_per_px]));
    const ids = [...new Set(shapes.map((s) => s.sheet_id))];
    return ids.filter((id) => upp[id] > 0 && (sheetDims?.(id)?.w > 0)).map((id) => ({ id, upp: upp[id] }));
  }, [shapes, scaleInfo, sheetDims]);
  const dxfSkipped = useMemo(() => {
    const ok = new Set(dxfSheets.map((s) => s.id));
    return [...new Set(shapes.map((s) => s.sheet_id))].filter((id) => !ok.has(id));
  }, [shapes, dxfSheets]);
  const exportDxf = async () => {
    const built = dxfSheets.map(({ id, upp }) => {
      const label = sheetLabel ? sheetLabel(id) : id;
      const b = buildSheetDxf({ sheet_id: id, label, dims: sheetDims(id), upp, shapes, conditions }, { units: units === "metric" ? "m" : "ft" });
      return { name: dxfFileName(projectName || "takeoff", label), dxf: b.dxf };
    });
    if (built.length === 1) { downloadText(built[0].name, built[0].dxf, DXF_MIME); return; }
    const { zipSync, strToU8 } = await import("fflate"); // lazy — same pattern as xlsx.js
    const files = {};
    for (const f of built) files[files[f.name] ? f.name.replace(/\.dxf$/, `_${Object.keys(files).length}.dxf`) : f.name] = strToU8(f.dxf);
    downloadText(`${baseName}_dxf.zip`, zipSync(files, { level: 6 }), "application/zip");
  };

  const th = { textAlign: "right", padding: "7px 6px", fontFamily: "var(--f-mono)", fontSize: 12.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-muted)", borderBottom: "1.25px solid var(--ink)", whiteSpace: "normal" };
  const td = { textAlign: "right", padding: "8px 6px", fontVariantNumeric: "tabular-nums", borderBottom: "1px solid var(--ink-faint)", whiteSpace: "nowrap" };

  // one condition-table cell, keyed off the column profile; values come
  // through the shared colGetter so the table and the CSV read the same
  // numbers. Sheet groups pass their own ctx (per-sheet perimByCond).
  const renderCell = (col, r, cellCtx) => {
    const get = colGetter(col);
    const v = get ? get(r, cellCtx) : r[col.key];
    // custom columns, read-only spec columns, and labor/subfloor-type columns:
    // plain left-aligned text (already coerced to string by their getter);
    // TOTAL cells stay blank (no foot). spec cells can hold sentence-length
    // values (esp. Description) — let them WRAP and cap the width so one long
    // value can't push report/print columns off the page edge (mirrors the
    // notes cell below). Custom and labor columns stay nowrap.
    if (col.custom || col.spec || col.labor) {
      const cell = col.spec ? { ...td, textAlign: "left", whiteSpace: "normal", maxWidth: 240 } : { ...td, textAlign: "left" };
      return <td key={col.key} style={cell}>{v || "—"}</td>;
    }
    switch (col.key) {
      case "finish":
        return (
          <td key={col.key} style={{ ...td, textAlign: "left", whiteSpace: "normal", width: "30%", maxWidth: 300 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ flexShrink: 0, width: 12, height: 12, background: r.color, display: "inline-block", border: "1px solid var(--ink-faint)" }} />
              <strong style={{ fontFamily: "var(--f-mono)", fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>{display.finish(r.finish_tag)}</strong>
              {r.multiplier > 1 && <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>×{uiText(r.multiplier)}</span>}
            </span>
            {/* proposals (#365): the pending diff beside the current values —
                the numbers in this row are what the takeoff stands on today */}
            {editProposalByCond.get(r.id) && (
              <span data-proposed-edit={editProposalByCond.get(r.id).id} title={uiText(`Proposed by the agent, pending your acceptance in the Takeoffs panel${editProposalByCond.get(r.id).rationale ? ` — ${editProposalByCond.get(r.id).rationale}` : ""}. This row shows the current values.`)}
                style={{ display: "block", marginTop: 3, fontFamily: "var(--f-mono)", fontSize: 10.5, color: "var(--cobalt)", whiteSpace: "nowrap" }}>
                {uiText("proposed: ")}{uiText(describeConditionEdit(conditions.find((c) => c.id === r.id), editProposalByCond.get(r.id)).map((d) => `${d.field} ${d.from} → ${d.to}`).join(" · "))}
              </span>
            )}
          </td>
        );
      case "shapes":
        return <td key={col.key} style={td}>{uiText(v)}</td>;
      case "waste_pct":
        return <td key={col.key} style={td}>{uiText(v ? `${num(v, 0)}%` : "—")}</td>;
      case "ea":
        return <td key={col.key} style={td}>{uiText(v ? num(v, 0) : "—")}</td>;
      case "total_sf_net":
        return <td key={col.key} style={{ ...td, fontWeight: 700, color: "var(--cobalt)" }}>{uiText(r.total_sf ? num(v) : "—")}</td>;
      case "sy_net":
        return <td key={col.key} style={{ ...td, color: "var(--cobalt)" }}>{uiText(r.total_sf ? num(v) : "—")}</td>;
      case "perimeter_ref":
        return <td key={col.key} style={{ ...td, color: "var(--ink-muted)" }}>{uiText(v ? num(v) : "—")}</td>;
      default: // floor_sf, wall_sf, border_sf, lf, waste_sf, waste_lf, …
        return <td key={col.key} style={td}>{uiText(v ? num(v) : "—")}</td>;
    }
  };

  // picker row — locked columns (finish) are filtered out of the lists below
  const colCheckbox = (c) => (
    <React.Fragment key={c.key}>
      <label style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0", cursor: "pointer" }}>
        <input name="report-column-toggle" type="checkbox" checked={colPrefs[c.key] ?? c.defaultVisible} onChange={() => toggleCol(c)} />
        <span>{uiText(c.header)}</span>
      </label>
      {COL_HINTS[c.key] && (
        <div style={{ margin: "0 0 4px 24px", fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1.5 }}>{uiText(c.key === 'waste_sf' || c.key === 'waste_lf' ? 'Material allowance = purchase quantity − measured quantity' : COL_HINTS[c.key])}</div>
      )}
    </React.Fragment>
  );

  return (
    <div className="report-panel" style={{ ...theme.vars, position: "absolute", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", background: "var(--paper-cream)" }}>
      <div className="report-toolbar" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: "1px solid var(--ink)", background: "var(--paper-bright)" }}>
        <Icon name="takeoffs" size={18} />
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)" }}>{uiText("Takeoff report")}</strong>
        <input name="project-name" value={projectName} onChange={(e) => onProjectName(e.target.value)} placeholder={uiText("Project name (optional)")}
          className="field-input" style={{ width: 260, padding: "5px 9px", fontSize: 13 }} />
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={() => setShowInfo(true)}
          title={uiText("Your company identity and the client/job details for the print header and marked-set cover")}>{uiText("Project info")}</button>
        {onEstimate && <button className="btn-ghost" onClick={onEstimate} title={uiText("Price this takeoff — material and labor per unit, markups, Excel")}>{uiText("Estimate")}</button>}
        {/* always rendered, even with zero custom columns — Sheet grouping
            is useful on its own */}
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink)", whiteSpace: "nowrap" }}
          title={uiText("Break the condition table into sections with subtotals")}>
          {uiText("Group:")}<select name="report-group-by" value={groupBy} onChange={(e) => { setGroupByRaw(e.target.value); saveGroupBy(e.target.value); }}
            style={{ padding: "5px 6px", border: "1px solid var(--ink-faint)", background: "transparent", fontSize: 12, maxWidth: 160 }}>
            <option value="">{uiText("None")}</option>
            <option value="sheet">{uiText("Sheet")}</option>
            {shapeLabels.length > 0 && <option value="label">{uiText("Label")}</option>}
            {hasAuthors && <option value="author">{uiText("Author")}</option>}
            {conditionColumns.map((cc) => (
              <option key={cc.id} value={cc.id}>{uiText(columnLabel(cc))}</option>
            ))}
          </select>
        </label>
        <div ref={colsRef} style={{ position: "relative" }}>
          <button className="btn-ghost" onClick={() => setShowCols((s) => !s)} title={uiText("Choose which columns the table and CSV show")}>{uiText("Columns")}</button>
          {showCols && (
            <div className="report-modal" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 70, width: 310, maxHeight: "min(70vh, 650px)", overflowY: "auto", background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-2)", padding: "10px 12px", fontSize: 12.5, color: "var(--ink)" }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                <strong style={{ fontFamily: "var(--f-display)", fontSize: 13 }}>{uiText("Columns")}</strong>
                <div style={{ flex: 1 }} />
                <button onClick={applyLaborPreset} title={uiText("No-waste actuals per condition — hides SF/SY w/Waste, shows Total SF")}
                  style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11.5, padding: "0 10px 0 0" }}>{uiText("Labor view")}</button>
                <button onClick={() => { setColPrefs({}); saveColPrefs({}); }} title={uiText("Back to the default column set")}
                  style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11.5, padding: "0 10px 0 0" }}>{uiText("Reset")}</button>
                <button onClick={() => setShowCols(false)} title={uiText("Close")}
                  style={{ border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
              </div>
              {uiText(applyUnits(TABLE_PROFILE, units).filter((c) => !c.locked && c.defaultVisible).map(colCheckbox))}
              <div style={{ borderTop: "1px solid var(--ink-faint)", margin: "8px 0 4px", paddingTop: 6, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>{uiText("Optional")}</div>
              {uiText(applyUnits(TABLE_PROFILE, units).filter((c) => !c.locked && !c.defaultVisible).map(colCheckbox))}
              <div style={{ borderTop: "1px solid var(--ink-faint)", margin: "8px 0 4px", paddingTop: 6, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>{uiText("Custom columns")}</div>
              {customCols.length ? customCols.map(colCheckbox) : (
                <div style={{ fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1.5 }}>{uiText("No custom columns yet — define them from the condition bar in the canvas.")}</div>
              )}
              {/* read-only product-spec columns — only shown when a schedule
                  import attached spec data to at least one condition */}
              {specCols.length > 0 && (
                <>
                  <div style={{ borderTop: "1px solid var(--ink-faint)", margin: "8px 0 4px", paddingTop: 6, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>{uiText("Product spec (imported)")}</div>
                  {uiText(specCols.map(colCheckbox))}
                </>
              )}
              {/* labor/subfloor-type columns — only shown once a condition has
                  a value typed in from the Supporting Materials panel */}
              {laborCols.length > 0 && (
                <>
                  <div style={{ borderTop: "1px solid var(--ink-faint)", margin: "8px 0 4px", paddingTop: 6, fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>{uiText("Labor & subfloor")}</div>
                  {uiText(laborCols.map(colCheckbox))}
                </>
              )}
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--ink-muted)" }}>{uiText("Also applies to the CSV export. Grouping by a custom column always exports that column.")}</p>
            </div>
          )}
        </div>
        <div ref={templatesRef} style={{ position: "relative" }}>
          <button className="btn-ghost" onClick={() => setShowTemplates((s) => !s)} title={uiText("Save and recall report layouts (columns + grouping)")}>{uiText("Templates")}{uiText(templates.length ? ` (${templates.length})` : "")}</button>
          {showTemplates && (
            <div className="report-modal" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 70, width: 260, background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-2)", padding: "10px 12px", fontSize: 12.5, color: "var(--ink)" }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                <strong style={{ fontFamily: "var(--f-display)", fontSize: 13 }}>{uiText("Templates")}</strong>
                <div style={{ flex: 1 }} />
                <button onClick={() => setShowTemplates(false)} title={uiText("Close")}
                  style={{ border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1.4, marginBottom: 6 }}>{uiText("Saved column + grouping layouts (this device). Click one to apply.")}</div>
              {templates.length === 0 && <div style={{ fontSize: 10.5, color: "var(--ink-muted)", marginBottom: 6 }}>{uiText("No saved templates yet.")}</div>}
              {templates.map((t) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 0" }}>
                  <button onClick={() => applyTemplate(t)} title={uiText("Apply this layout")}
                    style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12, padding: "3px 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</button>
                  <button onClick={() => renameTpl(t)} title={uiText("Rename")}
                    style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                  <button onClick={() => setTemplates(deleteTemplate(t.id))} title={uiText("Delete this template")}
                    style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 6, borderTop: "1px solid var(--ink-faint)", marginTop: 6, paddingTop: 8 }}>
                <input name="template-name" value={tplName} onChange={(e) => setTplName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && saveAsTemplate()}
                  placeholder={uiText("Name this layout")} style={{ flex: 1, minWidth: 0, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
                <button onClick={saveAsTemplate} disabled={!tplName.trim()} title={uiText("Save the current columns + grouping under this name")}
                  style={{ padding: "3px 8px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>{uiText("Save")}</button>
              </div>
              {/* Optional Drive sync — only when signed in and a Projects root is
                  configured. Load MERGES (this device wins on a name clash); it
                  does not pull remote deletes/edits, so the copy stays "Load," not
                  "Sync," to avoid over-promising two-way behavior. */}
              {canSync && (
                <div style={{ borderTop: "1px solid var(--ink-faint)", marginTop: 8, paddingTop: 8 }}>
                  <div style={{ fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1.4, marginBottom: 6 }}>{uiText("Carry these across your own devices via Drive. Load only adds templates this device doesn't have — a same-name template is never overwritten (rename or delete it here first to pull a newer copy).")}</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={pushToDrive} disabled={syncBusy} title={uiText("Write your saved templates to your private Drive file")}
                      style={{ flex: 1, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--cobalt)", cursor: syncBusy ? "default" : "pointer", fontSize: 12 }}>{uiText("Push to Drive")}</button>
                    <button onClick={loadFromDrive} disabled={syncBusy} title={uiText("Merge templates from your Drive file into this device")}
                      style={{ flex: 1, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--cobalt)", cursor: syncBusy ? "default" : "pointer", fontSize: 12 }}>{uiText("Load from Drive")}</button>
                  </div>
                  {syncMsg && <div style={{ fontSize: 10.5, color: "var(--ink-muted)", marginTop: 6 }}>{uiText(syncMsg)}</div>}
                </div>
              )}
            </div>
          )}
        </div>
        <div ref={themeRef} style={{ position: "relative" }}>
          <button className="btn-ghost" onClick={() => setShowTheme((s) => !s)} title={uiText("Apply an imported design-token theme to the report (colors + fonts)")}>{uiText("Theme")}{uiText(theme.name ? " ●" : "")}</button>
          {showTheme && (
            <div className="report-modal" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 70, width: 292, background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-2)", padding: "10px 12px", fontSize: 12.5, color: "var(--ink)" }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                <strong style={{ fontFamily: "var(--f-display)", fontSize: 13 }}>{uiText("Report theme")}</strong>
                <div style={{ flex: 1 }} />
                <button onClick={() => setShowTheme(false)} title={uiText("Close")}
                  style={{ border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.5, marginBottom: 8 }}>
                {uiText("Import a design-token file (e.g. a Claude Design ")}<code>{"tokens.json"}</code>{uiText(") to reskin this report — palette and fonts only. Your company identity stays where it is.")}</div>
              {theme.name ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span className="pip" />
                  <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }} title={theme.name}>{theme.name}</div>
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginBottom: 8 }}>{uiText("Using the default house style.")}</div>
              )}
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => themeFileRef.current?.click()} title={uiText("Choose a design-token file to import")}
                  style={{ flex: 1, padding: "5px 8px", border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{uiText("Import theme…")}</button>
                {theme.name && (
                  <button onClick={resetTheme} title={uiText("Remove the imported theme and return to the default")}
                    style={{ padding: "5px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 12 }}>{uiText("Reset")}</button>
                )}
              </div>
              {theme.warnings.length > 0 && (
                <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 10.5, color: "var(--c-warning)", lineHeight: 1.5 }}>
                  {theme.warnings.map((w, i) => <li key={i}>{uiText(w)}</li>)}
                </ul>
              )}
              <input ref={themeFileRef} type="file" accept="application/json,.json" onChange={importThemeFile} style={{ display: "none" }} />
            </div>
          )}
        </div>
        {/* Exports consolidated into Export ▾; browser print + marked set into
            Print ▾. JSON / Print / Marked set intentionally work markups-only
            ("Revisions noted" renders from markups alone); CSV stays rows-only.
            Every item keeps the exact disabled condition + tooltip its button
            carried. RFI exports stay their own controls, shown only when RFIs exist. */}
        <ToolMenu
          title={uiText("Download the report and shape data")}
          disabled={!rows.length && !shapes.length && !markups.length && !rfis.length}
          face={<><Icon name="document" size={13} />{uiText("Export")}</>}
          items={[
            { section: uiText("Report") },
            { id: "csv", icon: "document", label: uiText("CSV"), disabled: !rows.length, onSelect: exportCsv },
            { id: "xlsx", icon: "document", label: uiText("Excel"), disabled: !rows.length, title: uiText("Excel workbook — Conditions / By sheet / Materials / Shapes"), onSelect: exportXlsx },
            { id: "json", icon: "document", label: uiText("JSON"), disabled: !rows.length && !markups.length && !rfis.length, title: uiText("JSON — works markups-only / RFI-only too"), onSelect: exportJson },
            { section: uiText("Shapes") },
            { id: "shapes-csv", icon: "document", label: uiText("Shapes CSV"), disabled: !shapes.length, title: uiText("Per-shape measured quantities — no multiplier, no waste"), onSelect: exportShapesCsv },
            { id: "shapes-json", icon: "document", label: uiText("Shapes JSON"), disabled: !shapes.length, title: uiText("Per-shape measured quantities — no multiplier, no waste"), onSelect: exportShapesJson },
            { id: "dxf", icon: "document", label: dxfSheets.length > 1 ? `DXF (CAD) · ${dxfSheets.length} sheets` : "DXF (CAD)", disabled: !dxfSheets.length,
              title: !shapes.length ? "Nothing measured yet"
                : !dxfSheets.length ? "Set the scale on a sheet with shapes first — a CAD file in pixels is worse than none"
                : `AutoCAD-ready geometry: closed polylines per finish on OT-<TAG> layers, ${units === "metric" ? "metres" : "feet"}, one drawing per sheet${dxfSkipped.length ? ` — ${dxfSkipped.length} unscaled sheet${dxfSkipped.length > 1 ? "s" : ""} left out` : ""}`,
              onSelect: exportDxf },
          ]}
        />
        <ToolMenu
          title={uiText("Print the report, or generate the marked-set PDF")}
          disabled={!rows.length && !markups.length && !rfis.length /* both items are disabled exactly here: with no rows/rfis, the marked-set condition also collapses to true */}
          face={<span>{uiText("Print")}</span>}
          items={[
            { id: "print", label: uiText("Print report"), disabled: !rows.length && !markups.length && !rfis.length, title: uiText("Print the on-screen report (browser print / save as PDF)"), onSelect: () => window.print() },
            ...(onMarkedSet ? [
              "divider",
              { section: uiText("Marked set") },
              ...(markups.length > 0 ? [{ id: "inc-markups", label: uiText("Include markups"), checked: includeMarkups, stayOpen: true, title: uiText("Include your markups (clouds, callouts, notes, highlights) in the Marked Set PDF. Independent of the canvas layer toggle."), onSelect: () => setIncludeMarkups((v) => !v) }] : []),
              { id: "marked-set", icon: "document", label: uiText(`Download marked set${markedSetDark ? " ☾" : ""}`), disabled: !rows.length && (!includeMarkups || !markups.length) && !rfis.length, title: uiText(`Distribution PDF — marked sheets with the takeoff burned in, plus a legend cover${markedSetDark ? " (dark, following your view)" : ""}`), onSelect: () => onMarkedSet(includeMarkups) },
            ] : []),
          ]}
        />
        {rfis.length > 0 && (
          <>
            <button className="btn-ghost" onClick={exportRfisCsv}
              title={uiText("RFI log — one row per RFI with linked markups/sheets derived")}><Icon name="rfi" size={13} />{uiText("RFI CSV")}</button>
            <button className="btn-ghost" onClick={exportRfisJson}
              title={uiText("RFI log as JSON")}><Icon name="rfi" size={13} />{uiText("RFI JSON")}</button>
          </>
        )}
        <button className="btn-primary" onClick={() => setShowContribute(true)} disabled={!rows.length}
          title={uiText("Optionally contribute this takeoff's derived data to the open flooring model")}>
          <Icon name="oneClick" size={13} />{uiText("Contribute")}</button>
        <button className="report-close" onClick={onClose} title={uiText("Back to the canvas (Esc)")}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12.5 }}>
          <Icon name="close" size={12} />{uiText("Close")}</button>
      </div>

      <div className="report-scroll" style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>
        {/* print pagination: the flow-table's thead repeats this one-line strip at
            the top of every printed page (screen hides it) — a fixed footer would
            overlap the last row of intermediate pages */}
        <table className="report-flow"><thead><tr><td>
          {projectName || uiText("Untitled project")} — {uiText(DISCLAIMER)}
          {/* the OpenTakeoff line on every printed page, in every branding mode */}
          <span style={{ float: "right" }}>{uiText(OT_WATERMARK)}</span>
        </td></tr></thead><tbody><tr><td>
        {/* print-only masthead — hidden on screen via app.css. Title-block header
            (logo/firm row · project title · bordered fact grid), the drafting-
            spec-book letterhead treatment. */}
        <div className="report-print-header">
          {/* firm row: logo + name/address on the left, report kind on the right,
              closed by a strong rule */}
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, borderBottom: "1.25px solid var(--ink)", paddingBottom: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              {/* clear-label: the trade-name identity. default: the OpenTakeoff
                  brand name (no company data shown — "purely OpenTakeoff") */}
              {brand.clear ? (
                <>
                  {company.logo && <img src={company.logo} alt={uiText("")} style={{ maxHeight: 46, maxWidth: 170, objectFit: "contain", display: "block" }} />}
                  {(company.name || company.address) && (
                    <div style={{ minWidth: 0 }}>
                      {company.name && <div style={{ fontFamily: "var(--f-display)", fontWeight: 700, fontSize: 12.5, lineHeight: 1.15 }}>{company.name}</div>}
                      {company.address && <div style={{ fontSize: 11, color: "var(--ink-muted)", whiteSpace: "pre-line", lineHeight: 1.35 }}>{company.address}</div>}
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontFamily: "var(--f-display)", fontWeight: 700, fontSize: 12.5, lineHeight: 1.15 }}>{uiText(brand.brandName)}</div>
              )}
            </div>
            <div style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--ink-muted)", whiteSpace: "nowrap" }}>{uiText("Takeoff Report")}</div>
          </div>

          {/* project title */}
          <div style={{ fontFamily: "var(--f-display)", fontSize: 25, fontWeight: 700, letterSpacing: "0.005em", textTransform: "uppercase", lineHeight: 0.98, margin: "11px 0 9px" }}>{projectName || uiText("Untitled project")}</div>

          {/* title-block fact grid */}
          {(() => {
            const cells = [
              ["Client", clientInfo.client_name],
              ["Reference", clientInfo.reference],
              ["Date", clientInfo.date || new Date().toLocaleDateString()],
              ["Prepared by", brand.brandName],
            ];
            return (
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${cells.length}, 1fr)`, border: "1px solid var(--ink)", marginBottom: hasClient && clientInfo.client_address ? 8 : 12 }}>
                {cells.map(([k, v], i) => (
                  <div key={k} style={{ padding: "7px 11px", borderRight: i < cells.length - 1 ? "1px solid var(--ink-faint)" : "none", minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: 2 }}>{uiText(k)}</div>
                    <div style={{ fontFamily: "var(--f-body)", fontSize: 12.5, fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v || "—"}</div>
                  </div>
                ))}
              </div>
            );
          })()}
          {/* client address rides below the grid (multi-line; capped so a pasted
              40-line address can't eat the page) */}
          {hasClient && clientInfo.client_address && (
            <div style={{ fontSize: 11, color: "var(--ink-muted)", whiteSpace: "pre-line", lineHeight: 1.4, marginBottom: 12 }}>{clientInfo.client_address.split("\n").slice(0, 4).join("\n")}</div>
          )}

          {/* meta footer: scale provenance · attribution · disclaimer */}
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--ink-muted)", lineHeight: 1.6, borderTop: "1px solid var(--ink-faint)", paddingTop: 6, marginBottom: 12 }}>
            {scaleInfo.map((si) => (
              <div key={si.sheet_id}>{sheetLabel ? sheetLabel(si.sheet_id) : si.sheet_id} — {uiText(!si.scale_source || si.scale_source === "unknown" ? "scale set — provenance unrecorded" : si.scale_source)}{si.scale_confirmed === false ? <span style={{ color: "var(--c-warning)", fontWeight: 700 }}> {uiText("· agent-set, UNCONFIRMED")}</span> : null}</div>
            ))}
            <div>{uiText("Generated ")}{uiText(new Date().toLocaleDateString())}</div>
            <div>{uiText(DISCLAIMER)}</div>
          </div>
        </div>
        {/* the empty-state hides once markups exist — "Revisions noted" below
            renders from markups alone, and "Nothing measured yet" reading as a
            headline above a populated table was a lie */}
        {!rows.length ? (
          markups.length ? null : (
            <div style={{ padding: 48, textAlign: "center", color: "var(--ink-muted)" }}>
              {uiText("Nothing measured yet — trace some areas, then come back for the breakdown.")}</div>
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
              {uiText("Grouped by ")}<strong>{uiText(groupCol ? columnLabel(groupCol) : groupBy === "label" ? "label" : groupBy === "author" ? "author" : "sheet")}</strong>
            </p>
          )}
          <table style={{ width: "100%", maxWidth: 980, margin: "0 auto", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
            <thead>
              <tr>
                {tableCols.map((c) => (
                  // custom, spec, and labor columns are text — header left-aligns with the cells
                  <th key={c.key} style={c.key === "finish" || c.custom || c.spec || c.labor ? { ...th, textAlign: "left" } : c.accent ? { ...th, color: "var(--cobalt)" } : th}>{c.custom ? c.header : uiText(c.header)}</th>
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
              const gctx = gp.perimByCond ? { perimByCond: gp.perimByCond, attrsByCond, specByCond, laborByCond } : ctx;
              return (
                <tbody key={key}>
                  {/* breakAfter is a print nicety only — unreliable on table
                      rows in Chromium, unimplemented in Gecko; occasional
                      header stranding at a page bottom is accepted in v1 */}
                  {grouped && (
                    <tr style={{ breakAfter: "avoid" }}>
                      <td colSpan={tableCols.length} style={{ ...td, textAlign: "left", fontFamily: "var(--f-display)", fontSize: 13, fontWeight: 700, background: "var(--paper-cream)", borderTop: "1px solid var(--ink-soft)", borderBottom: "1px solid var(--ink-soft)", padding: "9px 10px", ...(gp.value === null ? { fontStyle: "italic" } : {}) }}>
                        {gp.label}
                      </td>
                    </tr>
                  )}
                  {gp.rows.map((r) => (
                    <tr key={r.id}>
                      {uiText(tableCols.map((c) => renderCell(c, r, gctx)))}
                    </tr>
                  ))}
                  {/* single-row group: no subtotal — it would repeat the row verbatim */}
                  {sub && (
                    <tr>
                      <td style={{ ...td, textAlign: "left", borderTop: "1px solid var(--ink-soft)", color: "var(--ink-muted)", fontWeight: 600 }}>{uiText("Subtotal")}</td>
                      {/* lighter than the grand-total tfoot: thin border,
                          muted color; same foot mechanism on the group's
                          own grandTotals */}
                      {tableCols.slice(1).map((c) => (
                        <td key={c.key} style={{ ...td, borderTop: "1px solid var(--ink-soft)", color: "var(--ink-muted)" }}>
                          {uiText(c.foot && !c.ref ? num(c.foot(sub)) : "")}
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              );
            })}
            <tfoot>
              <tr>
                <td style={{ ...td, textAlign: "left", borderTop: "2px solid var(--ink)", borderBottom: "2px solid var(--ink)", background: "var(--paper-cream)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: "var(--f-mono)" }}>{uiText("Total")}</td>
                {/* finish is always first & locked; every other visible column gets its
                    own td — footed columns render foot(g), ref columns never foot */}
                {tableCols.slice(1).map((c) => (
                  c.foot && !c.ref ? (
                    <td key={c.key} style={{ ...td, borderTop: "2px solid var(--ink)", borderBottom: "2px solid var(--ink)", background: "var(--paper-cream)", fontWeight: 700, ...(c.accent ? { color: "var(--cobalt)" } : {}) }}>{uiText(num(c.foot(g)))}</td>
                  ) : (
                    <td key={c.key} style={{ ...td, borderTop: "2px solid var(--ink)", borderBottom: "2px solid var(--ink)", background: "var(--paper-cream)" }}></td>
                  )
                ))}
              </tr>
            </tfoot>
          </table>
          </>
        )}
        {rows.length > 0 && (
          <p style={{ maxWidth: 980, margin: "14px auto 0", fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.6 }}>
            <strong>{uiText(AU)} {uiText("w/Waste")}</strong> {uiText("= measured quantity × waste %. Waste is set per condition in the canvas. Wall ")}{uiText(AU)} {uiText("comes from Surface-Area traces (run × height); Border ")}{uiText(AU)} {uiText("from Linear runs with a thickness.")}{M ? uiText(' Coverage rates use metric units in Excel and CSV.') : ''}
            {tableCols.some((c) => c.key === "perimeter_ref") && (
              <> {uiText("Perim ")}{uiText(LU)} {uiText("(ref) sums floor-trace perimeters — includes door openings and shared walls; reference only, never totaled or waste-adjusted.")}</>
            )}
            {/* bridge to the base-quantity By-sheet section below — the two
                slice the same shapes with different semantics */}
            {groupBy === "sheet" && grouped && (
              <> {uiText("Groups show w/Waste quantities (waste and ×N applied per sheet); the By-sheet section below shows base measured quantities.")}</>
            )}
          </p>
        )}
        {rows.length > 0 && bySheet.length > 0 && (
          <div style={{ maxWidth: 980, margin: "26px auto 0" }}>
            <h3 style={{ fontFamily: "var(--f-display)", fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--ink)", margin: "0 0 10px", paddingBottom: 5, borderBottom: "1.25px solid var(--ink)" }}>{uiText("By sheet")}</h3>
            {bySheet.map((gp) => (
              <div key={gp.sheet_id} style={{ margin: "0 0 14px" }}>
                <h3 style={{ fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: "0.06em", color: "var(--ink-muted)", margin: "0 0 6px" }}>{sheetLabel ? sheetLabel(gp.sheet_id) : gp.sheet_id}</h3>
                <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: "left" }}>{uiText("Finish")}</th>
                      <th style={th}>{uiText("Floor ")}{uiText(AU)}</th>
                      <th style={th}>{uiText("Wall ")}{uiText(AU)}</th>
                      <th style={th}>{uiText("Border ")}{uiText(AU)}</th>
                      <th style={th}>{uiText(LU)}</th>
                      <th style={th}>{uiText("EA")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gp.rows.map((r) => (
                      <tr key={r.id}>
                        <td style={{ ...td, textAlign: "left", whiteSpace: "normal", width: "38%", maxWidth: 360 }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <span style={{ flexShrink: 0, width: 12, height: 12, background: r.color, display: "inline-block", border: "1px solid var(--ink-faint)" }} />
                            <strong style={{ fontFamily: "var(--f-mono)", fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>{display.finish(r.finish_tag)}</strong>
                            {r.multiplier > 1 && <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>×{uiText(r.multiplier)}</span>}
                          </span>
                        </td>
                        <td style={td}>{uiText(sheetNum(areaVal(r.floor_sf, units)))}</td>
                        <td style={td}>{uiText(sheetNum(areaVal(r.wall_sf, units)))}</td>
                        <td style={td}>{uiText(sheetNum(areaVal(r.border_sf, units)))}</td>
                        <td style={td}>{uiText(sheetNum(lenVal(r.lf, units)))}</td>
                        <td style={td}>{uiText(sheetNum(r.ea, 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <p style={{ margin: "10px auto 0", fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.6 }}>
              {uiText("Base quantities as measured per sheet — waste not applied.")}{hasMultipliers(bySheet) && (
                // the shared note + a screen-only reconcile clause (CSV/PDF omit it)
                <> {uiText(BY_SHEET_BASE_NOTE)} {uiText("— sheet subtotals × multiplier reconcile to the condition table.")}</>
              )}
            </p>
          </div>
        )}
        {markups.some((m) => m.type !== "svg" && m.type !== "image") && (
          <div style={{ maxWidth: 980, margin: "26px auto 0" }}>
            {/* svg symbols and image markups aren't revision notes — excluded */}
            <h3 style={{ fontFamily: "var(--f-display)", fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--ink)", margin: "0 0 10px", paddingBottom: 5, borderBottom: "1.25px solid var(--ink)" }}>{uiText("Revisions noted")}</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>{uiText("Type")}</th>
                  <th style={{ ...th, textAlign: "left" }}>{uiText("Sheet")}</th>
                  <th style={{ ...th, textAlign: "left" }}>{uiText("Note")}</th>
                </tr>
              </thead>
              <tbody>
                {markups.filter((m) => m.type !== "svg" && m.type !== "image").map((m) => (
                  <tr key={m.id}>
                    <td style={{ ...td, textAlign: "left" }}>
                      <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: "0.08em", border: "1px solid var(--ink-faint)", padding: "1px 6px", color: "var(--ink-soft)" }}>
                        {uiText(m.type === "cloud" ? "CLOUD" : m.type === "callout" ? "CALLOUT" : "NOTE")}
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: "left", fontFamily: "var(--f-mono)", fontSize: 11.5 }}>{sheetLabel ? sheetLabel(m.sheet_id) : m.sheet_id}</td>
                    <td style={{ ...td, textAlign: "left", whiteSpace: "normal", width: "60%" }}>{resolveNote(m.text, m.condition_id, noteQty).text || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ margin: "10px auto 0", fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.6 }}>
              {uiText("Markups are annotations, not measurements — quantities above are unaffected.")}</p>
          </div>
        )}
        {matSummary.length > 0 && (
          <div style={{ maxWidth: 980, margin: "26px auto 0" }}>
            <h3 style={{fontSize:14}}>{uiText('Supporting materials — buy list')}</h3>
            <div style={{marginBottom:12}}><MaterialUnitSelector /></div>
            <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>{uiText("Material")}</th>
                  <th style={th}>{uiText("Quantity")}</th>
                  <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>{uiText("Unit")}</th>
                </tr>
              </thead>
              <tbody>
                {matSummary.map((m, i) => (
                  <tr key={i}>
                    <td style={{ ...td, textAlign: "left" }}>{display.material(m.name)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{uiText(num(m.qty, 2))}</td>
                    <td style={{ ...td, textAlign: "left", paddingLeft: 16, color: "var(--ink-muted)" }}>{uiText(m.unit || "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ maxWidth: 980, margin: "10px auto 0", fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.7 }}>
              <strong>{uiText("By finish:")}</strong>{uiText(" ")}
              {rows.filter((r) => r.materials?.length).map((r) => (
                // inline-block + a trailing space outside the span: each finish
                // moves to the next line as a unit when it fits, and wraps
                // internally instead of running off the page edge when it
                // doesn't (#27)
                <React.Fragment key={r.id}>
                  <span style={{ marginRight: 14, display: "inline-block" }}>
                    <strong style={{ fontFamily: "var(--f-mono)" }}>{display.finish(r.finish_tag)}</strong>{uiText(" ")}
                    {r.materials.map((m) => `${display.material(m.name)} ${num(m.qty, 2)}${m.unit ? " " + uiText(m.unit) : ""}${m.note ? ` (${display.note(m.note)})` : ""}`).join(" · ")}
                  </span>{uiText(" ")}
                </React.Fragment>
              ))}
              <br />{uiText('Liquid volumes and unit prices are converted; purchase rounding follows the original package size.')}</p>
          </div>
        )}
        {/* subtle parent credit — clear-label mode only (default mode is already
            OpenTakeoff-branded in the masthead, so a separate credit is redundant) */}
        {brand.credit && (
          <p style={{ maxWidth: 980, margin: "20px auto 0", textAlign: "center", fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-faint)" }}>{uiText(brand.credit)}</p>
        )}
        </td></tr></tbody></table>
      </div>

      {showContribute && (
        <ContributeModal conditions={conditions} shapes={shapes} scaleInfo={scaleInfo} provenanceCounters={provenanceCounters} onClose={() => setShowContribute(false)} />
      )}
      {showInfo && (
        <ProjectInfoModal clientInfo={clientInfo} onClientInfo={onClientInfo}
          onSaved={() => setIdentityRev((r) => r + 1)} onClose={() => setShowInfo(false)}
          onOpenCompanySetup={onOpenCompanySetup && (() => { setShowInfo(false); onOpenCompanySetup(); })} />
      )}
    </div>
  );
}

// Project info — two homes: company identity is per-device (identity.js /
// localStorage), client/job fields are per-project (onClientInfo → autosave).
// Company edits save on every change, so an overlay-click close loses nothing;
// onSaved bumps identityRev so the print masthead re-reads immediately.
function ProjectInfoModal({ clientInfo = {}, onClientInfo, onSaved, onClose, onOpenCompanySetup }) {
  // trade-name profiles: the picker chooses which trade name is active for
  // EDITING; the active one still mirrors to the legacy company key (backward
  // compat). Which trade name BRANDS a project is the separate per-project
  // branding selection below (resolveBranding), not this active-id.
  const company = useCompanyProfiles(onSaved);
  const { profs } = company;

  // branding mode — per-project (meta KV, keyed on the project id). Toggling
  // clear-label on brands the deliverables as the trade name; off (default) is
  // OpenTakeoff. Persists immediately and bumps the masthead via onSaved.
  const projectId = projectIdFromUrl();
  const [brandSel, setBrandSel] = useState({ mode: "default", profileId: null });
  useEffect(() => {
    let alive = true;
    loadBrandingSelection(projectId).then((s) => { if (alive) setBrandSel(s); });
    return () => { alive = false; };
  }, [projectId]);
  // side effects stay OUT of the setState updater (React may double-invoke it):
  // update local state, then persist and only bump the masthead AFTER the write
  // commits — so the parent's meta-KV reload can't race ahead and read the old value
  const setBranding = (patch) => {
    const next = { ...brandSel, ...patch };
    // turning clear-label on with no explicit pick defaults to the first profile
    if (next.mode === "clearlabel" && !next.profileId) next.profileId = profs.profiles[0]?.id ?? null;
    setBrandSel(next);
    saveBrandingSelection(projectId, next).then((ok) => { if (ok && onSaved) onSaved(); });
  };
  // which chip highlights — the SAME fallback the resolver uses (activeProfile),
  // so a stale/deleted profileId highlights the profile the deliverable actually
  // brands as (profiles[0]) instead of highlighting nothing
  const brandProfileId = activeProfile({ profiles: profs.profiles, activeId: brandSel.profileId })?.id || null;

  const client = (field) => (e) => onClientInfo && onClientInfo({ ...clientInfo, [field]: e.target.value });

  const section = { fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" };
  const row = { display: "block", margin: "8px 0" };

  return (
    <div onClick={onClose} className="report-modal" style={{ position: "absolute", inset: 0, zIndex: 60, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: 520, maxWidth: "100%", maxHeight: "90%", overflow: "auto", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--ink)" }}>
          <Icon name="document" size={16} />
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 15 }}>{uiText("Project info")}</strong>
        </div>
        <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          <div style={section}>{uiText("Company — your trade names, saved on this device")}</div>
          <CompanyIdentityFields company={company} />
          {onOpenCompanySetup && (
            <button onClick={onOpenCompanySetup} className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}
              title={uiText("Phone, email, license, markups and proposal terms")}>{uiText("Company setup — markups and proposal terms…")}</button>
          )}

          {/* branding mode — per project. Off = OpenTakeoff (default); on brands
              the report + marked set as the selected trade name, keeping a subtle
              "Measured with OpenTakeoff" credit. Disabled until a trade name exists. */}
          <div style={{ ...section, borderTop: "1px solid var(--ink-faint)", marginTop: 14, paddingTop: 12 }}>{uiText("Branding — how this project's documents present")}</div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0", cursor: profs.profiles.length ? "pointer" : "not-allowed", opacity: profs.profiles.length ? 1 : 0.6 }}>
            <input type="checkbox" name="trade-name-brand" checked={brandSel.mode === "clearlabel"} disabled={!profs.profiles.length}
              onChange={(e) => setBranding({ mode: e.target.checked ? "clearlabel" : "default" })} />
            <span style={{ fontSize: 12.5 }}>
              {uiText("Trade name — brand as your company")}{!profs.profiles.length && <span style={{ color: "var(--ink-muted)" }}> {uiText("(add a trade name first)")}</span>}
            </span>
          </label>
          {brandSel.mode === "clearlabel" && profs.profiles.length > 1 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "0 0 8px" }}>
              {profs.profiles.map((p) => {
                const on = brandProfileId === p.id;
                return (
                  <button key={p.id} onClick={() => setBranding({ profileId: p.id })} title={uiText("Brand this project as this trade name")}
                    style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer",
                      border: `1px solid ${on ? "var(--cobalt)" : "var(--ink-faint)"}`,
                      background: on ? "var(--cobalt)" : "transparent", color: on ? "var(--paper-bright)" : "var(--ink)" }}>
                    {p.name || uiText("Untitled trade name")}
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ ...section, borderTop: "1px solid var(--ink-faint)", marginTop: 14, paddingTop: 12 }}>{uiText("Client / job — saved with this project")}</div>
          <label style={row}>
            <span className="field-label">{uiText("Client name")}</span>
            <input name="client-name" autoComplete="off" value={clientInfo.client_name || ""} onChange={client("client_name")} className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={row}>
            <span className="field-label">{uiText("Client address")}</span>
            <textarea name="client-address" autoComplete="off" value={clientInfo.client_address || ""} onChange={client("client_address")} rows={2}
              className="field-input" style={{ marginTop: 4, resize: "vertical" }} />
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ ...row, flex: 1 }}>
              <span className="field-label">{uiText("PO / reference")}</span>
              <input name="client-reference" autoComplete="off" value={clientInfo.reference || ""} onChange={client("reference")} className="field-input" style={{ marginTop: 4 }} />
            </label>
            <label style={{ ...row, flex: 1 }}>
              <span className="field-label">{uiText("Date")}</span>
              <input name="client-date" autoComplete="off" value={clientInfo.date || ""} onChange={client("date")} placeholder={uiText('e.g. "Bid 7/12"')}
                className="field-input" style={{ marginTop: 4 }} />
            </label>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 16px", borderTop: "1px solid var(--ink-faint)" }}>
          <button className="btn-primary" onClick={onClose}>{uiText("Done")}</button>
        </div>
      </div>
    </div>
  );
}

function ContributeModal({ conditions, shapes, scaleInfo = [], provenanceCounters = null, onClose }) {
  const [attest, setAttest] = useState(false);
  const [contributor, setContributor] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | done | error
  const [msg, setMsg] = useState("");
  const configured = isContributeConfigured();

  const send = async () => {
    if (!attest || !configured) return;
    setState("sending"); setMsg("");
    try {
      await sendContribution(buildContribution({ conditions, shapes, scaleInfo, counters: provenanceCounters }), contributor.trim());
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
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 15 }}>{uiText("Contribute to the open flooring model")}</strong>
        </div>
        <div style={{ padding: "16px", fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          <p style={{ marginTop: 0 }}>{uiText("Help grow a shared, flooring-tuned open model. We send only the ")}<strong>{uiText("derived takeoff")}</strong>:</p>
          <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
            <li>{uiText("condition labels, shape types, and quantities (SF / LF / EA)")}</li>
            <li>{uiText("normalized room geometry (shape only — no scale, no location)")}</li>
            <li>{uiText("how each shape was made (hand-traced vs. machine-proposed) and whether you corrected it")}</li>
          </ul>
          <p style={{ margin: "0 0 10px", color: "var(--c-positive)", fontWeight: 600 }}>
            {uiText("Never sent: the PDF itself, file names, project or client names, your markups, or any absolute coordinates.")}</p>
          {!configured && (
            <p style={{ background: "var(--paper-shadow)", padding: "8px 10px", fontSize: 12.5, color: "var(--ink)" }}>
              {uiText("This build has no contribution endpoint configured, so nothing can be sent. (Set ")}<code>{"VITE_CONTRIBUTE_ENDPOINT"}</code> {uiText("at build time, or")}<code> {"localStorage.opentakeoff_contribute_endpoint"}</code> {uiText("in your browser.)")}</p>
          )}
          <label style={{ display: "block", margin: "6px 0" }}>
            <span className="field-label">{uiText("Credit (optional)")}</span>
            <input name="contributor" autoComplete="name" value={contributor} onChange={(e) => setContributor(e.target.value)} placeholder={uiText("Name or company to credit")}
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "12px 0", cursor: "pointer" }}>
            <input name="attest" type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} style={{ marginTop: 3 }} />
            <span>{uiText("I have the right to share this takeoff data and am contributing it to the open flooring model.")}</span>
          </label>
          {msg && <p style={{ fontSize: 12.5, color: state === "error" ? "var(--c-danger)" : "var(--c-positive)" }}>{uiText(msg)}</p>}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: "12px 16px", borderTop: "1px solid var(--ink-faint)" }}>
          <button className="btn-ghost" onClick={onClose}>{uiText(state === "done" ? "Close" : "Cancel")}</button>
          <button className="btn-primary" onClick={send} disabled={!attest || !configured || state === "sending" || state === "done"}>
            {uiText(state === "sending" ? "Sending…" : "Contribute")}
          </button>
        </div>
      </div>
    </div>
  );
}
