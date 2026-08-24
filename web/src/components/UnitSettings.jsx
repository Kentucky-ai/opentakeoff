// Unit system settings — global display-unit preference (Imperial / SI).
// Modal overlay following AiSettings conventions: panel class, field-label
// inputs, i18n via "panels" namespace, controlled radio buttons that apply
// immediately on selection (no save step needed for a single toggle).
//
// Accessibility: role="dialog", aria-modal, labelled-by/description IDs,
// Escape-to-close, and focus restoration to the triggering control.
import { useEffect, useRef } from "react";
import { Icon } from "../brand/icons.jsx";
import { useTranslation } from "react-i18next";
import { useUnitSystem } from "./UnitSystemProvider.jsx";

export default function UnitSettings({ onClose, triggerRef }) {
  const { t } = useTranslation("panels");
  const { unitSystem, setUnitSystem } = useUnitSystem();
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape-to-close and focus management
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); }
    };
    document.addEventListener("keydown", onKey, true);
    // Focus the dialog on mount (or the first focusable element inside it)
    const el = dialogRef.current;
    if (el) {
      const focusable = el.querySelector("input[type=radio]:checked") || el.querySelector("input[type=radio]") || el.querySelector("button");
      if (focusable) focusable.focus();
    }
    const trigger = triggerRef?.current;
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Restore focus to the trigger button if it still exists in the DOM
      if (trigger && typeof trigger.focus === "function") {
        trigger.focus();
      }
    };
  }, [triggerRef]);

  const titleId = "unit-settings-title";
  const descId = "unit-settings-desc";

  return (
    <div
      onClick={() => onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      style={{
        position: "absolute", inset: 0, zIndex: 60,
        background: "rgba(14,26,46,.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{ width: 420, maxWidth: "100%", maxHeight: "90%", overflow: "auto",
          background: "var(--paper-bright)", boxShadow: "var(--shadow-2)" }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--ink)" }}>
          <Icon name="target" size={16} />
          <strong id={titleId} style={{ fontFamily: "var(--f-display)", fontSize: 15 }}>
            {t("units.title")}
          </strong>
        </div>

        {/* body */}
        <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          <p id={descId} style={{ marginTop: 0 }}>{t("units.description")}</p>

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
              <span style={{ fontSize: 13 }}>{t("units.imperial_option")}</span>
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
              <span style={{ fontSize: 13 }}>{t("units.metric_option")}</span>
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
