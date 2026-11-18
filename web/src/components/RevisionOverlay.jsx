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

export default function RevisionOverlay({
  fileName,
  pageNumber = 1,
  shapes = [],
  onApplyCarriedShapes,
  onClose,
}) {
  const [revisions, setRevisions] = useState([]);
  const [baseRev, setBaseRev] = useState(1);
  const [incomingRev, setIncomingRev] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [diffResult, setDiffResult] = useState(null);
  const [alignment, setAlignment] = useState({ dx: 0, dy: 0, confidence: 1, method: "identity" });
  const [fade, setFade] = useState(50); // 0 = 100% Base, 50 = Diff, 100 = 100% Incoming
  const [manualAlignState, setManualAlignState] = useState(null); // null | { step: "pick_base" } | { step: "pick_inc", pBase: [x, y] }
  const [slipSheetMessage, setSlipSheetMessage] = useState("");

  const canvasRef = useRef(null);
  const baseSegsRef = useRef([]);
  const incSegsRef = useRef([]);
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

  // 2. Load and extract vector geometry for both revisions
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

        // Auto-align sheets
        const autoAlign = autoAlignSheets(baseSegs, incSegs, vp.width, vp.height);
        setAlignment(autoAlign);

        // Run vector diff
        const diff = diffVectorSegments(baseSegs, incSegs, autoAlign, 1.0);
        if (!cancelled) {
          setDiffResult(diff);
          setLoading(false);
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
  }, [fileName, pageNumber, baseRev, incomingRev]);

  // 3. Render canvas overlay according to fade slider
  useEffect(() => {
    if (!diffResult || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = pageDimsRef.current;
    canvas.width = width;
    canvas.height = height;

    // Clear background (white paper)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const f = fade / 100; // 0..1
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

    // 4. Draw Changed Region bounding boxes (amber outline)
    ctx.strokeStyle = "rgba(217, 119, 6, 0.75)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    for (const region of diffResult.changedRegions) {
      const b = region.bounds;
      ctx.strokeRect(b[0] - 2, b[1] - 2, (b[2] - b[0]) + 4, (b[3] - b[1]) + 4);
    }
    ctx.setLineDash([]);
  }, [diffResult, fade]);

  // 4. Handle Slip-Sheet Action
  const handleSlipSheet = () => {
    if (!diffResult || !onApplyCarriedShapes) return;
    const baseKey = `${fileName}#${pageNumber}`;
    const targetKey = `${fileName}#${pageNumber}`;
    const { width, height } = pageDimsRef.current;

    const carried = carryTakeoffShapes(
      shapes,
      baseKey,
      targetKey,
      width,
      height,
      diffResult.changedRegions
    );

    onApplyCarriedShapes(carried.shapes);
    setSlipSheetMessage(
      `✓ Carried ${carried.shapes.length} takeoffs to Rev ${incomingRev}. ${
        carried.flaggedCount > 0
          ? `${carried.flaggedCount} shape${carried.flaggedCount === 1 ? "" : "s"} flagged "Check after revision" because ink changed.`
          : "All shapes unaffected."
      }`
    );
  };

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
          <span style={{ fontSize: 13, color: "var(--ink-muted)" }}>{fileName} · Sheet {pageNumber}</span>
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
        gap: 20,
        flexWrap: "wrap",
      }}>
        {/* Revision Pickers */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ fontSize: 12.5, fontWeight: 600 }}>Compare Baseline (Old):</label>
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

          <label style={{ fontSize: 12.5, fontWeight: 600 }}>Incoming (New):</label>
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
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "0 1 360px" }}>
          <span style={{ fontSize: 12, color: "#ef4444", fontWeight: 600 }}>Rev {baseRev} (Old)</span>
          <input
            type="range"
            min={0}
            max={100}
            value={fade}
            onChange={(e) => setFade(Number(e.target.value))}
            style={{ flex: 1, cursor: "pointer" }}
            title="Fade slider: 0% = Rev A, 50% = Diff Overlay, 100% = Rev B"
          />
          <span style={{ fontSize: 12, color: "#0e636b", fontWeight: 600 }}>Rev {incomingRev} (New)</span>
        </div>

        {/* Actions & Slip-Sheet Button */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
            Slip-Sheet Takeoff
          </button>
        </div>
      </div>

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
          }}>
            <canvas ref={canvasRef} style={{ display: "block", maxWidth: "90vw", maxHeight: "80vh" }} />
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
          <span><strong style={{ color: "#888888" }}>■</strong> Unchanged linework</span>
          <span><strong style={{ color: "#ef4444" }}>■</strong> Removed in Rev {baseRev}</span>
          <span><strong style={{ color: "#0e636b" }}>■</strong> Added in Rev {incomingRev}</span>
          <span><strong style={{ color: "#d97706" }}>□</strong> Changed region boundary</span>
        </div>

        {diffResult && (
          <div>
            {diffResult.stats.removedCount} removed · {diffResult.stats.addedCount} added · {diffResult.changedRegions.length} change regions
          </div>
        )}
      </footer>
    </div>
  );
}
