// OcrDownloadNotice (#469): shown before on-device OCR downloads its files
// for the first time, or again after the browser clears its cache. It says
// how much downloads, where from, where it's kept and where the read runs,
// then waits for Download. The caller owns placement and state; this is a
// pure function of its props (the tests press its buttons without a DOM).
//
// Keyboard and screen readers: Download has focus when the notice opens;
// once the download starts Download goes away and Cancel takes focus (its
// key changes, so it remounts with autoFocus). Escape cancels either way,
// and Tab wraps at the ends so focus stays inside.
// The status region is always rendered, so its first update is announced,
// and it only changes on whole tens of percent; the per-percent readout sits
// outside it.
//
//   <OcrDownloadNotice downloadBytes progress onDownload onCancel />
//
// downloadBytes: raw bytes still to download (the client's probe). The
//   notice says "up to": a host that compresses sends fewer.
// progress: null before Download; { pct } while downloading.
// onCancel: dismisses the notice, or aborts a running download.
import { S } from "../lib/ui.js";

/** Bytes → MB with one decimal, rounded up so "up to" stays true:
 * 36,243,408 → "36.3 MB". */
export const formatMB = (bytes) => `${(Math.ceil(bytes / 1e5) / 10).toFixed(1)} MB`;

/** The percent the status region announces: whole tens, so a screen reader
 * hears ten updates, not a hundred. */
export const announcedPct = (pct) => Math.floor(Math.max(0, Math.min(100, pct)) / 10) * 10;

/** Keys inside the notice: Escape cancels; Tab and Shift+Tab wrap at the
 * ends so focus stays in the notice, as aria-modal promises. */
export const noticeKeyDown = (onCancel) => (e) => {
  if (e.key === "Tab") {
    const items = [...e.currentTarget.querySelectorAll("button:not([disabled])")];
    if (!items.length) return;
    const first = items[0], lastItem = items[items.length - 1];
    const wrapTo = e.shiftKey ? (e.target === first ? lastItem : null) : (e.target === lastItem ? first : null);
    if (!wrapTo) return;
    e.preventDefault();
    wrapTo.focus();
    return;
  }
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  onCancel();
};

const visuallyHidden = { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 };

export default function OcrDownloadNotice({ downloadBytes, progress, onDownload, onCancel }) {
  const downloading = !!progress;
  const pct = Math.max(0, Math.min(100, Math.round(progress?.pct ?? 0)));
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="ocr-download-title" aria-describedby="ocr-download-body" onKeyDown={noticeKeyDown(onCancel)}
      style={{ width: "min(420px, calc(100vw - 2 * var(--sp-4)))", background: "var(--paper-bright)", border: "1px solid var(--cobalt)", boxShadow: "var(--shadow-pop)", borderRadius: "var(--r-1)", color: "var(--ink)" }}>
      <div style={{ padding: "var(--sp-3) var(--sp-4)", borderBottom: "1px solid var(--ink-faint)" }}>
        <div style={S.monoLabel}>On-device text recognition</div>
        <h2 id="ocr-download-title" style={{ margin: "var(--sp-1) 0 0", fontSize: "var(--fs-l)", fontWeight: 600 }}>
          Download the text reader?
        </h2>
      </div>
      <div id="ocr-download-body" style={{ padding: "var(--sp-3) var(--sp-4)", fontSize: "var(--fs-s)", lineHeight: 1.5 }}>
        <p style={{ margin: 0 }}>
          Reading text from an image needs two recognition models, a character list and their runtime:{" "}
          <span style={S.monoReadout}>up to {formatMB(downloadBytes)}</span>, downloaded once from this site and kept in your browser.
        </p>
        <p style={{ margin: "var(--sp-2) 0 0", color: "var(--ink-muted)" }}>
          The read runs on this device. The page image isn’t sent anywhere.
        </p>
        {downloading && (
          <div style={{ marginTop: "var(--sp-3)", display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
            <progress value={pct} max={100} aria-label="Download progress" style={{ flex: 1, accentColor: "var(--cobalt)" }} />
            <span style={S.monoReadout} aria-hidden="true">{pct}%</span>
          </div>
        )}
        <div role="status" style={visuallyHidden}>{downloading ? `Downloading the text reader: ${announcedPct(pct)}%` : ""}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-2)", padding: "var(--sp-3) var(--sp-4)", borderTop: "1px solid var(--ink-faint)" }}>
        <button key={downloading ? "cancel-download" : "cancel"} type="button" className="btn-ghost" autoFocus={downloading} onClick={onCancel}>Cancel</button>
        {!downloading && <button type="button" className="btn-primary" autoFocus onClick={onDownload}>Download</button>}
      </div>
    </div>
  );
}
