import { localizeText as uiText } from "../lib/i18n/core.js";
// Backup reminder + Export everything / Import everything (.otkx).
//
// Mounted once at the app root (main.jsx), so the reminder shows on every
// screen. The File menu opens the dialog with openBackupCenter(), a window
// event, so the canvas needs no new props. The reminder rule and the persist
// request live in lib/backupStatus.js; the file format in lib/browserExport.js.
import { useCallback, useEffect, useRef, useState } from "react";
import { Z } from "../lib/ui.js";
import { inOtherModal, otherModalOpen } from "../lib/modalKeys";
import { withStoreDb } from "../lib/store.js";
import { buildProfile } from "../lib/profile.js";
import {
  readBackupState, requestPersistentStorage, markBackupDone, dismissBackupReminder, backupReminder,
} from "../lib/backupStatus.js";

const OPEN_EVENT = "opentakeoff:backup-open";

/** Open the backup dialog from anywhere (the File menu, the reminder). */
export function openBackupCenter() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

// once per page load, never awaited by a render
let persistAsked = null;
function askPersistOnce() {
  if (!persistAsked) persistAsked = requestPersistentStorage().catch(() => null);
  return persistAsked;
}

// Anything here worth backing up: a plan, a snapshot or a project record.
async function browserHasData() {
  return withStoreDb((db) => new Promise((resolve) => {
    const names = ["pdfs", "snapshots", "meta"].filter((n) => db.objectStoreNames.contains(n));
    if (!names.length) { resolve(false); return; }
    const t = db.transaction(names, "readonly");
    let found = false;
    for (const n of names) {
      const os = t.objectStore(n);
      const r = n === "meta" ? os.count(IDBKeyRange.bound("annotations", "annotations￿")) : os.count();
      r.onsuccess = () => { if (r.result > 0) found = true; };
    }
    t.oncomplete = () => resolve(found);
    t.onerror = () => resolve(false);
    t.onabort = () => resolve(false);
  })).catch(() => false);
}

const fmtBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const stamp = (d = new Date()) => d.toISOString().slice(0, 10);

const btn = {
  padding: "7px 14px", border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)",
  cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "var(--f-body)",
};
const btnQuiet = { ...btn, background: "transparent", color: "var(--ink)", border: "1px solid var(--ink-faint)", fontWeight: 500 };
const section = { fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)", borderTop: "1px solid var(--ink-faint)", marginTop: 16, paddingTop: 12 };

function summaryOf(m) {
  const c = m.counts || {};
  return uiText(`${plural(c.projects || 0, "project")}, ${plural(c.pdfs || 0, "plan file")}, ${plural(c.pdf_revs || 0, "older revision")}, ${plural(c.snapshots || 0, "snapshot")}, your libraries and settings`);
}

function Omitted({ manifest }) {
  if (!manifest?.omitted?.length) return null;
  const bytes = manifest.omitted.reduce((n, o) => n + (o.bytes || 0), 0);
  return (
    <div role="alert" style={{ marginTop: 8, color: "var(--c-warning)", fontSize: 12.5 }}>
      {uiText(`${plural(manifest.omitted.length, "item")} (${fmtBytes(bytes)}) didn't fit in one file and were left out:`)}
      <ul style={{ margin: "4px 0 0", paddingLeft: 18, maxHeight: 120, overflow: "auto" }}>
        {manifest.omitted.slice(0, 50).map((o, i) => <li key={i}>{`${o.store}: ${o.key} — ${o.reason}`}</li>)}
      </ul>
    </div>
  );
}

