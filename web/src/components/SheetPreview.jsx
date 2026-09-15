import { useEffect, useRef, useState } from "react";
import { parseSheetKey } from "../lib/sheets";
import { previewPixelWidth, previewViewport } from "../lib/sheetPreview.js";
import "./sheetPreview.css";

// Separate render task and canvas: no changes to the working sheet, scale,
// selection or multi-sheet order. The native dialog owns focus restoration.
export default function SheetPreview({ sheet, label, getDoc, onClose, onOpen }) {
  const dialog = useRef(null);
  const canvas = useRef(null);
  const [status, setStatus] = useState("Loading detailed preview…");
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const el = dialog.current;
    el.showModal();
    const suppress = (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", suppress, true);
    return () => { window.removeEventListener("keydown", suppress, true); el.close(); };
  }, [onClose]);
  useEffect(() => {
    let live = true, task;
    setStatus("Loading detailed preview…"); setZoom(false);
    (async () => {
      const { file, page } = parseSheetKey(sheet);
      const doc = await getDoc(file);
      if (!live) return;
      const pg = await doc.getPage(page);
      if (!live) return;
      const vp = previewViewport(pg, previewPixelWidth(Math.min(1200, window.innerWidth - 64), window.devicePixelRatio));
      const c = canvas.current;
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      task = pg.render({ canvasContext: c.getContext("2d", { alpha: false }), viewport: vp, background: "#ffffff" });
      await task.promise;
      if (live) setStatus("");
    })().catch(() => { if (live) setStatus("This preview could not load. Open the sheet to inspect it on the canvas."); });
    return () => { live = false; task?.cancel(); };
  }, [sheet, getDoc]);
  return <dialog ref={dialog} className="sheet-detail-dialog" aria-label={`Sheet preview: ${label}`} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <header><div><small>Sheet preview</small><h2>{label}</h2></div><button type="button" onClick={onClose} aria-label="Close sheet preview">×</button></header>
    <div className="sheet-detail-toolbar"><span>Inspect before opening</span><button type="button" aria-pressed={zoom} onClick={() => setZoom(v => !v)}>{zoom ? "Fit page" : "Actual pixels"}</button><button type="button" onClick={() => onOpen(sheet)}>Open sheet</button></div>
    {status && <p role="status">{status}</p>}
    <div className={`sheet-detail-paper${zoom ? " actual-pixels" : ""}`}><canvas ref={canvas} aria-label={`${label} rendered page`} hidden={!!status} /></div>
  </dialog>;
}
