import { finishLabel, localizeText as uiText } from "../lib/i18n/core.js";
// RevisionsPanel — save the takeoff as a named revision, then compare any two
// (or a revision against the live takeoff) as quantity deltas: per condition,
// per sheet, and on the supporting-materials buy list. Addendum lands → save
// "Addendum 2", retrace what moved, and the compare reads out exactly which
// finishes and sheets changed and by how much. Restore is guarded: restoring
// auto-banks the live takeoff first, so it is never destructive.
//
// Persistence rides the snapshot entry points (store.saveSnapshot/
// listSnapshots/getSnapshot/deleteSnapshot) — the store's one primitive for
// point-in-time payloads — so revisions inherit per-project scoping in cloud
// mode and the snapshot-sync layer for free. This panel is the single review
// surface over those records (the old Snapshots modal is retired).
import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { store, isStaleTabError, STALE_TAB_MESSAGE, friendlyStoreError } from "../lib/store.js";
import { diffTakeoffs, diffToCsv, revSheetLabel } from "../lib/revisions.js";
import { downloadText } from "../lib/totals.js";
import { areaVal, areaUnit, lenVal, lenUnit } from "../lib/units";

const num = (v, d = 1) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });
const STATUS_COLOR = { added: "var(--c-positive)", removed: "var(--c-danger)", changed: "var(--c-warning)", unchanged: "var(--ink-muted)" };
const errText = (e) => (isStaleTabError(e) ? STALE_TAB_MESSAGE : friendlyStoreError(e));

