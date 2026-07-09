// TakeoffsPanel — the docked conditions panel on the canvas's right edge
// (reflows the canvas, not an overlay): every condition with its running
// totals and inline properties, plus the template Library, material-library
// Materials (#47/#48), and custom Columns tabs. Extracted from TakeoffCanvas
// and memoized so canvas-only renders (the
// ~11Hz transform mirror during pan/zoom, crosshair churn) skip this whole
// subtree — every callback prop the canvas passes is identity-stable.
//
// View state lives HERE (active tab, filter, collapsed tag-family groups, the
// ⌘/⇧ multi-select, bulk-waste draft): search keystrokes and bulk inputs
// re-render only the panel. Three couplings reach back to the canvas:
//   · `epoch` — hydrate (mount load or snapshot Load) bumps it and an effect
//     clears filter/collapsed-groups/selection IN PLACE. An effect, not a
//     `key` remount: the active tab and resize width survive a snapshot load
//     exactly as they did when this state lived in the canvas.
//   · `clearSelectionRef` — the canvas owns activateCondition (panel rows, the
//     compact strip, and the 1–9 hotkeys all funnel through it); plain
//     activation dismisses a live bulk selection through this ref.
//   · bulk MUTATIONS stay in the canvas: onBulkWaste/onBulkColor/onBulkDelete
//     take the LIVE id set computed here. Liveness derives from the conditions
//     prop (`liveChecked`), so a checked id deleted elsewhere is inert by
//     construction — the canvas never needs to prune this selection.
//
// The panel stays MOUNTED while collapsed (open=false renders null), so all of
// that transient state survives a collapse/expand round-trip.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { attrValue, columnLabel } from "../lib/conditionColumns.js";
import { num } from "../lib/num.js";
import { HATCHES, PALETTE, NO_FILL, HatchSwatch } from "./hatches.jsx";
import { LINE_STYLES, LINE_STYLE_IDS } from "../lib/lineStyles.js";

export const PANEL_MIN_W = 240;
export const PANEL_MAX_W = 560;
export const clampPanelW = (w) => Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, w));

// drag-and-drop payload type carrying a condition id — a condition row here is
// a drag SOURCE, the top-bar quick-access palette (TakeoffCanvas) is the drop
// TARGET. Custom MIME so a condition drag never looks like a file drop.
export const CONDITION_DND_MIME = "application/x-opentakeoff-condition";

// tag family = the text before the dash (CPT-1 → CPT) — the grouping key for
// the panel's grouped view. VIEW-ONLY, like sort and search: the conditions
// array order is canonical (1–9 hotkeys are positional and the payload
// serializes it), so nothing here ever reorders the array itself.
const tagFamily = (t) => (String(t || "").split("-")[0].trim().toUpperCase() || "—");
// one module-level collator — localeCompare builds a fresh collator per CALL
// (~56× slower, benchmarked), and natCompare runs n·log n per sorted view
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const natCompare = (a, b) => coll.compare(String(a), String(b));

// shared style atoms — these were re-declared at every call site (one even
// fresh per matLib row per render); hoisted so identical controls can't drift
const ip = { padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 };
const btnAddFull = { width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 };
const btnClearX = { border: "none", background: "none", color: "var(--ink-muted)", cursor: "pointer", fontSize: 13, padding: 0 };

// Adhesive coverage by trowel notch, SF per gallon. Typical wood-adhesive range is
// ~40–70 SF/gal: a wider/coarser notch lays more glue and covers less per gallon.
// Picking a notch fills the coverage rate + notes it. Always verify against the
// current product data sheet for your subfloor + flooring type.
const TROWEL_PRESETS = [
  { label: "fine",     per: 70 },
  { label: "medium",   per: 58 },
  { label: "standard", per: 50 },
  { label: "coarse",   per: 40 },
];
const isAdhesive = (name) => /adhes|glue|bond|mastic/i.test(name || "");

