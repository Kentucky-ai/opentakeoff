// The page's side of OCR consent (#471): session.ts asks requestConsent to
// show the download notice; this turns that into what the page renders (the
// OcrDownloadNotice's props, or null for no notice) and maps its buttons.
//
//   show({ downloadBytes, progress: null })   asking
//   Download → resolve "download", show progress { pct: 0 } at once (the
//              button goes, so a second press can't happen), then the
//              download's own progress
//   Cancel   → before Download: resolve "cancel", close
//              after Download:  notice.cancel() (the session stops the
//              download and aborts the signal, which closes)
//   the notice's signal aborts → close (every waiter left, or the download
//              finished, failed or was cancelled)
//
// One notice at a time: the session opens one and joins later callers to it.
// A newer notice replaces an older one on screen, and a late abort of the
// older one leaves the newer alone. Pure: `show` is the page's setState.
import type { RequestConsent } from "./session";

/** What the page renders: OcrDownloadNotice's downloadBytes and progress. */
export interface NoticeView { downloadBytes: number; progress: { pct: number } | null }

export interface ConsentHost {
  /** session.ts's requestConsent */
  requestConsent: RequestConsent;
  /** the notice's Download button */
  download(): void;
  /** the notice's Cancel button (and Escape) */
  cancel(): void;
}

interface Shown {
  bytes: number;
  downloading: boolean;
  answer: (a: "download" | "cancel") => void;
  cancelDownload: () => void;
}

export function createConsentHost(show: (view: NoticeView | null) => void): ConsentHost {
  let cur: Shown | null = null;

  return {
    requestConsent(downloadBytes, notice) {
      return new Promise((resolve) => {
        if (notice.signal.aborted) { resolve("cancel"); return; }
        const entry: Shown = { bytes: downloadBytes, downloading: false, answer: resolve, cancelDownload: () => notice.cancel() };
        cur = entry;
        show({ downloadBytes, progress: null });
        notice.onProgress((p) => {
          if (cur === entry && entry.downloading) show({ downloadBytes, progress: { pct: p.pct } });
        });
        notice.signal.addEventListener("abort", () => {
          if (cur === entry) { cur = null; show(null); }
          // Settles nothing the session still reads (it ignores the answer
          // once the signal is aborted); it just doesn't leave this pending.
          resolve("cancel");
        }, { once: true });
      });
    },
    download() {
      const e = cur;
      if (!e || e.downloading) return;
      e.downloading = true;
      show({ downloadBytes: e.bytes, progress: { pct: 0 } });
      e.answer("download");
    },
    cancel() {
      const e = cur;
      if (!e) return;
      if (e.downloading) { e.cancelDownload(); return; }
      cur = null;
      show(null);
      e.answer("cancel");
    },
  };
}

interface Focusable { focus(): void }
/** Where focus goes when the notice closes: back to what had it when the
 * notice opened, if that is still in the page (and was a real target, not
 * the body), else to the read control (`fallback`, found at close). */
export function focusAfterNotice<T extends Focusable>(
  saved: (T & { isConnected?: boolean; tagName?: string }) | null | undefined,
  fallback: () => Focusable | null,
): Focusable | null {
  if (saved && saved.isConnected && saved.tagName !== "BODY") return saved;
  return fallback();
}
