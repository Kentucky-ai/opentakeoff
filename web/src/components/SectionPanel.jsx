import React, { useState, useMemo } from "react";
import { averageEndArea, trenchQuantities, slabPavingQuantities, footingQuantities } from "../lib/suiteMath.ts";
import "./sectionPanel.css";

export const FERDINAND_37_STATIONS = [
  { station: "14+00.00", cut_sf: 0.0, fill_sf: 0.0, printed_cut_cy: 0, printed_fill_cy: 0 },
  { station: "14+27.00", cut_sf: 2.4, fill_sf: 1.5, printed_cut_cy: 1, printed_fill_cy: 1 },
  { station: "14+50.00", cut_sf: 20.9, fill_sf: 25.8, printed_cut_cy: 10, printed_fill_cy: 12 },
  { station: "14+68.50", cut_sf: 43.4, fill_sf: 28.1, printed_cut_cy: 22, printed_fill_cy: 13 },
  { station: "14+75.00", cut_sf: 19.7, fill_sf: 64.1, printed_cut_cy: 8, printed_fill_cy: 11 },
  { station: "14+97.00", cut_sf: 21.9, fill_sf: 23.3, printed_cut_cy: 17, printed_fill_cy: 36 },
  { station: "15+12.00", cut_sf: 0.0, fill_sf: 16.6, printed_cut_cy: 2, printed_fill_cy: 11 },
  { station: "15+25.00", cut_sf: 0.0, fill_sf: 0.0, printed_cut_cy: 0, printed_fill_cy: 4 },
  { station: "19+90.00", cut_sf: 0.0, fill_sf: 0.0, printed_cut_cy: 0, printed_fill_cy: 0 },
  { station: "20+00.00", cut_sf: 7.4, fill_sf: 0.0, printed_cut_cy: 1, printed_fill_cy: 0 },
  { station: "20+28.00", cut_sf: 30.6, fill_sf: 2.0, printed_cut_cy: 20, printed_fill_cy: 1 },
  { station: "20+43.00", cut_sf: 75.9, fill_sf: 39.3, printed_cut_cy: 30, printed_fill_cy: 11 },
  { station: "20+50.00", cut_sf: 77.9, fill_sf: 47.6, printed_cut_cy: 20, printed_fill_cy: 11 },
  { station: "20+80.00", cut_sf: 47.3, fill_sf: 8.7, printed_cut_cy: 70, printed_fill_cy: 31 },
  { station: "21+00.00", cut_sf: 37.9, fill_sf: 61.0, printed_cut_cy: 32, printed_fill_cy: 26 },
  { station: "21+17.00", cut_sf: 37.2, fill_sf: 36.9, printed_cut_cy: 24, printed_fill_cy: 31 },
  { station: "21+25.00", cut_sf: 17.6, fill_sf: 32.7, printed_cut_cy: 8, printed_fill_cy: 10 },
  { station: "21+32.00", cut_sf: 12.4, fill_sf: 28.2, printed_cut_cy: 4, printed_fill_cy: 8 },
  { station: "21+50.00", cut_sf: 1.3, fill_sf: 0.0, printed_cut_cy: 5, printed_fill_cy: 9 },
  { station: "21+60.00", cut_sf: 0.0, fill_sf: 0.0, printed_cut_cy: 0, printed_fill_cy: 0 },
  { station: "28+50.00", cut_sf: 0.0, fill_sf: 0.0, printed_cut_cy: 0, printed_fill_cy: 0 },
  { station: "28+58.00", cut_sf: 8.0, fill_sf: 9.7, printed_cut_cy: 1, printed_fill_cy: 1 },
  { station: "28+78.00", cut_sf: 21.2, fill_sf: 12.8, printed_cut_cy: 11, printed_fill_cy: 8 },
  { station: "29+00.00", cut_sf: 12.3, fill_sf: 40.0, printed_cut_cy: 14, printed_fill_cy: 22 },
  { station: "29+33.00", cut_sf: 0.5, fill_sf: 0.0, printed_cut_cy: 8, printed_fill_cy: 24 },
  { station: "29+50.00", cut_sf: 2.5, fill_sf: 77.9, printed_cut_cy: 1, printed_fill_cy: 25 },
  { station: "29+75.00", cut_sf: 14.8, fill_sf: 26.4, printed_cut_cy: 8, printed_fill_cy: 48 },
  { station: "29+88.00", cut_sf: 19.9, fill_sf: 7.9, printed_cut_cy: 8, printed_fill_cy: 8 },
  { station: "30+00.00", cut_sf: 4.1, fill_sf: 19.7, printed_cut_cy: 5, printed_fill_cy: 6 },
  { station: "30+25.00", cut_sf: 1.1, fill_sf: 1.9, printed_cut_cy: 2, printed_fill_cy: 10 },
  { station: "30+50.00", cut_sf: 0.6, fill_sf: 1.0, printed_cut_cy: 1, printed_fill_cy: 1 },
  { station: "30+75.00", cut_sf: 12.2, fill_sf: 9.7, printed_cut_cy: 6, printed_fill_cy: 5 },
  { station: "30+93.00", cut_sf: 32.3, fill_sf: 3.6, printed_cut_cy: 15, printed_fill_cy: 4 },
  { station: "31+25.00", cut_sf: 17.7, fill_sf: 19.9, printed_cut_cy: 30, printed_fill_cy: 14 },
  { station: "31+35.00", cut_sf: 18.6, fill_sf: 17.4, printed_cut_cy: 7, printed_fill_cy: 7 },
  { station: "31+50.00", cut_sf: 0.0, fill_sf: 0.9, printed_cut_cy: 0, printed_fill_cy: 5 },
  { station: "31+75.00", cut_sf: 0.0, fill_sf: 0.0, printed_cut_cy: 0, printed_fill_cy: 0 },
];

