// SheetGallery — the gallery-first plan-set view (STACK-style overview).
// Thumbnails of every sheet in the project; checkbox one or several (click
// order = left-to-right), open as tabs or side-by-side. Thumbnails render
// lazily through the SAME pdf.js document cache the canvas uses (getDoc), one
// at a time, and yield while the canvas is rastering a full sheet.
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import AuthChip from "./AuthChip.jsx";
import { parseSheetKey, extractSheetNumber, detectScale, RENDER_SCALE, MAX_GROUP } from "../lib/sheets";

const THUMB_W = 380;

export default function SheetGallery({
  sheets, getDoc, scales, detectedScales, shapes, labels, onLabel, onDetect,
  thumbCacheRef, busyRef, openTabs, onOpen, onClose, canClose, onAddFiles, onAddFromDrive,
}) {
  const fileRef = useRef(null);
  const [pages, setPages] = useState({});   // file -> numPages (as discovered)
  const [sel, setSel] = useState([]);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [, bump] = useState(0);
  const seqRef = useRef(0);
  const queueRef = useRef([]);
  const pumpingRef = useRef(false);
  const obsRef = useRef(null);

  // First-visit shortcut: fetch the bundled sample plan and feed it through the
  // same ingest path as a dropped file, so a visitor can try a real takeoff in
  // one click. The PDF lives in /public/demo and is fetched only on demand.
  const loadSample = async () => {
    if (sampleBusy || !onAddFiles) return;
    setSampleBusy(true);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${base}demo/sample-finish-plan.pdf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      onAddFiles([new File([blob], "sample-finish-plan.pdf", { type: "application/pdf" })]);
    } catch {
      setSampleBusy(false);   // on success this empty state unmounts as sheets load
    }
  };

  // enumerate: learn every file's page count through the shared doc cache
  useEffect(() => {
    const seq = ++seqRef.current;
    (async () => {
      for (const s of sheets) {
        try {
          const pdf = await getDoc(s.name);
          if (seq !== seqRef.current) return;
          setPages((m) => (m[s.name] ? m : { ...m, [s.name]: pdf.numPages || 1 }));
        } catch { if (seq === seqRef.current) setPages((m) => (m[s.name] !== undefined ? m : { ...m, [s.name]: 0 })); }
      }
    })();
    return () => { seqRef.current++; };
  }, [sheets, getDoc]);

  const allKeys = sheets.flatMap((s) => {
    const n = pages[s.name];
    if (!n) return [];
    return Array.from({ length: n }, (_, i) => (i ? `${s.name}#${i + 1}` : s.name));
  });

  // a one-sheet project has nothing to choose — open it
  const enumerated = sheets.length > 0 && sheets.every((s) => pages[s.name] !== undefined);
  useEffect(() => {
    if (enumerated && allKeys.length === 1) onOpen([allKeys[0]], false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  // sequential thumbnail worker — one raster in flight, paused while the
  // canvas itself is rendering a sheet
  const pump = async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    const seq = seqRef.current;
    while (queueRef.current.length) {
      if (seq !== seqRef.current) break;
      if (busyRef.current === "rendering") { await new Promise((r) => setTimeout(r, 150)); continue; }
      const key = queueRef.current.shift();
      if (thumbCacheRef.current.has(key)) continue;
      try {
        const { file, page } = parseSheetKey(key);
        const pdf = await getDoc(file);
        const pg = await pdf.getPage(page);
        if (seq !== seqRef.current) break;
        const vp1 = pg.getViewport({ scale: 1 });
        const vp = pg.getViewport({ scale: THUMB_W / vp1.width });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        thumbCacheRef.current.set(key, c.toDataURL("image/jpeg", 0.72));
        bump((n) => n + 1);
        if (!labels[key] || !detectedScales[key]) {
          const tc = await pg.getTextContent();
          const vpL = pg.getViewport({ scale: RENDER_SCALE });
          const lbl = extractSheetNumber(tc, vpL);
          if (lbl) onLabel(key, lbl);
          const det = detectScale(tc, vpL);
          if (det) onDetect(key, det);
        }
      } catch { /* destroyed doc on unmount / render-cancel — skip */ }
    }
    pumpingRef.current = false;
  };

  useEffect(() => {
    obsRef.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const key = e.target.dataset.sheetkey;
        if (key && !thumbCacheRef.current.has(key) && !queueRef.current.includes(key)) queueRef.current.push(key);
        obsRef.current?.unobserve(e.target);
      }
      pump();
    }, { rootMargin: "300px" });
    return () => obsRef.current?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && canClose) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canClose, onClose]);

  const toggle = (key) => setSel((g) => (g.includes(key) ? g.filter((k) => k !== key) : [...g, key]));
  const shapeCount = (key) => shapes.reduce((n, s) => n + (s.sheet_id === key ? 1 : 0), 0);
  const labelOf = (key) => {
    if (labels[key]) return labels[key];
    const t = parseSheetKey(key);
    const base = t.file.replace(/\.pdf$/i, "");
    return t.page > 1 ? `${base} · ${t.page}` : base;
  };

  return (
    <div
      onDragOver={(e) => { if (onAddFiles) e.preventDefault(); }}
      onDrop={(e) => { if (onAddFiles) { e.preventDefault(); onAddFiles(e.dataTransfer?.files); } }}
      style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", flexDirection: "column", background: "var(--paper-cream)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: "1px solid var(--ink)", background: "var(--paper-bright)" }}>
        <Icon name="sheets" size={18} />
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)" }}>Plan set</strong>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ink-muted)" }}>
          {allKeys.length || "…"} sheets · pick one or several — the order you pick is the left-to-right order
        </span>
        <div style={{ flex: 1 }} />
        {/* Choose more PDFs from the project's Drive folder (cloud projects). */}
        {onAddFromDrive && (
          <button onClick={onAddFromDrive} title="Choose more PDFs from this project's Drive folder"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", border: "1px solid var(--cobalt)", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontWeight: 600, fontSize: 12.5 }}>
            <Icon name="plus" size={13} />Add from Drive
          </button>
        )}
        {/* Sign-in for the optional team cloud mode — visible on the gallery/
            landing view (the main toolbar's chip is hidden behind this overlay).
            Renders nothing when cloud mode isn't configured. */}
        <AuthChip />
        {onAddFiles && (
          <>
            <input name="sheet-file" ref={fileRef} type="file" accept=".pdf,application/pdf,image/*,.zip,application/zip,application/x-zip-compressed" multiple style={{ display: "none" }}
              onChange={(e) => { onAddFiles(e.target.files); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} title="Open plans — PDF, image, or a .zip plan set"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 12.5 }}>
              <Icon name="plus" size={13} />Open
            </button>
          </>
        )}
        {canClose && (
          <button onClick={onClose} title="Back to the canvas (Esc)" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12.5 }}>
            <Icon name="close" size={12} />Close
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: 14 }}>
          {allKeys.map((key) => {
            const idx = sel.indexOf(key);
            const isSel = idx >= 0;
            const thumb = thumbCacheRef.current.get(key);
            const cnt = shapeCount(key);
            const isOpenTab = openTabs.includes(key);
            return (
              <div key={key} data-sheetkey={key} ref={(el) => { if (el && !thumb) obsRef.current?.observe(el); }}
                onClick={() => toggle(key)}
                style={{ border: isSel ? "1.5px solid var(--cobalt)" : "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", position: "relative", boxShadow: isSel ? "var(--shadow-2)" : "var(--shadow-1)" }}>
                <span style={{ position: "absolute", top: 8, left: 8, zIndex: 2, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", border: isSel ? "none" : "1.5px solid var(--ink-faint)", background: isSel ? "var(--cobalt)" : "var(--paper-bright)", color: "var(--paper-bright)", fontFamily: "var(--f-mono)", fontSize: 12, fontWeight: 700 }}>{isSel ? idx + 1 : ""}</span>
                <button onClick={(e) => { e.stopPropagation(); onOpen([key], false); }} title="Open just this sheet"
                  style={{ position: "absolute", top: 8, right: 8, zIndex: 2, padding: "5px 12px", border: "none", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}>View</button>
                <div style={{ height: 185, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--well)", borderBottom: "1px solid var(--ink-faint)", overflow: "hidden" }}>
                  {thumb
                    ? <img src={thumb} alt={labelOf(key)} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                    : <div className="skeleton" style={{ width: "86%", height: "78%" }} />}
                </div>
                <div style={{ padding: "8px 10px", display: "flex", alignItems: "baseline", gap: 8 }}>
                  <strong style={{ fontFamily: "var(--f-mono)", fontSize: 12.5, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }} title={key}>{labelOf(key)}</strong>
                  {isOpenTab && <span title="Already open as a tab" style={{ fontSize: 9.5, fontFamily: "var(--f-mono)", color: "var(--cobalt)", textTransform: "uppercase", letterSpacing: "0.08em" }}>open</span>}
                  {cnt > 0 && <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, color: "var(--ink-muted)" }}>{cnt}▦</span>}
                  <span style={{ fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", color: scales[key] ? "var(--c-positive)" : detectedScales[key] ? "var(--c-warning)" : "var(--c-danger)" }}>
                    {scales[key] ? "scale ✓" : detectedScales[key] ? `plan: ${detectedScales[key].label}` : "no scale"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {!allKeys.length && (
          <div style={{ padding: 48, textAlign: "center", color: "var(--ink-muted)", fontSize: 13.5, lineHeight: 1.7 }}>
            {!sheets.length ? (
              <div style={{ maxWidth: 560, margin: "0 auto" }}>
                <button onClick={() => fileRef.current?.click()}
                  style={{ display: "block", width: "100%", margin: "24px auto 0", padding: "44px 24px", border: "2px dashed var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", color: "var(--ink-muted)", fontFamily: "var(--f-body)", fontSize: 13.5, lineHeight: 1.7 }}>
                  <div style={{ fontFamily: "var(--f-display)", fontSize: 20, color: "var(--ink)", marginBottom: 8 }}>Open your plans</div>
                  Drag a PDF, an image, or a whole .zip plan set here — or click to choose. Nothing leaves your browser.
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px auto 16px", color: "var(--text-faint)", fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                  <span style={{ flex: 1, height: 1, background: "var(--ink-faint)" }} />new here?<span style={{ flex: 1, height: 1, background: "var(--ink-faint)" }} />
                </div>
                <button onClick={loadSample} disabled={sampleBusy} title="Open a real floor finish plan and try a takeoff"
                  style={{ display: "inline-flex", alignItems: "center", gap: 9, padding: "13px 22px", border: "1px solid var(--ink)", background: "var(--cobalt)", color: "var(--paper-bright)", cursor: sampleBusy ? "default" : "pointer", opacity: sampleBusy ? 0.65 : 1, fontWeight: 700, fontSize: 14, fontFamily: "var(--f-body)" }}>
                  <Icon name="takeoff" size={16} />{sampleBusy ? "Loading sample…" : "Load sample plan"}
                </button>
                <div style={{ fontFamily: "var(--f-body)", fontSize: 12.5, color: "var(--ink-muted)", marginTop: 11, lineHeight: 1.6 }}>
                  A real medical-center <strong style={{ color: "var(--ink)" }}>floor finish plan</strong> — the scale auto-detects;
                  pick a finish and trace a flooring takeoff in seconds.
                </div>
              </div>
            ) : enumerated ? (
              <>
                <div style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)", marginBottom: 6 }}>Couldn't read those PDFs</div>
                None of the opened files would render — try opening them again.
              </>
            ) : "Reading the plan set…"}
          </div>
        )}
      </div>

      {sheets.length > 0 && (
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "12px 18px", borderTop: "1px solid var(--ink)", background: "var(--paper-bright)" }}>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink-muted)" }}>{sel.length ? `${sel.length} selected` : "select sheets, or hover a card and hit View"}</span>
        <div style={{ flex: 1 }} />
        {sel.length > 0 && (
          <button onClick={() => setSel([])} style={{ padding: "7px 12px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>Clear</button>
        )}
        <button disabled={!sel.length} onClick={() => onOpen(sel, false)}
          style={{ padding: "8px 14px", border: "1px solid var(--ink)", background: "transparent", color: "var(--ink)", cursor: sel.length ? "pointer" : "default", opacity: sel.length ? 1 : 0.4, fontWeight: 700, fontSize: 12.5 }}>
          Open {sel.length || ""} as tabs
        </button>
        <button disabled={sel.length < 2 || sel.length > MAX_GROUP} onClick={() => onOpen(sel, true)}
          title={sel.length > MAX_GROUP ? `Side-by-side maxes at ${MAX_GROUP} — open as tabs instead` : "One pan/zoom moves the whole row"}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", border: "none", background: sel.length >= 2 && sel.length <= MAX_GROUP ? "var(--cobalt)" : "var(--ink-faint)", color: "var(--paper-bright)", cursor: sel.length >= 2 && sel.length <= MAX_GROUP ? "pointer" : "default", fontWeight: 700, fontSize: 12.5 }}>
          <Icon name="sideBySide" size={14} />Open {sel.length >= 2 ? sel.length : ""} side-by-side
        </button>
      </div>
      )}
    </div>
  );
}
