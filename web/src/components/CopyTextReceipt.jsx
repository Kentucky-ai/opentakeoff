// The Copy text receipt (#471): what went on the clipboard, which reader
// read it, and the first words to check against the sheet. If the clipboard
// refused the write, the receipt keeps the whole text in a read-only
// textarea with its own Copy button (the canvas's ⌘C handler skips
// textareas, so ⌘C works there too). Decisions live in lib/copyText.ts; this
// is its face.
import { useRef, useState } from "react";
import { Z, S } from "../lib/ui.js";
import { retryCopy, receiptKeyDown, RECEIPT_W, RECEIPT_TEXTAREA_H, RECEIPT_PREVIEW_MAX_H } from "../lib/copyText";

export default function CopyTextReceipt({ receipt: r, placement, onClose, onCopyPage, onCopied }) {
  const taRef = useRef(null);
  const [retryFailed, setRetryFailed] = useState(false);
  const retry = async () => {
    const ta = taRef.current;
    const ok = await retryCopy(r.text, {
      clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
      select: () => { ta?.focus(); ta?.select(); },
      execCopy: () => document.execCommand("copy"),
    });
    if (ok) onCopied(); else setRetryFailed(true);
  };
  return (
    <div role={r.failed ? "dialog" : "status"} aria-label="Copy text result"
      style={{ ...placement, width: RECEIPT_W, maxWidth: "calc(100% - 20px)", zIndex: Z.canvasUi, background: "var(--paper-cream)", border: `1px solid ${r.failed ? "var(--c-danger)" : "var(--ink-faint)"}`, boxShadow: "var(--shadow-pop)", fontSize: "var(--fs-s)", color: "var(--ink)" }}>
      <div style={{ ...S.monoReadout, fontSize: "var(--fs-xs)", display: "flex", gap: "var(--sp-2)", alignItems: "baseline", padding: "var(--sp-2) var(--sp-3)", borderBottom: "1px solid var(--ink-faint)" }}>
        <b style={{ color: r.failed ? "var(--c-danger)" : "var(--c-positive)" }}>{r.failed ? "Couldn't copy automatically — use Copy below" : "Copied"}</b>
        <span>{r.lineCount} line{r.lineCount === 1 ? "" : "s"}{r.scope === "page" ? " · whole page" : ""}</span>
        <span style={{ marginLeft: "auto", color: "var(--ink-muted)" }}>{r.reader}{r.skipped > 0 ? ` · ${r.skipped} rotated left out` : ""}{r.clipped > 0 ? ` · ${r.clipped} split at a seam` : ""}</span>
        <button type="button" onClick={onClose} title="Close" aria-label="Close"
          style={{ background: "none", border: "none", color: "var(--ink-soft)", cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
      </div>
      {r.failed ? (
        <div style={{ padding: "var(--sp-2) var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <textarea ref={taRef} readOnly value={r.text} aria-label="Copied text" onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => receiptKeyDown(e, onClose)}
            style={{ ...S.monoReadout, fontSize: "var(--fs-xs)", width: "100%", boxSizing: "border-box", height: RECEIPT_TEXTAREA_H, resize: "none", border: "1px solid var(--ink-faint)", padding: "var(--sp-1)", background: "var(--paper-bright)" }} />
          {retryFailed && <span style={{ color: "var(--ink-soft)" }}>This page can't write to the clipboard. The text is selected: press ⌘C.</span>}
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            <button type="button" className="btn-primary" onClick={retry} style={{ flex: 1, justifyContent: "center" }}>Copy</button>
            <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      ) : (
        <div style={{ ...S.monoReadout, fontSize: "var(--fs-xs)", padding: "var(--sp-2) var(--sp-3)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: RECEIPT_PREVIEW_MAX_H, overflow: "hidden", lineHeight: 1.5 }}>{r.preview}</div>
      )}
      {r.scope === "box" && (
        <div style={{ padding: "0 var(--sp-3) var(--sp-2)" }}>
          <button type="button" className="btn-ghost" onClick={() => onCopyPage(r.key)}>Copy page text</button>
        </div>
      )}
    </div>
  );
}
