// Proposal — the bid proposal PDF for this project: who it's for, lump sum or
// itemized, and this job's copy of the proposal text (lib/bidProposal.js).
// The company block and the prices come from Company setup and the Estimate;
// every edit here saves with the project. Downloading never blocks on an
// incomplete estimate — the dialog names what is unpriced and the estimator
// decides.
import { useEffect, useRef, useState } from "react";
import { Z } from "../lib/ui.js";
import { inOtherModal, otherModalOpen } from "../lib/modalKeys";
import { bidProposalFromDefaults, buildBidProposal, bidProposalFileName } from "../lib/bidProposal.js";
import { loadEstimatingDefaults, TEXT_LIMIT } from "../lib/companySetup.js";
import { loadProfiles, activeProfile } from "../lib/identity.js";
import { downloadText } from "../lib/totals.js";
import { OT_WATERMARK } from "../lib/branding.js";

const TEXTS = [
  ["inclusions", "Inclusions", "One per line"],
  ["exclusions", "Exclusions", "One per line"],
  ["terms", "Terms", "Payment terms, schedule, warranty"],
];
const section = { fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)", borderTop: "1px solid var(--ink-faint)", marginTop: 14, paddingTop: 12 };
const row = { display: "block", margin: "8px 0" };

export default function BidProposalDialog({ est, conditions, projectName, clientInfo = {}, onClientInfo, proposal, onProposal, onOpenCompanySetup, onClose }) {
  const dialogRef = useRef(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // read each render: a Company setup save re-renders the panel above, so the
  // letterhead preview and the PDF always use the active trade name
  const company = activeProfile(loadProfiles()) || {};

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (inOtherModal(e.target, dialogRef.current) || otherModalOpen(document, dialogRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const p = proposal || bidProposalFromDefaults(loadEstimatingDefaults());
  const set = (patch) => onProposal({ ...p, ...patch });
  const client = (field) => (e) => onClientInfo && onClientInfo({ ...clientInfo, [field]: e.target.value });

  const download = async () => {
    setBusy(true);
    try {
      const model = buildBidProposal({ est, conditions, company, clientInfo, projectName, proposal: p });
      const { buildBidProposalPdf } = await import("../lib/bidProposalPdf.js");
      const { bytes, pages } = await buildBidProposalPdf(model);
      downloadText(bidProposalFileName(projectName), bytes, "application/pdf");
      setMsg(`Downloaded ${bidProposalFileName(projectName)} — ${pages} page${pages === 1 ? "" : "s"}.`);
    } catch (e) {
      setMsg(`Couldn't build the proposal: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: Z.modal + 1, background: "var(--scrim)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", overflow: "auto" }}>
      <div ref={dialogRef} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Proposal" className="panel"
        style={{ width: "min(620px, 100%)", background: "var(--paper-bright)", color: "var(--ink)", border: "1px solid var(--ink-faint)", padding: "20px 24px 22px", boxShadow: "var(--shadow-2)", fontFamily: "var(--f-body)", fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 17, letterSpacing: "-0.02em" }}>Proposal</strong>
          <button type="button" onClick={onClose} title="Close (Esc)" aria-label="Close"
            style={{ background: "none", border: "none", color: "var(--ink-soft)", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <p style={{ margin: "4px 0 0", color: "var(--ink-muted)", fontSize: 12.5 }}>
          From {company.name ? <strong>{company.name}</strong> : "your company"}
          {onOpenCompanySetup && <> · <button onClick={onOpenCompanySetup} style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", padding: 0, fontSize: 12.5 }}>{company.name ? "Company setup…" : "Add your company in Company setup…"}</button></>}
        </p>

        {!est.complete && (
          <div role="status" style={{ margin: "10px 0 0", padding: "8px 12px", border: "1px solid var(--c-danger)", fontSize: 12.5 }}>
            <strong>The estimate isn't fully priced.</strong> The base bid counts {est.unpriced.map((u) => u.finish_tag).join(", ")} at $0 for what is missing. You can still download.
          </div>
        )}

        <div style={{ ...section, borderTop: "none", marginTop: 8 }}>Prepared for — saved with this project</div>
        <label style={row}>
          <span className="field-label">Client</span>
          <input name="proposal-client-name" autoComplete="off" value={clientInfo.client_name || ""} onChange={client("client_name")} className="field-input" style={{ marginTop: 4 }} />
        </label>
        <label style={row}>
          <span className="field-label">Client address</span>
          <textarea name="proposal-client-address" autoComplete="off" value={clientInfo.client_address || ""} onChange={client("client_address")} rows={2} className="field-input" style={{ marginTop: 4, resize: "vertical" }} />
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <label style={{ ...row, flex: "1 1 160px" }}>
            <span className="field-label">Reference</span>
            <input name="proposal-client-reference" autoComplete="off" value={clientInfo.reference || ""} onChange={client("reference")} className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={{ ...row, flex: "1 1 120px" }}>
            <span className="field-label">Valid for (days)</span>
            <input name="proposal-valid-days" type="number" min={1} max={365} value={p.valid_days} onChange={(e) => set({ valid_days: Number(e.target.value) })} className="field-input mono" style={{ marginTop: 4 }} />
          </label>
        </div>

        <div style={section}>Price</div>
        <div role="radiogroup" aria-label="Show the price as" style={{ display: "flex", flexWrap: "wrap", gap: 16, margin: "8px 0", fontSize: 12.5 }}>
          {[[false, "Lump sum — one base bid"], [true, "Itemized — a price on each line"]].map(([v, label]) => (
            <label key={String(v)} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="radio" name="proposal-itemized" checked={p.itemized === v} onChange={() => set({ itemized: v })} />{label}
            </label>
          ))}
        </div>
        <label style={row}>
          <span className="field-label">Scope note</span>
          <textarea name="proposal-scope-note" value={p.scope_note} onChange={(e) => set({ scope_note: e.target.value })} maxLength={TEXT_LIMIT} rows={2}
            placeholder="Optional — printed under the scope table" className="field-input" style={{ marginTop: 4, resize: "vertical" }} />
        </label>

        <div style={section}>Proposal text — this job's copy</div>
        {TEXTS.map(([k, label, placeholder]) => (
          <label key={k} style={row}>
            <span className="field-label">{label}</span>
            <textarea name={`proposal-${k}`} value={p[k]} onChange={(e) => set({ [k]: e.target.value })} maxLength={TEXT_LIMIT} rows={3}
              placeholder={placeholder} className="field-input" style={{ marginTop: 4, resize: "vertical" }} />
          </label>
        ))}
        <button className="btn-ghost" onClick={() => { onProposal({ ...bidProposalFromDefaults(loadEstimatingDefaults()), itemized: p.itemized, scope_note: p.scope_note }); setMsg("Proposal text reset to your Company setup."); }}
          style={{ padding: "4px 10px", fontSize: 12 }}>Reset text to Company setup</button>

        {msg && <p role="status" style={{ margin: "10px 0 0", fontSize: 12.5, color: msg.startsWith("Couldn't") ? "var(--c-danger)" : "var(--ink-muted)" }}>{msg}</p>}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14 }}>
          <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>Every page carries: {OT_WATERMARK}</span>
          <button className="btn-primary" onClick={download} disabled={busy || !est.lines.length}>{busy ? "Building…" : "Download PDF"}</button>
        </div>
      </div>
    </div>
  );
}
