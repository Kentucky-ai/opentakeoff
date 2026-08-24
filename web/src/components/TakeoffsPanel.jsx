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
import { useTranslation } from "react-i18next";
import { Icon } from "../brand/icons.jsx";
import { attrValue, columnLabel } from "../lib/conditionColumns.js";
import { SPEC_FIELDS } from "../lib/reportColumns.js";
import { num } from "../lib/num.js";
import { areaVal, areaUnit, lenVal, lenUnit, heightUnit, heightInputToFeet, heightStep, thickUnit, thickInputToInches, thickStep, dimInputStr } from "../lib/units";
import { HATCHES, PALETTE, NO_FILL, HatchSwatch } from "./hatches.jsx";
import { getLineStyles, LINE_STYLE_IDS } from "../lib/lineStyles.js";
import { baseTagOf, localCount } from "../lib/variants.ts";
import { materialKind, getMaterialPresets, GROUT_DEFAULTS, groutDerivedFields, showsGroutCalc, showsGroutDeriveAffordance } from "../lib/coverage.js";
import { draftCommitValue, blurCommitValue, blurCommitNonNegative } from "../lib/draftInput.js";
import { ROLL_FLOORING_TYPES } from "../lib/rollgoods.js";
import { hasRollSetup, mintRollSetup } from "../lib/rollTakeoff.js";
import { Z } from "../lib/ui.js";
import { ftIn, M_PER_FT, thickVal } from "../lib/units";

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
// A condition minted as a TWIN carries an explicit family_id, which beats guessing from the
// tag: "SV-1 – Level 2" and "SV-1" are one family by construction, and the group is named for
// the base tag they share (lib/variants.ts). Everything else still groups by its tag prefix.
const tagFamily = (c) => {
  const t = typeof c === "string" ? c : c?.finish_tag;
  if (typeof c === "object" && c?.family_id) return baseTagOf(t).toUpperCase() || "—";
  return String(t || "").split("-")[0].trim().toUpperCase() || "—";
};
// one module-level collator — localeCompare builds a fresh collator per CALL
// (~56× slower, benchmarked), and natCompare runs n·log n per sorted view
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const natCompare = (a, b) => coll.compare(String(a), String(b));

// shared style atoms — these were re-declared at every call site (one even
// fresh per matLib row per render); hoisted so identical controls can't drift
const ip = { padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 };
const btnAddFull = { width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 };
const btnClearX = { border: "none", background: "none", color: "var(--ink-muted)", cursor: "pointer", fontSize: 13, padding: 0 };

// Per-material-kind coverage presets (adhesive trowel notches, mortar trowels)
// and the grout-from-tile-geometry calculator live in lib/coverage.js —
// vendor-neutral, generic rates; always verify against the product data sheet.

// The fraction formatter (inFrac) and derivation-note builder moved to
// lib/coverage.js with the rest of the grout math so they're pure and tested.

// One grout tile-geometry input. Keeps the RAW string in local state while the
// field is being edited — clamping/coercing inside onChange made the joint
// field untypeable (every keystroke through "0." snapped to the 0.03125 min)
// and wiped the leading "0" of decimals in the tile fields. The commit/clamp
// decision rules live in lib/draftInput.js (pure, tested): typing commits only
// a fully valid in-range value; blur clamps an out-of-range value into range
// and abandons an empty/invalid draft, so the last good committed value
// redisplays.
function GroutParamInput({ name, value, title, min = 0, max, width = 52, override, onCommit }) {
  const [draft, setDraft] = useState(null);   // raw text mid-edit; null = mirror the committed value
  return (
    <input name={name} type="number" min={min || 0} max={max} step="any" title={title}
      value={draft ?? (value > 0 ? String(value) : "")}
      onChange={(e) => { const t = e.target.value; setDraft(t); const v = draftCommitValue(t, min, max); if (v != null) onCommit(v); }}
      onBlur={() => {
        const v = blurCommitValue(draft, min, max);
        if (v != null) onCommit(v);
        setDraft(null);
      }}
      style={{ ...ip, width, ...(override ? { border: "1px solid var(--c-warning)" } : {}) }} />
  );
}

// Draft-buffered input for a condition's dimension params — wall height
// (stored `height_ft`) and material thickness (stored `thickness_in`). Both
// are internal-feet-contract fields, so this component owns the whole display
// edge: it SHOWS the value in the active unit system and commits back in the
// stored one (issue #115 — a metric user typing a 2.4 m wall used to get a
// 2.4 FOOT wall, silently, beside a readout that said m²).
//
// Draft-buffered for the same reason GroutParamInput is, plus one specific to
// converting: without it the field fights the typist, because every keystroke
// round-trips through a rounded conversion — typing "2.4" would redisplay as
// "2.438" mid-word. The raw text stays local while editing; the converted
// value still commits per keystroke, so thickness keeps re-flowing linear runs
// live the way it always has. Clearing commits "" (the param's null), which is
// distinct from an intentional 0.
function DimParamInput({ name, internal, units, kind, width, onCommit }) {
  const [draft, setDraft] = useState(null);   // raw text mid-edit; null = mirror the committed value
  const toInternal = (n) => (kind === "height" ? heightInputToFeet(n, units) : thickInputToInches(n, units));
  // A raw draft has meaning only in the unit system in which it was typed.
  // Cancel it when the global unit preference changes so an old-unit number
  // can never be committed using the new conversion factor. The canonical
  // value remains authoritative and is immediately redisplayed in `units`.
  useEffect(() => { setDraft(null); }, [units]);
  const commit = (text) => {
    if (text === "") return onCommit("");
    const n = parseFloat(text);
    if (Number.isFinite(n) && n >= 0) onCommit(toInternal(n));
  };
  return (
    <input name={name} type="number" min="0" step={kind === "height" ? heightStep(units) : thickStep(units)}
      placeholder={kind === "height" ? heightUnit(units) : thickUnit(units)}
      value={draft ?? dimInputStr(internal, units, kind)}
      onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }}
      onBlur={() => { if (draft != null) commit(draft); setDraft(null); }}
      style={{ width, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
  );
}

// Draft-buffered input for the Materials tab's name + per + note fields:
// keeps the raw text local while editing and commits ONLY on blur/Enter —
// every commit there flows through libEntryPatch, where a CHANGED per/note
// detaches a grout entry's tile geometry and a name edit re-classifies the
// entry's kind, so committing per keystroke destroyed the geometry (or the
// classification) on the transient values of a select-all-retype ("5" of
// "512") or a clear-and-retype, silently and with no undo. In number mode an
// empty/unparseable draft on blur is ABANDONED and the last good value
// redisplays (blurCommitNonNegative, the GroutParamInput/blurCommitValue
// philosophy) — clearing the per field must not commit 0 and take the
// geometry with it; an intentional 0 can still be typed as "0". Text drafts
// commit as-is (clearing a name/note is a legitimate edit).
function LibDraftInput({ name, value, number, placeholder, width, onCommitText }) {
  const [draft, setDraft] = useState(null);   // raw text mid-edit; null = mirror the committed value
  return (
    <input name={name} type={number ? "number" : "text"} min={number ? 0 : undefined} step={number ? "any" : undefined}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft != null) {
          if (number) { const v = blurCommitNonNegative(draft); if (v != null) onCommitText(String(v)); }
          else onCommitText(draft);
        }
        setDraft(null);
      }}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur(); }}
      placeholder={placeholder} style={{ ...ip, width }} />
  );
}

// Coverage preset picker — shared by the condition-line editor and the
// Materials tab so a library "Adhesive" and an attached line offer the same
// notch/roller list. Renders nothing when the kind has no preset table.
function CoveragePresetSelect({ material: m, onPick }) {
  const { t } = useTranslation("panels");
  const presets = (m.basis || "area") === "area" ? getMaterialPresets()[materialKind(m)] : undefined;
  if (!presets) return null;
  return (
    <select name="coverage-preset" value={presets.some((t) => t.label === m.note) ? m.note : ""}
      onChange={(e) => { const t = presets.find((x) => x.label === e.target.value); if (t) onPick({ note: t.label, per: t.per }); }}
      title={t('takeoffs.coverage_preset_title')}
      style={{ ...ip, background: "var(--paper-bright)" }}>
      <option value="">{t('takeoffs.coverage_preset_option')}</option>
      {presets.map((t) => <option key={t.label} value={t.label}>{t.label} · {t.per} SF/{m.unit || "unit"}</option>)}
    </select>
  );
}

