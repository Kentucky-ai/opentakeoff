import { useEffect, useRef } from "react";
import { Icon } from "../brand/icons.jsx";
import { keyText } from "../lib/keys.ts";
import { Z } from "../lib/ui.js";

export function DeleteSheetModal({ sheet, onConfirm, onCancel }) {
  const cancelBtnRef = useRef(null);

  useEffect(() => {
    cancelBtnRef.current?.focus();
  }, []);

  if (!sheet) return null;

  const { file, targetPage, pageTitle, takeoffsOnPage } = sheet;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-sheet-modal-title"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z.modal + 10,
        background: "var(--scrim)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--sp-4)",
      }}
    >
      <div
        className="delete-sheet-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--paper-bright)",
          color: "var(--ink)",
          border: "1px solid var(--ink-faint)",
          borderRadius: 12,
          boxShadow: "var(--shadow-pop)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px 14px",
            borderBottom: "1px solid var(--ink-faint)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                background: "color-mix(in srgb, var(--c-danger) 14%, transparent)",
                color: "var(--c-danger)",
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              <Icon name="trash" size={18} />
            </span>
            <div>
              <h3
                id="delete-sheet-modal-title"
                style={{
                  margin: 0,
                  fontSize: 16,
                  fontWeight: 600,
                  fontFamily: "var(--f-display)",
                  color: "var(--ink)",
                  lineHeight: 1.2,
                }}
              >
                Delete page from PDF?
              </h3>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--ink-muted)",
                  fontFamily: "var(--f-mono)",
                }}
              >
                {file}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              color: "var(--ink-muted)",
              cursor: "pointer",
              padding: 6,
              borderRadius: 6,
              display: "grid",
              placeItems: "center",
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Target Sheet Badge */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              background: "var(--paper-cream)",
              border: "1px solid var(--ink-faint)",
              borderRadius: 8,
            }}
          >
            <span style={{ color: "var(--cobalt)" }}>
              <Icon name="document" size={18} />
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                {pageTitle || `Page ${targetPage}`}
              </span>
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                Page {targetPage} of {file}
              </span>
            </div>
          </div>

          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--ink-soft)" }}>
            Are you sure you want to remove this page from the PDF? The page will be deleted from the document.
          </p>

          {/* Warning if takeoffs/markups exist */}
          {takeoffsOnPage > 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "10px 12px",
                background: "color-mix(in srgb, var(--c-warning) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--c-warning) 30%, transparent)",
                borderRadius: 8,
                color: "var(--ink)",
                fontSize: 12.5,
                lineHeight: 1.45,
              }}
            >
              <span style={{ color: "var(--c-warning)", flexShrink: 0, marginTop: 1 }}>
                <Icon name="warning" size={16} />
              </span>
              <span>
                <strong>{takeoffsOnPage} takeoff measurement{takeoffsOnPage === 1 ? "" : "s"}/markup{takeoffsOnPage === 1 ? "" : "s"}</strong> on this sheet will be removed from your project totals.
              </span>
            </div>
          ) : null}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              color: "var(--ink-muted)",
              marginTop: 2,
            }}
          >
            <span>Undo ({keyText("⌘Z")}) restores the page and its takeoffs at any time.</span>
          </div>
        </div>

        {/* Footer Actions */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 10,
            padding: "12px 20px",
            borderTop: "1px solid var(--ink-faint)",
            background: "var(--paper-cream)",
          }}
        >
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={onCancel}
            style={{
              padding: "7px 16px",
              border: "1px solid var(--ink-faint)",
              borderRadius: 8,
              background: "var(--paper-bright)",
              color: "var(--ink)",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              padding: "7px 18px",
              border: "1px solid var(--c-danger)",
              borderRadius: 8,
              background: "var(--c-danger)",
              color: "var(--paper-bright)",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
            }}
          >
            Delete page
          </button>
        </div>
      </div>
    </div>
  );
}
