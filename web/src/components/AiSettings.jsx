// AI settings — bring your own key. The single always-visible pixel of the AI
// seam; everything else stays dormant until this is configured (ai.js).
import { useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { aiConfig, saveAiConfig } from "../lib/ai.js";

export default function AiSettings({ onClose }) {
  const [cfg, setCfg] = useState(aiConfig);
  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }));
  const save = () => { saveAiConfig(cfg); onClose(true); };
  const clear = () => { saveAiConfig({ endpoint: "", apiKey: "", model: "", provider: "" }); onClose(true); };

  return (
    <div onClick={() => onClose(false)} style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(14,26,46,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: 520, maxWidth: "100%", maxHeight: "90%", overflow: "auto", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--ink)" }}>
          <Icon name="target" size={16} />
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 15 }}>AI — bring your own key</strong>
        </div>
        <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          <p style={{ marginTop: 0 }}>
            OpenTakeoff can ask a vision model <strong>you</strong> provide to read things off the plan — starting
            with the drawn scale when the sheet text doesn't state one. Point it at an OpenAI-style or
            Anthropic-style endpoint: a hosted API, or a local runtime on your own machine (most local
            runtimes speak the OpenAI style and need no key).
          </p>
          <p style={{ margin: "0 0 10px", color: "var(--c-positive)", fontWeight: 600 }}>
            What's sent, and only when you click an AI button: a snapshot of the sheet region in question,
            plus the question. Never the whole plan file, file names, project names, or your takeoff.
          </p>
          <label style={{ display: "block", margin: "6px 0" }}>
            <span className="field-label">Endpoint</span>
            <input value={cfg.endpoint} onChange={set("endpoint")} placeholder="https://… or http://localhost:1234"
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={{ display: "block", margin: "6px 0" }}>
            <span className="field-label">API style</span>
            <select value={cfg.provider} onChange={set("provider")} className="field-input" style={{ marginTop: 4 }}>
              <option value="openai">OpenAI-style API (most local runtimes)</option>
              <option value="anthropic">Anthropic-style API</option>
            </select>
          </label>
          <label style={{ display: "block", margin: "6px 0" }}>
            <span className="field-label">Model</span>
            <input value={cfg.model} onChange={set("model")} placeholder="a vision-capable model id"
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={{ display: "block", margin: "6px 0" }}>
            <span className="field-label">API key (leave blank for local runtimes)</span>
            <input type="password" value={cfg.apiKey} onChange={set("apiKey")} placeholder="stored in this browser only"
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <p style={{ background: "var(--paper-shadow)", padding: "8px 10px", fontSize: 12.5, marginTop: 10 }}>
            The key is stored <strong>in this browser</strong> (localStorage) — anyone with access to this browser
            profile can read it, so use a key you can revoke. Leave everything blank and the AI features stay
            out of your way entirely. The endpoint must allow requests from a browser (CORS); local runtimes
            generally allow localhost.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid var(--ink-faint)" }}>
          <button className="btn-ghost" onClick={clear} style={{ color: "var(--c-danger)" }}>Clear</button>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="btn-ghost" onClick={() => onClose(false)}>Cancel</button>
            <button className="btn-primary" onClick={save}>Save</button>
          </span>
        </div>
      </div>
    </div>
  );
}