// Editable supporting-materials rows — the assembly behind a condition.
function MaterialsEditor({ materials, onAdd, onUpdate, onRemove, library, libById, overridden, onRevert, onAttach, onPromote }) {
  // library link affordances (#47, all optional so the editor works standalone):
  // linked lines show ⛓; a field differing from its library entry tints amber
  // and grows a per-field ↺ revert; unlinked lines can be promoted to the library
  const OV = "1px solid #c47a10";
  const rv = (m, f) => (
    <button onClick={() => onRevert(m, f)} title="Revert this field to the library value"
      style={{ padding: "0 3px", border: "none", background: "transparent", color: "#c47a10", cursor: "pointer", fontSize: 11, lineHeight: 1 }}>↺</button>
  );
  return (
    <>
      {(materials || []).map((m) => {
        const lm = libById ? libById[m.lib_id] : null;
        const ov = (f) => (lm && overridden ? overridden(m, lm, f) : false);
        return (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {lm && <span title={`Linked to “${lm.name}” in the material library — amber fields differ from the library values`} style={{ color: "var(--ink-muted)", fontSize: 11, cursor: "default" }}>⛓</span>}
            <input value={m.name} onChange={(e) => onUpdate(m.id, { name: e.target.value })} placeholder="Material (e.g. Adhesive)" style={{ ...ip, width: 160, ...(ov("name") ? { border: OV } : {}) }} />
            {ov("name") && rv(m, "name")}
            <span style={{ color: "var(--ink-muted)" }}>1</span>
            <input value={m.unit} onChange={(e) => onUpdate(m.id, { unit: e.target.value })} placeholder="unit" style={{ ...ip, width: 60, ...(ov("unit") ? { border: OV } : {}) }} />
            {ov("unit") && rv(m, "unit")}
            <span style={{ color: "var(--ink-muted)" }}>per</span>
            <input type="number" min="0" step="any" value={m.per || ""} onChange={(e) => onUpdate(m.id, { per: Math.max(0, parseFloat(e.target.value) || 0) })} placeholder="0" style={{ ...ip, width: 66, ...(ov("per") ? { border: OV } : {}) }} />
            {ov("per") && rv(m, "per")}
            <select value={m.basis || "area"} onChange={(e) => onUpdate(m.id, { basis: e.target.value })} style={{ ...ip, background: "var(--paper-bright)", ...(ov("basis") ? { border: OV } : {}) }}>
              <option value="area">floor SF</option>
              <option value="linear">linear LF</option>
              <option value="count">each</option>
            </select>
            {ov("basis") && rv(m, "basis")}
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4, color: ov("round") ? "#c47a10" : "var(--ink-muted)" }} title="Round up to whole units (you buy whole buckets/bags)">
              <input type="checkbox" checked={m.round !== false} onChange={(e) => onUpdate(m.id, { round: e.target.checked })} />round up
            </label>
            {ov("round") && rv(m, "round")}
            {isAdhesive(m.name) && (m.basis || "area") === "area" && (
              <select value={TROWEL_PRESETS.some((t) => t.label === m.note) ? m.note : ""}
                onChange={(e) => { const t = TROWEL_PRESETS.find((x) => x.label === e.target.value); if (t) onUpdate(m.id, { note: t.label, per: t.per }); }}
                title="Trowel notch — sets the adhesive coverage (SF/gal). Verify against the data sheet."
                style={{ ...ip, background: "var(--paper-bright)" }}>
                <option value="">trowel…</option>
                {TROWEL_PRESETS.map((t) => <option key={t.label} value={t.label}>{t.label} · {t.per} SF/gal</option>)}
              </select>
            )}
            <input value={m.note || ""} onChange={(e) => onUpdate(m.id, { note: e.target.value })} placeholder="note (coats, trowel…)" style={{ ...ip, width: 150, ...(ov("note") ? { border: OV } : {}) }} />
            {ov("note") && rv(m, "note")}
            {!lm && onPromote && (
              <button onClick={() => onPromote(m)} title="Save this material to the library (this line becomes linked)"
                style={{ padding: "2px 7px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>→ lib</button>
            )}
            <button onClick={() => onRemove(m.id)} title="Remove this material"
              style={{ padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 12 }}>✕</button>
          </div>
        );
      })}
      <button onClick={onAdd}
        style={{ marginTop: 2, padding: "4px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>+ add material</button>
      {onAttach && (library || []).length > 0 && (
        <select value="" onChange={(e) => { if (e.target.value) onAttach(e.target.value); }}
          title="Attach a material from the library — the line copies the library values and stays linked"
          style={{ ...ip, marginLeft: 6, background: "var(--paper-bright)", color: "var(--ink-muted)" }}>
          <option value="">+ from library…</option>
          {library.map((lm) => <option key={lm.id} value={lm.id}>{lm.name || "(unnamed)"}{lm.per ? ` · ${lm.per}/${lm.unit || "?"}` : ""}</option>)}
        </select>
      )}
    </>
  );
}

// Per-condition custom-column assignment — one select per defined column.
// Unassigned = attrs key absent; a value deleted from the vocabulary
// keeps the condition's string, shown as "<value> (removed)".
function ColumnSelects({ columns, cond, onAssign }) {
  return (
    <>
      {columns.map((cc) => {
        const v = attrValue(cond?.attrs, cc.id);   // the shared assigned-value rule (hydrate sanitizes, this keeps the display consistent)
        return (
          <label key={cc.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginRight: 12, marginBottom: 6 }}>
            <span style={{ color: "var(--ink-muted)" }}>{columnLabel(cc)}</span>
            <select value={v} onChange={(e) => onAssign(cc.id, e.target.value)} style={{ ...ip, background: "var(--paper-bright)" }}>
              <option value="">Unassigned</option>
              {cc.values.map((val) => <option key={val} value={val}>{val}</option>)}
              {v && !cc.values.includes(v) && <option value={v}>{v} (removed)</option>}
            </select>
          </label>
        );
      })}
    </>
  );
}

// add-value input for the column manager — local draft state, commit on Enter/+
function AddValueInput({ onAdd }) {
  const [v, setV] = useState("");
  const commit = () => { const t = v.trim(); if (t) onAdd(t); setV(""); };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && commit()} placeholder="add value" style={{ ...ip, width: 90 }} />
      <button onClick={commit} title="Add this value to the list"
        style={{ padding: "2px 7px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>+</button>
    </span>
  );
}

// Appearance editor for ONE condition — tag, ×N, waste, line/fill color, hatch,
// line style, height, thickness, and custom-column assignment. This is the row
// that "used to live in its own toolbar row above the canvas"; extracted here so
// the docked panel AND the restored top-bar band render the SAME editor (one
// source of truth, like the app's single activateCondition path). Owns only its
// hatch-popover open state; everything else flows through the passed handlers.
export function ConditionAppearanceEditor({ cond: c, onUpdateCond, onSetCondParam, onAssignAttr, conditionColumns = [], layout = "stack" }) {
  const [hatchOpen, setHatchOpen] = useState(false);
  const activeColor = c.color || "#c96442";
  // Two layouts, one editor. "stack" (docked panel, narrow) stacks the groups
  // vertically; "row" (top-bar band, wide) flows them left-to-right so they use
  // the horizontal space instead of clumping in a corner, split by thin rules.
  const isRow = layout === "row";
  const rule = () => <span aria-hidden style={{ width: 1, alignSelf: "stretch", background: "var(--ink-faint)", margin: "0 3px" }} />;
  return (
    <div style={isRow
      ? { padding: "6px 2px 2px", display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 8, fontSize: 11 }
      : { padding: "4px 12px 10px", display: "flex", flexDirection: "column", gap: 7, fontSize: 11 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input value={c.finish_tag} onChange={(e) => onUpdateCond({ finish_tag: e.target.value })}
          title="Rename this condition / finish tag"
          style={{ width: 88, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: 12, color: "var(--ink)" }} />
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title="Multiply this condition by N identical units (measure one, ×N)">
          <span style={{ color: "var(--ink-muted)" }}>×</span>
          <input type="number" min="1" step="1" value={c.multiplier || 1}
            onChange={(e) => onUpdateCond({ multiplier: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            style={{ width: 46, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title="Waste % — a flooring allowance added on top of the measured quantity in the Report. You choose it per condition (e.g. ~8% straight-lay LVP, ~15% diagonal, ~20% herringbone).">
          <span style={{ color: "var(--ink-muted)" }}>Waste</span>
          <input type="number" min="0" step="1" value={c.waste_pct ?? 0}
            onChange={(e) => onUpdateCond({ waste_pct: Math.max(0, parseFloat(e.target.value) || 0) })}
            style={{ width: 50, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
          <span style={{ color: "var(--ink-muted)" }}>%</span>
        </span>
      </div>
      {isRow && rule()}
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        <span style={{ color: "var(--ink-muted)", width: 26 }}>Line</span>
        {PALETTE.map((p) => <button key={p} title={p} onClick={() => onUpdateCond({ color: p })} style={{ width: 16, height: 16, borderRadius: 4, background: p, border: c.color === p ? "2px solid #0e1a2e" : "1px solid var(--ink-faint)", cursor: "pointer" }} />)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        <span style={{ color: "var(--ink-muted)", width: 26 }}>Fill</span>
        <button title="No fill" onClick={() => onUpdateCond({ fill: NO_FILL })} style={{ width: 16, height: 16, borderRadius: 4, background: "var(--paper-bright)", border: c.fill === NO_FILL ? "2px solid #0e1a2e" : "1px solid var(--ink-faint)", cursor: "pointer", fontSize: 9, lineHeight: "12px", color: "#b03a26" }}>⦸</button>
        {PALETTE.map((p) => <button key={p} title={p} onClick={() => onUpdateCond({ fill: p })} style={{ width: 16, height: 16, borderRadius: 4, background: p, opacity: 0.55, border: c.fill === p ? "2px solid #0e1a2e" : "1px solid var(--ink-faint)", cursor: "pointer" }} />)}
      </div>
      {isRow && rule()}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4, position: "relative" }}>
          <button onClick={() => setHatchOpen((v) => !v)} title="Choose a hatch pattern"
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 7px 2px 2px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", lineHeight: 0 }}>
            <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>
            <span style={{ fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1 }}>{(HATCHES.find((h) => h.id === (c.hatch || "solid")) || {}).label || "Solid"} ▾</span>
          </button>
          {hatchOpen && (
            <div style={{ position: "absolute", top: 26, left: 0, zIndex: 30, display: "grid", gridTemplateColumns: "repeat(6, auto)", gap: 4, padding: 8, background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", borderRadius: 0, boxShadow: "0 6px 22px rgba(0,0,0,.16)" }}>
              {HATCHES.map((h) => {
                const hOn = (c.hatch || "solid") === h.id;
                return <button key={h.id} title={h.label} onClick={() => { onUpdateCond({ hatch: h.id }); setHatchOpen(false); }} style={{ padding: 1, borderRadius: 0, border: hOn ? `2px solid ${activeColor}` : "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", lineHeight: 0 }}><HatchSwatch type={h.id} line={c.color} fill={c.fill} /></button>;
              })}
            </div>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title="Line style — the outline dash for this finish's floor-area and linear takeoffs (canvas + Marked Set PDF). Surface walls and deducts keep their own dashing.">
          <span style={{ color: "var(--ink-muted)" }}>Style</span>
          <select value={c.line_style || "solid"} onChange={(e) => onUpdateCond({ line_style: e.target.value })}
            style={{ fontSize: 11, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", padding: "1px 3px" }}>
            {LINE_STYLE_IDS.map((id) => <option key={id} value={id}>{LINE_STYLES[id].label}</option>)}
          </select>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title="Height (ft) — the default for NEW wall traces (SF = LF × H) and the vertical-SF display on floor areas. Walls keep the height they were drawn at — select a wall to change just that one.">
          <Icon name="height" size={13} /><span style={{ color: "var(--ink-muted)" }}>H</span>
          <input type="number" min="0" step="0.25" value={c.height_ft ?? ""} placeholder="ft"
            onChange={(e) => onSetCondParam("height_ft", e.target.value)}
            style={{ width: 54, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title="Thickness (in) — a Linear run with thickness also computes border/feature-strip SF = LF × T/12. Changing it re-flows existing linear runs.">
          <Icon name="thickness" size={13} /><span style={{ color: "var(--ink-muted)" }}>T</span>
          <input type="number" min="0" step="0.25" value={c.thickness_in ?? ""} placeholder="in"
            onChange={(e) => onSetCondParam("thickness_in", e.target.value)}
            style={{ width: 50, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
        </span>
      </div>
      {conditionColumns.length > 0 && isRow && rule()}
      {conditionColumns.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 2 }} title="Classify this condition — the Report can group and export by these (manage columns in the Columns tab)">
          <ColumnSelects columns={conditionColumns} cond={c} onAssign={onAssignAttr} />
        </div>
      )}
    </div>
  );
}

function TakeoffsPanel({
  open, width, multiSheet,
  conditions, activeCond, visRowById, conditionColumns, templates, palette = [],
  matLib, matLibById, linkedCountById,
  panelPrefs, onPanelPrefs, reassigning, epoch, clearSelectionRef,
  onActivate, onSetActive, onLocate,
  onAddCondition, onDeleteCondition, onUpdateCond, onSetCondParam, onAssignAttr,
  onAddMaterial, onUpdateMaterial, onRemoveMaterial,
  onBulkWaste, onBulkColor, onBulkDelete,
  onSaveTemplate, onApplyTemplate, onRenameTemplate, onDeleteTemplate,
  onAttachLibMaterial, onPromoteMaterial, onRevertMatField, matFieldOverridden,
  onUpdateLibMaterial, onPushLibUpdate, onDeleteLibMaterial, onAddLibMaterial,
  onAddColumn, onRenameColumn, onDeleteColumn, onAddColumnValue, onRemoveColumnValue, onRenameColumnValue,
  onToggleCollapse, onHoldGesture, onTogglePin,
}) {
  const [panelTab, setPanelTab] = useState("takeoffs");       // "takeoffs" | "library" | "materials" | "columns"
  const [condQuery, setCondQuery] = useState("");             // live filter over the condition list (transient, never persisted)
  const [matLibQuery, setMatLibQuery] = useState("");         // Materials tab search (transient; describes the browser-global library, so hydrate/epoch leaves it alone)
  const [closedGroups, setClosedGroups] = useState(() => new Set()); // collapsed tag-family groups in the grouped view
  // multi-select for bulk edit — VIEW STATE ONLY, never persisted. ⌘/ctrl-click
  // toggles a row into the set, ⇧-click ranges from the last toggle in the
  // current view order, plain click clears (and activates, as always).
  const [checkedConds, setCheckedConds] = useState(() => new Set());
  const [bulkWaste, setBulkWaste] = useState("");
  const checkAnchorRef = useRef(null);
  const [panelMatOpen, setPanelMatOpen] = useState(false);    // assemblies editor expanded inline under the active row
  const rootRef = useRef(null);   // panel root — mid-drag width writes bypass React
  const dragRef = useRef(null);   // { sx, sw, w } — w is the live width during the drag

  // hydrate (mount load or snapshot Load) replaced the conditions this view
  // state described — a checked set / range anchor / filter / collapsed groups
  // aimed at the PRE-load list would misfire on ids that happen to survive.
  // Cleared in place so panelTab (and the width pref) survive, matching the
  // pre-extraction behavior. On mount this is a no-op (fresh state).
  useEffect(() => {
    setCheckedConds((s) => (s.size ? new Set() : s));
    checkAnchorRef.current = null;
    setCondQuery("");
    setClosedGroups((s) => (s.size ? new Set() : s));
  }, [epoch]);

  // the canvas's activateCondition (rows, strip, 1–9 hotkeys) dismisses a live
  // bulk selection — it reaches this view state through the shared ref
  useEffect(() => {
    if (!clearSelectionRef) return undefined;
    clearSelectionRef.current = () => setCheckedConds((s) => (s.size ? new Set() : s));
    return () => { clearSelectionRef.current = null; };
  }, [clearSelectionRef]);

  // ── condition list: VIEW-ONLY search / natural sort / grouping ────────────
  // Rows are wrapped as { c } so the view transforms (filter/sort/group) never
  // touch the condition objects; the hotkey badge now reflects palette order,
  // resolved per row from the palette prop (no original-index bookkeeping).
  const condQ = condQuery.trim().toLowerCase();
  const matQ = matLibQuery.trim().toLowerCase();   // Materials tab filter — hoisted so the row map below computes it once, not per row
  // the one finish-tag match rule — condView's filter and searchMiss must
  // agree on what "matches" means, or a row could show while the "no match"
  // message also shows (or vice versa)
  const matchesQuery = useCallback((c) => (c.finish_tag || "").toLowerCase().includes(condQ), [condQ]);
  const condView = useMemo(() => {
    let v = conditions.map((c) => ({ c }));
    // the ACTIVE condition is force-included past the filter: hotkeys, the
    // strip, and applyTemplate can activate a row the query hides, and the
    // properties editor lives only in the active row — it must stay reachable
    if (condQ) v = v.filter(({ c }) => matchesQuery(c) || c.id === activeCond);
    if (panelPrefs.az) v = [...v].sort((a, b) => natCompare(a.c.finish_tag, b.c.finish_tag));
    return v;
  }, [conditions, condQ, matchesQuery, activeCond, panelPrefs.az]);
  const condGroups = useMemo(() => {
    if (!panelPrefs.group) return [{ name: null, items: condView }];
    const by = new Map();
    for (const it of condView) {
      const fam = tagFamily(it.c.finish_tag);
      if (!by.has(fam)) by.set(fam, []);
      by.get(fam).push(it);
    }
    return [...by.entries()].sort((a, b) => natCompare(a[0], b[0])).map(([name, items]) => ({ name, items }));
  }, [condView, panelPrefs.group]);
  // "no match" keys on the QUERY missing, not on an empty view — the forced-in
  // active row would otherwise hide the message forever (includes("") is true)
  const searchMiss = conditions.length > 0 && !condView.some(({ c }) => matchesQuery(c));

  // the one "which rows does a collapsed group show" rule — a collapsed
  // group still renders its ACTIVE row: hotkeys, the strip, and applyTemplate
  // can activate a condition the view hides, and the editor lives only in
  // that row. Shared by the ⇧-range order below AND the render, below, so
  // they can never disagree on what's visible.
  const groupVisibleItems = useCallback(
    (g) => (g.name != null && closedGroups.has(g.name) ? g.items.filter((it) => it.c.id === activeCond) : g.items),
    [closedGroups, activeCond]
  );
  // bulk selection helpers — ranges follow the DISPLAYED order (current view,
  // skipping collapsed groups — except the active row, which a collapsed group
  // still renders, so ⇧-ranges anchored on or through it must see it too)
  const visibleCondOrder = useMemo(
    () => condGroups.flatMap((g) => groupVisibleItems(g).map((it) => it.c.id)),
    [condGroups, groupVisibleItems]
  );
  // bulk actions run on the LIVE intersection — checkedConds is view state and
  // deletes elsewhere (or a stale set) must never inflate a count or a patch
  const liveChecked = conditions.filter((c) => checkedConds.has(c.id));
  const liveIds = () => new Set(liveChecked.map((c) => c.id));
  const toggleChecked = (id) => {
    setCheckedConds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    checkAnchorRef.current = id;
  };
  const rangeCheck = (id) => {
    const a = checkAnchorRef.current;
    const ai = a ? visibleCondOrder.indexOf(a) : -1, bi = visibleCondOrder.indexOf(id);
    if (ai < 0 || bi < 0) { toggleChecked(id); return; }
    const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
    setCheckedConds((s) => { const n = new Set(s); for (let k = lo; k <= hi; k++) n.add(visibleCondOrder[k]); return n; });
  };
  const applyBulkWaste = () => {
    const v = Math.max(0, parseFloat(bulkWaste));
    if (!Number.isFinite(v)) return;
    onBulkWaste(liveIds(), v);
  };
  const bulkDelete = () => {
    if (!liveChecked.length) return;
    // the canvas confirms + mutates; the selection clears only if it went through
    if (onBulkDelete(liveIds())) { setCheckedConds(new Set()); checkAnchorRef.current = null; }
  };

  // Resize by dragging the panel's left edge. Mid-drag the width lives in a
  // ref and goes straight to the panel root's DOM style — NO pref commit per
  // move (each one re-rendered the whole canvas tree and re-wrote
  // localStorage). The canvas's detail-crop gesture window is held per move
  // (onHoldGesture, like wheel zoom) and state commits ONCE on release, so the
  // persistence effect and the detail crop fire once per drag.
  const onResizeDown = (e) => {
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sw: width, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e) => {
    const d = dragRef.current; if (!d) return;
    if (e.buttons === 0) { onResizeEnd(e); return; }   // release happened off-window — a missed pointerup must not leave a phantom drag
    onHoldGesture();
    d.w = clampPanelW(d.sw + (d.sx - e.clientX));
    if (rootRef.current) rootRef.current.style.width = `${d.w}px`;
  };
  // shared by pointerup / pointercancel / lostpointercapture — any way the
  // gesture ends, the width commits exactly once
  const onResizeEnd = (e) => {
    const d = dragRef.current; if (!d) return;
    dragRef.current = null;
    onPanelPrefs((p) => (p.w === d.w ? p : { ...p, w: d.w }));
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
  };

  const aCond = conditions.find((c) => c.id === activeCond);

  const renderCondRow = (c) => {
    const row = visRowById.get(c.id);
    const mult = c.multiplier || 1;
    const sf = row?.floor_sf || 0, lf = row?.lf || 0, ea = row?.ea || 0, wsf = row?.wall_sf || 0;
    const shapeCount = row?.shape_count || 0;
    const on = c.id === activeCond;
    const matOn = on && panelMatOpen;
    const checked = checkedConds.has(c.id);
    const pinIdx = palette.indexOf(c.id);        // position in the top-bar palette (−1 = not pinned)
    const pinned = pinIdx >= 0;
    // 1–9 hotkey badge follows the same rule as the keys (and the strip): palette
    // order when the palette is curated, condition-array order as the fallback
    // when nothing is pinned so the badge never under-advertises a working key
    const hIdx = palette.length ? pinIdx : conditions.findIndex((x) => x.id === c.id);
    const hot = hIdx >= 0 && hIdx < 9;
    return (
      <div key={c.id} data-cond-id={c.id} style={{ borderTop: "1px solid var(--ink-faint)", background: checked ? "#e8eefc" : on ? "#f3f8f4" : "transparent", borderLeft: on ? `3px solid ${c.color}` : checked ? "3px solid #1f3fc7" : "3px solid transparent" }}>
        <div draggable
          onDragStart={(e) => { e.dataTransfer.setData(CONDITION_DND_MIME, c.id); e.dataTransfer.effectAllowed = "copy"; }}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) { toggleChecked(c.id); return; }
            if (e.shiftKey) { rangeCheck(c.id); return; }
            onActivate(c.id);
          }}
          onDoubleClick={() => onLocate(c.id)}
          title={reassigning ? "Reassign selected shape to this condition" : "Make this the active condition (double-click zooms to its takeoffs · ⌘-click / ⇧-click selects for bulk edit · drag to the top-bar palette for one-click access)"}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", cursor: "pointer", outline: reassigning ? "1px dashed #1f3fc7" : "none", outlineOffset: -3, userSelect: "none" }}>
          {hot && <span title={pinned ? `Palette shortcut — press ${hIdx + 1} to activate` : `Press ${hIdx + 1} to activate (pin to lock this number)`} style={{ fontSize: 9, fontFamily: "var(--f-mono,monospace)", color: pinned ? "var(--cobalt)" : "var(--ink-muted)", border: `1px solid ${pinned ? "var(--cobalt)" : "var(--ink-faint)"}`, borderRadius: 3, padding: "0 3px", flexShrink: 0 }}>{hIdx + 1}</span>}
          <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: on ? 700 : 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.finish_tag}{mult > 1 ? <span style={{ color: "var(--ink-muted)", fontWeight: 500 }}> ×{mult}</span> : null}</div>
            <div style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 11, color: "var(--ink-muted)" }}>
              {sf ? `${num(sf)} SF` : ""}{wsf ? `${sf ? " · " : ""}${num(wsf)} SF wall` : ""}{lf ? `${sf || wsf ? " · " : ""}${num(lf)} LF` : ""}{ea ? `${sf || wsf || lf ? " · " : ""}${num(ea, 0)} EA` : ""}{!sf && !wsf && !lf && !ea ? "—" : ""}
            </div>
          </div>
          <span style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, color: "var(--ink-muted)", flexShrink: 0 }}>{shapeCount}▦</span>
          <button onClick={(e) => { e.stopPropagation(); onLocate(c.id); }} title="Zoom the canvas to this condition's takeoffs"
            style={{ flexShrink: 0, padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12, lineHeight: 1 }}>⌖</button>
          <button onClick={(e) => { e.stopPropagation(); onSetActive(c.id); setPanelMatOpen((v) => (on ? !v : true)); }}
            title="Assemblies — supporting materials for this condition"
            style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: matOn ? "var(--ink)" : "transparent", color: matOn ? "var(--paper-bright)" : "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>
            <Icon name="product" size={11} />{c.materials?.length ? c.materials.length : ""}
          </button>
          <button onClick={(e) => { e.stopPropagation(); onTogglePin(c.id); }}
            title={pinned ? "Unpin from the top-bar palette" : (palette.length >= 9 ? "Palette is full (9)" : "Pin to the top-bar palette for one-click access")}
            style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", padding: "2px 5px", borderRadius: 0, border: `1px solid ${pinned ? "var(--cobalt)" : "var(--ink-faint)"}`, background: "transparent", color: pinned ? "var(--cobalt)" : (!pinned && palette.length >= 9 ? "var(--ink-faint)" : "var(--ink-muted)"), cursor: "pointer", lineHeight: 0 }}>
            <Icon name="pin" size={12} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDeleteCondition(c.id); }} title="Delete this condition (and its takeoffs)"
            style={{ flexShrink: 0, padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 12 }}>✕</button>
        </div>
        {/* properties for the ACTIVE condition — the appearance editing that
            used to live in its own toolbar row above the canvas. Extracted to
            ConditionAppearanceEditor so the docked panel AND the top-bar band
            render the same editor from one source of truth. */}
        {on && <ConditionAppearanceEditor cond={c} onUpdateCond={onUpdateCond} onSetCondParam={onSetCondParam} onAssignAttr={onAssignAttr} conditionColumns={conditionColumns} />}
        {matOn && (
          <div style={{ padding: "8px 12px 10px", background: "var(--paper-cream)", borderTop: "1px solid var(--ink-faint)", fontSize: 11.5 }}>
            <div style={{ marginBottom: 6, color: "var(--ink-muted)" }}>Assemblies — order qty = measured ÷ coverage, rounded up.</div>
            <MaterialsEditor materials={c.materials} onAdd={onAddMaterial} onUpdate={onUpdateMaterial} onRemove={onRemoveMaterial}
              library={matLib} libById={matLibById} overridden={matFieldOverridden} onRevert={onRevertMatField}
              onAttach={onAttachLibMaterial} onPromote={onPromoteMaterial} />
          </div>
        )}
      </div>
    );
  };

  if (!open) return null;
  return (
    <div ref={rootRef} style={{ width, flexShrink: 0, display: "flex", background: "var(--paper-bright)", borderLeft: "1px solid var(--ink-faint)", fontSize: 12.5 }}>
      <div onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd} onLostPointerCapture={onResizeEnd}
        title="Drag to resize"
        style={{ width: 5, flexShrink: 0, cursor: "col-resize", touchAction: "none", background: "transparent", borderRight: "1px solid var(--ink-faint)" }} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 12px", background: "var(--ink)", color: "var(--paper-cream)", flexShrink: 0 }}>
          <span style={{ display: "inline-flex", gap: 2 }}>
            {[["takeoffs", `Takeoffs · ${multiSheet ? "these sheets" : "this sheet"}`], ["library", `Library${templates.length ? ` (${templates.length})` : ""}`], ["materials", `Materials${matLib.length ? ` (${matLib.length})` : ""}`], ["columns", `Columns${conditionColumns.length ? ` (${conditionColumns.length})` : ""}`]].map(([id, label]) => (
              <button key={id} onClick={() => setPanelTab(id)}
                style={{ padding: "3px 8px", border: "none", borderBottom: panelTab === id ? "2px solid var(--paper-cream)" : "2px solid transparent", background: "none", color: "var(--paper-cream)", opacity: panelTab === id ? 1 : 0.65, cursor: "pointer", fontWeight: 700, fontSize: 12.5 }}>{label}</button>
            ))}
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => onPanelPrefs((p) => ({ ...p, strip: !p.strip }))}
              title="Compact strip — also show the conditions as a horizontal strip above the canvas (handy on small projects with the panel collapsed)"
              style={{ background: panelPrefs.strip ? "var(--paper-cream)" : "none", border: "1px solid var(--paper-cream)", color: panelPrefs.strip ? "var(--ink)" : "var(--paper-cream)", fontSize: 9.5, fontFamily: "var(--f-mono)", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", padding: "2px 6px", lineHeight: 1.4 }}>strip</button>
            <button onClick={onToggleCollapse} title="Collapse the panel (the ☰ button on the canvas edge brings it back)"
              style={{ background: "none", border: "none", color: "#fff", fontSize: 15, cursor: "pointer", lineHeight: 1 }}>»</button>
          </span>
        </div>
        {panelTab === "takeoffs" && <>
        {/* view controls — search / natural sort / tag-family grouping.
            All VIEW-ONLY: the array order (hotkeys, payload) never changes. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--ink-faint)", flexShrink: 0 }}>
          <input value={condQuery} onChange={(e) => setCondQuery(e.target.value)} placeholder="filter conditions…"
            style={{ flex: 1, minWidth: 0, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
          {condQuery && <button onClick={() => setCondQuery("")} title="Clear the filter" style={btnClearX}>×</button>}
          <button onClick={() => onPanelPrefs((p) => ({ ...p, az: !p.az }))}
            title="Natural sort by tag (CT-2 before CT-10) — a view; hotkeys 1–9 keep their original numbering"
            style={{ padding: "3px 7px", borderRadius: 0, border: `1px solid ${panelPrefs.az ? "var(--cobalt)" : "var(--ink-faint)"}`, background: panelPrefs.az ? "var(--cobalt)" : "transparent", color: panelPrefs.az ? "var(--paper-bright)" : "var(--ink-muted)", cursor: "pointer", fontSize: 10.5, fontFamily: "var(--f-mono)", lineHeight: 1.4 }}>A→Z</button>
          <button onClick={() => onPanelPrefs((p) => ({ ...p, group: !p.group }))}
            title="Group by tag family (the text before the dash: CPT, LVT, CT…)"
            style={{ padding: "3px 7px", borderRadius: 0, border: `1px solid ${panelPrefs.group ? "var(--cobalt)" : "var(--ink-faint)"}`, background: panelPrefs.group ? "var(--cobalt)" : "transparent", color: panelPrefs.group ? "var(--paper-bright)" : "var(--ink-muted)", cursor: "pointer", fontSize: 10.5, fontFamily: "var(--f-mono)", lineHeight: 1.4 }}>≡ grp</button>
        </div>
        {/* bulk actions — appear while a ⌘/⇧ multi-selection is live
            (liveChecked: the count never claims ids the list lost) */}
        {liveChecked.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", borderBottom: "1px solid var(--ink-faint)", background: "#e8eefc", flexShrink: 0, flexWrap: "wrap", fontSize: 11 }}>
            <strong style={{ color: "#1f3fc7" }}>{liveChecked.length} selected</strong>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title="Set the waste % on every selected condition">
              <span style={{ color: "var(--ink-muted)" }}>Waste</span>
              <input type="number" min="0" step="1" value={bulkWaste} onChange={(e) => setBulkWaste(e.target.value)} placeholder="%"
                onKeyDown={(e) => e.key === "Enter" && applyBulkWaste()}
                style={{ width: 44, padding: "2px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 11 }} />
              <button onClick={applyBulkWaste} title="Apply waste % to the selection" style={{ padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 11 }}>✓</button>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title="Set the line color on every selected condition">
              {PALETTE.map((p) => <button key={p} title={p} onClick={() => onBulkColor(liveIds(), p)} style={{ width: 13, height: 13, borderRadius: 3, background: p, border: "1px solid var(--ink-faint)", cursor: "pointer", padding: 0 }} />)}
            </span>
            <button onClick={bulkDelete} title="Delete every selected condition (and their takeoffs)"
              style={{ padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Delete</button>
            <button onClick={() => setCheckedConds(new Set())} title="Clear the selection"
              style={{ marginLeft: "auto", padding: "2px 6px", border: "none", background: "none", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>✕</button>
          </div>
        )}
        <div style={{ flex: 1, overflow: "auto" }}>
          {conditions.length === 0 && <div style={{ padding: "12px", color: "var(--ink-muted)" }}>No conditions yet — add one and start tracing.</div>}
          {condGroups.map((g) => (
            <React.Fragment key={g.name ?? "_all"}>
              {g.name != null && (
                <div onClick={() => setClosedGroups((s) => { const n = new Set(s); if (n.has(g.name)) n.delete(g.name); else n.add(g.name); return n; })}
                  title="Collapse / expand this tag family"
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderTop: "1px solid var(--ink-faint)", background: "var(--paper-cream)", cursor: "pointer", fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-muted)", userSelect: "none" }}>
                  <span style={{ width: 10 }}>{closedGroups.has(g.name) ? "▸" : "▾"}</span>
                  <span style={{ fontWeight: 700, color: "var(--ink)" }}>{g.name}</span>
                  <span>· {g.items.length}</span>
                </div>
              )}
              {/* groupVisibleItems: a collapsed group still renders its
                  ACTIVE row (see the shared rule above visibleCondOrder) */}
              {groupVisibleItems(g).map(({ c }) => renderCondRow(c))}
            </React.Fragment>
          ))}
          {searchMiss && <div style={{ padding: "12px", color: "var(--ink-muted)" }}>No conditions match “{condQuery}”.</div>}
          <div style={{ padding: "6px 12px", borderTop: "1px solid var(--ink-faint)" }}>
            <button onClick={onAddCondition} style={{ width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--ink-muted)" }}>+ condition</button>
          </div>
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)", color: "var(--ink-muted)", fontSize: 10.5 }}>
            Select a shape on the plan, then ⧉ Copy / ⎘ Paste (⌘C / ⌘V) — it lands on the sheet under your cursor.
            <br />⌫ undo point · Esc cancel · scroll = zoom · pan mid-measure: press-and-drag (a click without dragging places the point).
          </div>
        </div>
        </>}
        {/* Library tab — reusable condition templates, browser-wide */}
        {panelTab === "library" && (
          <div style={{ flex: 1, overflow: "auto" }}>
            <div style={{ padding: "8px 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
              Reusable condition templates, shared across every plan in this browser. A fresh workspace seeds from this library (built-in flooring defaults when it's empty).
            </div>
            <div style={{ padding: "6px 12px 10px" }}>
              <button onClick={onSaveTemplate} disabled={!aCond}
                title="Snapshot the active condition (appearance, waste, H/T, materials) into the library"
                style={{ width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: aCond ? "pointer" : "default", fontSize: 12, color: aCond ? "var(--ink)" : "var(--ink-faint)" }}>
                + save {aCond?.finish_tag || "the active condition"} to the library
              </button>
            </div>
            {templates.length === 0 && <div style={{ padding: "2px 12px 12px", color: "var(--ink-muted)" }}>No templates yet — make a condition the way you like it, then save it here.</div>}
            {templates.map((t, idx) => (
              <div key={`${t.finish_tag}-${idx}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={t.hatch || "solid"} line={t.color} fill={t.fill} /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.finish_tag}</div>
                  <div style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, color: "var(--ink-muted)" }}>
                    {t.waste_pct || 0}% waste{t.height_ft != null ? ` · H ${t.height_ft}′` : ""}{t.thickness_in != null ? ` · T ${t.thickness_in}″` : ""}{t.materials?.length ? ` · ${t.materials.length} material${t.materials.length === 1 ? "" : "s"}` : ""}
                  </div>
                </div>
                <button onClick={() => { onApplyTemplate(t); setPanelTab("takeoffs"); }} title="Add a condition from this template to the takeoff"
                  style={{ flexShrink: 0, padding: "3px 8px", borderRadius: 0, border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Apply</button>
                <button onClick={() => onRenameTemplate(idx)} title="Rename this template"
                  style={{ flexShrink: 0, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                <button onClick={() => onDeleteTemplate(idx)} title="Remove this template from the library"
                  style={{ flexShrink: 0, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 11 }}>✕</button>
              </div>
            ))}
          </div>
        )}
        {/* Materials tab — the material library (#47/#48): canonical
            consumables shared across every plan in this browser. Conditions
            COPY on attach (lib_id link); edits here never propagate unless
            explicitly pushed to linked lines. */}
        {panelTab === "materials" && (
          <div style={{ flex: 1, overflow: "auto", fontSize: 11.5 }}>
            <div style={{ padding: "8px 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
              Reusable materials, browser-wide. Attaching one to a condition copies its values and keeps a link — edits here only reach linked lines when you push them.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px 8px" }}>
              <input value={matLibQuery} onChange={(e) => setMatLibQuery(e.target.value)} placeholder="filter materials…"
                style={{ flex: 1, minWidth: 0, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
              {matLibQuery && <button onClick={() => setMatLibQuery("")} title="Clear the filter" style={btnClearX}>×</button>}
            </div>
            {matLib.length === 0 && <div style={{ padding: "2px 12px 12px", color: "var(--ink-muted)" }}>No library materials yet — add one below, or use “→ lib” on a condition's material line.</div>}
            {matLib.filter((lm) => !matQ || (lm.name || "").toLowerCase().includes(matQ)).map((lm) => {
              const n = linkedCountById[lm.id] || 0;
              return (
                <div key={lm.id} style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <input value={lm.name} onChange={(e) => onUpdateLibMaterial(lm.id, { name: e.target.value })} placeholder="Material (e.g. Adhesive)" style={{ ...ip, width: 150 }} />
                    <span style={{ color: "var(--ink-muted)" }}>1</span>
                    <input value={lm.unit} onChange={(e) => onUpdateLibMaterial(lm.id, { unit: e.target.value })} placeholder="unit" style={{ ...ip, width: 54 }} />
                    <span style={{ color: "var(--ink-muted)" }}>per</span>
                    <input type="number" min="0" step="any" value={lm.per || ""} onChange={(e) => onUpdateLibMaterial(lm.id, { per: Math.max(0, parseFloat(e.target.value) || 0) })} placeholder="0" style={{ ...ip, width: 62 }} />
                    <select value={lm.basis || "area"} onChange={(e) => onUpdateLibMaterial(lm.id, { basis: e.target.value })} style={{ ...ip, background: "var(--paper-bright)" }}>
                      <option value="area">floor SF</option>
                      <option value="linear">linear LF</option>
                      <option value="count">each</option>
                    </select>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ink-muted)" }} title="Round up to whole units">
                      <input type="checkbox" checked={lm.round !== false} onChange={(e) => onUpdateLibMaterial(lm.id, { round: e.target.checked })} />round up
                    </label>
                    <input value={lm.note || ""} onChange={(e) => onUpdateLibMaterial(lm.id, { note: e.target.value })} placeholder="note" style={{ ...ip, width: 120 }} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
                    <span style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, color: "var(--ink-muted)" }}>{n ? `⛓ ${n} linked line${n === 1 ? "" : "s"}` : "not linked yet"}</span>
                    <div style={{ flex: 1 }} />
                    {n > 0 && (
                      <button onClick={() => onPushLibUpdate(lm.id)} title="Replace the values on every linked condition line with these library values (overrides included)"
                        style={{ padding: "2px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 11 }}>update linked ({n})</button>
                    )}
                    <button onClick={() => onDeleteLibMaterial(lm.id)} title="Remove from the library — linked lines keep their values, only the link is removed"
                      style={{ padding: "2px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 11 }}>✕</button>
                  </div>
                </div>
              );
            })}
            <div style={{ padding: "6px 12px", borderTop: matLib.length ? "1px solid var(--ink-faint)" : "none" }}>
              <button onClick={onAddLibMaterial} style={btnAddFull}>+ add library material</button>
            </div>
          </div>
        )}
        {/* Columns tab — the custom-columns manager (#31/#33): project-level
            vocabulary; per-condition assignment lives in the active row's
            properties on the Takeoffs tab */}
        {panelTab === "columns" && (
          <div style={{ flex: 1, overflow: "auto", fontSize: 11.5 }}>
            <div style={{ padding: "8px 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
              Custom columns (e.g. CSI Division) classify conditions for report grouping and exports. Columns and values apply to the whole project; assign values on a condition in the Takeoffs tab.
            </div>
            {conditionColumns.length === 0 && <div style={{ padding: "2px 12px 8px", color: "var(--ink-muted)" }}>Add a column, e.g. CSI Division.</div>}
            {conditionColumns.map((cc) => (
              <div key={cc.id} style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <input value={cc.name} onChange={(e) => onRenameColumn(cc.id, e.target.value)} placeholder="Column name (e.g. CSI Division)"
                    style={{ padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12, flex: 1, minWidth: 0 }} />
                  <button onClick={() => onDeleteColumn(cc.id)} title="Delete this column (whole project)"
                    style={{ flexShrink: 0, padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 12 }}>✕ column</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {cc.values.map((v) => (
                    <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 3px 2px 8px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 11.5, color: "var(--ink)" }}>
                      {v}
                      <button onClick={() => onRenameColumnValue(cc.id, v)} title="Rename this value — assigned conditions follow"
                        style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                      <button onClick={() => onRemoveColumnValue(cc.id, v)} title="Remove from the list — conditions keep the value, shown as (removed)"
                        style={{ padding: "0 3px", border: "none", background: "transparent", color: "#b03a26", cursor: "pointer", fontSize: 11 }}>✕</button>
                    </span>
                  ))}
                  <AddValueInput onAdd={(v) => onAddColumnValue(cc.id, v)} />
                </div>
              </div>
            ))}
            <div style={{ padding: "6px 12px", borderTop: conditionColumns.length ? "1px solid var(--ink-faint)" : "none" }}>
              <button onClick={onAddColumn} style={btnAddFull}>+ add column</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default React.memo(TakeoffsPanel);
