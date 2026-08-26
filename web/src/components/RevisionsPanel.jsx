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
import { useTranslation } from "react-i18next";
import { Icon } from "../brand/icons.jsx";
import { store, isStaleTabError, friendlyStoreError, staleTabMessage } from "../lib/store.js";
import { diffTakeoffs, diffToCsv, revSheetLabel } from "../lib/revisions.js";
import { downloadText } from "../lib/totals.js";
import { areaVal, areaUnit, lenVal, lenUnit } from "../lib/units";

const num = (v, d = 1) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });
const STATUS_COLOR = { added: "var(--c-positive)", removed: "var(--c-danger)", changed: "var(--c-warning)", unchanged: "var(--ink-muted)" };
const errText = (e) => (isStaleTabError(e) ? staleTabMessage() : friendlyStoreError(e));
export default function RevisionsPanel({ current, units = "imperial", onRestore, onClose }) {
  const { t } = useTranslation("panels");
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
    .then((list) => setRevs(list.map((s) => ({ id: s.id, name: s.label || t("revisions.untitled"), created_at: s.ts, conditions: s.conditions ?? 0, shapes: s.shapes ?? 0 }))))
    .catch((e) => setErr(errText(e)));
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
          if (!rec) { setErr(t('revisions.not_found')); return; }
          setPayloads((p) => ({ ...p, [id]: rec.payload || {} }));
        })
        .catch((e) => setErr(errText(e)));
    }
  }, [baseId, compareId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const sideA = baseId && baseId !== "current" ? payloads[baseId] : baseId === "current" ? current : null;
  const sideB = compareId === "current" ? current : payloads[compareId];
  const diff = useMemo(() => (sideA && sideB ? diffTakeoffs(sideA, sideB) : null), [sideA, sideB]);

  const nameOf = (id) => (id === "current" ? t('revisions.current_takeoff') : revs?.find((r) => r.id === id)?.name || "Revision");
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
      await store.saveSnapshot(t('revisions.auto_backup_label', { date: new Date().toLocaleString() }), current);
      const rec = await store.getSnapshot(id);
      if (!rec) { setErr(t('revisions.not_found')); setBusy(false); setConfirmId(""); return; }
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
    return <span style={{ fontWeight: 700, color: v > 0 ? "var(--cobalt)" : "var(--c-danger)" }}>{v > 0 ? "+" : "−"}{num(Math.abs(shown), isEa ? 0 : 1)}</span>;
  };
  const chip = (status) => (
    <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: STATUS_COLOR[status] || "var(--ink)", fontWeight: 700 }}>{status}</span>
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
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)" }}>{t('revisions.title')}</strong>
        <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t('revisions.subtitle')}</span>
        <div style={{ flex: 1 }} />
        <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={defaultName()}
          className="field-input" style={{ width: 220, padding: "5px 9px", fontSize: 13 }}
          onKeyDown={(e) => { if (e.key === "Enter") save(saveName); }} name="revision-name" />
        <button className="btn-primary" onClick={() => save(saveName)} disabled={busy}
          title={t('revisions.save_title')}>
          <Icon name="revisions" size={13} />{t('revisions.save')}
        </button>
        <button onClick={onClose} title={t('revisions.close_title')}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12.5 }}>
          <Icon name="close" size={12} />{t('revisions.close')}
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>
        {err && <p style={{ maxWidth: 980, margin: "0 auto 12px", color: "var(--c-danger)", fontSize: 12.5 }}>{err}</p>}

        {/* saved revisions */}
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          {revs === null ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--ink-muted)" }}>{t('revisions.loading')}</div>
          ) : revs.length === 0 ? (
            <div style={{ padding: "28px 24px", textAlign: "center", color: "var(--ink-muted)", border: "1px dashed var(--ink-faint)", background: "var(--paper-bright)" }}>
              {t('revisions.empty')}
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
              <thead><tr>
                <th style={{ ...th, textAlign: "left" }}>{t('revisions.table_revision')}</th>
                <th style={th}>{t('revisions.table_saved')}</th>
                <th style={th}>{t('revisions.table_conditions')}</th>
                <th style={th}>{t('revisions.table_shapes')}</th>
                <th style={{ ...th, textAlign: "left", paddingLeft: 18 }}>{t('revisions.table_actions')}</th>
              </tr></thead>
              <tbody>
                {revs.map((r) => (
                  <tr key={r.id}>
                    <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{r.name}</td>
                    <td style={{ ...td, color: "var(--ink-muted)" }}>{r.created_at ? new Date(r.created_at).toLocaleString() : "—"}</td>
                    <td style={td}>{r.conditions}</td>
                    <td style={td}>{r.shapes}</td>
                    <td style={{ ...td, textAlign: "left", paddingLeft: 18 }}>
                      <button className="btn-ghost" style={{ fontSize: 11.5, padding: "3px 8px" }}
                        onClick={() => { setBaseId(r.id); setCompareId("current"); }}
                        title={t('revisions.compare_current_title')}>{t('revisions.compare_current')}</button>{" "}
                      <button className="btn-ghost" style={{ fontSize: 11.5, padding: "3px 8px", color: confirmId === `restore:${r.id}` ? "var(--c-warning)" : undefined }}
                        onClick={() => (confirmId === `restore:${r.id}` ? restore(r.id) : setConfirmId(`restore:${r.id}`))} disabled={busy}
                        title={t('revisions.restore_title')}>
                        {confirmId === `restore:${r.id}` ? t('revisions.restore_confirm') : t('revisions.restore')}</button>{" "}
                      <button className="btn-ghost" style={{ fontSize: 11.5, padding: "3px 8px", color: confirmId === `del:${r.id}` ? "var(--c-danger)" : undefined }}
                        onClick={() => (confirmId === `del:${r.id}` ? del(r.id) : setConfirmId(`del:${r.id}`))} disabled={busy}>
                        {confirmId === `del:${r.id}` ? t('revisions.delete_confirm') : t('revisions.delete')}</button>
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
              <h3 style={{ fontFamily: "var(--f-display)", fontSize: 14, color: "var(--ink)", margin: 0 }}>{t('revisions.compare_heading')}</h3>
              <select value={baseId} onChange={(e) => setBaseId(e.target.value)} style={sel} name="compare-baseline">
                <option value="" disabled>{t('revisions.baseline_placeholder')}</option>
                {revs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <span style={{ color: "var(--ink-muted)" }}>→</span>
              <select value={compareId} onChange={(e) => setCompareId(e.target.value)} style={sel} name="compare-to">
                <option value="current">{t('revisions.current_takeoff')}</option>
                {revs.filter((r) => r.id !== baseId).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <div style={{ flex: 1 }} />
              <label style={{ fontSize: 12, color: "var(--ink-muted)", display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} name="show-unchanged" />{t('revisions.show_unchanged')}
              </label>
              <button className="btn-ghost" onClick={exportCsv} disabled={!diff}><Icon name="document" size={13} />{t('revisions.export_csv')}</button>
            </div>

            {!diff ? (
              <p style={{ marginTop: 14, color: "var(--ink-muted)", fontSize: 12.5 }}>{t('revisions.pick_baseline')}</p>
            ) : identical ? (
              <p style={{ marginTop: 14, color: "var(--c-positive)", fontSize: 13, fontWeight: 600 }}>
                {t('revisions.identical', { a: nameOf(baseId), b: nameOf(compareId) })}
              </p>
            ) : (
              <>
                {/* headline: the ordered-quantity move */}
                <p style={{ margin: "14px 0 10px", fontSize: 13, color: "var(--ink)" }}>
                  <strong>{nameOf(baseId)}</strong> → <strong>{nameOf(compareId)}</strong>:{" "}
                  ordered {AU} {num(av(diff.totals.a.total_sf_net))} → <strong>{num(av(diff.totals.b.total_sf_net))}</strong>{" "}
                  ({delta(diff.totals.deltas.total_sf_net, false, av)}) · {diff.changed} condition{diff.changed === 1 ? "" : "s"} moved
                </p>
                <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign: "left" }}>{t('revisions.table_finish')}</th>
                    <th style={{ ...th, textAlign: "left" }}>{t('revisions.table_status')}</th>
                    <th style={th}>{t('revisions.table_floor', { unit: AU })}</th>
                    <th style={th}>{t('revisions.table_wall', { unit: AU })}</th>
                    <th style={th}>{t('revisions.table_border', { unit: AU })}</th>
                    <th style={th}>{t('revisions.table_lf', { unit: LU })}</th>
                    <th style={th}>{t('revisions.table_ea')}</th>
                    <th style={{ ...th, color: "var(--cobalt)" }}>{t('revisions.table_ordered', { unit: AU })}</th>
                  </tr></thead>
                  <tbody>
                    {condRows.map((c) => (
                      <tr key={c.key}>
                        <td style={{ ...td, textAlign: "left" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <span style={{ width: 12, height: 12, background: c.color, display: "inline-block", border: "1px solid var(--ink-faint)" }} />
                            <strong style={{ fontFamily: "var(--f-mono)", fontWeight: 600 }}>{c.finish_tag}</strong>
                          </span>
                        </td>
                        <td style={{ ...td, textAlign: "left" }}>{chip(c.status)}</td>
                        <td style={td}>{delta(c.deltas.floor_sf, false, av)}</td>
                        <td style={td}>{delta(c.deltas.wall_sf, false, av)}</td>
                        <td style={td}>{delta(c.deltas.border_sf, false, av)}</td>
                        <td style={td}>{delta(c.deltas.lf, false, lv)}</td>
                        <td style={td}>{delta(c.deltas.ea, true)}</td>
                        <td style={{ ...td, color: "var(--cobalt)" }}>
                          {c.a ? num(av(c.a.total_sf_net)) : "·"} → <strong>{c.b ? num(av(c.b.total_sf_net)) : "·"}</strong>
                        </td>
                      </tr>
                    ))}
                    {!condRows.length && <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: "var(--ink-muted)" }}>{t('revisions.only_unchanged')}</td></tr>}
                  </tbody>
                </table>

                {sheetRows.length > 0 && (
                  <>
                    <h3 style={{ fontFamily: "var(--f-display)", fontSize: 14, color: "var(--ink)", margin: "22px 0 8px" }}>{t('revisions.by_sheet')}</h3>
                    <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
                      <thead><tr>
                        <th style={{ ...th, textAlign: "left" }}>{t('revisions.table_finish')}</th>
                        <th style={{ ...th, textAlign: "left" }}>{t('revisions.table_status')}</th>
                        <th style={th}>{t('revisions.table_floor', { unit: AU })}</th>
                        <th style={th}>{t('revisions.table_wall', { unit: AU })}</th>
                        <th style={th}>{t('revisions.table_border', { unit: AU })}</th>
                        <th style={th}>{t('revisions.table_lf', { unit: LU })}</th>
                        <th style={th}>{t('revisions.table_ea')}</th>
                      </tr></thead>
                      <tbody>
                        {sheetRows.map((s) => (
                          <tr key={s.sheet_id}>
                            <td style={{ ...td, textAlign: "left", fontFamily: "var(--f-mono)" }}>{revSheetLabel(s.sheet_id)}</td>
                            <td style={{ ...td, textAlign: "left" }}>{chip(s.status)}</td>
                            <td style={td}>{delta(s.deltas.floor_sf, false, av)}</td>
                            <td style={td}>{delta(s.deltas.wall_sf, false, av)}</td>
                            <td style={td}>{delta(s.deltas.border_sf, false, av)}</td>
                            <td style={td}>{delta(s.deltas.lf, false, lv)}</td>
                            <td style={td}>{delta(s.deltas.ea, true)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--ink-muted)" }}>{t('revisions.sheet_base_note')}</p>
                  </>
                )}

                {matRows.length > 0 && (
                  <>
                    <h3 style={{ fontFamily: "var(--f-display)", fontSize: 14, color: "var(--ink)", margin: "22px 0 8px" }}>{t('revisions.buy_list')}</h3>
                    <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
                      <thead><tr>
                        <th style={{ ...th, textAlign: "left" }}>{t('revisions.table_material')}</th>
                        <th style={{ ...th, textAlign: "left" }}>{t('revisions.table_status')}</th>
                        <th style={th}>{t('revisions.table_qty', { name: nameOf(baseId) })}</th>
                        <th style={th}>{t('revisions.table_qty', { name: nameOf(compareId) })}</th>
                        <th style={th}>{t('revisions.table_delta')}</th>
                        <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>{t('revisions.table_unit')}</th>
                      </tr></thead>
                      <tbody>
                        {matRows.map((m, i) => (
                          <tr key={i}>
                            <td style={{ ...td, textAlign: "left" }}>{m.name}</td>
                            <td style={{ ...td, textAlign: "left" }}>{chip(m.status)}</td>
                            <td style={td}>{num(m.a_qty, 2)}</td>
                            <td style={{ ...td, fontWeight: 700 }}>{num(m.b_qty, 2)}</td>
                            <td style={td}>{delta(m.delta)}</td>
                            <td style={{ ...td, textAlign: "left", paddingLeft: 16, color: "var(--ink-muted)" }}>{m.unit || "—"}</td>
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
