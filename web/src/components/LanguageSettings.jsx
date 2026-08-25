// Language settings — modal overlay for choosing the UI language.
// Follows UnitSettings accessibility conventions: role="dialog", aria-modal,
// labelled-by/description IDs, Escape-to-close, focus trap for Tab/Shift+Tab,
// and focus restoration to the triggering control.
import { useEffect, useRef } from "react";
import { Icon } from "../brand/icons.jsx";
import { useTranslation } from "react-i18next";
import i18n from "../i18n/index.js";
import { SUPPORTED_LANGUAGES } from "../i18n/index.js";

/** Query all focusable elements within a container. */
function focusables(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(
      'input:not([disabled]):not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
    )
  );
}

export default function LanguageSettings({ onClose, triggerRef }) {
  const { t } = useTranslation("panels");
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape-to-close, focus trap, and focus management
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key === "Tab") {
        const els = focusables(dialogRef.current);
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !dialogRef.current.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !dialogRef.current.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    const el = dialogRef.current;
    if (el) {
      // Focus the currently-selected radio, or the first radio, or the close button
      const focusable =
        el.querySelector("input[type=radio]:checked") ||
        el.querySelector("input[type=radio]") ||
        el.querySelector("button");
      if (focusable) focusable.focus();
    }
    const trigger = triggerRef?.current;
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (trigger && typeof trigger.focus === "function") {
        trigger.focus();
      }
    };
  }, [triggerRef]);

  const titleId = "language-settings-title";
  const descId = "language-settings-desc";
  const currentLang = i18n.language || "en";

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
            {t("language.title")}
          </strong>
        </div>

        {/* body */}
        <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>
          <p id={descId} style={{ marginTop: 0 }}>{t("language.description")}</p>

          <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
            <legend className="field-label" style={{ marginBottom: 8 }}>
              {t("language.legend")}
            </legend>

            {SUPPORTED_LANGUAGES.map((lang) => {
              const isActive = currentLang === lang.code || currentLang.startsWith(lang.code);
              return (
                <label
                  key={lang.code}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                    marginBottom: 6, cursor: "pointer",
                    border: `1px solid ${isActive ? "var(--cobalt)" : "var(--ink-faint)"}`,
                    background: isActive ? "var(--paper-cream)" : "transparent",
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                >
                  <input
                    type="radio"
                    name="ui-language"
                    value={lang.code}
                    checked={isActive}
                    onChange={() => { i18n.changeLanguage(lang.code); onClose(); }}
                    style={{ accentColor: "var(--cobalt)" }}
                  />
                  <span style={{ fontSize: 13 }}>{lang.nativeLabel}</span>
                </label>
              );
            })}
          </fieldset>

          <p style={{ background: "var(--paper-shadow)", padding: "8px 10px", fontSize: 12.5, marginTop: 10 }}>
            {t("language.note")}
          </p>
        </div>

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 16px", borderTop: "1px solid var(--ink-faint)" }}>
          <button className="btn-primary" onClick={() => onClose()}>
            {t("language.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
