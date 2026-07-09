// SnapshotPanel — point-in-time copies of the takeoff. Save the current state
// under a label ("Before Addendum 1"), then compare any snapshot against the
// current takeoff (totals delta — "what changed since?"), restore one, or
// delete it. Snapshots live in IndexedDB next to the autosave record
// (store.js) and never leave the device.
import React, { useEffect, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { store, isStaleTabError, STALE_TAB_MESSAGE, friendlyStoreError } from "../lib/store.js";
import { diffSnapshots, SHEET_FIELDS as DIFF_SHEET_FIELDS } from "../lib/snapshotDiff.js";

const num = (v, d = 1) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });

// signed delta cell — zero-gated at DISPLAY precision like ReportPanel's
// sheetNum, but with an explicit sign: +x positive, −x danger, "—" for zero
const delta = (v, d = 1) => {
  const r = Number(v) || 0;
  if (!Math.round(Math.abs(r) * 10 ** d)) return "—";
  if (r < 0) return <span style={{ color: "var(--c-danger)" }}>−{num(-r, d)}</span>;
  return <span style={{ color: "var(--c-positive)" }}>+{num(r, d)}</span>;
};

const errText = (e) => isStaleTabError(e) ? STALE_TAB_MESSAGE : friendlyStoreError(e);

// borrowed from ReportPanel so the compare table reads like the report
const th = { textAlign: "right", padding: "7px 10px", fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)", borderBottom: "1px solid var(--ink)", whiteSpace: "nowrap" };
const td = { textAlign: "right", padding: "8px 10px", fontVariantNumeric: "tabular-nums", borderBottom: "1px solid var(--ink-faint)", whiteSpace: "nowrap" };

const STATUS_TINT = { added: "var(--c-positive)", removed: "var(--c-danger)" };
// [deltas key, column header, display decimals]
const DELTA_COLS = [["floor_sf", "Floor SF Δ", 1], ["wall_sf", "Wall SF Δ", 1], ["border_sf", "Border SF Δ", 1], ["lf", "LF Δ", 1], ["ea", "EA Δ", 0], ["total_sf_net", "SF ordered Δ", 1]];
// by-sheet deltas are base quantities — no waste-adjusted column there.
// The field list comes from snapshotDiff (the single source of what's diffed);
// only display meta lives here. Decimals must match allZero's precision rule
// in snapshotDiff.js (ea → 0 decimals, others → 1) — drift resurrects the
// all-"—" changed-rows bug documented there.
const SHEET_META = { floor_sf: ["floor SF", 1], wall_sf: ["wall SF", 1], border_sf: ["border SF", 1], lf: ["LF", 1], ea: ["EA", 0] };
const SHEET_FIELDS = DIFF_SHEET_FIELDS.map((k) => [k, ...SHEET_META[k]]);

