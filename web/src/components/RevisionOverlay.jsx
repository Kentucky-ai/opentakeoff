// RevisionOverlay — visual drawing-level revision comparison & slip-sheeting.
// Shows what moved on the drawing: removed ink in red, added in cobalt/green,
// unchanged in gray, with a fading slider between revisions.
// Carries existing takeoff shapes forward, flagging shapes that cross changed ink.
import React, { useEffect, useRef, useState, useMemo } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { Icon } from "../brand/icons.jsx";
import { store } from "../lib/store.js";
import { extractVectorGeometry } from "../lib/oneclick.ts";
import { diffVectorSegments, diffRasterGrayscale } from "../lib/revisionDiff.ts";
import { autoAlignSheets, manualTwoPointAlign } from "../lib/sheetAlign.ts";
import { carryTakeoffShapes, aabbOverlap, polygonsIntersect } from "../lib/slipsheet.ts";
import { parseSheetKey } from "../lib/sheetKey";

export default function RevisionOverlay({
  sheets = [],
  initialSheetKey = "",
  fileName: initialFileName,
  pageNumber: initialPageNumber = 1,
  shapes = [],
  onApplyCarriedShapes,
  onClose,
}) {
  const [selectedSheetKey, setSelectedSheetKey] = useState(() => {
    if (initialSheetKey) return initialSheetKey;
    if (sheets && sheets.length > 0) return sheets[0].key || sheets[0].sheet_id || "";
    if (initialFileName) return initialPageNumber > 1 ? `${initialFileName}#${initialPageNumber}` : initialFileName;
    return "sample-finish-plan.pdf#1";
  });

  const parsedSheet = useMemo(() => {
    return parseSheetKey(selectedSheetKey || initialFileName || "sample-finish-plan.pdf");
  }, [selectedSheetKey, initialFileName]);

  const fileName = parsedSheet.file;
  const pageNumber = parsedSheet.page;

  const [revisions, setRevisions] = useState([]);
  const [baseRev, setBaseRev] = useState(1);
  const [incomingRev, setIncomingRev] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [diffMode, setDiffMode] = useState("auto"); // "auto" | "vector" | "raster"
  const [diffResult, setDiffResult] = useState(null);
  const [alignment, setAlignment] = useState({ dx: 0, dy: 0, confidence: 1, method: "identity" });
  const alignmentRef = useRef(alignment);
  alignmentRef.current = alignment;
  const [fade, setFade] = useState(50); // 0 = 100% Base, 50 = Diff, 100 = 100% Incoming
  const [manualAlignState, setManualAlignState] = useState(null); // null | { step: "pick_base", pBase: null } | { step: "pick_inc", pBase: [x, y] }
  const [slipSheetMessage, setSlipSheetMessage] = useState("");

  const canvasRef = useRef(null);
  const baseSegsRef = useRef([]);
  const incSegsRef = useRef([]);
  const baseRasterCanvasRef = useRef(null);
  const incRasterCanvasRef = useRef(null);
  const pageDimsRef = useRef({ width: 1000, height: 800 });

  const [customIncBytes, setCustomIncBytes] = useState(null);
  const [customIncFileName, setCustomIncFileName] = useState("");
  const [incPageNum, setIncPageNum] = useState(pageNumber);
  const [incDocNumPages, setIncDocNumPages] = useState(1);

  // 1. Fetch available revisions for this PDF
  useEffect(() => {
    let cancelled = false;
    store.listPdfRevisions(fileName)
      .then((list) => {
        if (cancelled) return;
        setRevisions(list);
        if (list.length >= 2) {
          setBaseRev(list[1].rev);
          setIncomingRev(list[0].rev);
        } else if (list.length === 1) {
          setBaseRev(list[0].rev);
          setIncomingRev(list[0].rev);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(`Couldn't list revisions: ${e.message || e}`);
      });
    return () => { cancelled = true; };
  }, [fileName]);

  // Handle direct file upload for comparing with an Addendum PDF
  const handleIncomingFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setCustomIncBytes(bytes);
      setCustomIncFileName(file.name);

      // Pass a clone so pdf.js worker transfer never detaches our stored bytes
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      setIncDocNumPages(doc.numPages);

      // Auto-match sheet number if possible (e.g. A1.3 on page 6)
      let matchedPage = pageNumber;
      const activeSheetObj = sheets.find(
        (s) => s.key === selectedSheetKey || (s.file === fileName && s.page === pageNumber)
      );

      // Try finding the sheet identifier from sheet metadata or current sheet text
      let query = (activeSheetObj?.sheetNumber || activeSheetObj?.label || "").toUpperCase();
      if (!query) {
        // Read the base page text to find its drawing number (e.g. A1.3)
        try {
          const baseRaw = await store.loadPdfRevisionData(fileName, baseRev);
          const baseDoc = await pdfjsLib.getDocument({ data: baseRaw.slice() }).promise;
          const bPage = await baseDoc.getPage(pageNumber);
          const bTc = await bPage.getTextContent();
          const bStr = bTc.items.map((it) => it.str).join(" ");
          const bMatch = bStr.match(/\b(A\d+\.\d+|A\d+)\b/i);
          if (bMatch) query = bMatch[1].toUpperCase();
          await baseDoc.destroy();
        } catch {
          // ignore fallback
        }
      }

      if (query) {
        // Get base page dimensions so we can prefer the page with matching sheet size
        // (avoids matching A1.3 in cover-sheet index tables, which are letter-sized)
        const baseDoc2 = await pdfjsLib.getDocument({ data: (await store.loadPdfRevisionData(fileName, baseRev)).slice() }).promise;
        const basePg = await baseDoc2.getPage(pageNumber);
        const baseView = basePg.view; // [x0, y0, x1, y1]
        const baseW = Math.round(baseView[2] - baseView[0]);
        const baseH = Math.round(baseView[3] - baseView[1]);
        await baseDoc2.destroy();

        // First pass: find all candidates with the query string
        const candidates = [];
        for (let p = 1; p <= doc.numPages; p++) {
          const pg = await doc.getPage(p);
          const pgView = pg.view;
          const pgW = Math.round(pgView[2] - pgView[0]);
          const pgH = Math.round(pgView[3] - pgView[1]);
          const tc = await pg.getTextContent();
          const str = tc.items.map((it) => it.str).join(" ");
          if (str.toUpperCase().includes(query)) {
            const dimMatch = (pgW === baseW && pgH === baseH) || (pgW === baseH && pgH === baseW);
            candidates.push({ p, dimMatch });
          }
        }

        if (candidates.length > 0) {
          // Prefer a candidate whose page size matches the base sheet over letter-sized index pages
          const bestCandidate = candidates.find((c) => c.dimMatch) || candidates[0];
          matchedPage = bestCandidate.p;
        }
      }
      setIncPageNum(matchedPage);
      await doc.destroy();
    } catch (err) {
      setError(`Failed to read addendum PDF: ${err.message || err}`);
    }
  };

  // 2. Load and compute diff for both revisions
  useEffect(() => {
    if (!baseRev || (!incomingRev && !customIncBytes) || !fileName) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setSlipSheetMessage("");

    async function loadAndDiff() {
      try {
        const baseBytes = await store.loadPdfRevisionData(fileName, baseRev);
        const incBytes = customIncBytes || await store.loadPdfRevisionData(fileName, incomingRev);

        // Always pass .slice() so pdf.js worker transfer never detaches the original buffers
        const [baseDoc, incDoc] = await Promise.all([
          pdfjsLib.getDocument({ data: baseBytes.slice() }).promise,
          pdfjsLib.getDocument({ data: incBytes.slice() }).promise,
        ]);

        const [basePage, incPage] = await Promise.all([
          baseDoc.getPage(pageNumber),
          incDoc.getPage(customIncBytes ? incPageNum : pageNumber),
        ]);

        const vp = basePage.getViewport({ scale: 2.0 });
        pageDimsRef.current = { width: vp.width, height: vp.height };

        const [baseOps, incOps] = await Promise.all([
          basePage.getOperatorList(),
          incPage.getOperatorList(),
        ]);

        const baseGeom = extractVectorGeometry(baseOps, vp.transform, pdfjsLib.OPS);
        const incGeom = extractVectorGeometry(incOps, vp.transform, pdfjsLib.OPS);

        // Convert geom to Segments (extractVectorGeometry segs is [x0, y0, x1, y1, ...])
        const baseSegs = [];
        for (let i = 0; i < baseGeom.segs.length; i += 4) {
          baseSegs.push([
            baseGeom.segs[i],
            baseGeom.segs[i + 1],
            baseGeom.segs[i + 2],
            baseGeom.segs[i + 3],
          ]);
        }

        const incSegs = [];
        for (let i = 0; i < incGeom.segs.length; i += 4) {
          incSegs.push([
            incGeom.segs[i],
            incGeom.segs[i + 1],
            incGeom.segs[i + 2],
            incGeom.segs[i + 3],
          ]);
        }

        baseSegsRef.current = baseSegs;
        incSegsRef.current = incSegs;

        // Auto-align sheets unless user supplied a manual alignment
        let activeAlign = alignmentRef.current;
        if (activeAlign.method !== "manual") {
          activeAlign = autoAlignSheets(baseSegs, incSegs, vp.width, vp.height);
          alignmentRef.current = activeAlign;
          setAlignment(activeAlign);
        }

        const shouldUseRaster = diffMode === "raster" || (diffMode === "auto" && (baseSegs.length === 0 || incSegs.length === 0));

        if (shouldUseRaster) {
          // Render offscreen at 150 DPI for raster comparison
          const dpi = 150;
          const rasterVp = basePage.getViewport({ scale: dpi / 72 });
          const rW = Math.round(rasterVp.width);
          const rH = Math.round(rasterVp.height);

          const cBase = document.createElement("canvas");
          cBase.width = rW; cBase.height = rH;
          const ctxBase = cBase.getContext("2d");
          await basePage.render({ canvasContext: ctxBase, viewport: rasterVp }).promise;

          const cInc = document.createElement("canvas");
          cInc.width = rW; cInc.height = rH;
          const ctxInc = cInc.getContext("2d");
          await incPage.render({ canvasContext: ctxInc, viewport: rasterVp }).promise;

          baseRasterCanvasRef.current = cBase;
          incRasterCanvasRef.current = cInc;

          const dBase = ctxBase.getImageData(0, 0, rW, rH).data;
          const dInc = ctxInc.getImageData(0, 0, rW, rH).data;

          const basePix = new Uint8Array(rW * rH);
          const incPix = new Uint8Array(rW * rH);
          for (let i = 0; i < rW * rH; i++) {
            const idx = i * 4;
            basePix[i] = Math.round(0.299 * dBase[idx] + 0.587 * dBase[idx + 1] + 0.114 * dBase[idx + 2]);
            incPix[i] = Math.round(0.299 * dInc[idx] + 0.587 * dInc[idx + 1] + 0.114 * dInc[idx + 2]);
          }

          const rasterDiff = diffRasterGrayscale(basePix, incPix, rW, rH, dpi);
          if (!cancelled) {
            setDiffResult(rasterDiff);
            setLoading(false);
          }
        } else {
          // Run vector diff (tolerance 2.0 device px = 1.0 pt at scale 2.0)
          const vDiff = diffVectorSegments(baseSegs, incSegs, activeAlign, 2.0);
          if (!cancelled) {
            setDiffResult(vDiff);
            setLoading(false);
          }
        }

        await Promise.all([baseDoc.destroy(), incDoc.destroy()]);
      } catch (err) {
        if (!cancelled) {
          setError(`Failed to compute revision overlay: ${err.message || err}`);
          setLoading(false);
        }
      }
    }

    loadAndDiff();
    return () => { cancelled = true; };
  }, [fileName, pageNumber, baseRev, incomingRev, diffMode, customIncBytes, incPageNum]);

  // 3. Render canvas overlay according to fade slider and diff result
  useEffect(() => {
    if (!diffResult || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = pageDimsRef.current;
    canvas.width = width;
    canvas.height = height;

    // Clear background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const f = fade / 100; // 0..1

    if (diffResult.method === "raster" && baseRasterCanvasRef.current && incRasterCanvasRef.current) {
      // Cross-fade raster canvases
      const baseAlpha = Math.max(0, 1 - f);
      const incAlpha = Math.max(0, f);

      if (baseAlpha > 0) {
        ctx.globalAlpha = baseAlpha;
        ctx.drawImage(baseRasterCanvasRef.current, 0, 0, width, height);
      }
      if (incAlpha > 0) {
        ctx.globalAlpha = incAlpha;
        ctx.drawImage(incRasterCanvasRef.current, 0, 0, width, height);
      }
      ctx.globalAlpha = 1.0;
    } else if (diffResult.method === "vector") {
      const f50 = Math.abs(f - 0.5); // 0 at mid = diff mode; 0.5 at extremes

      // 1. Draw Unchanged linework in neutral gray — lighter when slider is at mid (diff focus)
      const unchangedAlpha = 0.25 + f50 * 0.5; // 0.25 at mid, 0.5 at extremes
      ctx.lineWidth = 1.0;
      ctx.strokeStyle = `rgba(140, 150, 165, ${unchangedAlpha})`;
      ctx.beginPath();
      for (const seg of diffResult.unchangedSegments) {
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
      }
      ctx.stroke();

      // 2. Draw Removed linework (Base only) in red — bold and always visible at mid
      const removedAlpha = Math.max(0, 1 - f * 1.5);
      if (removedAlpha > 0.02) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = `rgba(220, 38, 38, ${Math.max(removedAlpha, f50 < 0.3 ? 0.75 : 0)})`;
        ctx.beginPath();
        for (const seg of diffResult.removedSegments) {
          ctx.moveTo(seg[0], seg[1]);
          ctx.lineTo(seg[2], seg[3]);
        }
        ctx.stroke();
      }

      // 3. Draw Added linework (Incoming only) in cobalt/teal — bold and always visible at mid
      const addedAlpha = Math.max(0, (f - 0.2) * 1.25);
      if (addedAlpha > 0.02) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = `rgba(14, 155, 170, ${Math.max(addedAlpha, f50 < 0.3 ? 0.75 : 0)})`;
        ctx.beginPath();
        for (const seg of diffResult.addedSegments) {
          ctx.moveTo(seg[0], seg[1]);
          ctx.lineTo(seg[2], seg[3]);
        }
        ctx.stroke();
      }

      // 4. At mid-slider (diff mode): always show removed in red and added in cyan regardless of alpha calc
      if (f50 < 0.1) {
        // Pure diff mode: show BOTH removed (red) and added (cyan) at full opacity
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(220, 38, 38, 0.9)";
        ctx.beginPath();
        for (const seg of diffResult.removedSegments) {
          ctx.moveTo(seg[0], seg[1]);
          ctx.lineTo(seg[2], seg[3]);
        }
        ctx.stroke();
        ctx.strokeStyle = "rgba(0, 185, 200, 0.9)";
        ctx.beginPath();
        for (const seg of diffResult.addedSegments) {
          ctx.moveTo(seg[0], seg[1]);
          ctx.lineTo(seg[2], seg[3]);
        }
        ctx.stroke();
      }
    }

    // Draw Changed Region bounding boxes (amber outline)
    ctx.strokeStyle = "rgba(217, 119, 6, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    for (const region of diffResult.changedRegions) {
      const b = region.bounds;
      ctx.strokeRect(b[0] - 2, b[1] - 2, (b[2] - b[0]) + 4, (b[3] - b[1]) + 4);
    }
    ctx.setLineDash([]);

    // Draw manual alignment marker if actively picking
    if (manualAlignState?.pBase) {
      const [bx, by] = manualAlignState.pBase;
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(bx, by, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 5. Draw existing takeoff shapes overlaid on the sheet
    if (shapes && shapes.length > 0) {
      const pageShapes = shapes.filter(
        (s) => s.sheet_id === selectedSheetKey || (!s.sheet_id && pageNumber === 1)
      );
      for (const shape of pageShapes) {
        if (!shape.verts_norm || shape.verts_norm.length < 3) continue;

        const vertsPx = shape.verts_norm.map(([nx, ny]) => [nx * width, ny * height]);

        // Check if this shape touches any changed region
        let touchesChange = false;
        if (diffResult?.changedRegions?.length > 0) {
          let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
          for (const [vx, vy] of vertsPx) {
            if (vx < sMinX) sMinX = vx;
            if (vx > sMaxX) sMaxX = vx;
            if (vy < sMinY) sMinY = vy;
            if (vy > sMaxY) sMaxY = vy;
          }
          const sBox = [sMinX, sMinY, sMaxX, sMaxY];
          for (const reg of diffResult.changedRegions) {
            if (aabbOverlap(sBox, reg.bounds) && polygonsIntersect(vertsPx, reg.hull)) {
              touchesChange = true;
              break;
            }
          }
        }

        ctx.beginPath();
        ctx.moveTo(vertsPx[0][0], vertsPx[0][1]);
        for (let i = 1; i < vertsPx.length; i++) {
          ctx.lineTo(vertsPx[i][0], vertsPx[i][1]);
        }
        ctx.closePath();

        if (touchesChange) {
          // Flagged for revision: distinct amber/orange fill and border
          ctx.fillStyle = "rgba(245, 158, 11, 0.28)";
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = "rgba(217, 119, 6, 0.95)";
          ctx.stroke();
        } else {
          // Unaffected: normal green takeoff fill and border
          ctx.fillStyle = "rgba(16, 185, 129, 0.24)";
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = "rgba(16, 185, 129, 0.9)";
          ctx.stroke();
        }
      }
    }
  }, [diffResult, fade, manualAlignState, shapes, selectedSheetKey]);

  // Helper to apply and re-diff when alignment changes manually
  const applyAlignment = (newAlign) => {
    alignmentRef.current = newAlign;
    setAlignment(newAlign);
    if (baseSegsRef.current.length > 0 && incSegsRef.current.length > 0) {
      const vDiff = diffVectorSegments(baseSegsRef.current, incSegsRef.current, newAlign, 2.0);
      setDiffResult(vDiff);
    }
  };

  // 4. Handle Canvas Click for 2-Point Manual Alignment
  const handleCanvasClick = (e) => {
    if (!manualAlignState || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    const clickX = (e.clientX - rect.left) * scaleX;
    const clickY = (e.clientY - rect.top) * scaleY;

    if (manualAlignState.step === "pick_base") {
      setManualAlignState({ step: "pick_inc", pBase: [clickX, clickY] });
    } else if (manualAlignState.step === "pick_inc") {
      const manualAlign = manualTwoPointAlign(manualAlignState.pBase, [clickX, clickY]);
      applyAlignment(manualAlign);
      setManualAlignState(null);
    }
  };

  // 5. Handle Slip-Sheet Action
  const handleSlipSheet = () => {
    if (!diffResult || !onApplyCarriedShapes) return;
    const baseKey = selectedSheetKey;
    const hasProjectSheet = sheets && sheets.some((s) => (s.key || s.sheet_id) === `${customIncFileName}#${incPageNum}`);
    const targetKey = (customIncFileName && hasProjectSheet)
      ? `${customIncFileName}#${incPageNum}`
      : selectedSheetKey;
    const { width, height } = pageDimsRef.current;

    const carried = carryTakeoffShapes(
      shapes,
      baseKey,
      targetKey,
      width,
      height,
      diffResult.changedRegions
    );

    onApplyCarriedShapes(carried.shapes, baseKey, targetKey);
    setSlipSheetMessage(
      `✓ Carried ${carried.shapes.length} takeoffs to ${customIncFileName ? `${customIncFileName} (p.${incPageNum})` : `Rev ${incomingRev}`}. ${
        carried.flaggedCount > 0
          ? `${carried.flaggedCount} shape${carried.flaggedCount === 1 ? "" : "s"} flagged "Check after revision" because ink changed.`
          : "All shapes unaffected."
      }`
    );
  };

  // 6. Summary stats using useMemo
  const statsSummary = useMemo(() => {
    if (!diffResult) return null;
    if (diffResult.method === "vector") {
      return `${diffResult.stats.removedCount} removed · ${diffResult.stats.addedCount} added · ${diffResult.changedRegions.length} change regions`;
    }
    return `${diffResult.stats.changedPixels} px changed (${(diffResult.stats.changeRatio * 100).toFixed(1)}%) · ${diffResult.changedRegions.length} change regions`;
  }, [diffResult]);

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 1000,
      backgroundColor: "rgba(13, 21, 38, 0.8)",
      display: "flex",
      flexDirection: "column",
      color: "var(--ink)",
      fontFamily: "var(--f-body, sans-serif)",
    }}>
      {/* Header bar */}
      <header style={{
        height: 52,
        backgroundColor: "var(--paper-bright, #fafcfe)",
        borderBottom: "1px solid var(--ink-faint, #d8e0ec)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 18px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Icon name="revisions" size={20} />
          <strong style={{ fontSize: 16 }}>Visual Revision Overlay</strong>

          {/* Dynamic Sheet Selector */}
          {sheets && sheets.length > 0 ? (
            <select
              value={selectedSheetKey}
              onChange={(e) => setSelectedSheetKey(e.target.value)}
              style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid var(--ink-faint)", fontSize: 13 }}
            >
              {sheets.map((s) => (
                <option key={s.key || s.sheet_id} value={s.key || s.sheet_id}>
                  {s.sheetNumber ? `${s.sheetNumber} — ` : ""}{s.file}{s.page > 1 ? ` (p.${s.page})` : ""}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ fontSize: 13, color: "var(--ink-muted)" }}>{fileName} · Sheet {pageNumber}</span>
          )}

          {diffResult && (
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 12,
              backgroundColor: "var(--tint-select, #e3f3f4)",
              color: "var(--cobalt, #0e636b)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}>
              {diffResult.method === "vector" ? "Vector diff" : `Raster diff @ ${diffResult.dpi} DPI`}
            </span>
          )}
        </div>

        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 18,
            color: "var(--ink)",
            padding: "4px 8px",
          }}
          title="Close overlay"
        >
          ✕
        </button>
      </header>

      {/* Control bar */}
      <div style={{
        backgroundColor: "var(--paper-cream, #ffffff)",
        borderBottom: "1px solid var(--ink-faint, #d8e0ec)",
        padding: "10px 18px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
      }}>
        {/* Revision Pickers */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ fontSize: 12.5, fontWeight: 600 }}>Baseline:</label>
          <select
            value={baseRev}
            onChange={(e) => setBaseRev(Number(e.target.value))}
            style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid var(--ink-faint)" }}
          >
            {revisions.map((r) => (
              <option key={r.rev} value={r.rev}>
                Rev {r.rev} {r.current ? "(Live)" : ""}
              </option>
            ))}
          </select>

          <span style={{ color: "var(--ink-muted)" }}>➔</span>

          <label style={{ fontSize: 12.5, fontWeight: 600 }}>Incoming:</label>
          {customIncFileName ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--cobalt, #0e636b)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={customIncFileName}>
                {customIncFileName}
              </span>
              <label style={{ fontSize: 11, color: "var(--ink-muted)" }}>p.</label>
              <select
                value={incPageNum}
                onChange={(e) => setIncPageNum(Number(e.target.value))}
                style={{ padding: "3px 6px", borderRadius: 4, border: "1px solid var(--ink-faint)", fontSize: 12 }}
              >
                {Array.from({ length: incDocNumPages }, (_, i) => i + 1).map((p) => (
                  <option key={p} value={p}>Page {p}</option>
                ))}
              </select>
              <label style={{
                fontSize: 11,
                padding: "3px 7px",
                backgroundColor: "var(--tint-select, #e3f3f4)",
                color: "var(--cobalt, #0e636b)",
                borderRadius: 4,
                cursor: "pointer",
                fontWeight: 600,
                border: "1px solid var(--ink-faint)",
              }}>
                Change…
                <input type="file" accept=".pdf" onChange={handleIncomingFileUpload} style={{ display: "none" }} />
              </label>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <select
                value={incomingRev}
                onChange={(e) => setIncomingRev(Number(e.target.value))}
                style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid var(--ink-faint)" }}
              >
                {revisions.map((r) => (
                  <option key={r.rev} value={r.rev}>
                    Rev {r.rev} {r.current ? "(Live)" : ""}
                  </option>
                ))}
              </select>
              <label style={{
                fontSize: 11.5,
                padding: "4px 9px",
                backgroundColor: "var(--cobalt, #0e636b)",
                color: "#ffffff",
                borderRadius: 4,
                cursor: "pointer",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }} title="Select an issued Addendum PDF (e.g. 26-31-Addendum-Three-COMPLETE.pdf) to compare against this sheet">
                <span>📁 Select Addendum PDF</span>
                <input type="file" accept=".pdf" onChange={handleIncomingFileUpload} style={{ display: "none" }} />
              </label>
            </div>
          )}
        </div>

        {/* Fading Slider */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "0 1 320px" }}>
          <span style={{ fontSize: 12, color: "#ef4444", fontWeight: 600 }}>
            {`Rev ${baseRev}`}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={fade}
            onChange={(e) => setFade(Number(e.target.value))}
            style={{ flex: 1, cursor: "pointer" }}
            title="Fade slider: 0% = Rev A, 50% = Diff Overlay, 100% = Rev B"
          />
          <span style={{ fontSize: 12, color: "#0e636b", fontWeight: 600 }}>
            {customIncFileName ? `p.${incPageNum}` : `Rev ${incomingRev}`}
          </span>
        </div>

        {/* Diff Mode Toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-muted)" }}>Mode:</label>
          <select
            value={diffMode}
            onChange={(e) => setDiffMode(e.target.value)}
            style={{ padding: "3px 6px", borderRadius: 4, border: "1px solid var(--ink-faint)", fontSize: 12 }}
          >
            <option value="auto">Auto (Vector/Raster)</option>
            <option value="vector">Vector Only</option>
            <option value="raster">Raster (150 DPI)</option>
          </select>
        </div>

        {/* Alignment Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => {
              if (manualAlignState) setManualAlignState(null);
              else setManualAlignState({ step: "pick_base", pBase: null });
            }}
            style={{
              padding: "4px 10px",
              backgroundColor: manualAlignState ? "var(--c-warning, #d97706)" : "transparent",
              color: manualAlignState ? "#fff" : "var(--ink)",
              border: "1px solid var(--ink-faint)",
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
            title="Calibrate alignment by picking matching points on baseline and incoming revisions"
          >
            {manualAlignState ? "Cancel 2-Point Align" : "2-Point Align"}
          </button>

          {alignment.method === "manual" && (
            <button
              onClick={() => {
                const autoAlign = autoAlignSheets(
                  baseSegsRef.current,
                  incSegsRef.current,
                  pageDimsRef.current.width,
                  pageDimsRef.current.height
                );
                applyAlignment(autoAlign);
              }}
              style={{
                padding: "4px 8px",
                background: "transparent",
                border: "1px solid var(--ink-faint)",
                borderRadius: 4,
                fontSize: 11,
                cursor: "pointer",
                color: "var(--ink-muted)",
              }}
              title="Reset alignment back to auto-alignment"
            >
              Reset Align
            </button>
          )}
        </div>

        {/* Slip-Sheet Button */}
        <div>
          <button
            onClick={handleSlipSheet}
            disabled={loading || !diffResult}
            style={{
              padding: "6px 14px",
              backgroundColor: "var(--cobalt, #0e636b)",
              color: "#ffffff",
              border: "none",
              borderRadius: 4,
              fontWeight: 600,
              fontSize: 12.5,
              cursor: "pointer",
            }}
            title="Carry shapes forward to incoming revision and flag overlapping takeoffs"
          >
            Slip-Sheet Takeoffs
          </button>
        </div>
      </div>

      {/* Manual Alignment Instruction Banner */}
      {manualAlignState && (
        <div style={{
          backgroundColor: "#fef3c7",
          color: "#92400e",
          padding: "8px 18px",
          fontSize: 12.5,
          fontWeight: 600,
          borderBottom: "1px solid #fde68a",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <span>
            {manualAlignState.step === "pick_base"
              ? "🎯 Step 1: Click a reference corner/point on Baseline (Old)"
              : "🎯 Step 2: Click the matching reference corner/point on Incoming (New)"}
          </span>
          <button
            onClick={() => setManualAlignState(null)}
            style={{ border: "none", background: "transparent", color: "#92400e", cursor: "pointer", fontWeight: 700 }}
          >
            ✕ Cancel
          </button>
        </div>
      )}

      {/* Slip-sheet notification message */}
      {slipSheetMessage && (
        <div style={{
          backgroundColor: "var(--tint-active, #edf6f1)",
          color: "var(--c-positive, #1f6b4a)",
          padding: "8px 18px",
          fontSize: 13,
          fontWeight: 600,
          borderBottom: "1px solid var(--ink-faint)",
        }}>
          {slipSheetMessage}
        </div>
      )}

      {/* Overlay Canvas Viewport */}
      <div style={{
        flex: 1,
        overflow: "auto",
        backgroundColor: "#111827",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}>
        {loading ? (
          <div style={{ color: "#ffffff", fontSize: 14 }}>Computing drawing revision diff…</div>
        ) : error ? (
          <div style={{ color: "#ef4444", fontSize: 14 }}>{error}</div>
        ) : (
          <div style={{
            position: "relative",
            boxShadow: "0 10px 25px rgba(0,0,0,0.5)",
            borderRadius: 4,
            overflow: "hidden",
            cursor: manualAlignState ? "crosshair" : "default",
          }}>
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              style={{ display: "block", maxWidth: "90vw", maxHeight: "80vh" }}
            />
          </div>
        )}
      </div>

      {/* Footer legend */}
      <footer style={{
        height: 38,
        backgroundColor: "var(--paper-bright, #fafcfe)",
        borderTop: "1px solid var(--ink-faint, #d8e0ec)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 18px",
        fontSize: 12,
        color: "var(--ink-muted)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span><strong style={{ color: "#888888" }}>■</strong> Unchanged</span>
          <span><strong style={{ color: "#ef4444" }}>■</strong> Removed (Old)</span>
          <span><strong style={{ color: "#00b9c8" }}>■</strong> Added (New)</span>
          <span><strong style={{ color: "#d97706" }}>□</strong> Changed ink boundary</span>
          <span><strong style={{ color: "#10b981" }}>■</strong> Takeoff (Clean)</span>
          <span><strong style={{ color: "#f59e0b" }}>■</strong> Takeoff (Flagged)</span>
          <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>
            Align: {alignment.method} (dx: {Math.round(alignment.dx)}, dy: {Math.round(alignment.dy)})
          </span>
        </div>

        {statsSummary && (
          <div>{statsSummary}</div>
        )}
      </footer>
    </div>
  );
}
