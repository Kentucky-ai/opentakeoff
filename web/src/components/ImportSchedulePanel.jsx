// ImportSchedulePanel — the approval dialog for "Import from schedule".
// The estimator drags a box around the finish/material schedule; the parent
// (TakeoffCanvas) reads it (lib/scheduleRead) and hands the rows
// here. This view is the one human beat: glance, FIX a mis-read code, uncheck
// what you don't want, Create.
//
// Parsing/normalization is the parent's (tested) job; this holds local checkbox
// state AND local edited-tag state. The scan/OCR path mis-reads codes. The
// reader repairs a $ read for S and an O or I read for 0 or 1 after the hyphen,
// and the row says so ("read as", below); what it can't repair (CPT↔CRT, a
// dropped letter) comes through as read. finish_tag is the identity the canvas
// dedups on and matches callouts against — so the tag is inline-editable here
// and the CORRECTED tag is what flows through selection and onCreate (the parent
// gets edited rows, never the originals). The dedup/normalization math lives in
// lib/scheduleEdit (tested).
// Contract (skipped is optional with a safe default):
//   <ImportSchedulePanel rows existing={Set<finish_tag>} palette startIndex
//                        skipped?={string[]} onCreate(rows[]) onClose />
// skipped = codes the reader saw but didn't read (four- or five-letter codes
// with no number, one entry per line); a notice above the rows names them.
// rows can be empty when skipped codes were all the box held: the dialog then
// says "no rows read" and offers Close only.
//
// Defaults do the work: ceilings/millwork arrive suggested:false (unchecked),
// rows the schedule marks NOT USED / N.I.C. arrive unchecked with a label
// saying so, and codes already present as conditions arrive locked ("in use")
// so a second import can't duplicate them. When rows share a code, the row
// read the usual way claims it over a row whose code the reader repaired
// (read_as), that over a row only the newer rules read (key_rule), and all
// of them over a NOT USED row; the others show "duplicate". A category the reader GUESSED from the row's
// own words (category_source "text" — no printed heading names one, whether
// there is no heading or it is a MISC / ACCESSORIES one) is flagged
// "from description" so the estimator reviews it before Create. A code the
// reader repaired from an OCR misread (read_as: PT-O1 imported as PT-01, #482)
// is flagged "read as PT-O1" until the code is edited to another one.
import React, { useId, useMemo, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { closeOnEscape, evaluateTags, groupState, groupToggle, isCreatable, previewColors, readAsShown, setPicked as pickRows, skippedBanner } from "../lib/scheduleEdit";
import { notUsedKind, notUsedNote } from "../lib/notUsed";
import { S } from "../lib/ui.js";

// category → display group, in the order an estimator reads a floor set.
// Rows the schedule gives no section (and whose words name no item) come
// first, so the ones that still need a decision are the first thing read.
const GROUPS = [
  { key: "unassigned", label: "No section" },
  { key: "floor", label: "Floor" },
  { key: "base", label: "Base" },
  { key: "wall", label: "Wall" },
  { key: "wall_protection", label: "Wall Protection" },
  { key: "transition", label: "Transition" },
  { key: "ceiling", label: "Ceiling" },
  { key: "other", label: "Other" },
];

export default function ImportSchedulePanel({ rows = [], existing = new Set(), palette = [], startIndex = 0, skipped = [], onCreate, onClose }) {
  const uid = useId(); // prefixes each row's flag id so aria-describedby is unique on the page
  // Give every row a STABLE key up front. Checkbox + color state is keyed on it,
  // not on the tag, so editing a tag never drops a row's selection.
  const keyed = useMemo(() => rows.map((row, i) => ({ key: `r${i}`, row })), [rows]);
  // Which row claims a code several rows share, by the row the dialog holds
  // (never its edited tag): read the usual way 2, its code repaired from an
  // OCR misread (read_as) 1.5, read only by the newer rules (key_rule) 1,
  // marked NOT USED by the schedule 0. The lowest that applies wins, so a
  // key_rule row that was also repaired ranks 1.
  const rank = useMemo(() => {
    const byKey = new Map(keyed.map(({ key, row }) => [key, row]));
    return (key) => { const r = byKey.get(key); return r?.unticked_reason ? 0 : r?.key_rule ? 1 : r?.read_as ? 1.5 : 2; };
  }, [keyed]);

  // Edited tags, keyed by row key. Seeded from the parsed tag; a row absent from
  // this map is still showing its original tag.
  const [tags, setTags] = useState(() => Object.fromEntries(keyed.map(({ key, row }) => [key, row.finish_tag])));
  const tagOf = (key, row) => (tags[key] !== undefined ? tags[key] : row.finish_tag);

  // Resolve every (edited) tag to a normalized value + status. This is the single
  // source of truth for "can this row be created": unique, non-empty, and not
  // already a condition. Re-evaluated on every keystroke so dedup stays live.
  const tagState = useMemo(
    () => evaluateTags(keyed.map(({ key, row }) => ({ key, tag: tags[key] !== undefined ? tags[key] : row.finish_tag })), existing, rank),
    [keyed, tags, existing, rank],
  );
  const stateOf = (key) => tagState.get(key);
  const canPick = (key) => isCreatable(tagState.get(key));

  const [picked, setPicked] = useState(() => {
    const init = evaluateTags(keyed.map(({ key, row }) => ({ key, tag: row.finish_tag })), existing, rank);
    return new Set(keyed.filter(({ key, row }) => row.suggested && isCreatable(init.get(key))).map(({ key }) => key));
  });
  const [editing, setEditing] = useState(null); // { key, orig } | null

  // Preview the line color each new condition will actually get: the parent
  // assigns palette[startIndex + n] over the rows it CREATES (picked and
  // creatable, in row order), so number only those — an unpicked row shows the
  // neutral swatch, and ticking/unticking a row re-numbers the ones after it.
  const colorByKey = useMemo(
    () => previewColors(keyed.map(({ key }) => key), (key) => picked.has(key) && isCreatable(tagState.get(key)), palette, startIndex),
    [keyed, tagState, picked, palette, startIndex],
  );

  const grouped = useMemo(() => {
    const by = new Map(GROUPS.map((g) => [g.key, []]));
    for (const item of keyed) (by.get(item.row.category) || by.get("other")).push(item);
    return GROUPS.filter((g) => (by.get(g.key) || []).length).map((g) => ({ ...g, items: by.get(g.key) }));
  }, [keyed]);

  const toggle = (key) => setPicked((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  // A group's checkbox: all picked → clear the group; some or none → pick
  // every pickable row in it, NOT USED rows included.
  const toggleGroup = (grp) => setPicked((s) => groupToggle(s, grp.items.map(({ key }) => key), canPick));
  // Select All / Deselect All: the same set math over every row. Locked rows
  // (in use / duplicate / needs a code) are never picked.
  const allKeys = keyed.map(({ key }) => key);
  const pickAll = (on) => setPicked((s) => pickRows(s, allKeys, canPick, on));

  // editing lifecycle
  const startEdit = (key, row) => setEditing({ key, orig: tagOf(key, row) });
  const editValue = (key, value) => setTags((t) => ({ ...t, [key]: value }));
  const commitEdit = () => setEditing(null);
  const cancelEdit = () => { if (editing) setTags((t) => ({ ...t, [editing.key]: editing.orig })); setEditing(null); };
  const onEditKey = (e) => { if (e.key === "Enter") { e.preventDefault(); commitEdit(); } else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); } };

  // Escape closes the dialog — unless it was a tag edit's Escape, which only
  // cancels the edit (onEditKey preventDefaults it; React's handler runs before
  // this document listener). Stopped so the canvas's own Escape doesn't also
  // fire behind the modal. The decision is lib/scheduleEdit's closeOnEscape (tested).
  React.useEffect(() => {
    const onKey = (e) => { closeOnEscape(e, onClose); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const titleId = `${uid}-title`;
  const bannerId = `${uid}-skipped`;
  const hasSkipped = skipped.length > 0;
  const legacyBannerId = `${uid}-legacy`;
  const hasLegacy = [...tagState.values()].some((s) => s.status === "legacy");
  const empty = rows.length === 0;

  // Rows to create: only picked + creatable, in row order (so the parent's
  // palette[startIndex + n] assignment lines up), carrying the NORMALIZED tag.
  const creatable = keyed.filter(({ key }) => picked.has(key) && canPick(key));
  const count = creatable.length;
  const create = () => { if (count) onCreate(creatable.map(({ key, row }) => ({ ...row, finish_tag: stateOf(key).tag }))); };

  const lbl = { fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-muted)" };
  const flagFor = { "in-use": "in use", duplicate: "duplicate", empty: "needs a code" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 40 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={[hasSkipped && bannerId, hasLegacy && legacyBannerId].filter(Boolean).join(" ") || undefined}
        style={{ width: "min(560px, calc(100vw - 32px))", maxHeight: "min(82vh, 720px)", display: "flex", flexDirection: "column", background: "var(--paper-bright)", border: "1px solid var(--cobalt)", boxShadow: "var(--shadow-pop)", fontSize: 12.5 }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--ink-faint)", background: "var(--cobalt)", color: "var(--accent-contrast)" }}>
          <span id={titleId} style={{ fontWeight: 700 }}>{empty ? "Import from schedule — no rows read" : `Import from schedule — ${rows.length} finish${rows.length === 1 ? "" : "es"} found`}</span>
          <button onClick={onClose} title="Close" style={{ background: "transparent", border: "none", color: "var(--accent-contrast)", cursor: "pointer", display: "inline-flex" }}><Icon name="close" size={14} /></button>
        </div>

        {hasSkipped && (
          <div role="note" id={bannerId} style={{ fontSize: "var(--fs-s)", color: "var(--ink)", borderLeft: "3px solid var(--c-warning)", paddingLeft: 8, margin: "8px 14px" }}>
            {skippedBanner(skipped)}
          </div>
        )}

        {hasLegacy && (
          <div role="note" id={legacyBannerId} style={{ fontSize: "var(--fs-s)", color: "var(--ink)", borderLeft: "3px solid var(--c-warning)", paddingLeft: 8, margin: "8px 14px" }}>
            Some codes may already exist without parentheses. Those rows are held. Check the existing condition; if it is the same finish, rename it before importing again. If they are different finishes, add the new condition manually.
          </div>
        )}

        {/* rows */}
        <div style={{ overflow: "auto", padding: "4px 0" }}>
          {grouped.map((grp) => {
            const keys = grp.items.map(({ key }) => key);
            const anyPickable = keys.some(canPick);
            const state = groupState(picked, keys, canPick);
            return (
              <div key={grp.key}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", cursor: anyPickable ? "pointer" : "default", background: "var(--paper)", borderTop: "1px solid var(--ink-faint)" }}>
                  <input type="checkbox" checked={state === "all"} data-state={state} disabled={!anyPickable} onChange={() => toggleGroup(grp)}
                    ref={(el) => { if (el) el.indeterminate = state === "some"; }} />
                  <span style={lbl}>{grp.label}</span>
                  <span style={{ ...lbl, opacity: 0.6 }}>{grp.items.length}</span>
                </label>
                {grp.items.map(({ key, row: r }) => {
                  const st = stateOf(key);
                  const ok = isCreatable(st);
                  const isEditing = editing?.key === key;
                  const on = picked.has(key) && ok;
                  const flag = st?.status === "legacy" ? `check existing ${st.legacyTag}` : flagFor[st?.status];
                  // The guessed-category flag, the read-as flag and the NOT USED
                  // label sit OUTSIDE the <label> (so they aren't folded into the
                  // checkbox's name) and describe the checkbox. The in-use /
                  // duplicate flag is inside the label, already part of the name.
                  const guessId = r.category_source === "text" ? `${uid}-${key}-guess` : undefined;
                  const readAsId = readAsShown(r, tagOf(key, r)) ? `${uid}-${key}-readas` : undefined;
                  const notUsedId = r.unticked_reason ? `${uid}-${key}-notused` : undefined;
                  const note = notUsedId ? notUsedNote(notUsedKind(r.not_used_text || "") || "not-used", { pickable: ok, picked: on }) : "";
                  const describedBy = [guessId, readAsId, notUsedId].filter(Boolean).join(" ") || undefined;
                  // Descriptors sit right of the label and drop to their own line
                  // when the row is narrow. A lone one is the label's sibling; more
                  // than one are grouped so they wrap together.
                  const several = [guessId, readAsId, notUsedId].filter(Boolean).length > 1;
                  const right = several ? {} : { marginLeft: "auto" };
                  const guess = guessId && (
                    <span id={guessId} title="Category guessed from the row's own words — no printed heading names one" style={{ ...lbl, color: "var(--c-warning)", flex: "0 0 auto", cursor: "help", ...right }}>from description</span>
                  );
                  // The code as read, in the edit button's mono and size, so O and
                  // 0 can be told apart. The title says what was repaired; the
                  // hidden text only adds what to do, since a screen reader has
                  // just read the code out.
                  const repaired = readAsId && `Repaired from ${r.read_as}; check the code against the schedule.`;
                  const readAs = readAsId && (
                    <span id={readAsId} title={repaired} style={{ ...lbl, textTransform: "none", color: "var(--c-warning)", flex: "0 0 auto", cursor: "help", ...right }}>
                      read as <span style={{ fontFamily: "var(--f-mono)", fontSize: 12.5 }}>{r.read_as}</span><span style={S.visuallyHidden}> — check the code against the schedule.</span>
                    </span>
                  );
                  const notUsed = notUsedId && (
                    <span id={notUsedId} title={note.trimStart()} style={{ ...lbl, textTransform: "none", color: "var(--ink)", borderLeft: "2px solid var(--c-warning)", paddingLeft: 4, position: "relative", flex: "0 0 auto", cursor: "help", ...right }}>
                      {r.not_used_text || "NOT USED"}<span style={S.visuallyHidden}>{note}</span>
                    </span>
                  );
                  return (
                    <div key={key} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "5px 14px 5px 26px" }}>
                      <label style={{ flex: "1 1 160px", minWidth: 0, display: "flex", alignItems: "center", gap: 10, cursor: ok ? "pointer" : "default", ...(ok ? {} : { opacity: 0.55 }) }}>
                        <input type="checkbox" checked={on} disabled={!ok} onChange={() => toggle(key)} aria-describedby={describedBy} />
                        <span style={{ width: 12, height: 12, flex: "0 0 auto", background: colorByKey.get(key) || "var(--ink-faint)", border: "1px solid var(--ink-faint)" }} />
                        {isEditing ? (
                          <input
                            autoFocus
                            onFocus={(e) => e.target.select()}   // one-act edit: type straight over the mis-read code
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
                        {flag && <span title={st?.status === "legacy" ? `An earlier import may have removed the parentheses. Check the existing ${st.legacyTag} condition; if it is this finish, rename that condition to ${st.tag} before importing again.` : st?.status === "duplicate" ? "Click the code to rename it." : undefined} style={{ ...lbl, opacity: 0.8 }}>{flag}</span>}
                      </label>
                      {several ? <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>{guess}{readAs}{notUsed}</div> : guess || readAs || notUsed}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* footer */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "10px 14px", borderTop: "1px solid var(--ink-faint)" }}>
          {empty ? (
            // nothing to pick or create: the notice says what wasn't read
            <button autoFocus onClick={onClose} style={{ padding: "7px 12px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12 }}>Close</button>
          ) : (
            <>
              <button onClick={() => pickAll(true)} style={{ padding: "7px 12px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12 }}>Select all</button>
              <button onClick={() => pickAll(false)} style={{ padding: "7px 12px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12, marginRight: "auto" }}>Deselect all</button>
              <button onClick={onClose} style={{ padding: "7px 12px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12 }}>Cancel</button>
              <button onClick={create} disabled={!count}
                style={{ padding: "8px 16px", border: "none", background: count ? "var(--ink)" : "var(--text-faint)", color: "var(--paper-bright)", cursor: count ? "pointer" : "default", fontWeight: 700, fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Create {count} condition{count === 1 ? "" : "s"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
