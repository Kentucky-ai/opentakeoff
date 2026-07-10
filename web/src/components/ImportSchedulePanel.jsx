// ImportSchedulePanel — the approval dialog for "Import from schedule".
// The estimator drags a box around the finish/material schedule; the parent
// (TakeoffCanvas) extracts + parses it (lib/scheduleParse) and hands the rows
// here. This view is the one human beat: glance, FIX a mis-read code, uncheck
// what you don't want, Create.
//
// Parsing/normalization is the parent's (tested) job; this holds local checkbox
// state AND local edited-tag state. The scan/OCR path mis-reads codes (O↔0,
// I↔1, CPT↔CRT), and finish_tag is the identity the canvas dedups on and matches
// callouts against — so the tag is inline-editable here and the CORRECTED tag is
// what flows through selection and onCreate (the parent gets edited rows, never
// the originals). The dedup/normalization math lives in lib/scheduleEdit (tested).
// Contract (unchanged; skipped is optional with a safe default):
//   <ImportSchedulePanel rows existing={Set<finish_tag>} palette startIndex
//                        skipped? onCreate(rows[]) onClose />
//
// Defaults do the work: ceilings/millwork arrive suggested:false (unchecked),
// and codes already present as conditions arrive locked ("in use") so a second
// import can't duplicate them.
import React, { useMemo, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { evaluateTags, isCreatable } from "../lib/scheduleEdit";

// category → display group, in the order an estimator reads a floor set
const GROUPS = [
  { key: "floor", label: "Floor" },
  { key: "base", label: "Base" },
  { key: "wall", label: "Wall" },
  { key: "transition", label: "Transition" },
  { key: "ceiling", label: "Ceiling" },
  { key: "other", label: "Other" },
];

export default function ImportSchedulePanel({ rows = [], existing = new Set(), palette = [], startIndex = 0, skipped = 0, onCreate, onClose }) {
  // Give every row a STABLE key up front. Checkbox + color state is keyed on it,
  // not on the tag, so editing a tag never drops a row's selection.
  const keyed = useMemo(() => rows.map((row, i) => ({ key: `r${i}`, row })), [rows]);

  // Edited tags, keyed by row key. Seeded from the parsed tag; a row absent from
  // this map is still showing its original tag.
  const [tags, setTags] = useState(() => Object.fromEntries(keyed.map(({ key, row }) => [key, row.finish_tag])));
  const tagOf = (key, row) => (tags[key] !== undefined ? tags[key] : row.finish_tag);

  // Resolve every (edited) tag to a normalized value + status. This is the single
  // source of truth for "can this row be created": unique, non-empty, and not
  // already a condition. Re-evaluated on every keystroke so dedup stays live.
  const tagState = useMemo(
    () => evaluateTags(keyed.map(({ key, row }) => ({ key, tag: tags[key] !== undefined ? tags[key] : row.finish_tag })), existing),
    [keyed, tags, existing],
  );
  const stateOf = (key) => tagState.get(key);
  const canPick = (key) => isCreatable(tagState.get(key));

  const [picked, setPicked] = useState(() => {
    const init = evaluateTags(keyed.map(({ key, row }) => ({ key, tag: row.finish_tag })), existing);
    return new Set(keyed.filter(({ key, row }) => row.suggested && isCreatable(init.get(key))).map(({ key }) => key));
  });
  const [editing, setEditing] = useState(null); // { key, orig } | null

  // Preview the line color each new condition will actually get: the parent
  // assigns palette[startIndex + n] over the creatable rows in this order, so
  // mirror that here (non-creatable rows are skipped, matching create).
  const colorByKey = useMemo(() => {
    const m = new Map();
    let n = startIndex;
    for (const { key } of keyed) if (isCreatable(tagState.get(key)) && palette.length) m.set(key, palette[n++ % palette.length]);
    return m;
  }, [keyed, tagState, palette, startIndex]);

  const grouped = useMemo(() => {
    const by = new Map(GROUPS.map((g) => [g.key, []]));
    for (const item of keyed) (by.get(item.row.category) || by.get("other")).push(item);
    return GROUPS.filter((g) => (by.get(g.key) || []).length).map((g) => ({ ...g, items: by.get(g.key) }));
  }, [keyed]);

  const toggle = (key) => setPicked((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const toggleGroup = (grp) => {
    const pickable = grp.items.filter(({ key }) => canPick(key)).map(({ key }) => key);
    const allOn = pickable.length > 0 && pickable.every((k) => picked.has(k));
    setPicked((s) => { const n = new Set(s); for (const k of pickable) allOn ? n.delete(k) : n.add(k); return n; });
  };

  // editing lifecycle
  const startEdit = (key, row) => setEditing({ key, orig: tagOf(key, row) });
  const editValue = (key, value) => setTags((t) => ({ ...t, [key]: value }));
  const commitEdit = () => setEditing(null);
  const cancelEdit = () => { if (editing) setTags((t) => ({ ...t, [editing.key]: editing.orig })); setEditing(null); };
  const onEditKey = (e) => { if (e.key === "Enter") { e.preventDefault(); commitEdit(); } else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); } };

  // Rows to create: only picked + creatable, in row order (so the parent's
  // palette[startIndex + n] assignment lines up), carrying the NORMALIZED tag.
  const creatable = keyed.filter(({ key }) => picked.has(key) && canPick(key));
  const count = creatable.length;
  const create = () => { if (count) onCreate(creatable.map(({ key, row }) => ({ ...row, finish_tag: stateOf(key).tag }))); };

  const lbl = { fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-muted)" };
  const flagFor = { "in-use": "in use", duplicate: "duplicate", empty: "needs a code" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 40 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxHeight: "min(82vh, 720px)", display: "flex", flexDirection: "column", background: "var(--paper-bright)", border: "1px solid var(--cobalt)", boxShadow: "var(--shadow-pop)", fontSize: 12.5 }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--ink-faint)", background: "var(--cobalt)", color: "var(--accent-contrast)" }}>
          <span style={{ fontWeight: 700 }}>Import from schedule — {rows.length} finish{rows.length === 1 ? "" : "es"} found</span>
          <button onClick={onClose} title="Close" style={{ background: "transparent", border: "none", color: "var(--accent-contrast)", cursor: "pointer", display: "inline-flex" }}><Icon name="close" size={14} /></button>
        </div>

        {skipped > 0 && (
          <div style={{ padding: "5px 14px", background: "var(--paper)", borderBottom: "1px solid var(--ink-faint)", ...lbl, opacity: 0.85 }}>
            {skipped} row{skipped === 1 ? "" : "s"} skipped (couldn't be read as a single finish)
          </div>
        )}

        {/* rows */}
        <div style={{ overflow: "auto", padding: "4px 0" }}>
          {grouped.map((grp) => {
            const pickable = grp.items.filter(({ key }) => canPick(key)).map(({ key }) => key);
            const allOn = pickable.length > 0 && pickable.every((k) => picked.has(k));
            return (
              <div key={grp.key}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", cursor: pickable.length ? "pointer" : "default", background: "var(--paper)", borderTop: "1px solid var(--ink-faint)" }}>
                  <input type="checkbox" checked={allOn} disabled={!pickable.length} onChange={() => toggleGroup(grp)} />
                  <span style={lbl}>{grp.label}</span>
                  <span style={{ ...lbl, opacity: 0.6 }}>{grp.items.length}</span>
                </label>
                {grp.items.map(({ key, row: r }) => {
                  const st = stateOf(key);
                  const ok = isCreatable(st);
                  const isEditing = editing?.key === key;
                  const on = picked.has(key) && ok;
                  const flag = flagFor[st?.status];
                  return (
                    <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 14px 5px 26px", cursor: ok ? "pointer" : "default", opacity: ok ? 1 : 0.55 }}>
                      <input type="checkbox" checked={on} disabled={!ok} onChange={() => toggle(key)} />
                      <span style={{ width: 12, height: 12, flex: "0 0 auto", background: colorByKey.get(key) || "var(--ink-faint)", border: "1px solid var(--ink-faint)" }} />
                      {isEditing ? (
                        <input
                          autoFocus
                          value={tagOf(key, r)}
                          onChange={(e) => editValue(key, e.target.value)}
                          onKeyDown={onEditKey}
                          onBlur={commitEdit}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                          onMouseDown={(e) => e.stopPropagation()}
                          spellCheck={false}
                          style={{ fontFamily: "var(--f-mono)", fontWeight: 600, fontSize: 12.5, width: 76, padding: "1px 4px", border: "1px solid var(--cobalt)", background: "var(--paper-bright)", color: "var(--ink)", textTransform: "uppercase" }}
                        />
                      ) : (
                        <button
                          type="button"
                          title="Click to fix the code"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); startEdit(key, r); }}
                          style={{ fontFamily: "var(--f-mono)", fontWeight: 600, fontSize: 12.5, minWidth: 58, textAlign: "left", padding: "1px 3px", border: "1px dashed var(--ink-faint)", background: "transparent", color: st?.status === "empty" ? "var(--ink-muted)" : "var(--ink)", cursor: "text" }}
                        >
                          {st?.tag || "set code"}
                        </button>
                      )}
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.description || <span style={{ color: "var(--ink-muted)" }}>—</span>}
                        {(r.manufacturer || r.size) && (
                          <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>  ·  {[r.manufacturer, r.size].filter(Boolean).join(" · ")}</span>
                        )}
                      </span>
                      {flag && <span style={{ ...lbl, opacity: 0.8 }}>{flag}</span>}
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "10px 14px", borderTop: "1px solid var(--ink-faint)" }}>
          <button onClick={onClose} style={{ padding: "7px 12px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12 }}>Cancel</button>
          <button onClick={create} disabled={!count}
            style={{ padding: "8px 16px", border: "none", background: count ? "var(--ink)" : "var(--text-faint)", color: "var(--paper-bright)", cursor: count ? "pointer" : "default", fontWeight: 700, fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Create {count} condition{count === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
