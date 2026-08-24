// Unit system settings — global display-unit preference (Imperial / SI).
// Modal overlay following AiSettings conventions: panel class, field-label
// inputs, i18n via "panels" namespace, controlled radio buttons that apply
// immediately on selection (no save step needed for a single toggle).
import { Icon } from "../brand/icons.jsx";
import { useTranslation } from "react-i18next";
import { useUnitSystem } from "./UnitSystemProvider.jsx";

export default function UnitSettings({ onClose }) {
  const { t } = useTranslation("panels");
  const { unitSystem, setUnitSystem } = useUnitSystem();

  return (
    <div
      onClick={() => onClose()}
      style={{
        position: "absolute", inset: 0, zIndex: 60,
        background: "rgba(14,26,46,.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{ width: 420, maxWidth: "100%", maxHeight: "90%", overflow: "auto",
          background: "var(--paper-bright)", boxShadow: "var(--shadow-2)" }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--ink)" }}>
          <Icon name="target" size={16} />
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 15 }}>
            {t("units.title")}
          </strong>
        </div>

        {/* body */}
        <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          <p style={{ marginTop: 0 }}>{t("units.description")}</p>

          <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
            <legend className="field-label" style={{ marginBottom: 8 }}>
              {t("units.legend")}
            </legend>

            {/* Imperial option */}
            <label
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                marginBottom: 6, cursor: "pointer",
                border: `1px solid ${unitSystem === "imperial" ? "var(--cobalt)" : "var(--ink-faint)"}`,
                background: unitSystem === "imperial" ? "var(--paper-cream)" : "transparent",
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              <input
                type="radio"
                name="unit-system"
                value="imperial"
                checked={unitSystem === "imperial"}
                onChange={() => setUnitSystem("imperial")}
                style={{ accentColor: "var(--cobalt)" }}
              />
              <span>
                <strong>{t("units.imperial_label")}</strong>
                <span style={{ marginLeft: 6, color: "var(--ink-muted)", fontSize: 12 }}>
                  {t("units.imperial_units")}
                </span>
              </span>
            </label>

            {/* SI / Metric option */}
            <label
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                marginBottom: 6, cursor: "pointer",
                border: `1px solid ${unitSystem === "metric" ? "var(--cobalt)" : "var(--ink-faint)"}`,
                background: unitSystem === "metric" ? "var(--paper-cream)" : "transparent",
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              <input
                type="radio"
                name="unit-system"
                value="metric"
                checked={unitSystem === "metric"}
                onChange={() => setUnitSystem("metric")}
                style={{ accentColor: "var(--cobalt)" }}
              />
              <span>
                <strong>{t("units.metric_label")}</strong>
                <span style={{ marginLeft: 6, color: "var(--ink-muted)", fontSize: 12 }}>
                  {t("units.metric_units")}
                </span>
              </span>
            </label>
          </fieldset>

          <p style={{ background: "var(--paper-shadow)", padding: "8px 10px", fontSize: 12.5, marginTop: 10 }}>
            {t("units.note")}
          </p>
        </div>

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 16px", borderTop: "1px solid var(--ink-faint)" }}>
          <button className="btn-primary" onClick={() => onClose()}>
            {t("units.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