// Editable supporting-materials rows for a condition (coverage-derived order qty).
function MaterialsEditor({ materials, onAdd, onUpdate, onRemove, library, libById, overridden, onRevert, onAttach, onPromote,
    twin = false, parentTag = "", dropped = [], parentRows = [], onFollowFamilyRow, onRestoreDroppedRow }) {
  const { t } = useTranslation("panels");
  // library link affordances (#47, all optional so the editor works standalone):
  // linked lines show ⛓; a field differing from its library entry tints amber
  // and grows a per-field ↺ revert; unlinked lines can be promoted to the library
  const OV = "1px solid var(--c-warning)";
  const rv = (m, f) => (
    <button onClick={() => onRevert(m, f)} title={t('takeoffs.mat_revert_title')}
      style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--c-warning)", cursor: "pointer", fontSize: 11, lineHeight: 1 }}>↺</button>
  );
  return (
    <>
      {(materials || []).map((m) => {
        const lm = libById ? libById[m.lib_id] : null;
        const ov = (f) => (lm && overridden ? overridden(m, lm, f) : false);
        const g = { ...GROUT_DEFAULTS, ...(m.grout || {}) };
        // grout coverage derives from tile geometry — a param change re-derives
        // per + writes the derivation into the note so the Report shows its
        // work, but ONLY while the whole geometry is valid: an incomplete edit
        // (cleared field, zero) keeps the last good per + note instead of
        // silently committing a rate of 0 into the buy list and exports
        const setGrout = (patch) => {
          const grout = { ...g, ...patch };
          onUpdate(m.id, { grout, ...(groutDerivedFields(grout) || {}) });
        };
        const gi = (key, title, extra) => (
          <GroutParamInput name={`grout-${key}`} value={g[key]} title={title} override={ov("grout")}
            onCommit={(v) => setGrout({ [key]: v })} {...extra} />
        );
        return (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {/* family state: this row still follows the original, or it is this condition's own */}
            {twin && (
              <span title={m.inherited
                ? `Following ${parentTag || "the family"} — edit any field here and this row stops following (the others keep following)`
                : `This row is this condition's own${m.origin_id ? ` — it no longer follows ${parentTag || "the family"}` : ""}`}
                style={{ fontSize: 10, lineHeight: 1, cursor: "default", padding: "2px 3px",
                  color: m.inherited ? "var(--ink-faint)" : "var(--cobalt)",
                  border: `1px solid ${m.inherited ? "var(--ink-faint)" : "var(--cobalt)"}` }}>{m.inherited ? "↳" : "✎"}</span>
            )}
            {twin && !m.inherited && m.origin_id && onFollowFamilyRow && (
              <button onClick={() => onFollowFamilyRow(m.id)} title={`Follow the family again — take this row's values back from ${parentTag || "the original"}`}
                style={{ padding: "1px 4px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 10, lineHeight: 1.4 }}>↺ follow</button>
            )}
            {lm && <span title={`Linked to “${lm.name}” in the material library — amber fields differ from the library values`} style={{ color: "var(--ink-muted)", fontSize: 11, cursor: "default" }}>⛓</span>}
            <input name="material-name" value={m.name} onChange={(e) => onUpdate(m.id, { name: e.target.value })} placeholder={t('takeoffs.mat_name_placeholder')} style={{ ...ip, width: 160, ...(ov("name") ? { border: OV } : {}) }} />
            {ov("name") && rv(m, "name")}
            <span style={{ color: "var(--ink-muted)" }}>1</span>
            <input name="material-unit" value={m.unit} onChange={(e) => onUpdate(m.id, { unit: e.target.value })} placeholder={t('takeoffs.mat_unit_placeholder')} style={{ ...ip, width: 60, ...(ov("unit") ? { border: OV } : {}) }} />
            {ov("unit") && rv(m, "unit")}
            <span style={{ color: "var(--ink-muted)" }}>per</span>
            <input name="material-per" type="number" min="0" step="any" value={m.per || ""} onChange={(e) => onUpdate(m.id, { per: Math.max(0, parseFloat(e.target.value) || 0) })} placeholder="0" style={{ ...ip, width: 66, ...(ov("per") ? { border: OV } : {}) }} />
            {ov("per") && rv(m, "per")}
            <select name="material-basis" value={m.basis || "area"} onChange={(e) => onUpdate(m.id, { basis: e.target.value })} style={{ ...ip, background: "var(--paper-bright)", ...(ov("basis") ? { border: OV } : {}) }}>
              <option value="area">{t('takeoffs.mat_basis_floor_sf')}</option>
              <option value="linear">{t('takeoffs.mat_basis_linear_lf')}</option>
              <option value="count">{t('takeoffs.mat_basis_each')}</option>
              <option value="seam_lf" title={t('takeoffs.mat_basis_seam_lf_title')}>{t('takeoffs.mat_basis_seam_lf')}</option>
            </select>
            {ov("basis") && rv(m, "basis")}
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4, color: ov("round") ? "var(--c-warning)" : "var(--ink-muted)" }} title={t('takeoffs.mat_round_title')}>
              <input name="material-round" type="checkbox" checked={m.round !== false} onChange={(e) => onUpdate(m.id, { round: e.target.checked })} />{t('takeoffs.mat_round')}
            </label>
            {ov("round") && rv(m, "round")}
            <CoveragePresetSelect material={m} onPick={(patch) => onUpdate(m.id, patch)} />
            <input name="material-note" value={m.note || ""} onChange={(e) => onUpdate(m.id, { note: e.target.value })} placeholder={t('takeoffs.mat_note_placeholder')} style={{ ...ip, width: 150, ...(ov("note") ? { border: OV } : {}) }} />
            {ov("note") && rv(m, "note")}
            {!lm && onPromote && (
              <button onClick={() => onPromote(m)} title={t('takeoffs.mat_promote_title')}
                style={{ padding: "2px 7px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>{t('takeoffs.mat_promote')}</button>
            )}
            <button onClick={() => onRemove(m.id)} title={t('takeoffs.mat_remove_title')}
              style={{ padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 12 }}>✕</button>
            {/* the calculator renders ONLY when the line HAS geometry; a grout
                line without it keeps its rate untouched behind an explicit
                opt-in below — never a calculator backfilled with defaults */}
            {showsGroutCalc(m) && (
              <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingLeft: 14, color: "var(--ink-muted)", fontSize: 12 }}>
                <span>{t('takeoffs.grout_tile')}</span>
                {gi("tileL", "Tile length (in)")}
                <span>×</span>
                {gi("tileW", "Tile width (in)")}
                <span>{t('takeoffs.grout_tile_thick')}</span>
                {gi("tileT", "Tile thickness (in)")}
                <span>{t('takeoffs.grout_joint')}</span>
                {gi("joint", "Joint width (in) — 1/32″ to 1/2″", { min: 0.03125, max: 0.5, width: 62 })}
                <span>{t('takeoffs.grout_bag')}</span>
                {gi("bagLbs", "Bag size (lbs)")}
                <span>lb</span>
                {ov("grout") && rv(m, "grout")}
              </div>
            )}
            {showsGroutDeriveAffordance(m) && (
              <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 6, paddingLeft: 14 }}>
                <button onClick={() => setGrout({})}
                  title={t('takeoffs.grout_derive_title')}
                  style={{ padding: "2px 7px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>
                  {t('takeoffs.grout_derive')}
                </button>
                {ov("grout") && rv(m, "grout")}
              </div>
            )}
          </div>
        );
      })}
      {/* Rows this twin threw away. They stay visible (struck through) rather than silently
          vanishing, because "this area has no moisture barrier" is a DECISION — and it is also
          what stops a later family edit from quietly putting it back. */}
      {twin && dropped.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2, paddingTop: 4, borderTop: "1px dashed var(--ink-faint)" }}>
          {dropped.map((k) => {
            const src = parentRows.find((r) => r.id === k);
            return (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-muted)" }}>
                <span style={{ color: "var(--c-danger)" }}>✕</span>
                <span style={{ textDecoration: "line-through" }}>{src?.name || "(removed material)"}</span>
                <span style={{ fontSize: 10 }}>removed here</span>
                {src && onRestoreDroppedRow && (
                  <button onClick={() => onRestoreDroppedRow(k)} title={`Put it back — takes the row from ${parentTag || "the family"} again`}
                    style={{ padding: "1px 4px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 10, lineHeight: 1.4 }}>↺ restore</button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <button onClick={onAdd}
        style={{ marginTop: 2, padding: "4px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>{t('takeoffs.mat_add')}</button>
      {onAttach && (library || []).length > 0 && (
        <select name="attach-material" value="" onChange={(e) => { if (e.target.value) onAttach(e.target.value); }}
          title={t('takeoffs.mat_attach_title')}
          style={{ ...ip, marginLeft: 6, background: "var(--paper-bright)", color: "var(--ink-muted)" }}>
          <option value="">{t('takeoffs.mat_attach_option')}</option>
          {library.map((lm) => <option key={lm.id} value={lm.id}>{lm.name || t('takeoffs.mat_unnamed')}{lm.per ? ` · ${lm.per}/${lm.unit || "?"}` : ""}</option>)}
        </select>
      )}
    </>
  );
}

// Per-condition custom-column assignment — one select per defined column.
// Unassigned = attrs key absent; a value deleted from the vocabulary
// keeps the condition's string, shown as "<value> (removed)".
function ColumnSelects({ columns, cond, onAssign }) {
  const { t } = useTranslation("panels");
  return (
    <>
      {columns.map((cc) => {
        const v = attrValue(cond?.attrs, cc.id);   // the shared assigned-value rule (hydrate sanitizes, this keeps the display consistent)
        return (
          <label key={cc.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginRight: 12, marginBottom: 6 }}>
            <span style={{ color: "var(--ink-muted)" }}>{columnLabel(cc)}</span>
            <select name="assign-column-value" value={v} onChange={(e) => onAssign(cc.id, e.target.value)} style={{ ...ip, background: "var(--paper-bright)" }}>
              <option value="">{t('takeoffs.unassigned')}</option>
              {cc.values.map((val) => <option key={val} value={val}>{val}</option>)}
              {v && !cc.values.includes(v) && <option value={v}>{v}{t('takeoffs.columns_value_removed')}</option>}
            </select>
          </label>
        );
      })}
    </>
  );
}

// add-value input for the column manager — local draft state, commit on Enter/+
function AddValueInput({ onAdd }) {
  const { t } = useTranslation("panels");
  const [v, setV] = useState("");
  const commit = () => { const tVal = v.trim(); if (tVal) onAdd(tVal); setV(""); };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <input name="column-add-value" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && commit()} placeholder={t('takeoffs.columns_add_value_placeholder')} style={{ ...ip, width: 90 }} />
      <button onClick={commit} title={t('takeoffs.columns_add_value_title')}
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
export function ConditionAppearanceEditor({ cond: c, onUpdateCond, onSetCondParam, onAssignAttr, conditionColumns = [], layout = "stack", units = "imperial", rollInfo = null }) {
  const { t } = useTranslation("panels");
  const lineStyles = getLineStyles();
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
        <input name="condition-finish-tag" value={c.finish_tag} onChange={(e) => onUpdateCond({ finish_tag: e.target.value })}
          title={t('takeoffs.cond_rename_title')}
          style={{ width: 88, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: 12, color: "var(--ink)" }} />
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title={t('takeoffs.cond_multiplier_title')}>
          <span style={{ color: "var(--ink-muted)" }}>×</span>
          <input name="condition-multiplier" type="number" min="1" step="1" value={c.multiplier || 1}
            onChange={(e) => onUpdateCond({ multiplier: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            style={{ width: 46, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title={t('takeoffs.cond_waste_title')}>
          <span style={{ color: "var(--ink-muted)" }}>{t('takeoffs.waste_label')}</span>
          <input name="condition-waste-pct" type="number" min="0" step="1" value={c.waste_pct ?? 0}
            onChange={(e) => onUpdateCond({ waste_pct: Math.max(0, parseFloat(e.target.value) || 0) })}
            style={{ width: 50, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
          <span style={{ color: "var(--ink-muted)" }}>%</span>
        </span>
      </div>
      {isRow && rule()}
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        <span style={{ color: "var(--ink-muted)", width: 26 }}>{t('takeoffs.line_label')}</span>
        {PALETTE.map((p) => <button key={p} title={p} onClick={() => onUpdateCond({ color: p })} style={{ width: 16, height: 16, borderRadius: 4, background: p, border: c.color === p ? "2px solid var(--ink)" : "1px solid var(--ink-faint)", cursor: "pointer" }} />)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        <span style={{ color: "var(--ink-muted)", width: 26 }}>{t('takeoffs.fill_label')}</span>
        <button title={t('takeoffs.no_fill_title')} onClick={() => onUpdateCond({ fill: NO_FILL })} style={{ width: 16, height: 16, borderRadius: 4, background: "var(--paper-bright)", border: c.fill === NO_FILL ? "2px solid var(--ink)" : "1px solid var(--ink-faint)", cursor: "pointer", fontSize: 9, lineHeight: "12px", color: "var(--c-danger)" }}>⦸</button>
        {PALETTE.map((p) => <button key={p} title={p} onClick={() => onUpdateCond({ fill: p })} style={{ width: 16, height: 16, borderRadius: 4, background: p, opacity: 0.55, border: c.fill === p ? "2px solid var(--ink)" : "1px solid var(--ink-faint)", cursor: "pointer" }} />)}
      </div>
      {isRow && rule()}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4, position: "relative" }}>
          <button onClick={() => setHatchOpen((v) => !v)} title={t('takeoffs.hatch_title')}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 7px 2px 2px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", lineHeight: 0 }}>
            <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>
            <span style={{ fontSize: 10.5, color: "var(--ink-muted)", lineHeight: 1 }}>{t(`hatch.${(HATCHES.find((h) => h.id === (c.hatch || "solid"))?.id || "solid")}`)} ▾</span>
          </button>
          {hatchOpen && (
            <div style={{ position: "absolute", top: 26, left: 0, zIndex: 30, display: "grid", gridTemplateColumns: "repeat(6, auto)", gap: 4, padding: 8, background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", borderRadius: 0, boxShadow: "var(--shadow-pop)" }}>
              {HATCHES.map((h) => {
                const hOn = (c.hatch || "solid") === h.id;
                return <button key={h.id} title={t(`hatch.${h.id}`)} onClick={() => { onUpdateCond({ hatch: h.id }); setHatchOpen(false); }} style={{ padding: 1, borderRadius: 0, border: hOn ? `2px solid ${activeColor}` : "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", lineHeight: 0 }}><HatchSwatch type={h.id} line={c.color} fill={c.fill} /></button>;
              })}
            </div>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title={t('takeoffs.style_title')}>
          <span style={{ color: "var(--ink-muted)" }}>{t('takeoffs.style_label')}</span>
          <select name="condition-line-style" value={c.line_style || "solid"} onChange={(e) => onUpdateCond({ line_style: e.target.value })}
            style={{ fontSize: 11, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", padding: "1px 3px" }}>
            {LINE_STYLE_IDS.map((id) => <option key={id} value={id}>{lineStyles[id].label}</option>)}
          </select>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title={t('takeoffs.height_title', { unit: heightUnit(units) })}>
          <Icon name="height" size={13} /><span style={{ color: "var(--ink-muted)" }}>H</span>
          <DimParamInput name="condition-height-ft" internal={c.height_ft} units={units} kind="height" width={54}
            onCommit={(v) => onSetCondParam("height_ft", v)} />
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title={t('takeoffs.thickness_title', { unit: thickUnit(units) })}>
          <Icon name="thickness" size={13} /><span style={{ color: "var(--ink-muted)" }}>T</span>
          <DimParamInput name="condition-thickness-in" internal={c.thickness_in} units={units} kind="thickness" width={50}
            onCommit={(v) => onSetCondParam("thickness_in", v)} />
        </span>
      </div>
      {conditionColumns.length > 0 && isRow && rule()}
      {conditionColumns.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 2 }} title={t('takeoffs.classify_title')}>
          <ColumnSelects columns={conditionColumns} cond={c} onAssign={onAssignAttr} />
        </div>
      )}
      {/* Imported product spec (mfr/style/color/size/description) — editable here,
          read-only columns in the Report. Docked ("stack") layout only: five text
          fields would crowd the wide top-bar band. Shown only when a spec exists
          (schedule-imported conditions); hand-drawn conditions have none. Patch
          spreads c.spec so one edit can't clobber the other fields, and writes to
          spec.color — NOT the condition's line `color`. Guard that spec is a plain
          object first: a corrupted payload (spec an array/string) would otherwise
          render and let an edit spread it into a garbage shape ({0:"f",1:"o",…}). */}
      {/* Roll goods (#136) — OPT-IN per condition: conditions are trade-agnostic
          (no flooring-type field exists), so a roll_setup object PRESENT on the
          condition is what makes it roll goods. Docked ("stack") layout only,
          like spec. The engine (lib/rollgoods.js) figures seams/cuts/order
          footage from the condition's floor areas; the readout below comes back
          from the canvas via rollInfo. All lengths stored in feet (the lib/units
          contract); seam/wall allowances are inch-native like the engine. */}
      {!isRow && !hasRollSetup(c) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 6, marginTop: 1, borderTop: "1px solid var(--ink-faint)" }}>
          <select name="condition-roll-optin" value=""
            title={t('takeoffs.roll_optin_title')}
            onChange={(e) => { if (e.target.value) onUpdateCond({ roll_setup: mintRollSetup(e.target.value) }); }}
            style={{ padding: "3px 6px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", fontSize: 11.5, cursor: "pointer" }}>
            <option value="">{t('takeoffs.roll_optin')}</option>
            <option value="carpet">{t('takeoffs.roll_broadloom')}</option>
            <option value="sheet_vinyl">{t('takeoffs.roll_sheet_vinyl')}</option>
            <option value="rubber">{t('takeoffs.roll_rubber')}</option>
          </select>
        </div>
      )}
      {!isRow && hasRollSetup(c) && (() => {
        const rs = c.roll_setup;
        const patch = (p) => onUpdateCond({ roll_setup: { ...rs, ...p } });
        const M = units === "metric";
        const wFt = Math.floor(Number(rs.roll_width_ft) || 0);
        const wIn = Math.round(((Number(rs.roll_width_ft) || 0) - wFt) * 12);
        const setW = (ft, inch) => patch({ roll_width_ft: Math.max(0.5, (Number(ft) || 0) + (Number(inch) || 0) / 12) });
        // Metric: roll width/length displayed in meters, seam/wall in mm
        const setWM = (m) => patch({ roll_width_ft: Math.max(0.5, (Number(m) || 0) / M_PER_FT) });
        const setLM = (m) => patch({ roll_length_ft: Math.max(0, (Number(m) || 0) / M_PER_FT) });
        const setSeam = (v) => patch({ seam_allowance_in: Math.max(0, M ? thickInputToInches(Number(v) || 0, units) : parseFloat(v) || 0) });
        const setWall = (v) => patch({ wall_overage_in: Math.max(0, M ? thickInputToInches(Number(v) || 0, units) : parseFloat(v) || 0) });
        const numIp = { width: 46, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 };
        const sel = { padding: "2px 4px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 11.5 };
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, paddingTop: 6, marginTop: 1, borderTop: "1px solid var(--ink-faint)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--ink-muted)", fontSize: 10, letterSpacing: 0.4, textTransform: "uppercase" }}
                title={t('takeoffs.roll_setup_title')}>{t('takeoffs.roll_setup_label')}</span>
              <select name="condition-roll-material" value={rs.material || "carpet"} onChange={(e) => patch({ material: e.target.value })} style={sel}
                title={t('takeoffs.roll_material_title')}>
                {ROLL_FLOORING_TYPES.map((ft) => <option key={ft} value={ft}>{ft === "carpet" ? t('takeoffs.roll_broadloom') : ft === "sheet_vinyl" ? t('takeoffs.roll_sheet_vinyl') : t('takeoffs.roll_rubber')}</option>)}
              </select>
              <button onClick={() => onUpdateCond({ roll_setup: undefined })} title={t('takeoffs.roll_remove_title')}
                style={{ marginLeft: "auto", padding: "1px 6px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              <span style={{ color: "var(--ink-muted)" }}>{t('takeoffs.roll_width_label')}</span>
              {rs.material === "carpet" ? (
                <select name="condition-roll-width" value={String(rs.roll_width_ft)} onChange={(e) => patch({ roll_width_ft: parseFloat(e.target.value) || 12 })} style={sel}
                  title={t('takeoffs.roll_width_broadloom_title')}>
                  {M ? (
                    <>
                      <option value="12">12′ ({(12 * M_PER_FT).toFixed(2)} m)</option>
                      <option value="15">15′ ({(15 * M_PER_FT).toFixed(2)} m)</option>
                    </>
                  ) : (
                    <>
                      <option value="12">12′</option>
                      <option value="15">15′</option>
                    </>
                  )}
                </select>
              ) : M ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={t('takeoffs.roll_width_resilient_title')}>
                  <input name="condition-roll-width-m" type="number" min="0" step="0.01"
                    value={(Number(rs.roll_width_ft) * M_PER_FT).toFixed(2)}
                    onChange={(e) => setWM(e.target.value)} style={numIp} />
                  <span style={{ color: "var(--ink-muted)" }}>m</span>
                </span>
              ) : (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={t('takeoffs.roll_width_resilient_title')}>
                  <input name="condition-roll-width-ft" type="number" min="0" step="1" value={wFt} onChange={(e) => setW(e.target.value, wIn)} style={numIp} /><span style={{ color: "var(--ink-muted)" }}>′</span>
                  <input name="condition-roll-width-in" type="number" min="0" max="11" step="1" value={wIn} onChange={(e) => setW(wFt, e.target.value)} style={numIp} /><span style={{ color: "var(--ink-muted)" }}>″</span>
                </span>
              )}
              <span style={{ color: "var(--ink-muted)" }} title={t('takeoffs.roll_max_title')}>max</span>
              {M ? (
                <>
                  <input name="condition-roll-length-m" type="number" min="0" step="0.1"
                    value={((Number(rs.roll_length_ft) || 0) * M_PER_FT).toFixed(1)}
                    onChange={(e) => setLM(e.target.value)} style={numIp} />
                  <span style={{ color: "var(--ink-muted)" }}>m</span>
                </>
              ) : (
                <>
                  <input name="condition-roll-length" type="number" min="0" step="5" value={rs.roll_length_ft || 0}
                    onChange={(e) => patch({ roll_length_ft: Math.max(0, parseFloat(e.target.value) || 0) })} style={numIp} />
                  <span style={{ color: "var(--ink-muted)" }}>′</span>
                </>
              )}
              <select name="condition-roll-direction" value={rs.direction || "auto"} onChange={(e) => patch({ direction: e.target.value })} style={sel}
                title={t('takeoffs.roll_direction_title')}>
                <option value="auto">auto</option>
                <option value="ns">N–S</option>
                <option value="ew">E–W</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              <span style={{ color: "var(--ink-muted)" }} title={t('takeoffs.roll_seam_title')}>{t('takeoffs.seam_label')}</span>
              {M ? (
                <>
                  <input name="condition-roll-seam-mm" type="number" min="0" step="1"
                    value={thickVal(rs.seam_allowance_in ?? 2, units).toFixed(0)}
                    onChange={(e) => setSeam(e.target.value)} style={numIp} />
                  <span style={{ color: "var(--ink-muted)" }}>mm · wall</span>
                </>
              ) : (
                <>
                  <input name="condition-roll-seam" type="number" min="0" step="0.5" value={rs.seam_allowance_in ?? 2}
                    onChange={(e) => patch({ seam_allowance_in: Math.max(0, parseFloat(e.target.value) || 0) })} style={numIp} />
                  <span style={{ color: "var(--ink-muted)" }}>″ · wall</span>
                </>
              )}
              {M ? (
                <>
                  <input name="condition-roll-wall-mm" type="number" min="0" step="1"
                    value={thickVal(rs.wall_overage_in ?? 3, units).toFixed(0)}
                    onChange={(e) => setWall(e.target.value)} style={numIp} />
                  <span style={{ color: "var(--ink-muted)" }}>mm · sells by</span>
                </>
              ) : (
                <>
                  <input name="condition-roll-wall" type="number" min="0" step="0.5" value={rs.wall_overage_in ?? 3}
                    onChange={(e) => patch({ wall_overage_in: Math.max(0, parseFloat(e.target.value) || 0) })} style={numIp} />
                  <span style={{ color: "var(--ink-muted)" }}>″ · sells by</span>
                </>
              )}
              <select name="condition-roll-unit" value={rs.price_unit || "sf"} onChange={(e) => patch({ price_unit: e.target.value })} style={sel}
                title={t('takeoffs.roll_unit_title')}>
                <option value="sy">SY</option>
                <option value="sf">SF</option>
                <option value="lf">LF</option>
              </select>
            </div>
            {rollInfo && (
              <div style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 11, color: "var(--ink)" }}
                title={t('takeoffs.roll_figured_title')}>
                {t('takeoffs.roll_figured')} {M ? `${(rollInfo.orderFt * M_PER_FT).toFixed(2)} m` : ftIn(rollInfo.orderFt)} · {rollInfo.qty} {rollInfo.unit.toUpperCase()}
                {rollInfo.config.rollLengthFt > 0 ? ` · ${rollInfo.rollCount} roll${rollInfo.rollCount === 1 ? "" : "s"}` : ""}
                {rollInfo.oversize && <span style={{ color: "var(--c-danger)" }}> {t('takeoffs.roll_oversize_inline')}</span>}
              </div>
            )}
          </div>
        );
      })()}
      {!isRow && c.spec && typeof c.spec === "object" && !Array.isArray(c.spec) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 6, marginTop: 1, borderTop: "1px solid var(--ink-faint)" }}>
          <span style={{ color: "var(--ink-muted)", fontSize: 10, letterSpacing: 0.4, textTransform: "uppercase" }}
            title={t('takeoffs.spec_title')}>{t('takeoffs.spec_label')}</span>
          {SPEC_FIELDS.map(({ field, header }) => (
            <label key={field} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--ink-muted)", width: 74, flexShrink: 0 }}>{header}</span>
              <input name={`condition-spec-${field}`} value={c.spec[field] || ""}
                onChange={(e) => onUpdateCond({ spec: { ...c.spec, [field]: e.target.value } })}
                style={{ flex: 1, minWidth: 0, padding: "3px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12, color: "var(--ink)" }} />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ⟂ Transitions — where two finishes meet, onto the active condition ───────
// The estimator's half of derive_transitions (#202). Two finishes go in; the
// runs where their rooms BUTT — meeting inside one open space, no wall between
// them — come back as dashed linear shapes on this condition, waiting on the
// Accept pill like any other machine proposal.
//
// What does NOT come back as a shape is the whole point. Two rooms across a
// partition are adjacent, not joined: the transition there is a threshold in a
// doorway, and a flood trace records how much boundary it sealed, never where.
// Committing 34 LF of threshold because two rooms share 34 LF of wall would be
// a wrong bid with a machine's confidence behind it — so those are listed here
// with their length and their gap, reported and never counted, for someone to
// place with the drawing in front of them.
function TransitionsAction({ cond: c, sources, draft, setDraft, result, setResult, onDerive, onLocate2 }) {
  const { t } = useTranslation("panels");
  const open = draft.id === c.id;
  // the transition lands on its OWN tag, so this condition is never a source —
  // deriving onto C-1 would add the joint's LF to the carpet it separates
  const opts = sources.filter((s) => s.id !== c.id);
  const ready = open && draft.a && draft.b && draft.a !== draft.b;
  const close = () => { setDraft({ id: "", a: "", b: "" }); setResult(null); };
  const run = () => { if (ready) setResult(onDerive(draft.a, draft.b)); };
  const selStyle = { ...ip, background: "var(--paper-bright)", color: "var(--ink)", maxWidth: 110 };
  return (
    <div style={{ padding: "7px 12px 9px", background: "var(--paper-cream)", borderTop: "1px solid var(--ink-faint)", fontSize: 11.5 }}>
      {!open ? (
        <button onClick={() => { setDraft({ id: c.id, a: opts[0]?.id || "", b: opts[1]?.id || "" }); setResult(null); }}
          disabled={opts.length < 2}
          title={opts.length < 2
            ? t("takeoffs.transitions_disabled_title")
            : t("takeoffs.transitions_enabled_title", { tag: c.finish_tag })}
          style={{ padding: "3px 9px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent",
            color: opts.length < 2 ? "var(--ink-faint)" : "var(--ink)", cursor: opts.length < 2 ? "default" : "pointer", fontSize: 11.5 }}>
          {t("takeoffs.transitions_button")}
        </button>
      ) : (
        <div>
          <div style={{ color: "var(--ink-muted)", marginBottom: 5 }}>
            {t("takeoffs.transitions_derive_onto")} <b style={{ color: "var(--ink)" }}>{c.finish_tag}</b> {t("takeoffs.transitions_derive_onto_suffix")}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            <select name="transition-a" value={draft.a} onChange={(e) => setDraft({ ...draft, a: e.target.value })} style={selStyle}>
              {opts.map((s) => <option key={s.id} value={s.id}>{s.finish_tag} ({s.rooms})</option>)}
            </select>
            <span style={{ color: "var(--ink-muted)" }}>{t("takeoffs.transitions_meets")}</span>
            <select name="transition-b" value={draft.b} onChange={(e) => setDraft({ ...draft, b: e.target.value })} style={selStyle}>
              {opts.map((s) => <option key={s.id} value={s.id}>{s.finish_tag} ({s.rooms})</option>)}
            </select>
            <button name="transition-derive" onClick={run} disabled={!ready}
              style={{ padding: "2px 9px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent",
                color: ready ? "var(--ink)" : "var(--ink-faint)", cursor: ready ? "pointer" : "default", fontSize: 11 }}>{t("takeoffs.transitions_derive")}</button>
            <button onClick={close} style={{ padding: "2px 6px", border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>{t("takeoffs.transitions_cancel")}</button>
          </div>
          {result?.error && (
            <div style={{ marginTop: 6, padding: "4px 6px", border: "1px solid var(--c-warning)", color: "var(--ink)", background: "var(--paper-bright)" }}>{result.error}</div>
          )}
          {result && !result.error && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: result.committed ? "var(--c-positive)" : "var(--ink-muted)" }}>
                {result.committed
                  ? t("takeoffs.transitions_runs_committed", { count: result.committed, lf: result.total_lf, tag: result.onto })
                  : t("takeoffs.transitions_no_joints")}
              </div>
              {result.withheld?.length > 0 && (
                <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px solid var(--ink-faint)" }}>
                  <div style={{ color: "var(--ink-muted)", fontSize: 10.5, letterSpacing: 0.4, textTransform: "uppercase" }}
                    title={t("takeoffs.transitions_reported_title")}>
                    {t("takeoffs.transitions_reported")}
                  </div>
                  <ul style={{ margin: "3px 0 0", paddingLeft: 14, color: "var(--ink)" }}>
                    {result.withheld.map((w, i) => (
                      <li key={`${w.between_shape_ids.join("-")}-${i}`} style={{ marginBottom: 1 }}>
                        {w.length_lf} {t("takeoffs.transitions_across_wall", { gap: w.gap_in })}
                        <span style={{ color: "var(--ink-muted)" }}> — {w.between.join(" / ")}</span>
                        {onLocate2 && (
                          <button onClick={() => onLocate2(w.sheet_id, w.at)} title={t("takeoffs.transitions_look_title")}
                            style={{ marginLeft: 5, padding: 0, border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11, textDecoration: "underline" }}>{t("takeoffs.transitions_look")}</button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div style={{ marginTop: 3, color: "var(--ink-muted)" }}>{t("takeoffs.transitions_footnote")}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TakeoffsPanel({
  open, width, overlay = false, multiSheet, units = "imperial",
  conditions, activeCond, visRowById, projRowById = new Map(), conditionColumns, shapeLabels = [], templates, palette = [], rollByCond = null,
  transitionSources = [],
  matLib, matLibById, linkedCountById,
  panelPrefs, onPanelPrefs, reassigning, epoch, clearSelectionRef,
  onActivate, onSetActive, onLocate,
  onAddCondition, onDeleteCondition, onUpdateCond, onSetCondParam, onAssignAttr,
  onAddMaterial, onUpdateMaterial, onRemoveMaterial,
  onDuplicateCondition, onSplitCondition, onFollowFamilyRow, onRestoreDroppedRow,
  onDeriveTransitions, onLocateTransition,
  onBulkWaste, onBulkColor, onBulkDelete,
  onSaveTemplate, onApplyTemplate, onRenameTemplate, onDeleteTemplate,
  onAttachLibMaterial, onPromoteMaterial, onRevertMatField, matFieldOverridden,
  onUpdateLibMaterial, onPushLibUpdate, onDeleteLibMaterial, onAddLibMaterial,
  onAddColumn, onRenameColumn, onDeleteColumn, onAddColumnValue, onRemoveColumnValue, onRenameColumnValue,
  onAddLabel, onRenameLabel, onRemoveLabel,
  onToggleCollapse, onHoldGesture, onTogglePin,
}) {
  const { t } = useTranslation("panels");
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
  const [panelMatOpen, setPanelMatOpen] = useState(false);    // supporting-materials editor expanded inline under the active row
  const [twinDraft, setTwinDraft] = useState({ id: "", label: "" });   // inline "duplicate for another area" input (never a prompt)
  // ⟂ Transitions — the two finishes to compare, and the last run's report.
  // Inline for the same reason the twin input is: a window.prompt freezes a
  // CDP/automation-driven session dead, and this panel is scripted in demos.
  const [transDraft, setTransDraft] = useState({ id: "", a: "", b: "" });
  const [transResult, setTransResult] = useState(null);   // { committed, total_lf, withheld[], between, onto } | { error }
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
    setTransDraft((d) => (d.id ? { id: "", a: "", b: "" } : d));
    setTransResult(null);   // a report about shapes that no longer exist is worse than no report
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
      const fam = tagFamily(it.c);
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

  // unit-system display edge (mirrors the canvas HUD): internal math stays feet
  const fa = (sf) => `${num(areaVal(sf, units))} ${areaUnit(units)}`;
  const fl = (lf) => `${num(lenVal(lf, units))} ${lenUnit(units)}`;

  const renderCondRow = (c) => {
    const row = visRowById.get(c.id);
    const mult = c.multiplier || 1;
    const sf = row?.floor_sf || 0, lf = row?.lf || 0, ea = row?.ea || 0, wsf = row?.wall_sf || 0;
    const shapeCount = row?.shape_count || 0;
    // whole-project Σ suffix (#137): shown ONLY when the project holds more
    // than the open sheets, so the common everything-on-this-sheet case stays
    // one number. A condition entirely on closed sheets reads "Σ 412 SF"
    // instead of a dead "—".
    const qtys = (o) => [o.sf ? fa(o.sf) : "", o.wsf ? `${fa(o.wsf)} wall` : "", o.lf ? fl(o.lf) : "", o.ea ? `${num(o.ea, 0)} EA` : ""].filter(Boolean).join(" · ");
    const pr = projRowById.get(c.id);
    const prQ = pr ? { sf: pr.floor_sf || 0, wsf: pr.wall_sf || 0, lf: pr.lf || 0, ea: pr.ea || 0 } : null;
    const projDiff = prQ && (Math.abs(prQ.sf - sf) > 0.005 || Math.abs(prQ.wsf - wsf) > 0.005 || Math.abs(prQ.lf - lf) > 0.005 || Math.abs(prQ.ea - ea) > 0.005);
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
      <div key={c.id} data-cond-id={c.id} style={{ borderTop: "1px solid var(--ink-faint)", background: checked ? "var(--tint-select)" : on ? "var(--tint-active)" : "transparent", borderLeft: on ? `3px solid ${c.color}` : checked ? "3px solid var(--cobalt)" : "3px solid transparent" }}>
        <div draggable
          onDragStart={(e) => { e.dataTransfer.setData(CONDITION_DND_MIME, c.id); e.dataTransfer.effectAllowed = "copy"; }}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) { toggleChecked(c.id); return; }
            if (e.shiftKey) { rangeCheck(c.id); return; }
            onActivate(c.id);
          }}
          onDoubleClick={() => onLocate(c.id)}
          title={reassigning ? t('takeoffs.cond_title_reassign') : t('takeoffs.cond_title_active')}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", cursor: "pointer", outline: reassigning ? "1px dashed var(--cobalt)" : "none", outlineOffset: -3, userSelect: "none" }}>
          {hot && <span title={pinned ? t('takeoffs.palette_shortcut_title', { num: hIdx + 1 }) : t('takeoffs.hotkey_title', { num: hIdx + 1 })} style={{ fontSize: 9, fontFamily: "var(--f-mono,monospace)", color: pinned ? "var(--cobalt)" : "var(--ink-muted)", border: `1px solid ${pinned ? "var(--cobalt)" : "var(--ink-faint)"}`, borderRadius: 3, padding: "0 3px", flexShrink: 0 }}>{hIdx + 1}</span>}
          <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: on ? 700 : 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {/* a twin reads as one: whose it is, and how many of its rows have gone their own way */}
              {c.variant_of ? <span aria-hidden title={t('takeoffs.twin_title')} style={{ color: "var(--ink-faint)", fontWeight: 400 }}>↳ </span> : null}
              {c.finish_tag}{mult > 1 ? <span style={{ color: "var(--ink-muted)", fontWeight: 500 }}> ×{mult}</span> : null}
              {c.variant_of && localCount(c) > 0 ? (
                <span title={t('takeoffs.twin_count_title', { count: localCount(c) })}
                  style={{ marginLeft: 5, fontFamily: "var(--f-mono,monospace)", fontSize: 9, fontWeight: 500, color: "var(--cobalt)", border: "1px solid var(--cobalt)", borderRadius: 3, padding: "0 3px" }}>{localCount(c)}</span>
              ) : null}
            </div>
            <div style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 11, color: "var(--ink-muted)" }}>
              {qtys({ sf, wsf, lf, ea })}{!sf && !wsf && !lf && !ea && !projDiff ? "—" : ""}
              {projDiff ? (
                <span title={t('takeoffs.project_sigma_title')} style={{ color: "var(--ink-faint)" }}>
                  {(sf || wsf || lf || ea) ? " · " : ""}Σ {qtys(prQ) || "0"}
                </span>
              ) : null}
            </div>
          </div>
          <span style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, color: "var(--ink-muted)", flexShrink: 0 }}>{shapeCount}▦</span>
          <button onClick={(e) => { e.stopPropagation(); onLocate(c.id); }} title={t('takeoffs.zoom_title')}
            style={{ flexShrink: 0, padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12, lineHeight: 1 }}>⌖</button>
          <button onClick={(e) => { e.stopPropagation(); onSetActive(c.id); setPanelMatOpen((v) => (on ? !v : true)); }}
            title={t('takeoffs.materials_title')}
            style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: matOn ? "var(--ink)" : "transparent", color: matOn ? "var(--paper-bright)" : "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>
            <Icon name="product" size={11} />{c.materials?.length ? c.materials.length : ""}
          </button>
          <button onClick={(e) => { e.stopPropagation(); onTogglePin(c.id); }}
            title={pinned ? t('takeoffs.pin_title_pinned') : (palette.length >= 9 ? t('takeoffs.pin_title_full') : t('takeoffs.pin_title_available'))}
            style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", padding: "2px 5px", borderRadius: 0, border: `1px solid ${pinned ? "var(--cobalt)" : "var(--ink-faint)"}`, background: "transparent", color: pinned ? "var(--cobalt)" : (!pinned && palette.length >= 9 ? "var(--ink-faint)" : "var(--ink-muted)"), cursor: "pointer", lineHeight: 0 }}>
            <Icon name="pin" size={12} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDeleteCondition(c.id); }} title={t('takeoffs.delete_title')}
            style={{ flexShrink: 0, padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 12 }}>✕</button>
        </div>
        {/* properties for the ACTIVE condition — the appearance editing that
            used to live in its own toolbar row above the canvas. Extracted to
            ConditionAppearanceEditor so the docked panel AND the top-bar band
            render the same editor from one source of truth. */}
        {on && <ConditionAppearanceEditor cond={c} onUpdateCond={onUpdateCond} onSetCondParam={onSetCondParam} onAssignAttr={onAssignAttr} conditionColumns={conditionColumns} units={units} rollInfo={rollByCond?.get(c.id) || null} />}
        {on && onDeriveTransitions && <TransitionsAction cond={c} sources={transitionSources} draft={transDraft} setDraft={setTransDraft}
          result={transResult} setResult={setTransResult} onDerive={onDeriveTransitions} onLocate2={onLocateTransition} />}
        {matOn && (
          <div style={{ padding: "8px 12px 10px", background: "var(--paper-cream)", borderTop: "1px solid var(--ink-faint)", fontSize: 11.5 }}>
            <div style={{ marginBottom: 6, color: "var(--ink-muted)" }}>{t('takeoffs.supporting_heading')}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--ink-muted)", width: 56, flexShrink: 0 }}>{t('takeoffs.labor')}</span>
                <input name="condition-labor-type" value={c.laborType || ""} placeholder={t('takeoffs.labor_placeholder')}
                  onChange={(e) => onUpdateCond({ laborType: e.target.value })}
                  style={{ ...ip, flex: 1, minWidth: 0 }} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--ink-muted)", width: 56, flexShrink: 0 }}>{t('takeoffs.subfloor')}</span>
                <input name="condition-subfloor-type" value={c.subfloorType || ""} placeholder={t('takeoffs.subfloor_placeholder')}
                  onChange={(e) => onUpdateCond({ subfloorType: e.target.value })}
                  style={{ ...ip, flex: 1, minWidth: 0 }} />
              </label>
            </div>
            {/* Family: a twin says whose it is, and how to cut it loose. */}
            {c.variant_of && (() => {
              const par = conditions.find((x) => x.id === c.variant_of);
              const n = localCount(c);
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, padding: "3px 6px", border: "1px solid var(--ink-faint)", background: "var(--paper-cream)", fontSize: 11 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-muted)" }}
                    title={t('takeoffs.twin_follow_title', { tag: par?.finish_tag || "the original" })}>
                    {t('takeoffs.twin_of')} <b style={{ color: "var(--ink)" }}>{par?.finish_tag || "—"}</b>
                    {n ? <span style={{ color: "var(--cobalt)" }}> {t('takeoffs.twin_local', { count: n })}</span> : null}
                  </span>
                  {onSplitCondition && (
                    <button onClick={() => onSplitCondition(c.id)}
                      title={t('takeoffs.twin_split_title', { tag: par?.finish_tag || "the original" })}
                      style={{ padding: "1px 6px", border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 10.5, color: "var(--ink)", flexShrink: 0 }}>{t('takeoffs.twin_split')}</button>
                  )}
                </div>
              );
            })()}
            <MaterialsEditor materials={c.materials} onAdd={onAddMaterial} onUpdate={onUpdateMaterial} onRemove={onRemoveMaterial}
              library={matLib} libById={matLibById} overridden={matFieldOverridden} onRevert={onRevertMatField}
              onAttach={onAttachLibMaterial} onPromote={onPromoteMaterial}
              twin={!!c.variant_of} parentTag={(conditions.find((x) => x.id === c.variant_of) || {}).finish_tag || ""}
              dropped={c.materials_dropped || []} parentRows={(conditions.find((x) => x.id === c.variant_of) || {}).materials || []}
              onFollowFamilyRow={onFollowFamilyRow} onRestoreDroppedRow={onRestoreDroppedRow} />
            {/* Duplicate, inline — deliberately NOT a window.prompt: those freeze a
                CDP/automation-driven session dead, and this panel is scripted in demos. */}
            {onDuplicateCondition && (twinDraft.id === c.id ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>{t('takeoffs.duplicate_for')}</span>
                <input name="twin-label" autoFocus value={twinDraft.label}
                  onChange={(e) => setTwinDraft({ id: c.id, label: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && twinDraft.label.trim()) { onDuplicateCondition(c.id, twinDraft.label.trim()); setTwinDraft({ id: "", label: "" }); }
                    if (e.key === "Escape") setTwinDraft({ id: "", label: "" });
                  }}
                  placeholder={t('takeoffs.duplicate_placeholder')} style={{ ...ip, width: 120 }} />
                <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>
                  → <b style={{ color: "var(--ink)" }}>{twinDraft.label.trim() ? `${baseTagOf(c.finish_tag)} – ${twinDraft.label.trim()}` : "…"}</b>
                </span>
                <button onClick={() => { if (twinDraft.label.trim()) { onDuplicateCondition(c.id, twinDraft.label.trim()); setTwinDraft({ id: "", label: "" }); } }}
                  disabled={!twinDraft.label.trim()}
                  style={{ padding: "2px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: twinDraft.label.trim() ? "var(--ink)" : "var(--ink-faint)", cursor: twinDraft.label.trim() ? "pointer" : "default", fontSize: 11 }}>{t('takeoffs.duplicate')}</button>
                <button onClick={() => setTwinDraft({ id: "", label: "" })}
                  style={{ padding: "2px 6px", border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>{t('takeoffs.duplicate_cancel')}</button>
              </div>
            ) : (
              <button onClick={() => setTwinDraft({ id: c.id, label: "" })}
                title={t('takeoffs.duplicate_button_title')}
                style={{ marginTop: 6, padding: "3px 9px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 11.5 }}>{t('takeoffs.duplicate_button')}</button>
            ))}
          </div>
        )}
      </div>
    );
  };

  if (!open) return null;
  return (
    // Narrow screens (`overlay`): the panel slides OVER the canvas instead of
    // docking beside it — a docked 240px+ column plus the canvas doesn't fit a
    // phone (the panel was covering the whole screen). Desktop docked layout
    // is unchanged. The header's » collapse button is the close affordance.
    <div ref={rootRef} style={overlay
      ? { position: "absolute", top: 0, right: 0, bottom: 0, width: "min(100%, 420px)", zIndex: Z.drawer, boxShadow: "var(--shadow-pop)", display: "flex", background: "var(--paper-bright)", borderLeft: "1px solid var(--ink-faint)", fontSize: 12.5 }
      : { width, flexShrink: 0, display: "flex", background: "var(--paper-bright)", borderLeft: "1px solid var(--ink-faint)", fontSize: 12.5 }}>
      {!overlay && <div onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd} onLostPointerCapture={onResizeEnd}
        title={t('takeoffs.resize_title')}
        style={{ width: 5, flexShrink: 0, cursor: "col-resize", touchAction: "none", background: "transparent", borderRight: "1px solid var(--ink-faint)" }} />}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 12px", background: "var(--ink)", color: "var(--paper-cream)", flexShrink: 0 }}>
          <span style={{ display: "inline-flex", gap: 2 }}>
            {[["takeoffs", multiSheet ? t('takeoffs.tab_takeoffs_multi') : t('takeoffs.tab_takeoffs_single')], ["library", templates.length ? t('takeoffs.tab_library_count', { count: templates.length }) : t('takeoffs.tab_library')], ["materials", matLib.length ? t('takeoffs.tab_materials_count', { count: matLib.length }) : t('takeoffs.tab_materials')], ["columns", conditionColumns.length ? t('takeoffs.tab_columns_count', { count: conditionColumns.length }) : t('takeoffs.tab_columns')]].map(([id, label]) => (
              <button key={id} onClick={() => setPanelTab(id)}
                style={{ padding: "3px 8px", border: "none", borderBottom: panelTab === id ? "2px solid var(--paper-cream)" : "2px solid transparent", background: "none", color: "var(--paper-cream)", opacity: panelTab === id ? 1 : 0.65, cursor: "pointer", fontWeight: 700, fontSize: 12.5 }}>{label}</button>
            ))}
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => onPanelPrefs((p) => ({ ...p, strip: !p.strip }))}
              title={t('takeoffs.strip_title')}
              style={{ background: panelPrefs.strip ? "var(--paper-cream)" : "none", border: "1px solid var(--paper-cream)", color: panelPrefs.strip ? "var(--ink)" : "var(--paper-cream)", fontSize: 9.5, fontFamily: "var(--f-mono)", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", padding: "2px 6px", lineHeight: 1.4 }}>{t('takeoffs.strip')}</button>
            <button onClick={onToggleCollapse} title={t('takeoffs.collapse_title')}
              style={{ background: "none", border: "none", color: "var(--paper-cream)", fontSize: 15, cursor: "pointer", lineHeight: 1 }}>»</button>
          </span>
        </div>
        {panelTab === "takeoffs" && <>
        {/* view controls — search / natural sort / tag-family grouping.
            All VIEW-ONLY: the array order (hotkeys, payload) never changes. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--ink-faint)", flexShrink: 0 }}>
          <input name="condition-filter" value={condQuery} onChange={(e) => setCondQuery(e.target.value)} placeholder={t('takeoffs.filter_placeholder')}
            style={{ flex: 1, minWidth: 0, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
          {condQuery && <button onClick={() => setCondQuery("")} title={t('takeoffs.filter_clear_title')} style={btnClearX}>×</button>}
          <button onClick={() => onPanelPrefs((p) => ({ ...p, az: !p.az }))}
            title={t('takeoffs.sort_title')}
            style={{ padding: "3px 7px", borderRadius: 0, border: `1px solid ${panelPrefs.az ? "var(--cobalt)" : "var(--ink-faint)"}`, background: panelPrefs.az ? "var(--cobalt)" : "transparent", color: panelPrefs.az ? "var(--paper-bright)" : "var(--ink-muted)", cursor: "pointer", fontSize: 10.5, fontFamily: "var(--f-mono)", lineHeight: 1.4 }}>A→Z</button>
          <button onClick={() => onPanelPrefs((p) => ({ ...p, group: !p.group }))}
            title={t('takeoffs.group_title')}
            style={{ padding: "3px 7px", borderRadius: 0, border: `1px solid ${panelPrefs.group ? "var(--cobalt)" : "var(--ink-faint)"}`, background: panelPrefs.group ? "var(--cobalt)" : "transparent", color: panelPrefs.group ? "var(--paper-bright)" : "var(--ink-muted)", cursor: "pointer", fontSize: 10.5, fontFamily: "var(--f-mono)", lineHeight: 1.4 }}>≡ grp</button>
        </div>
        {/* bulk actions — appear while a ⌘/⇧ multi-selection is live
            (liveChecked: the count never claims ids the list lost) */}
        {liveChecked.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", borderBottom: "1px solid var(--ink-faint)", background: "var(--tint-select)", flexShrink: 0, flexWrap: "wrap", fontSize: 11 }}>
            <strong style={{ color: "var(--cobalt)" }}>{t('takeoffs.selected', { count: liveChecked.length })}</strong>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={t('takeoffs.waste_bulk_title')}>
              <span style={{ color: "var(--ink-muted)" }}>{t('takeoffs.waste_label')}</span>
              <input name="bulk-waste" type="number" min="0" step="1" value={bulkWaste} onChange={(e) => setBulkWaste(e.target.value)} placeholder="%"
                onKeyDown={(e) => e.key === "Enter" && applyBulkWaste()}
                style={{ width: 44, padding: "2px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 11 }} />
              <button onClick={applyBulkWaste} title={t('takeoffs.waste_apply_title')} style={{ padding: "2px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 11 }}>✓</button>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={t('takeoffs.color_bulk_title')}>
              {PALETTE.map((p) => <button key={p} title={p} onClick={() => onBulkColor(liveIds(), p)} style={{ width: 13, height: 13, borderRadius: 3, background: p, border: "1px solid var(--ink-faint)", cursor: "pointer", padding: 0 }} />)}
            </span>
            <button onClick={bulkDelete} title={t('takeoffs.delete_bulk_title')}
              style={{ padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t('takeoffs.delete')}</button>
            <button onClick={() => setCheckedConds(new Set())} title={t('takeoffs.clear_selection_title')}
              style={{ marginLeft: "auto", padding: "2px 6px", border: "none", background: "none", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>✕</button>
          </div>
        )}
        <div style={{ flex: 1, overflow: "auto" }}>
          {conditions.length === 0 && <div style={{ padding: "12px", color: "var(--ink-muted)" }}>{t('takeoffs.no_conditions')}</div>}
          {condGroups.map((g) => (
            <React.Fragment key={g.name ?? "_all"}>
              {g.name != null && (
                <div onClick={() => setClosedGroups((s) => { const n = new Set(s); if (n.has(g.name)) n.delete(g.name); else n.add(g.name); return n; })}
                  title={t('takeoffs.family_collapse_title')}
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
          {searchMiss && <div style={{ padding: "12px", color: "var(--ink-muted)" }}>{t('takeoffs.search_miss', { query: condQuery })}</div>}
          <div style={{ padding: "6px 12px", borderTop: "1px solid var(--ink-faint)" }}>
            <button onClick={onAddCondition} style={{ width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--ink-muted)" }}>{t('takeoffs.add_condition')}</button>
          </div>
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)", color: "var(--ink-muted)", fontSize: 10.5 }}>
            {t('takeoffs.help_copy')}
            <br />{t('takeoffs.help_undo')}
          </div>
        </div>
        </>}
        {/* Library tab — reusable condition templates, browser-wide */}
        {panelTab === "library" && (
          <div style={{ flex: 1, overflow: "auto" }}>
            <div style={{ padding: "8px 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
              {t('takeoffs.library_description')}
            </div>
            <div style={{ padding: "6px 12px 10px" }}>
              <button onClick={onSaveTemplate} disabled={!aCond}
                title={t('takeoffs.library_save_title')}
                style={{ width: "100%", padding: "6px 10px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", cursor: aCond ? "pointer" : "default", fontSize: 12, color: aCond ? "var(--ink)" : "var(--ink-faint)" }}>
                {aCond?.finish_tag ? t('takeoffs.library_save', { tag: aCond.finish_tag }) : t('takeoffs.library_save_default')}
              </button>
            </div>
            {templates.length === 0 && <div style={{ padding: "2px 12px 12px", color: "var(--ink-muted)" }}>{t('takeoffs.library_empty')}</div>}
            {templates.map((tItem, idx) => (
              <div key={`${tItem.finish_tag}-${idx}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={tItem.hatch || "solid"} line={tItem.color} fill={tItem.fill} /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tItem.finish_tag}</div>
                  <div style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, color: "var(--ink-muted)" }}>
                    {tItem.waste_pct || 0}% waste{tItem.height_ft != null ? ` · H ${dimInputStr(tItem.height_ft, units, "height")}${units === "metric" ? " m" : "′"}` : ""}{tItem.thickness_in != null ? ` · T ${dimInputStr(tItem.thickness_in, units, "thickness")}${units === "metric" ? " mm" : "″"}` : ""}{tItem.materials?.length ? ` · ${tItem.materials.length} material${tItem.materials.length === 1 ? "" : "s"}` : ""}
                  </div>
                </div>
                <button onClick={() => { onApplyTemplate(tItem); setPanelTab("takeoffs"); }} title={t('takeoffs.library_apply_title')}
                  style={{ flexShrink: 0, padding: "3px 8px", borderRadius: 0, border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t('takeoffs.library_apply')}</button>
                <button onClick={() => onRenameTemplate(idx)} title={t('takeoffs.library_rename_title')}
                  style={{ flexShrink: 0, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                <button onClick={() => onDeleteTemplate(idx)} title={t('takeoffs.library_delete_title')}
                  style={{ flexShrink: 0, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
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
              {t('takeoffs.materials_description')}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px 8px" }}>
              <input name="material-library-filter" value={matLibQuery} onChange={(e) => setMatLibQuery(e.target.value)} placeholder={t('takeoffs.materials_filter_placeholder')}
                style={{ flex: 1, minWidth: 0, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
              {matLibQuery && <button onClick={() => setMatLibQuery("")} title={t('takeoffs.filter_clear_title')} style={btnClearX}>×</button>}
            </div>
            {matLib.length === 0 && <div style={{ padding: "2px 12px 12px", color: "var(--ink-muted)" }}>{t('takeoffs.materials_empty')}</div>}
            {matLib.filter((lm) => !matQ || (lm.name || "").toLowerCase().includes(matQ)).map((lm) => {
              const n = linkedCountById[lm.id] || 0;
              return (
                <div key={lm.id} style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {/* name is draft-buffered like per/note (round-3 finding 3): a per-keystroke
                        commit routes every transient value through libEntryPatch's rename
                        re-classification, where a select-all-retype walks the entry's kind
                        through arbitrary intermediate classifications */}
                    <LibDraftInput name="library-material-name" value={lm.name} placeholder={t('takeoffs.mat_name_placeholder')} width={150}
                      onCommitText={(t) => onUpdateLibMaterial(lm.id, { name: t })} />
                    <span style={{ color: "var(--ink-muted)" }}>1</span>
                    <input name="library-material-unit" value={lm.unit} onChange={(e) => onUpdateLibMaterial(lm.id, { unit: e.target.value })} placeholder={t('takeoffs.mat_unit_placeholder')} style={{ ...ip, width: 54 }} />
            <span style={{ color: "var(--ink-muted)" }}>{t('takeoffs.mat_per')}</span>
                    <LibDraftInput name="library-material-per" number value={lm.per || ""} placeholder="0" width={62}
                      onCommitText={(t) => onUpdateLibMaterial(lm.id, { per: Math.max(0, parseFloat(t) || 0) })} />
                    <select name="library-material-basis" value={lm.basis || "area"} onChange={(e) => onUpdateLibMaterial(lm.id, { basis: e.target.value })} style={{ ...ip, background: "var(--paper-bright)" }}>
                      <option value="area">{t('takeoffs.mat_basis_floor_sf')}</option>
                      <option value="linear">{t('takeoffs.mat_basis_linear_lf')}</option>
                      <option value="count">{t('takeoffs.mat_basis_each')}</option>
                      <option value="seam_lf" title={t('takeoffs.mat_basis_seam_lf_title')}>{t('takeoffs.mat_basis_seam_lf')}</option>
                    </select>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ink-muted)" }} title={t('takeoffs.mat_round_title')}>
                      <input name="library-material-round" type="checkbox" checked={lm.round !== false} onChange={(e) => onUpdateLibMaterial(lm.id, { round: e.target.checked })} />{t('takeoffs.mat_round')}
                    </label>
                    <CoveragePresetSelect material={lm} onPick={(patch) => onUpdateLibMaterial(lm.id, patch)} />
                    <LibDraftInput name="library-material-note" value={lm.note || ""} placeholder={t('takeoffs.mat_note_placeholder')} width={120}
                      onCommitText={(t) => onUpdateLibMaterial(lm.id, { note: t })} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
                    <span style={{ fontFamily: "var(--f-mono,monospace)", fontSize: 10.5, color: "var(--ink-muted)" }}>{n ? t('takeoffs.materials_linked', { count: n }) : t('takeoffs.materials_not_linked')}</span>
                    <div style={{ flex: 1 }} />
                    {n > 0 && (
                      <button onClick={() => onPushLibUpdate(lm.id)} title={t('takeoffs.materials_push_title')}
                        style={{ padding: "2px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 11 }}>{t('takeoffs.materials_push', { count: n })}</button>
                    )}
                    <button onClick={() => onDeleteLibMaterial(lm.id)} title={t('takeoffs.materials_remove_title')}
                      style={{ padding: "2px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
                  </div>
                </div>
              );
            })}
            <div style={{ padding: "6px 12px", borderTop: matLib.length ? "1px solid var(--ink-faint)" : "none" }}>
              <button onClick={onAddLibMaterial} style={btnAddFull}>{t('takeoffs.materials_add')}</button>
            </div>
          </div>
        )}
        {/* Columns tab — the custom-columns manager (#31/#33): project-level
            vocabulary; per-condition assignment lives in the active row's
            properties on the Takeoffs tab */}
        {panelTab === "columns" && (
          <div style={{ flex: 1, overflow: "auto", fontSize: 11.5 }}>
            {/* Shape labels (#110) — a flat project-level vocabulary; each shape
                carries at most one label. Lives here rather than a 5th panel tab:
                it's the degenerate single-column case. */}
            <details open style={{ borderBottom: "2px solid var(--ink-faint)" }}>
              <summary style={{ padding: "8px 12px 4px", cursor: "pointer", fontWeight: 600, fontSize: 11.5 }}>
                {t('takeoffs.columns_shape_labels')}{shapeLabels.length ? ` (${shapeLabels.length})` : ""}
              </summary>
              <div style={{ padding: "0 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
                {t('takeoffs.columns_shape_labels_desc')}
              </div>
              <div style={{ padding: "2px 12px 10px", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {shapeLabels.map((v) => (
                  <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 3px 2px 8px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 11.5, color: "var(--ink)" }}>
                    {v}
                    <button onClick={() => onRenameLabel(v)} title={t('takeoffs.columns_label_rename_title')}
                      style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                    <button onClick={() => onRemoveLabel(v)} title={t('takeoffs.columns_label_remove_title')}
                      style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
                  </span>
                ))}
                <AddValueInput onAdd={onAddLabel} />
              </div>
            </details>
            <div style={{ padding: "8px 12px 4px", color: "var(--ink-muted)", fontSize: 11 }}>
              {t('takeoffs.columns_description')}
            </div>
            {conditionColumns.length === 0 && <div style={{ padding: "2px 12px 8px", color: "var(--ink-muted)" }}>{t('takeoffs.columns_empty')}</div>}
            {conditionColumns.map((cc) => (
              <div key={cc.id} style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-faint)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <input name="column-name" value={cc.name} onChange={(e) => onRenameColumn(cc.id, e.target.value)} placeholder={t('takeoffs.columns_name_placeholder')}
                    style={{ padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12, flex: 1, minWidth: 0 }} />
                  <button onClick={() => onDeleteColumn(cc.id)} title={t('takeoffs.columns_delete_title')}
                    style={{ flexShrink: 0, padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 12 }}>{t('takeoffs.columns_delete')}</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {cc.values.map((v) => (
                    <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 3px 2px 8px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 11.5, color: "var(--ink)" }}>
                      {v}
                      <button onClick={() => onRenameColumnValue(cc.id, v)} title={t('takeoffs.columns_value_rename_title')}
                        style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>✎</button>
                      <button onClick={() => onRemoveColumnValue(cc.id, v)} title={t('takeoffs.columns_value_remove_title')}
                        style={{ padding: "0 3px", border: "none", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 }}>✕</button>
                    </span>
                  ))}
                  <AddValueInput onAdd={(v) => onAddColumnValue(cc.id, v)} />
                </div>
              </div>
            ))}
            <div style={{ padding: "6px 12px", borderTop: conditionColumns.length ? "1px solid var(--ink-faint)" : "none" }}>
              <button onClick={onAddColumn} style={btnAddFull}>{t('takeoffs.columns_add')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default React.memo(TakeoffsPanel);
