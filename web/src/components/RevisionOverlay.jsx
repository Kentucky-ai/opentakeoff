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
import { carryTakeoffShapes } from "../lib/slipsheet.ts";
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
  const [fade, setFade] = useState(50); // 0 = 100% Base, 50 = Diff, 100 = 100% Incoming
  const [manualAlignState, setManualAlignState] = useState(null); // null | { step: "pick_base", pBase: null } | { step: "pick_inc", pBase: [x, y] }
  const [slipSheetMessage, setSlipSheetMessage] = useState("");

  const canvasRef = useRef(null);
  const baseSegsRef = useRef([]);
  const incSegsRef = useRef([]);
  const baseRasterCanvasRef = useRef(null);
  const incRasterCanvasRef = useRef(null);
  const pageDimsRef = useRef({ width: 1000, height: 800 });

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

  // 2. Load and compute diff for both revisions
  useEffect(() => {
    if (!baseRev || !incomingRev || !fileName) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setSlipSheetMessage("");

    async function loadAndDiff() {
      try {
        const [baseBytes, incBytes] = await Promise.all([
          store.loadPdfRevisionData(fileName, baseRev),
          store.loadPdfRevisionData(fileName, incomingRev),
        ]);

        const [baseDoc, incDoc] = await Promise.all([
          pdfjsLib.getDocument({ data: baseBytes }).promise,
          pdfjsLib.getDocument({ data: incBytes }).promise,
        ]);

        const [basePage, incPage] = await Promise.all([
          baseDoc.getPage(pageNumber),
          incDoc.getPage(pageNumber),
        ]);

        const vp = basePage.getViewport({ scale: 2.0 });
        pageDimsRef.current = { width: vp.width, height: vp.height };

        const [baseOps, incOps] = await Promise.all([
          basePage.getOperatorList(),
          incPage.getOperatorList(),
        ]);

        const baseGeom = extractVectorGeometry(baseOps, vp.transform, pdfjsLib.OPS);
        const incGeom = extractVectorGeometry(incOps, vp.transform, pdfjsLib.OPS);

        // Convert geom to Segments
        const baseSegs = [];
        for (let i = 0; i < baseGeom.segs.length; i += 2) {
          const p0 = baseGeom.points[baseGeom.segs[i]];
          const p1 = baseGeom.points[baseGeom.segs[i + 1]];
          if (p0 && p1) baseSegs.push([p0[0], p0[1], p1[0], p1[1]]);
        }

        const incSegs = [];
        for (let i = 0; i < incGeom.segs.length; i += 2) {
          const p0 = incGeom.points[incGeom.segs[i]];
          const p1 = incGeom.points[incGeom.segs[i + 1]];
          if (p0 && p1) incSegs.push([p0[0], p0[1], p1[0], p1[1]]);
        }

        baseSegsRef.current = baseSegs;
        incSegsRef.current = incSegs;

        // Auto-align sheets unless user supplied a manual alignment
        let activeAlign = alignment;
        if (activeAlign.method !== "manual") {
          activeAlign = autoAlignSheets(baseSegs, incSegs, vp.width, vp.height);
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
          // Run vector diff
          const vDiff = diffVectorSegments(baseSegs, incSegs, activeAlign, 1.0);
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
  }, [fileName, pageNumber, baseRev, incomingRev, diffMode, alignment]);

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
      ctx.lineWidth = 1.0;

      // 1. Draw Unchanged linework in neutral gray
      ctx.strokeStyle = "rgba(120, 135, 155, 0.5)";
      ctx.beginPath();
      for (const seg of diffResult.unchangedSegments) {
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
      }
      ctx.stroke();

      // 2. Draw Removed linework (Base only) in red, opacity weighted towards 0% fade
      const removedAlpha = Math.max(0, 1 - f * 1.5);
      if (removedAlpha > 0.05) {
        ctx.strokeStyle = `rgba(220, 38, 38, ${removedAlpha})`;
        ctx.beginPath();
        for (const seg of diffResult.removedSegments) {
          ctx.moveTo(seg[0], seg[1]);
          ctx.lineTo(seg[2], seg[3]);
        }
        ctx.stroke();
      }

      // 3. Draw Added linework (Incoming only) in cobalt/cyan, opacity weighted towards 100% fade
      const addedAlpha = Math.max(0, (f - 0.2) * 1.25);
      if (addedAlpha > 0.05) {
        ctx.strokeStyle = `rgba(14, 99, 107, ${addedAlpha})`;
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
  }, [diffResult, fade, manualAlignState]);

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
      setAlignment(manualAlign);
      setManualAlignState(null);
    }
  };

  // 5. Handle Slip-Sheet Action
  const handleSlipSheet = () => {
    if (!diffResult || !onApplyCarriedShapes) return;
    const baseKey = selectedSheetKey;
    const targetKey = selectedSheetKey;
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
      `✓ Carried ${carried.shapes.length} takeoffs to Rev ${incomingRev}. ${
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
        </div>

        {/* Fading Slider */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "0 1 320px" }}>
          <span style={{ fontSize: 12, color: "#ef4444", fontWeight: 600 }}>Rev {baseRev}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={fade}
            onChange={(e) => setFade(Number(e.target.value))}
            style={{ flex: 1, cursor: "pointer" }}
            title="Fade slider: 0% = Rev A, 50% = Diff Overlay, 100% = Rev B"
          />
          <span style={{ fontSize: 12, color: "#0e636b", fontWeight: 600 }}>Rev {incomingRev}</span>
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
              onClick={() => setAlignment({ dx: 0, dy: 0, confidence: 1, method: "identity" })}
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
          <span><strong style={{ color: "#0e636b" }}>■</strong> Added (New)</span>
          <span><strong style={{ color: "#d97706" }}>□</strong> Changed ink boundary</span>
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
