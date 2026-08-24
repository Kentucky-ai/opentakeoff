// RfiPanel — the RFI register (Request For Information). A docked, project-global
// panel (unlike the sheet-scoped markup panel): every RFI with number, subject,
// status chip, and linked-markup count; filter by status; edit every field;
// close / void / delete; and fly to a linked markup on any sheet.
//
// State lives in the PARENT (TakeoffCanvas) — this view holds only local filter
// state. The status→response_date auto-stamp is the parent's job (onUpdateRfi),
// so the view never computes a date. Contract:
//   <RfiPanel rfis markups onUpdateRfi(id,patch) onDeleteRfi(id) onFlyTo(markup)
//             sheetLabel={tabLabel} onClose />
import React, { useMemo, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { getRfiStatuses, rfiStatus, linkedMarkups } from "../lib/rfi.js";
import { useTranslation } from "react-i18next";

const PRIORITIES = ["low", "normal", "high"];

export default function RfiPanel({ docked = false, rfis = [], markups = [], onUpdateRfi, onDeleteRfi, onFlyTo, sheetLabel, onClose }) {
  const { t } = useTranslation("panels");
  const rfiStatuses = getRfiStatuses();
  const [filter, setFilter] = useState("all");
  const shown = useMemo(
    () => (filter === "all" ? rfis : rfis.filter((r) => rfiStatus(r.status).id === filter)),
    [rfis, filter],
  );

  const field = { width: "100%", padding: "4px 6px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 12, boxSizing: "border-box" };
  const lbl = { fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-muted)", display: "block", marginBottom: 2 };
  const up = (r, patch) => onUpdateRfi && onUpdateRfi(r.id, patch);

  const chip = (id, label) => {
    const on = filter === id;
    return (
      <button key={id} onClick={() => setFilter(id)}
        style={{ padding: "2px 8px", border: `1px solid ${on ? "var(--cobalt)" : "var(--ink-faint)"}`, background: on ? "var(--cobalt)" : "transparent", color: on ? "var(--accent-contrast)" : "var(--ink)", cursor: "pointer", fontSize: 11 }}>
        {label}
      </button>
    );
  };

  const outer = docked
    ? { display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "auto", background: "var(--paper-bright)", fontSize: 12.5 }
    : { position: "absolute", left: 14, top: 14, width: 372, maxHeight: "calc(100% - 28px)", overflow: "auto", background: "var(--paper-bright)", border: "1px solid var(--cobalt)", boxShadow: "var(--shadow-pop)", zIndex: 9, fontSize: 12.5 };

  return (
    <div style={outer}>
      {!docked && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)", background: "var(--cobalt)", color: "var(--accent-contrast)" }}>
          <strong style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Icon name="rfi" size={15} />{t("rfi.title", { count: rfis.length })}</strong>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--accent-contrast)", fontSize: 16, cursor: "pointer" }}>×</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", padding: "8px 10px", borderBottom: "1px solid var(--ink-faint)" }}>
        {chip("all", t("rfi.all_filter", { count: rfis.length }))}
        {rfiStatuses.map((s) => chip(s.id, `${s.label} ${rfis.filter((r) => rfiStatus(r.status).id === s.id).length}`))}
      </div>

      {rfis.length === 0 && (
        <div style={{ padding: "14px 12px", color: "var(--ink-muted)" }}
          dangerouslySetInnerHTML={{ __html: t("rfi.empty") }} />
      )}
      {rfis.length > 0 && shown.length === 0 && (
        <div style={{ padding: "14px 12px", color: "var(--ink-muted)" }}>{t("rfi.empty_filter")}</div>
      )}

      {shown.map((r) => {
        const st = rfiStatus(r.status);
        const linked = linkedMarkups(r, markups);
        return (
          <div key={r.id} style={{ padding: "10px 12px", borderTop: "1px solid var(--ink-faint)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
              <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, color: "var(--cobalt)" }}>{String(r.number ?? "")}</span>
              <span style={{ padding: "1px 7px", background: st.color, color: "#fff", fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>{st.label}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>{t("rfi.linked_count", { count: linked.length })}</span>
              <button onClick={() => { if (window.confirm(t("rfi.delete_confirm", { number: r.number }))) onDeleteRfi && onDeleteRfi(r.id); }}
                title={t("rfi.delete_title")} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--c-danger)" }}>🗑</button>
            </div>

            <label style={lbl}>{t("rfi.field_subject")}</label>
            <input name="rfi-subject" value={r.subject || ""} onChange={(e) => up(r, { subject: e.target.value })} placeholder={t("rfi.placeholder_subject")} style={{ ...field, marginBottom: 6 }} />

            <label style={lbl}>{t("rfi.field_question")}</label>
            <textarea name="rfi-question" value={r.question || ""} onChange={(e) => up(r, { question: e.target.value })} rows={2} placeholder={t("rfi.placeholder_question")} style={{ ...field, marginBottom: 6, resize: "vertical" }} />

            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>{t("rfi.field_status")}</label>
                <select name="rfi-status" value={st.id} onChange={(e) => up(r, { status: e.target.value })} style={field}>
                  {rfiStatuses.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>{t("rfi.field_priority")}</label>
                <select name="rfi-priority" value={r.priority || "normal"} onChange={(e) => up(r, { priority: e.target.value })} style={field}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>{t("rfi.field_ball_in_court")}</label>
                <input name="rfi-to" value={r.to || ""} onChange={(e) => up(r, { to: e.target.value })} placeholder={t("rfi.placeholder_ball")} style={field} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>{t("rfi.field_opened")}</label>
                <input name="rfi-date" value={r.date || ""} onChange={(e) => up(r, { date: e.target.value })} placeholder={t("rfi.placeholder_date")} style={field} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 6 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11.5 }}>
                <input name="rfi-cost-impact" type="checkbox" checked={!!r.cost_impact} onChange={(e) => up(r, { cost_impact: e.target.checked })} />{t("rfi.cost_impact")}
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11.5 }}>
                <input name="rfi-schedule-impact" type="checkbox" checked={!!r.schedule_impact} onChange={(e) => up(r, { schedule_impact: e.target.checked })} />{t("rfi.schedule_impact")}
              </label>
            </div>

            <label style={lbl}>{t("rfi.field_response")}</label>
            <textarea name="rfi-response" value={r.response || ""} onChange={(e) => up(r, { response: e.target.value })} rows={2} placeholder={t("rfi.placeholder_response")} style={{ ...field, marginBottom: 6, resize: "vertical" }} />
            <label style={lbl}>{t("rfi.field_response_date")}</label>
            <input name="rfi-response-date" value={r.response_date || ""} onChange={(e) => up(r, { response_date: e.target.value })} placeholder={t("rfi.placeholder_response_date")} style={{ ...field, marginBottom: 6 }} />

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={() => up(r, { status: "closed" })} disabled={st.id === "closed"}
                style={{ padding: "3px 9px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: st.id === "closed" ? "default" : "pointer", fontSize: 11, opacity: st.id === "closed" ? 0.5 : 1 }}>{t("rfi.close_button")}</button>
              <button onClick={() => up(r, { status: "void" })} disabled={st.id === "void"}
                style={{ padding: "3px 9px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: st.id === "void" ? "default" : "pointer", fontSize: 11, opacity: st.id === "void" ? 0.5 : 1 }}>{t("rfi.void_button")}</button>
              <span style={{ flex: 1 }} />
              {linked.length === 0
                ? <span style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>{t("rfi.no_linked_markups")}</span>
                : linked.map((m) => (
                  <button key={m.id} onClick={() => onFlyTo && onFlyTo(m)} title={t("rfi.fly_to_title", { type: m.type, sheet: sheetLabel ? sheetLabel(m.sheet_id) : m.sheet_id })}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", border: "1px solid var(--cobalt)", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11 }}>
                    <Icon name="target" size={11} />{sheetLabel ? sheetLabel(m.sheet_id) : m.sheet_id}
                  </button>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