export default function SnapshotPanel({ open, onClose, buildPayload, currentLabel, onLoadSnapshot, sheetLabel }) {
  const [snaps, setSnaps] = useState([]);
  const [label, setLabel] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [cmp, setCmp] = useState(null);   // { label, ts, diff } — active compare view
  const [showUnchanged, setShowUnchanged] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErr(""); setCmp(null); setLabel("");
    store.listSnapshots().then(setSnaps).catch((e) => setErr(errText(e)));
  }, [open]);

  if (!open) return null;

  const save = async () => {
    setErr(""); setSaving(true);
    try {
      const { id, ts } = await store.saveSnapshot(label, buildPayload());
      // prepend locally — the new ts is the max, so the desc order holds
      setSnaps((s) => [{ id, ts, label: label.trim() || null }, ...s]);
      setLabel("");
    } catch (e) { setErr(errText(e)); }
    setSaving(false);
  };

  const compare = async (s) => {
    setErr("");
    try {
      const rec = await store.getSnapshot(s.id);
      if (!rec) { setErr("Snapshot not found — it may have been deleted in another tab."); return; }
      setShowUnchanged(false);
      setCmp({ label: rec.label, ts: rec.ts, diff: diffSnapshots(rec.payload, buildPayload()) });
    } catch (e) { setErr(errText(e)); }
  };

  const load = async (s) => {
    if (!window.confirm("Replace the current takeoff with this snapshot? Save a snapshot of the current state first if you want to keep it.")) return;
    setErr("");
    try {
      const rec = await store.getSnapshot(s.id);
      if (!rec) { setErr("Snapshot not found — it may have been deleted in another tab."); return; }
      onLoadSnapshot(rec.payload);
      onClose();
    } catch (e) { setErr(errText(e)); }
  };

  const del = async (s) => {
    if (!window.confirm(`Delete snapshot "${s.label || "Untitled"}"? This can't be undone.`)) return;
    setErr("");
    try {
      await store.deleteSnapshot(s.id);
      setSnaps((list) => list.filter((x) => x.id !== s.id));
    } catch (e) { setErr(errText(e)); }
  };

  const d = cmp?.diff;
  const unchanged = d ? d.conditions.filter((r) => r.status === "unchanged") : [];
  const shownRows = d ? d.conditions.filter((r) => showUnchanged || r.status !== "unchanged") : [];

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(14,26,46,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: cmp ? 780 : 560, maxWidth: "100%", maxHeight: "90%", overflow: "auto", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--ink)" }}>
          <Icon name="document" size={16} />
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 15 }}>Snapshots</strong>
          {currentLabel && <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{currentLabel}</span>}
        </div>
        <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          {!cmp ? (
            <>
              <div style={{ display: "flex", gap: 8 }}>
                <input name="snapshot-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Before Addendum 1"
                  onKeyDown={(e) => { if (e.key === "Enter" && !saving) save(); }}
                  className="field-input" style={{ flex: 1 }} />
                <button className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save snapshot"}</button>
              </div>
              {err && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--c-danger)", opacity: 0.85 }}>{err}</p>}
              {snaps.length === 0 ? (
                <p style={{ margin: "16px 0 4px", color: "var(--ink-muted)" }}>No snapshots yet — save one before the next addendum lands.</p>
              ) : (
                <div style={{ marginTop: 12 }}>
                  {snaps.map((s) => (
                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--ink-faint)" }}>
                      <strong style={{ fontFamily: "var(--f-mono)", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>{s.label || "Untitled"}</strong>
                      <span style={{ fontSize: 11.5, color: "var(--ink-muted)", whiteSpace: "nowrap" }}>{new Date(s.ts).toLocaleString()}</span>
                      <div style={{ flex: 1 }} />
                      <button className="btn-ghost" onClick={() => compare(s)} title="What changed since this snapshot? Totals delta vs the current takeoff.">Compare</button>
                      <button className="btn-ghost" onClick={() => load(s)} title="Replace the current takeoff with this snapshot">Load</button>
                      <button onClick={() => del(s)} title="Delete this snapshot"
                        style={{ border: "none", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 12, padding: "4px 6px" }}>Delete</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <button onClick={() => setCmp(null)}
                style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 12.5, padding: 0 }}>← snapshots</button>
              <h3 style={{ fontFamily: "var(--f-display)", fontSize: 15, margin: "10px 0 2px" }}>
                {cmp.label || "Untitled"} <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>vs current takeoff</span>
              </h3>
              <div style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, color: "var(--ink-muted)", marginBottom: 10 }}>
                snapshot {new Date(cmp.ts).toLocaleString()} · deltas are current − snapshot
              </div>
              {err && <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--c-danger)", opacity: 0.85 }}>{err}</p>}
              {d.identical ? (
                <p style={{ margin: "12px 0 4px", color: "var(--ink-muted)" }}>No quantity changes — identical takeoff.</p>
              ) : (
                <>
                  <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
                    <thead>
                      <tr>
                        <th style={{ ...th, textAlign: "left" }}>Finish</th>
                        <th style={{ ...th, textAlign: "left" }}>Status</th>
                        {DELTA_COLS.map(([key, header]) => <th key={key} style={th}>{header}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {shownRows.map((r) => (
                        <tr key={r.key}>
                          <td style={{ ...td, textAlign: "left" }}>
                            <strong style={{ fontFamily: "var(--f-mono)", fontWeight: 600 }}>{r.finish_tag}</strong>
                          </td>
                          <td style={{ ...td, textAlign: "left", fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.06em", color: STATUS_TINT[r.status] || "var(--ink-muted)" }}>{r.status}</td>
                          {DELTA_COLS.map(([key, , dec]) => (
                            <td key={key} style={key === "total_sf_net" ? { ...td, fontWeight: 700 } : td}>{delta(r.deltas[key], dec)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {unchanged.length > 0 && (
                    <button onClick={() => setShowUnchanged((v) => !v)}
                      style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11.5, padding: 0, marginTop: 8 }}>
                      {showUnchanged ? "hide unchanged" : `show unchanged (${unchanged.length})`}
                    </button>
                  )}
                  {d.by_sheet.length > 0 && (
                    <div style={{ marginTop: 18 }}>
                      <h3 style={{ fontFamily: "var(--f-display)", fontSize: 13, margin: "0 0 6px" }}>By sheet</h3>
                      {d.by_sheet.map((gp) => (
                        <div key={gp.sheet_id} style={{ margin: "0 0 8px" }}>
                          <div style={{ fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: "0.06em", color: "var(--ink-muted)" }}>{sheetLabel ? sheetLabel(gp.sheet_id) : gp.sheet_id}</div>
                          {gp.rows.filter((r) => r.status !== "unchanged").map((r) => (
                            <div key={r.key} style={{ paddingLeft: 14, fontSize: 12.5 }}>
                              <strong style={{ fontFamily: "var(--f-mono)", fontWeight: 600 }}>{r.finish_tag}</strong>{" "}
                              <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.06em", color: STATUS_TINT[r.status] || "var(--ink-muted)" }}>{r.status}</span>{" "}
                              {SHEET_FIELDS.filter(([key, , dec]) => Math.round(Math.abs(Number(r.deltas[key]) || 0) * 10 ** dec))
                                .map(([key, name, dec], i) => (
                                  <span key={key}>{i > 0 && " · "}{delta(r.deltas[key], dec)} {name}</span>
                                ))}
                            </div>
                          ))}
                        </div>
                      ))}
                      <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.6 }}>
                        sheet deltas are measured (base) quantities — ×N applies at condition level.
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 16px", borderTop: "1px solid var(--ink-faint)" }}>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
