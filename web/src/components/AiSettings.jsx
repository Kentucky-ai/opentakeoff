// AI settings — bring your own key. The single always-visible pixel of the AI
// seam; everything else stays dormant until this is configured (ai.js).
import { useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { aiConfig, saveAiConfig } from "../lib/ai.js";
import { useTranslation } from "react-i18next";

export default function AiSettings({ onClose }) {
  const { t } = useTranslation("panels");
  const [cfg, setCfg] = useState(aiConfig);
  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }));
  const save = () => { saveAiConfig(cfg); onClose(true); };
  const clear = () => { saveAiConfig({ endpoint: "", apiKey: "", model: "", provider: "" }); onClose(true); };

  return (
    <div onClick={() => onClose(false)} style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(14,26,46,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: 520, maxWidth: "100%", maxHeight: "90%", overflow: "auto", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--ink)" }}>
          <Icon name="target" size={16} />
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 15 }}>{t("ai.title")}</strong>
        </div>
        <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          <p style={{ marginTop: 0 }} dangerouslySetInnerHTML={{ __html: t("ai.description") }} />
          <p style={{ margin: "0 0 10px", color: "var(--c-positive)", fontWeight: 600 }}>
            {t("ai.privacy_note")}
          </p>
          <label style={{ display: "block", margin: "6px 0" }}>
            <span className="field-label">{t("ai.field_endpoint")}</span>
            <input value={cfg.endpoint} onChange={set("endpoint")} placeholder={t("ai.placeholder_endpoint")}
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={{ display: "block", margin: "6px 0" }}>
            <span className="field-label">{t("ai.field_api_style")}</span>
            <select value={cfg.provider} onChange={set("provider")} className="field-input" style={{ marginTop: 4 }}>
              <option value="openai">{t("ai.api_openai")}</option>
              <option value="anthropic">{t("ai.api_anthropic")}</option>
            </select>
          </label>
          <label style={{ display: "block", margin: "6px 0" }}>
            <span className="field-label">{t("ai.field_model")}</span>
            <input value={cfg.model} onChange={set("model")} placeholder={t("ai.placeholder_model")}
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={{ display: "block", margin: "6px 0" }}>
            <span className="field-label">{t("ai.field_api_key")}</span>
            <input type="password" value={cfg.apiKey} onChange={set("apiKey")} placeholder={t("ai.placeholder_api_key")}
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <p style={{ background: "var(--paper-shadow)", padding: "8px 10px", fontSize: 12.5, marginTop: 10 }}
            dangerouslySetInnerHTML={{ __html: t("ai.storage_note") }} />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid var(--ink-faint)" }}>
          <button className="btn-ghost" onClick={clear} style={{ color: "var(--c-danger)" }}>{t("ai.clear")}</button>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="btn-ghost" onClick={() => onClose(false)}>{t("ai.cancel")}</button>
            <button className="btn-primary" onClick={save}>{t("ai.save")}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