export default function BackupCenter() {
  const [open, setOpen] = useState(false);
  const [reminder, setReminder] = useState(null);
  const [busy, setBusy] = useState("");
  const [exported, setExported] = useState(null);   // manifest of the last export
  const [error, setError] = useState("");
  const [incoming, setIncoming] = useState(null);   // { bundle, plan, name }
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [imported, setImported] = useState(null);
  const dialogRef = useRef(null);
  const fileRef = useRef(null);

  const recheck = useCallback(async () => {
    const hasData = await browserHasData();
    setReminder(backupReminder(readBackupState(), { hasData, now: new Date() }));
  }, []);

  useEffect(() => {
    let live = true;
    askPersistOnce().then(() => { if (live) recheck(); });
    const onOpen = () => { setOpen(true); setError(""); };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => { live = false; window.removeEventListener(OPEN_EVENT, onOpen); };
  }, [recheck]);

  const close = useCallback(() => {
    if (busy) return;
    // After an import the open canvas still holds the old project in memory,
    // and its next autosave would write it over what was just restored, so
    // leaving the dialog reloads the page.
    if (imported) { window.location.reload(); return; }
    setOpen(false); setIncoming(null); setConfirmReplace(false); setImported(null); setError("");
  }, [busy, imported]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (inOtherModal(e.target, dialogRef.current) || otherModalOpen(document, dialogRef.current)) return;
      e.preventDefault(); e.stopPropagation(); close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  const exportAll = async () => {
    setError(""); setExported(null);
    const filename = `opentakeoff-backup-${stamp()}.otkx`;
    // A file on disk where the browser can write one (Chromium); asked first,
    // inside the click, as the picker requires. Elsewhere the archive is
    // gathered as Blob parts and downloaded.
    let writable = null;
    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: "OpenTakeoff backup", accept: { "application/zip": [".otkx"] } }] });
        writable = await handle.createWritable();
      } catch (e) {
        if (e?.name === "AbortError") return;
        writable = null;
      }
    }
    setBusy(uiText("Packing…"));
    try {
      const { writeBrowserExport, blobSink } = await import("../lib/browserExport.js");
      const mem = writable ? null : blobSink();
      const sink = writable ? { write: (c) => writable.write(c), close: () => writable.close() } : mem;
      const manifest = await writeBrowserExport({
        withDb: withStoreDb, sink, storage: window.localStorage, buildProfile,
        appVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "",
        onProgress: (m) => setBusy(uiText(m)),
      });
      if (mem) {
        const url = URL.createObjectURL(mem.blob());
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      markBackupDone();
      setExported({ manifest, filename });
      recheck();
    } catch (e) {
      try { await writable?.abort?.(); } catch { /* already closed */ }
      setError(uiText(`Couldn't export: ${e?.message || e}`));
    } finally {
      setBusy("");
    }
  };

  const chooseImport = async (file) => {
    if (!file) return;
    setError(""); setIncoming(null); setConfirmReplace(false); setImported(null);
    setBusy(uiText(`Checking ${file.name}…`));
    try {
      const { openBrowserExport, inspectBrowserExport } = await import("../lib/browserExport.js");
      const bundle = await openBrowserExport(file, { onProgress: (m) => setBusy(uiText(m)) });
      const plan = await inspectBrowserExport(bundle, { withDb: withStoreDb, storage: window.localStorage });
      setIncoming({ bundle, plan, name: file.name });
    } catch (e) {
      setError(String(e?.message || "").startsWith("Couldn't") ? e.message : uiText(`Couldn't import: ${e?.message || e}`));
    } finally {
      setBusy("");
    }
  };

  const runImport = async () => {
    if (!incoming) return;
    const needsConfirm = incoming.plan.conflictCount > 0;
    if (needsConfirm && !confirmReplace) return;
    setError(""); setBusy(uiText("Restoring…"));
    try {
      const { applyBrowserExport } = await import("../lib/browserExport.js");
      const res = await applyBrowserExport(incoming.bundle, {
        withDb: withStoreDb, storage: window.localStorage, overwrite: needsConfirm && confirmReplace,
        onProgress: (m) => setBusy(uiText(m)),
      });
      setImported(res);
      setIncoming(null);
    } catch (e) {
      setError(String(e?.message || "").startsWith("Couldn't") ? e.message : uiText(`Couldn't import: ${e?.message || e}`));
    } finally {
      setBusy("");
    }
  };

  const banner = reminder && !open ? (
    <div role="status" aria-live="polite"
      style={{ position: "fixed", left: 16, bottom: 48, zIndex: Z.toast, maxWidth: "min(440px, calc(100vw - 32px))", background: "var(--paper-bright)", color: "var(--ink)", border: "1px solid var(--ink-faint)", borderLeft: "3px solid var(--c-warning)", boxShadow: "var(--shadow-2)", padding: "10px 12px", fontFamily: "var(--f-body)", fontSize: 13, lineHeight: 1.5 }}>
      <div>
        {reminder === "not-persisted"
          ? uiText("Your projects are saved only in this browser, and the browser can clear them to free space. Download a backup to keep them safe.")
          : uiText("You haven't backed up your projects in 14 days. Download a backup to keep them safe.")}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button type="button" style={btn} onClick={() => setOpen(true)}>{uiText("Back up now")}</button>
        <button type="button" style={btnQuiet} onClick={() => { dismissBackupReminder(); setReminder(null); }}>{uiText("Not now")}</button>
      </div>
    </div>
  ) : null;

  if (!open) return banner;

  const plan = incoming?.plan;
  return (
    <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: Z.modal, background: "var(--scrim)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "8vh 16px", overflow: "auto" }}>
      <div ref={dialogRef} onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label={uiText("Back up everything")} className="panel"
        style={{ width: "min(560px, 100%)", background: "var(--paper-bright)", color: "var(--ink)", border: "1px solid var(--ink-faint)", padding: "20px 24px 22px", boxShadow: "var(--shadow-2)", fontFamily: "var(--f-body)", fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 17, letterSpacing: "-0.02em" }}>{uiText("Back up everything")}</strong>
          <button type="button" aria-label={uiText("Close")} onClick={close} disabled={!!busy}
            style={{ background: "none", border: "none", color: "var(--ink-soft)", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <p style={{ margin: "4px 0 0", color: "var(--ink-muted)", fontSize: 12.5 }}>
          {uiText("Your projects live in this browser. One backup file holds all of them — plans, takeoffs, snapshots, libraries and settings — so you can keep a copy or move to another computer.")}
        </p>

        <div style={section}>{uiText("Export everything")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
          <button type="button" style={btn} disabled={!!busy} onClick={exportAll}>{uiText("Download backup (.otkx)")}</button>
          {readBackupState().last_backup ? <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>{uiText(`Last backup: ${new Date(readBackupState().last_backup).toLocaleDateString()}`)}</span> : null}
        </div>
        {exported ? (
          <div style={{ marginTop: 8 }}>
            <div>{uiText(`Saved ${exported.filename} — ${summaryOf(exported.manifest)}.`)}</div>
            <Omitted manifest={exported.manifest} />
          </div>
        ) : null}

        <div style={section}>{uiText("Import everything")}</div>
        <p style={{ margin: "6px 0 0", color: "var(--ink-muted)", fontSize: 12.5 }}>
          {uiText("Adds a backup's projects to this browser. Anything here that isn't in the backup stays.")}
        </p>
        <div style={{ marginTop: 8 }}>
          <button type="button" style={btnQuiet} disabled={!!busy} onClick={() => fileRef.current?.click()}>{uiText("Choose a backup file…")}</button>
          <input ref={fileRef} name="backup-import" type="file" accept=".otkx" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; chooseImport(f); }} />
        </div>
        {plan ? (
          <div style={{ marginTop: 10, padding: "10px 12px", border: "1px solid var(--ink-faint)" }}>
            <div>{uiText(`${incoming.name}: ${summaryOf(plan.manifest)}.`)}</div>
            <div style={{ color: "var(--ink-muted)", fontSize: 12 }}>{uiText(`Made ${new Date(plan.manifest.created).toLocaleString()}${plan.manifest.app_version ? ` by OpenTakeoff ${plan.manifest.app_version}` : ""}.`)}</div>
            {plan.manifest.omitted?.length ? <div style={{ color: "var(--c-warning)", fontSize: 12.5 }}>{uiText(`This backup is incomplete: ${plural(plan.manifest.omitted.length, "item")} didn't fit when it was made.`)}</div> : null}
            {plan.conflictCount ? (
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8, color: "var(--c-danger)" }}>
                <input type="checkbox" name="backup-replace" checked={confirmReplace} onChange={(e) => setConfirmReplace(e.target.checked)} style={{ marginTop: 4 }} />
                <span>{uiText(`Replace ${plural(plan.conflictCount, "item")} already in this browser with the backup's copy. This can't be undone — export a backup of this browser first if you may need them.`)}</span>
              </label>
            ) : null}
            {plan.conflictCount ? (
              <details style={{ marginTop: 4, fontSize: 12 }}>
                <summary style={{ cursor: "pointer", color: "var(--ink-muted)" }}>{uiText("Which items")}</summary>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18, maxHeight: 140, overflow: "auto", fontFamily: "var(--f-mono)" }}>
                  {Object.entries(plan.conflicts).flatMap(([s, keys]) => keys.map((k) => <li key={`${s}:${k}`}>{`${s}: ${String(k).replace("\u0000", " rev ")}`}</li>))}
                </ul>
              </details>
            ) : <div style={{ marginTop: 6, color: "var(--c-positive)" }}>{uiText("Nothing in this browser will be replaced.")}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button type="button" style={{ ...btn, opacity: plan.conflictCount && !confirmReplace ? 0.45 : 1 }}
                disabled={!!busy || (plan.conflictCount > 0 && !confirmReplace)} onClick={runImport}>
                {plan.conflictCount ? uiText("Replace and import") : uiText("Import")}
              </button>
              <button type="button" style={btnQuiet} disabled={!!busy} onClick={() => { setIncoming(null); setConfirmReplace(false); }}>{uiText("Cancel")}</button>
            </div>
          </div>
        ) : null}
        {imported ? (
          <div style={{ marginTop: 10 }}>
            <div style={{ color: "var(--c-positive)" }}>{uiText(`Imported ${plural(imported.written.meta || 0, "record")}, ${plural(imported.written.pdfs || 0, "plan file")}, ${plural(imported.written.pdf_revs || 0, "older revision")} and ${plural(imported.written.snapshots || 0, "snapshot")}.`)}</div>
            <div style={{ color: "var(--ink-muted)", fontSize: 12, marginTop: 4 }}>{uiText("The page reloads when you close this, so nothing open here writes over the restored projects.")}</div>
            <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => window.location.reload()}>{uiText("Reload to open them")}</button>
          </div>
        ) : null}

        {busy ? <div role="status" style={{ marginTop: 12, color: "var(--ink-muted)", fontFamily: "var(--f-mono)", fontSize: 12 }}>{busy}</div> : null}
        {error ? <div role="alert" style={{ marginTop: 12, color: "var(--c-danger)" }}>{error}</div> : null}
      </div>
    </div>
  );
}
