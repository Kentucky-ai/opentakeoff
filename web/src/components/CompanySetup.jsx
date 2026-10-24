// Company setup — who the firm is and how it prices, set once per device:
// trade name, contact and logo (identity.js, shared with Project info through
// CompanyIdentity.jsx), estimating defaults and proposal text (companySetup.js).
// Every field saves as it changes; the .otprofile carries all of it.
import { useEffect, useRef, useState } from "react";
import { Z } from "../lib/ui.js";
import { inOtherModal, otherModalOpen } from "../lib/modalKeys";
import { loadEstimatingDefaults, saveEstimatingDefaults, sanitizeEstimatingDefaults, TEXT_LIMIT } from "../lib/companySetup.js";
import { useCompanyProfiles, CompanyIdentityFields } from "./CompanyIdentity.jsx";

const NUMBER_FIELDS = [
  ["overhead_pct", "Overhead", "%", "On material, labor and tax"],
  ["profit_pct", "Profit", "%", null],
  ["tax_pct", "Sales tax", "%", "On material"],
  ["valid_days", "Proposal valid", "days", null],
];
const TEXT_AREAS = [
  ["inclusions", "Inclusions", "What the price includes, one per line"],
  ["exclusions", "Exclusions", "What the price leaves out, one per line"],
  ["terms", "Terms", "Payment terms, schedule, warranty — your own wording"],
];

const section = { fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)", borderTop: "1px solid var(--ink-faint)", marginTop: 16, paddingTop: 12 };

export default function CompanySetup({ onClose, onSaved }) {
  const dialogRef = useRef(null);
  const company = useCompanyProfiles(onSaved);
  const [defaults, setDefaults] = useState(loadEstimatingDefaults);
  // the number boxes keep what is typed (an emptied box stays empty while the
  // estimator types); the saved record is always the sanitized value
  const [draft, setDraft] = useState(() => Object.fromEntries(NUMBER_FIELDS.map(([k]) => [k, String(loadEstimatingDefaults()[k])])));
  const [saveFailed, setSaveFailed] = useState(false);

  // Same Esc ownership as ConnectAI / the user guide: the dialog closes itself,
  // capture phase, so the press can't also back out of a trace.
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

  const save = (patch) => {
    const next = sanitizeEstimatingDefaults({ ...defaults, ...patch });
    setDefaults(next);
    setSaveFailed(!saveEstimatingDefaults(next));
  };
  const onNumber = (k) => (e) => {
    const v = e.target.value;
    setDraft((d) => ({ ...d, [k]: v }));
    save({ [k]: v === "" ? (k === "valid_days" ? undefined : 0) : Number(v) });
  };
  const margin = defaults.profit_mode === "margin";

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: Z.modal, background: "var(--scrim)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", overflow: "auto" }}>
      <div ref={dialogRef} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Company setup" className="panel"
        style={{ width: "min(640px, 100%)", background: "var(--paper-bright)", color: "var(--ink)", border: "1px solid var(--ink-faint)", padding: "20px 24px 22px", boxShadow: "var(--shadow-2)", fontFamily: "var(--f-body)", fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 17, letterSpacing: "-0.02em" }}>Company setup</strong>
          <button type="button" onClick={onClose} title="Close (Esc)" aria-label="Close"
            style={{ background: "none", border: "none", color: "var(--ink-soft)", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <p style={{ margin: "4px 0 0", color: "var(--ink-muted)", fontSize: 12.5 }}>
          Saved on this device as you type. Export profile carries it to another computer. Every project's estimate starts from these defaults.
        </p>

        <div style={{ ...section, borderTop: "none", marginTop: 10 }}>Company — on your proposals</div>
        <CompanyIdentityFields company={company} contact />

        <div style={section}>Estimating defaults</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, margin: "8px 0" }}>
          {NUMBER_FIELDS.map(([k, label, unit, hint]) => (
            <label key={k} style={{ flex: "1 1 130px", minWidth: 0 }}>
              <span className="field-label">{label}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <input name={`estimating-${k}`} type="number" inputMode="decimal" min={0} step={k === "valid_days" ? 1 : "any"}
                  value={draft[k]} onChange={onNumber(k)} className="field-input mono" style={{ width: "100%", minWidth: 0 }} />
                <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>{unit}</span>
              </span>
              {hint && <span style={{ display: "block", color: "var(--ink-muted)", fontSize: 11 }}>{hint}</span>}
            </label>
          ))}
        </div>
        <div role="radiogroup" aria-label="Profit is" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, margin: "4px 0 2px", fontSize: 12.5 }}>
          <span className="field-label">Profit is</span>
          {[["markup", "a markup on cost"], ["margin", "a margin of the price"]].map(([id, label]) => (
            <label key={id} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="radio" name="profit-mode" value={id} checked={defaults.profit_mode === id} onChange={() => save({ profit_mode: id })} />
              {label}
            </label>
          ))}
        </div>
        <p style={{ margin: "2px 0 0", color: "var(--ink-muted)", fontSize: 11.5 }}>
          {margin
            ? `Price = cost ÷ (1 − ${defaults.profit_pct}%)${defaults.profit_pct >= 100 ? " — a margin must be under 100%." : defaults.profit_pct > 0 ? ` = cost × ${(1 / (1 - defaults.profit_pct / 100)).toFixed(3)}` : ""}`
            : `Price = cost × (1 + ${defaults.profit_pct}%)`}
        </p>

        <div style={section}>Proposal text</div>
        {TEXT_AREAS.map(([k, label, placeholder]) => (
          <label key={k} style={{ display: "block", margin: "8px 0" }}>
            <span className="field-label">{label}</span>
            <textarea name={`proposal-${k}`} value={defaults[k]} onChange={(e) => save({ [k]: e.target.value })} maxLength={TEXT_LIMIT}
              rows={3} placeholder={placeholder} className="field-input" style={{ marginTop: 4, width: "100%", resize: "vertical" }} />
          </label>
        ))}
        {saveFailed && <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--c-danger)" }}>Couldn't save on this device</p>}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
