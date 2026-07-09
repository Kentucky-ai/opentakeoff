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
import { RFI_STATUSES, rfiStatus, linkedMarkups } from "../lib/rfi.js";

const PRIORITIES = ["low", "normal", "high"];

export default function RfiPanel({ docked = false, rfis = [], markups = [], onUpdateRfi, onDeleteRfi, onFlyTo, sheetLabel, onClose }) {
  const [filter, setFilter] = useState("all"); // "all" | status id
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
        style={{ padding: "2px 8px", border: `1px solid ${on ? "#1f3fc7" : "var(--ink-faint)"}`, background: on ? "#1f3fc7" : "transparent", color: on ? "#fff" : "var(--ink)", cursor: "pointer", fontSize: 11 }}>
        {label}
      </button>
    );
  };

  const outer = docked
    ? { display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "auto", background: "var(--paper-bright)", fontSize: 12.5 }
    : { position: "absolute", left: 14, top: 14, width: 372, maxHeight: "calc(100% - 28px)", overflow: "auto", background: "var(--paper-bright)", border: "1px solid #1f3fc7", boxShadow: "0 6px 22px rgba(0,0,0,.16)", zIndex: 9, fontSize: 12.5 };

  return (
    <div style={outer}>
      {!docked && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)", background: "#1f3fc7", color: "#fff" }}>
          <strong style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Icon name="rfi" size={15} />RFIs · {rfis.length}</strong>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#fff", fontSize: 16, cursor: "pointer" }}>×</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", padding: "8px 10px", borderBottom: "1px solid var(--ink-faint)" }}>
        {chip("all", `All ${rfis.length}`)}
        {RFI_STATUSES.map((s) => chip(s.id, `${s.label} ${rfis.filter((r) => rfiStatus(r.status).id === s.id).length}`))}
      </div>

      {rfis.length === 0 && (
        <div style={{ padding: "14px 12px", color: "var(--ink-muted)" }}>
          No RFIs yet — select a cloud, callout, or note in the markup panel and press <b>Raise RFI</b>.
        </div>
      )}
      {rfis.length > 0 && shown.length === 0 && (
        <div style={{ padding: "14px 12px", color: "var(--ink-muted)" }}>No RFIs with this status.</div>
      )}

      {shown.map((r) => {
        const st = rfiStatus(r.status);
        const linked = linkedMarkups(r, markups);
        return (
          <div key={r.id} style={{ padding: "10px 12px", borderTop: "1px solid var(--ink-faint)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
              <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, color: "#1f3fc7" }}>{String(r.number ?? "")}</span>
              <span style={{ padding: "1px 7px", background: st.color, color: "#fff", fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>{st.label}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>{linked.length} linked</span>
              <button onClick={() => { if (window.confirm(`Delete ${r.number}? Linked markups keep their annotation but lose the RFI link.`)) onDeleteRfi && onDeleteRfi(r.id); }}
                title="Delete this RFI (hard remove; clears links)" style={{ border: "none", background: "none", cursor: "pointer", color: "#b03a26" }}>🗑</button>
            </div>

            <label style={lbl}>Subject</label>
            <input name="rfi-subject" value={r.subject || ""} onChange={(e) => up(r, { subject: e.target.value })} placeholder="Short subject" style={{ ...field, marginBottom: 6 }} />

            <label style={lbl}>Question</label>
            <textarea name="rfi-question" value={r.question || ""} onChange={(e) => up(r, { question: e.target.value })} rows={2} placeholder="What are you asking?" style={{ ...field, marginBottom: 6, resize: "vertical" }} />

            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Status</label>
                <select name="rfi-status" value={st.id} onChange={(e) => up(r, { status: e.target.value })} style={field}>
                  {RFI_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Priority</label>
                <select name="rfi-priority" value={r.priority || "normal"} onChange={(e) => up(r, { priority: e.target.value })} style={field}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Ball in court</label>
                <input name="rfi-to" value={r.to || ""} onChange={(e) => up(r, { to: e.target.value })} placeholder="Architect / GC…" style={field} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Opened</label>
                <input name="rfi-date" value={r.date || ""} onChange={(e) => up(r, { date: e.target.value })} placeholder="YYYY-MM-DD" style={field} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 6 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11.5 }}>
                <input name="rfi-cost-impact" type="checkbox" checked={!!r.cost_impact} onChange={(e) => up(r, { cost_impact: e.target.checked })} />cost impact
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11.5 }}>
                <input name="rfi-schedule-impact" type="checkbox" checked={!!r.schedule_impact} onChange={(e) => up(r, { schedule_impact: e.target.checked })} />schedule impact
              </label>
            </div>

            <label style={lbl}>Response</label>
            <textarea name="rfi-response" value={r.response || ""} onChange={(e) => up(r, { response: e.target.value })} rows={2} placeholder="The answer, once received" style={{ ...field, marginBottom: 6, resize: "vertical" }} />
            <label style={lbl}>Response date</label>
            <input name="rfi-response-date" value={r.response_date || ""} onChange={(e) => up(r, { response_date: e.target.value })} placeholder="auto-stamps when set to Answered" style={{ ...field, marginBottom: 6 }} />

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={() => up(r, { status: "closed" })} disabled={st.id === "closed"}
                style={{ padding: "3px 9px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: st.id === "closed" ? "default" : "pointer", fontSize: 11, opacity: st.id === "closed" ? 0.5 : 1 }}>Close</button>
              <button onClick={() => up(r, { status: "void" })} disabled={st.id === "void"}
                style={{ padding: "3px 9px", border: "1px solid var(--ink-faint)", background: "transparent", color: "#b03a26", cursor: st.id === "void" ? "default" : "pointer", fontSize: 11, opacity: st.id === "void" ? 0.5 : 1 }}>Void</button>
              <span style={{ flex: 1 }} />
              {linked.length === 0
                ? <span style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>no linked markups</span>
                : linked.map((m) => (
                  <button key={m.id} onClick={() => onFlyTo && onFlyTo(m)} title={`Fly to this ${m.type} on ${sheetLabel ? sheetLabel(m.sheet_id) : m.sheet_id}`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", border: "1px solid #1f3fc7", background: "transparent", color: "#1f3fc7", cursor: "pointer", fontSize: 11 }}>
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