export default function RevisionsPanel({ current, units = "imperial", onRestore, onClose }) {
  const [revs, setRevs] = useState(null);          // null = loading
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [baseId, setBaseId] = useState("");        // revision id
  const [compareId, setCompareId] = useState("current");
  const [payloads, setPayloads] = useState({});    // id -> revision payload
  const [confirmId, setConfirmId] = useState("");  // two-step delete/restore: "del:<id>" | "restore:<id>"
  const [showUnchanged, setShowUnchanged] = useState(false);

  // snapshot metadata → the panel's row shape (label/ts → name/created_at);
  // listSnapshots already sorts newest-first and scopes to this project
  const refresh = () => store.listSnapshots()
    .then((list) => setRevs(list.map((s) => ({ id: s.id, name: s.label || "Untitled", created_at: s.ts, conditions: s.conditions ?? 0, shapes: s.shapes ?? 0 }))))
    .catch((e) => setErr(errText(e)));
  useEffect(() => { refresh(); }, []);
  // default the baseline to the newest revision once the list is in
  useEffect(() => { if (revs?.length && !baseId) setBaseId(revs[0].id); }, [revs]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the two-step confirm decays back to the safe state on its own
  useEffect(() => {
    if (!confirmId) return;
    const t = setTimeout(() => setConfirmId(""), 4000);
    return () => clearTimeout(t);
  }, [confirmId]);

  // load the selected revisions' payloads (cached by id for the panel's life)
  useEffect(() => {
    for (const id of [baseId, compareId]) {
      if (!id || id === "current" || payloads[id]) continue;
      store.getSnapshot(id)
        .then((rec) => {
          if (!rec) { setErr("Revision not found — it may have been deleted in another tab."); return; }
          setPayloads((p) => ({ ...p, [id]: rec.payload || {} }));
        })
        .catch((e) => setErr(errText(e)));
    }
  }, [baseId, compareId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const sideA = baseId && baseId !== "current" ? payloads[baseId] : baseId === "current" ? current : null;
  const sideB = compareId === "current" ? current : payloads[compareId];
  const diff = useMemo(() => (sideA && sideB ? diffTakeoffs(sideA, sideB) : null), [sideA, sideB]);

  const nameOf = (id) => (id === "current" ? "Current takeoff" : revs?.find((r) => r.id === id)?.name || "Revision");
  const defaultName = () => `Rev ${(revs?.length || 0) + 1} — ${new Date().toLocaleDateString()}`;

  const save = async (name) => {
    setBusy(true); setErr("");
    try { await store.saveSnapshot((name || "").trim() || defaultName(), current); setSaveName(""); await refresh(); }
    catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  const del = async (id) => {
    setBusy(true); setErr("");
    try {
      await store.deleteSnapshot(id);
      if (baseId === id) setBaseId("");
      if (compareId === id) setCompareId("current");
      await refresh();
    } catch (e) { setErr(errText(e)); }
    setBusy(false); setConfirmId("");
  };
  const restore = async (id) => {
    setBusy(true); setErr("");
    try {
      // bank the live takeoff first — restore must never be a one-way door
      await store.saveSnapshot(`Auto-backup before restore — ${new Date().toLocaleString()}`, current);
      const rec = await store.getSnapshot(id);
      if (!rec) { setErr("Revision not found — it may have been deleted in another tab."); setBusy(false); setConfirmId(""); return; }
      onRestore(rec.payload || {});
      await refresh();
    } catch (e) { setErr(errText(e)); }
    setBusy(false); setConfirmId("");
  };

  const exportCsv = () => {
    if (!diff) return;
    const base = (current.project_name || "takeoff").replace(/[^\w.-]+/g, "_");
    downloadText(`${base}_compare.csv`, diffToCsv(diff, { aName: nameOf(baseId), bName: nameOf(compareId), units, projectName: current.project_name || "" }), "text/csv");
  };

  const AU = areaUnit(units), LU = lenUnit(units);
  const av = (sf) => areaVal(sf, units), lv = (lf) => lenVal(lf, units);
  const th = { textAlign: "right", padding: "7px 10px", fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)", borderBottom: "1px solid var(--ink)", whiteSpace: "nowrap" };
  const td = { textAlign: "right", padding: "8px 10px", fontVariantNumeric: "tabular-nums", borderBottom: "1px solid var(--ink-faint)", whiteSpace: "nowrap" };
  // deltas render signed and zero-gate at display precision — the same 0.05/0.5
  // thresholds the diff's own "changed" judgment uses, so a "changed" row always
  // shows at least one visible number
  const delta = (v, isEa = false, convert = (x) => x) => {
    if (Math.abs(v) < (isEa ? 0.5 : 0.05)) return <span style={{ color: "var(--ink-muted)" }}>—</span>;
    const shown = convert(v);
    return <span style={{ fontWeight: 700, color: v > 0 ? "var(--cobalt)" : "var(--c-danger)" }}>{uiText(v > 0 ? "+" : "−")}{uiText(num(Math.abs(shown), isEa ? 0 : 1))}</span>;
  };
  const chip = (status) => (
    <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: STATUS_COLOR[status] || "var(--ink)", fontWeight: 700 }}>{uiText(status)}</span>
  );

  const condRows = diff ? diff.conditions.filter((c) => showUnchanged || c.status !== "unchanged") : [];
  const sheetRows = diff ? diff.sheets.filter((s) => showUnchanged || s.status !== "unchanged") : [];
  const matRows = diff ? diff.materials.filter((m) => showUnchanged || m.status !== "unchanged") : [];
  const identical = diff && diff.changed === 0 && diff.sheets.every((s) => s.status === "unchanged");

  const sel = { padding: "5px 8px", fontSize: 12.5, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", color: "var(--ink)", maxWidth: 240 };

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", background: "var(--paper-cream)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: "1px solid var(--ink)", background: "var(--paper-bright)" }}>
        <Icon name="revisions" size={18} />
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)" }}>{uiText("Revisions")}</strong>
        <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{uiText("save the takeoff at each bid revision, then compare what moved")}</span>
        <div style={{ flex: 1 }} />
        <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={uiText(defaultName())}
          className="field-input" style={{ width: 220, padding: "5px 9px", fontSize: 13 }}
          onKeyDown={(e) => { if (e.key === "Enter") save(saveName); }} name="revision-name" />
        <button className="btn-primary" onClick={() => save(saveName)} disabled={busy}
          title={uiText("Snapshot the current takeoff (conditions, shapes, markups) as a named revision")}>
          <Icon name="revisions" size={13} />{uiText("Save revision")}</button>
        <button onClick={onClose} title={uiText("Back to the canvas")}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12.5 }}>
          <Icon name="close" size={12} />{uiText("Close")}</button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>
        {err && <p style={{ maxWidth: 980, margin: "0 auto 12px", color: "var(--c-danger)", fontSize: 12.5 }}>{uiText(err)}</p>}

        {/* saved revisions */}
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          {revs === null ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--ink-muted)" }}>{uiText("Loading revisions…")}</div>
          ) : revs.length === 0 ? (
            <div style={{ padding: "28px 24px", textAlign: "center", color: "var(--ink-muted)", border: "1px dashed var(--ink-faint)", background: "var(--paper-bright)" }}>
              {uiText("No revisions yet. Save one now, and after the next addendum lands you can compare exactly which quantities moved.")}</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
              <thead><tr>
                <th style={{ ...th, textAlign: "left" }}>{uiText("Revision")}</th>
                <th style={th}>{uiText("Saved")}</th>
                <th style={th}>{uiText("Conditions")}</th>
                <th style={th}>{uiText("Shapes")}</th>
                <th style={{ ...th, textAlign: "left", paddingLeft: 18 }}>{uiText("Actions")}</th>
              </tr></thead>
              <tbody>
                {revs.map((r) => (
                  <tr key={r.id}>
                    <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{r.name}</td>
                    <td style={{ ...td, color: "var(--ink-muted)" }}>{uiText(r.created_at ? new Date(r.created_at).toLocaleString() : "—")}</td>
                    <td style={td}>{uiText(r.conditions)}</td>
                    <td style={td}>{uiText(r.shapes)}</td>
                    <td style={{ ...td, textAlign: "left", paddingLeft: 18 }}>
                      <button className="btn-ghost" style={{ fontSize: 11.5, padding: "3px 8px" }}
                        onClick={() => { setBaseId(r.id); setCompareId("current"); }}
                        title={uiText("Diff this revision against the live takeoff")}>{uiText("Compare with current")}</button>{uiText(" ")}
                      <button className="btn-ghost" style={{ fontSize: 11.5, padding: "3px 8px", color: confirmId === `restore:${r.id}` ? "var(--c-warning)" : undefined }}
                        onClick={() => (confirmId === `restore:${r.id}` ? restore(r.id) : setConfirmId(`restore:${r.id}`))} disabled={busy}
                        title={uiText("Replace the live takeoff with this revision — the live takeoff is auto-backed-up first")}>
                        {uiText(confirmId === `restore:${r.id}` ? "Really restore? (auto-backup saved)" : "Restore")}</button>{uiText(" ")}
                      <button className="btn-ghost" style={{ fontSize: 11.5, padding: "3px 8px", color: confirmId === `del:${r.id}` ? "var(--c-danger)" : undefined }}
                        onClick={() => (confirmId === `del:${r.id}` ? del(r.id) : setConfirmId(`del:${r.id}`))} disabled={busy}>
                        {uiText(confirmId === `del:${r.id}` ? "Really delete?" : "Delete")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* compare picker + results */}
        {revs?.length > 0 && (
          <div style={{ maxWidth: 980, margin: "26px auto 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h3 style={{ fontFamily: "var(--f-display)", fontSize: 14, color: "var(--ink)", margin: 0 }}>{uiText("Compare")}</h3>
              <select value={baseId} onChange={(e) => setBaseId(e.target.value)} style={sel} name="compare-baseline">
                <option value="" disabled>{uiText("baseline…")}</option>
                {revs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <span style={{ color: "var(--ink-muted)" }}>→</span>
              <select value={compareId} onChange={(e) => setCompareId(e.target.value)} style={sel} name="compare-to">
                <option value="current">{uiText("Current takeoff")}</option>
                {revs.filter((r) => r.id !== baseId).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <div style={{ flex: 1 }} />
              <label style={{ fontSize: 12, color: "var(--ink-muted)", display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} name="show-unchanged" />{uiText("show unchanged")}</label>
              <button className="btn-ghost" onClick={exportCsv} disabled={!diff}><Icon name="document" size={13} />{uiText("Export compare CSV")}</button>
            </div>

            {!diff ? (
              <p style={{ marginTop: 14, color: "var(--ink-muted)", fontSize: 12.5 }}>{uiText("Pick a baseline revision to diff.")}</p>
            ) : identical ? (
              <p style={{ marginTop: 14, color: "var(--c-positive)", fontSize: 13, fontWeight: 600 }}>
                {uiText("Identical takeoffs — no visible quantity change between “")}{nameOf(baseId)}{uiText("” and “")}{nameOf(compareId)}”.
              </p>
            ) : (
              <>
                {/* headline: the ordered-quantity move */}
                <p style={{ margin: "14px 0 10px", fontSize: 13, color: "var(--ink)" }}>
                  <strong>{nameOf(baseId)}</strong> → <strong>{nameOf(compareId)}</strong>:{uiText(" ")}
                  {uiText("ordered ")}{uiText(AU)} {uiText(num(av(diff.totals.a.total_sf_net)))} → <strong>{uiText(num(av(diff.totals.b.total_sf_net)))}</strong>{uiText(" ")}
                  ({uiText(delta(diff.totals.deltas.total_sf_net, false, av))}) · {uiText(diff.changed)} {uiText("condition")}{uiText(diff.changed === 1 ? "" : "s")} {uiText("moved")}</p>
                <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign: "left" }}>{uiText("Finish")}</th>
                    <th style={{ ...th, textAlign: "left" }}>{uiText("Status")}</th>
                    <th style={th}>{uiText("Δ Floor ")}{uiText(AU)}</th>
                    <th style={th}>{uiText("Δ Wall ")}{uiText(AU)}</th>
                    <th style={th}>{uiText("Δ Border ")}{uiText(AU)}</th>
                    <th style={th}>Δ {uiText(LU)}</th>
                    <th style={th}>{uiText("Δ EA")}</th>
                    <th style={{ ...th, color: "var(--cobalt)" }}>{uiText(AU)} {uiText("ordered")}</th>
                  </tr></thead>
                  <tbody>
                    {condRows.map((c) => (
                      <tr key={c.key}>
                        <td style={{ ...td, textAlign: "left" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <span style={{ width: 12, height: 12, background: c.color, display: "inline-block", border: "1px solid var(--ink-faint)" }} />
                            <strong style={{ fontFamily: "var(--f-mono)", fontWeight: 600 }}>{finishLabel(c.finish_tag)}</strong>
                          </span>
                        </td>
                        <td style={{ ...td, textAlign: "left" }}>{uiText(chip(c.status))}</td>
                        <td style={td}>{uiText(delta(c.deltas.floor_sf, false, av))}</td>
                        <td style={td}>{uiText(delta(c.deltas.wall_sf, false, av))}</td>
                        <td style={td}>{uiText(delta(c.deltas.border_sf, false, av))}</td>
                        <td style={td}>{uiText(delta(c.deltas.lf, false, lv))}</td>
                        <td style={td}>{uiText(delta(c.deltas.ea, true))}</td>
                        <td style={{ ...td, color: "var(--cobalt)" }}>
                          {uiText(c.a ? num(av(c.a.total_sf_net)) : "·")} → <strong>{uiText(c.b ? num(av(c.b.total_sf_net)) : "·")}</strong>
                        </td>
                      </tr>
                    ))}
                    {!condRows.length && <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: "var(--ink-muted)" }}>{uiText("Only unchanged conditions — tick “show unchanged” to list them.")}</td></tr>}
                  </tbody>
                </table>

                {sheetRows.length > 0 && (
                  <>
                    <h3 style={{ fontFamily: "var(--f-display)", fontSize: 14, color: "var(--ink)", margin: "22px 0 8px" }}>{uiText("By sheet")}</h3>
                    <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
                      <thead><tr>
                        <th style={{ ...th, textAlign: "left" }}>{uiText("Sheet")}</th>
                        <th style={{ ...th, textAlign: "left" }}>{uiText("Status")}</th>
                        <th style={th}>{uiText("Δ Floor ")}{uiText(AU)}</th>
                        <th style={th}>{uiText("Δ Wall ")}{uiText(AU)}</th>
                        <th style={th}>{uiText("Δ Border ")}{uiText(AU)}</th>
                        <th style={th}>Δ {uiText(LU)}</th>
                        <th style={th}>{uiText("Δ EA")}</th>
                      </tr></thead>
                      <tbody>
                        {sheetRows.map((s) => (
                          <tr key={s.sheet_id}>
                            <td style={{ ...td, textAlign: "left", fontFamily: "var(--f-mono)" }}>{revSheetLabel(s.sheet_id)}</td>
                            <td style={{ ...td, textAlign: "left" }}>{uiText(chip(s.status))}</td>
                            <td style={td}>{uiText(delta(s.deltas.floor_sf, false, av))}</td>
                            <td style={td}>{uiText(delta(s.deltas.wall_sf, false, av))}</td>
                            <td style={td}>{uiText(delta(s.deltas.border_sf, false, av))}</td>
                            <td style={td}>{uiText(delta(s.deltas.lf, false, lv))}</td>
                            <td style={td}>{uiText(delta(s.deltas.ea, true))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--ink-muted)" }}>{uiText("Base measured quantities per sheet — multiplier and waste apply at condition level.")}</p>
                  </>
                )}

                {matRows.length > 0 && (
                  <>
                    <h3 style={{ fontFamily: "var(--f-display)", fontSize: 14, color: "var(--ink)", margin: "22px 0 8px" }}>{uiText("Buy list")}</h3>
                    <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
                      <thead><tr>
                        <th style={{ ...th, textAlign: "left" }}>{uiText("Material")}</th>
                        <th style={{ ...th, textAlign: "left" }}>{uiText("Status")}</th>
                        <th style={th}>{uiText("Qty (")}{nameOf(baseId)})</th>
                        <th style={th}>{uiText("Qty (")}{nameOf(compareId)})</th>
                        <th style={th}>Δ</th>
                        <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>{uiText("Unit")}</th>
                      </tr></thead>
                      <tbody>
                        {matRows.map((m, i) => (
                          <tr key={i}>
                            <td style={{ ...td, textAlign: "left" }}>{m.name}</td>
                            <td style={{ ...td, textAlign: "left" }}>{uiText(chip(m.status))}</td>
                            <td style={td}>{uiText(num(m.a_qty, 2))}</td>
                            <td style={{ ...td, fontWeight: 700 }}>{uiText(num(m.b_qty, 2))}</td>
                            <td style={td}>{uiText(delta(m.delta))}</td>
                            <td style={{ ...td, textAlign: "left", paddingLeft: 16, color: "var(--ink-muted)" }}>{uiText(m.unit || "—")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