export default function SectionPanel({
  sheetLabel = "Cross Sections",
  sheetKey = "",
  scaleH = 0,
  scaleV = 0,
  onSetDualScale,
  onClose,
}) {
  const [tab, setTab] = useState("stations");
  const [stations, setStations] = useState(FERDINAND_37_STATIONS);
  const [swellPct, setSwellPct] = useState(0);
  const [shrinkPct, setShrinkPct] = useState(0);
  const [newSta, setNewSta] = useState("");
  const [newCut, setNewCut] = useState("");
  const [newFill, setNewFill] = useState("");

  // Scale state
  const [hUpp, setHUpp] = useState(scaleH || 0.0347); // default ~1"=5'
  const [vUpp, setVUpp] = useState(scaleV || scaleH || 0.0347);

  // Trench helper state
  const [trenchL, setTrenchL] = useState(100);
  const [trenchW, setTrenchW] = useState(24);
  const [trenchD, setTrenchD] = useState(48);
  const [trenchBedding, setTrenchBedding] = useState(6);
  const [trenchPipeOd, setTrenchPipeOd] = useState(12);

  // Slab helper state
  const [slabSf, setSlabSf] = useState(2000);
  const [slabThick, setSlabThick] = useState(4);
  const [slabBase, setSlabBase] = useState(6);
  const [slabPerim, setSlabPerim] = useState(180);

  // Footing helper state
  const [ftgL, setFtgL] = useState(150);
  const [ftgH, setFtgH] = useState(3);
  const [ftgW, setFtgW] = useState(1.5);

  const aeaResult = useMemo(() => {
    return averageEndArea(stations, {
      swell_pct: Number(swellPct) || 0,
      shrink_pct: Number(shrinkPct) || 0,
    });
  }, [stations, swellPct, shrinkPct]);

  const trenchResult = useMemo(() => {
    return trenchQuantities({
      length_lf: Number(trenchL) || 0,
      width_in: Number(trenchW) || 0,
      depth_in: Number(trenchD) || 0,
      bedding_depth_in: Number(trenchBedding) || 0,
      pipe_od_in: Number(trenchPipeOd) || 0,
      swell_pct: Number(swellPct) || 0,
    });
  }, [trenchL, trenchW, trenchD, trenchBedding, trenchPipeOd, swellPct]);

  const slabResult = useMemo(() => {
    return slabPavingQuantities({
      area_sf: Number(slabSf) || 0,
      thickness_in: Number(slabThick) || 0,
      base_thickness_in: Number(slabBase) || 0,
      perimeter_lf: Number(slabPerim) || 0,
    });
  }, [slabSf, slabThick, slabBase, slabPerim]);

  const ftgResult = useMemo(() => {
    return footingQuantities({
      length_lf: Number(ftgL) || 0,
      height_ft: Number(ftgH) || 0,
      width_ft: Number(ftgW) || 0,
    });
  }, [ftgL, ftgH, ftgW]);

  const handleAddStation = (e) => {
    e.preventDefault();
    if (!newSta) return;
    const s = {
      station: newSta,
      cut_sf: Number(newCut) || 0,
      fill_sf: Number(newFill) || 0,
    };
    setStations((prev) => [...prev, s]);
    setNewSta("");
    setNewCut("");
    setNewFill("");
  };

  const handleApplyScale = () => {
    if (onSetDualScale && sheetKey) {
      onSetDualScale(sheetKey, Number(hUpp) || 0, Number(vUpp) || Number(hUpp) || 0);
    }
  };

  return (
    <div className="sec-panel" role="region" aria-label="Sitework and Section View">
      <div className="sec-head">
        <div className="sec-title-row">
          <h2>Sitework & Section View — {sheetLabel}</h2>
          {onClose && (
            <button className="sec-x" onClick={onClose} aria-label="Close section panel" title="Close">
              ×
            </button>
          )}
        </div>
        <p className="sec-summary">
          Divisions 31/32/33: Cross-section cut & fill average end area, dual-scale calibration, and sitework rollups.
        </p>
      </div>

      <div className="sec-tabs">
        <button className={tab === "stations" ? "on" : ""} onClick={() => setTab("stations")}>
          Stations & AEA
        </button>
        <button className={tab === "scale" ? "on" : ""} onClick={() => setTab("scale")}>
          Dual Scale (H / V)
        </button>
        <button className={tab === "helpers" ? "on" : ""} onClick={() => setTab("helpers")}>
          Plan Helpers
        </button>
      </div>

      <div className="sec-body">
        {tab === "stations" && (
          <>
            <div className="sec-kpis">
              <div className="sec-kpi-card">
                <span className="sec-kpi-label">Cut Volume</span>
                <span className="sec-kpi-val">{aeaResult.totals.cut_bcy} CY</span>
                <span className="sec-kpi-sub">Bank CY (excavation)</span>
              </div>
              <div className="sec-kpi-card">
                <span className="sec-kpi-label">Fill Volume</span>
                <span className="sec-kpi-val">{aeaResult.totals.fill_ccy} CY</span>
                <span className="sec-kpi-sub">Compacted CY (embankment)</span>
              </div>
            </div>

            <div className={`sec-banner ${aeaResult.checks.matching_stations === aeaResult.checks.total_stations ? "" : "warn"}`}>
              <strong>Average End Area Check:</strong> {aeaResult.checks.matching_stations} of {aeaResult.checks.total_stations} stations match printed answer key within 1 CY.
              <br />
              <small>
                Net-versus-gross: Cut ({aeaResult.totals.cut_bcy} CY) and Fill ({aeaResult.totals.fill_ccy} CY) are reported separately.{" "}
                {aeaResult.totals.disposition === "excess_cut_export" ? (
                  <span>Excess cut to export: <strong>{aeaResult.totals.export_bcy} BCY</strong></span>
                ) : (
                  <span>Borrow needed to import: <strong>{aeaResult.totals.borrow_import_bcy} BCY</strong></span>
                )}
              </small>
            </div>

            <div className="sec-form-card">
              <h3>Station Factors</h3>
              <div className="sec-grid-2">
                <div className="sec-field">
                  <label>Cut Swell % (BCY → LCY)</label>
                  <input type="number" min="0" value={swellPct} onChange={(e) => setSwellPct(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Fill Compaction Shrink %</label>
                  <input type="number" min="0" value={shrinkPct} onChange={(e) => setShrinkPct(e.target.value)} />
                </div>
              </div>
              <div className="sec-btn-row">
                <button
                  type="button"
                  className="sec-btn"
                  onClick={() => setStations(FERDINAND_37_STATIONS)}
                  title="Reset to the 37 stations from Indiana DNR culvert answer key"
                >
                  Load Ferdinand 37-Station Set
                </button>
                <button
                  type="button"
                  className="sec-btn"
                  onClick={() => setStations([])}
                >
                  Clear All
                </button>
              </div>
            </div>

            <form onSubmit={handleAddStation} className="sec-form-card">
              <h3>Add / Trace Station</h3>
              <div className="sec-grid-2">
                <div className="sec-field">
                  <label>Station (e.g. 14+50.00)</label>
                  <input type="text" placeholder="14+50.00" value={newSta} onChange={(e) => setNewSta(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Cut Area Ac (SF)</label>
                  <input type="number" step="0.1" placeholder="20.9" value={newCut} onChange={(e) => setNewCut(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Fill Area Af (SF)</label>
                  <input type="number" step="0.1" placeholder="25.8" value={newFill} onChange={(e) => setNewFill(e.target.value)} />
                </div>
              </div>
              <button type="submit" className="sec-btn sec-btn-primary" style={{ alignSelf: "flex-start" }}>
                Add Station
              </button>
            </form>

            <div className="sec-table-wrap">
              <table className="sec-table">
                <thead>
                  <tr>
                    <th>Station</th>
                    <th>Ac (SF)</th>
                    <th>Af (SF)</th>
                    <th>Vc (CY)</th>
                    <th>Prt Vc</th>
                    <th>Vf (CY)</th>
                    <th>Prt Vf</th>
                    <th>Check</th>
                  </tr>
                </thead>
                <tbody>
                  {aeaResult.stations.map((st) => (
                    <tr key={st.station}>
                      <td><strong>{st.station}</strong></td>
                      <td>{st.cut_sf.toFixed(1)}</td>
                      <td>{st.fill_sf.toFixed(1)}</td>
                      <td>{st.cut_cy.toFixed(1)}</td>
                      <td>{st.printed_cut_cy != null ? st.printed_cut_cy : "-"}</td>
                      <td>{st.fill_cy.toFixed(1)}</td>
                      <td>{st.printed_fill_cy != null ? st.printed_fill_cy : "-"}</td>
                      <td>
                        {st.differs ? (
                          <span className="sec-badge sec-badge-diff" title="Differs from printed note">Differs</span>
                        ) : (
                          <span className="sec-badge sec-badge-ok">Match</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === "scale" && (
          <div className="sec-form-card">
            <h3>Cross-Section Dual Scale</h3>
            <p className="sec-summary">
              Cross-section sheets often have vertical exaggeration (different horizontal and vertical scales).
              Area is computed as <code>poly_area_px × upp_h × upp_v</code>.
            </p>
            <div className="sec-field">
              <label>Horizontal Scale (ft per px)</label>
              <input type="number" step="0.0001" value={hUpp} onChange={(e) => setHUpp(e.target.value)} />
              <small className="sec-kpi-sub">e.g. 1" = 5' at 72dpi × 2 = ~0.0347 ft/px (28.79 px/ft)</small>
            </div>
            <div className="sec-field">
              <label>Vertical Scale (ft per px)</label>
              <input type="number" step="0.0001" value={vUpp} onChange={(e) => setVUpp(e.target.value)} />
              <small className="sec-kpi-sub">e.g. 1" = 5' (1x) or 1" = 1' (5x exaggeration = 0.00694 ft/px)</small>
            </div>
            <div className="sec-res-box">
              <div className="sec-res-line">
                <span>Vertical Exaggeration:</span>
                <strong>{hUpp > 0 && vUpp > 0 ? (hUpp / vUpp).toFixed(2) : 1}x</strong>
              </div>
            </div>
            <button type="button" className="sec-btn sec-btn-primary" onClick={handleApplyScale}>
              Apply Dual Scale to Sheet
            </button>
          </div>
        )}

        {tab === "helpers" && (
          <>
            <div className="sec-form-card">
              <h3>Utility Trench Helper</h3>
              <div className="sec-grid-2">
                <div className="sec-field">
                  <label>Length (LF)</label>
                  <input type="number" value={trenchL} onChange={(e) => setTrenchL(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Width (in)</label>
                  <input type="number" value={trenchW} onChange={(e) => setTrenchW(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Depth (in)</label>
                  <input type="number" value={trenchD} onChange={(e) => setTrenchD(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Bedding Depth (in)</label>
                  <input type="number" value={trenchBedding} onChange={(e) => setTrenchBedding(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Pipe O.D. (in)</label>
                  <input type="number" value={trenchPipeOd} onChange={(e) => setTrenchPipeOd(e.target.value)} />
                </div>
              </div>
              <div className="sec-res-box">
                <div className="sec-res-line">
                  <span>Trench Excavation:</span>
                  <strong>{trenchResult.trench_cy} CY</strong>
                </div>
                <div className="sec-res-line">
                  <span>Bedding Aggregate:</span>
                  <strong>{trenchResult.bedding_cy} CY</strong>
                </div>
                {trenchResult.pipe_displacement_cy > 0 && (
                  <div className="sec-res-line">
                    <span>Pipe Deduction:</span>
                    <strong>{trenchResult.pipe_displacement_cy} CY</strong>
                  </div>
                )}
                <div className="sec-res-line">
                  <span>Backfill Volume:</span>
                  <strong>{trenchResult.backfill_cy} CY</strong>
                </div>
                <div className="sec-res-line">
                  <span>Excess Spoil to Haul:</span>
                  <strong>{trenchResult.spoil_bcy} CY</strong>
                </div>
              </div>
            </div>

            <div className="sec-form-card">
              <h3>Slab & Paving Helper</h3>
              <div className="sec-grid-2">
                <div className="sec-field">
                  <label>Area (SF)</label>
                  <input type="number" value={slabSf} onChange={(e) => setSlabSf(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Paving Thickness (in)</label>
                  <input type="number" value={slabThick} onChange={(e) => setSlabThick(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Subbase Thickness (in)</label>
                  <input type="number" value={slabBase} onChange={(e) => setSlabBase(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Perimeter (LF)</label>
                  <input type="number" value={slabPerim} onChange={(e) => setSlabPerim(e.target.value)} />
                </div>
              </div>
              <div className="sec-res-box">
                <div className="sec-res-line">
                  <span>Surface Area:</span>
                  <strong>{slabResult.surface_sy} SY</strong>
                </div>
                <div className="sec-res-line">
                  <span>Concrete/Paving Volume:</span>
                  <strong>{slabResult.paving_cy} CY</strong>
                </div>
                <div className="sec-res-line">
                  <span>Aggregate Subbase:</span>
                  <strong>{slabResult.subbase_tons} TONS ({slabResult.subbase_cy} CY)</strong>
                </div>
                <div className="sec-res-line">
                  <span>Edge Formwork:</span>
                  <strong>{slabResult.edge_formwork_sfca} SFCA</strong>
                </div>
              </div>
            </div>

            <div className="sec-form-card">
              <h3>Continuous Footing Helper</h3>
              <div className="sec-grid-2">
                <div className="sec-field">
                  <label>Length (LF)</label>
                  <input type="number" value={ftgL} onChange={(e) => setFtgL(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Height (ft)</label>
                  <input type="number" step="0.5" value={ftgH} onChange={(e) => setFtgH(e.target.value)} />
                </div>
                <div className="sec-field">
                  <label>Width (ft)</label>
                  <input type="number" step="0.5" value={ftgW} onChange={(e) => setFtgW(e.target.value)} />
                </div>
              </div>
              <div className="sec-res-box">
                <div className="sec-res-line">
                  <span>2-Sided Formwork:</span>
                  <strong>{ftgResult.formwork_sfca} SFCA</strong>
                </div>
                <div className="sec-res-line">
                  <span>Concrete Volume:</span>
                  <strong>{ftgResult.concrete_cy} CY</strong>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
