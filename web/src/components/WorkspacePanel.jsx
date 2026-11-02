import { localizeText as uiText } from "../lib/i18n/core.js";
import { useEffect, useMemo, useState } from "react";
import { filterWork, workActor, workMethod, workQuantity, workReviewState } from "../lib/workReview.js";
import { Z } from "../lib/ui.js";
import { ScanStar } from "../brand/marks.jsx";
import "./workspacePanel.css";

export default function WorkspacePanel({ open, shapes, conditions, selectedId, sheetLabel, fmtArea, fmtLength,
  scales, scaleUnconfirmed, running, proposalCount, onLocate, onReview, onClose, onReport, children, dockSide, width, dockHandle }) {
  const [tab, setTab] = useState("work");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const pending = shapes.filter((s) => workReviewState(s) === "Needs review").length;
  const rows = useMemo(() => filterWork(shapes, { filter, query,
    conditionLabel: (id) => conditions[id]?.finish_tag || "", sheetLabel }), [shapes, filter, query, conditions, sheetLabel]);
  const selected = shapes.find((s) => s.id === selectedId);
  useEffect(() => { setLimit(50); }, [filter, query]);
  const quantity = (shape) => {
    const q = workQuantity(shape);
    if (q.value === null) return "Not measured";
    const text = q.kind === "count" ? `${q.value} EA` : q.kind === "length" ? fmtLength(q.value) : fmtArea(q.value);
    return `${q.deduct ? "−" : ""}${text}`;
  };
  const evidence = selected?.origin?.evidence || {};
  return (
    <aside className="workspace-panel" hidden={!open} aria-label={uiText("Work and review")} data-dock-side={dockSide} style={{ zIndex: Z.drawer, ...(dockSide ? { order: dockSide === "left" ? -10 : 10, width } : {}) }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <header className="workspace-heading">
        {uiText(dockHandle)}
        <div><span className="workspace-eyebrow">{uiText("Shared workspace")}</span><h2>{uiText("Work and review")}</h2></div>
        <button type="button" onClick={onClose} aria-label={uiText("Close work panel")}>×</button>
      </header>
      <div className="workspace-summary">
        <div><strong>{uiText(shapes.length)}</strong><span>{uiText("measurements")}</span></div>
        <div><strong>{uiText(pending)}</strong><span>{uiText("need review")}</span></div>
        <div><strong>{uiText(new Set(shapes.map((s) => s.sheet_id)).size)}</strong><span>{uiText("sheets with work")}</span></div>
      </div>
      <div className="workspace-tabs" role="tablist" aria-label={uiText("Workspace views")} onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const next = e.key === "Home" ? "work" : e.key === "End" ? "agent" : tab === "work" ? "agent" : "work";
        setTab(next); document.getElementById(`workspace-${next}-tab`)?.focus();
      }}>
        <button type="button" role="tab" tabIndex={tab === "work" ? 0 : -1} id="workspace-work-tab" aria-controls="workspace-work-view" aria-selected={tab === "work"} onClick={() => setTab("work")}>{uiText("Measurements")}</button>
        <button type="button" role="tab" tabIndex={tab === "agent" ? 0 : -1} id="workspace-agent-tab" aria-controls="workspace-agent-view" aria-selected={tab === "agent"} onClick={() => setTab("agent")}><ScanStar size={12} working={!!running} style={{ marginRight: 6 }} />{uiText("Agent ")}{uiText(running ? "· Working" : proposalCount ? `· ${proposalCount} proposals` : "")}</button>
      </div>
      <div id="workspace-agent-view" role="tabpanel" aria-labelledby="workspace-agent-tab" hidden={tab !== "agent"} className="workspace-agent-view">{uiText(children)}</div>
      <div id="workspace-work-view" role="tabpanel" aria-labelledby="workspace-work-tab" hidden={tab !== "work"} className="workspace-work-view">
        <div className="workspace-filters">
          <label className="workspace-search"><span>{uiText("Find work")}</span><input name="work-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={uiText("Condition, sheet, label, or author")} /></label>
          <div className="workspace-filter-buttons" aria-label={uiText("Filter measurements")}>
            {[["all", "All work"], ["pending", `Needs review · ${pending}`], ["agent", "Agent"]].map(([id, label]) =>
              <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{uiText(label)}</button>)}
          </div>
        </div>
        <div className="workspace-list" aria-label={uiText("Measurements")}>
          {!rows.length && <div className="workspace-empty"><h3>{uiText(shapes.length ? "No matching work" : "Your measurements appear here")}</h3><p>{uiText(shapes.length ? "Change the filter or search to see more measurements." : "Measure on the plan or import an agent’s takeoff. Inspect either actor’s work here, then open its boundary on the drawing.")}</p></div>}
          {rows.slice(0, limit).map((shape) => <button type="button" className="workspace-row" key={shape.id} aria-pressed={selectedId === shape.id} onClick={() => onLocate(shape)}>
            <span className="workspace-row-top"><strong>{uiText(conditions[shape.condition_id]?.finish_tag || "Unassigned")}{uiText(shape.label ? ` · ${shape.label}` : "")}</strong><span className="workspace-quantity">{uiText(quantity(shape))}</span></span>
            <span className="workspace-sheet">{uiText(sheetLabel(shape.sheet_id))}</span>
            <span className="workspace-row-bottom"><span>{workActor(shape) === "Agent" && <ScanStar size={10} style={{ marginRight: 5, color: "var(--cobalt)" }} />}{uiText(shape.author || workActor(shape))}</span><span className={workReviewState(shape) === "Needs review" ? "workspace-pending" : ""}>{uiText(workReviewState(shape))}</span></span>
          </button>)}
          {rows.length > limit && <button type="button" className="workspace-more" onClick={() => setLimit((n) => n + 50)}>{uiText("Show more · ")}{uiText(rows.length - limit)} {uiText("remaining")}</button>}
        </div>
        {selected && <section className="workspace-inspector" aria-label={uiText("Selected measurement")}>
          <div className="workspace-inspector-title"><h3>{uiText("Measurement receipt")}</h3><strong className="workspace-quantity">{uiText(quantity(selected))}</strong></div>
          <dl>
            <div><dt>{uiText("Source")}</dt><dd>{uiText(workActor(selected))}{uiText(selected.author ? ` · ${selected.author}` : "")}</dd></div>
            <div><dt>{uiText("Method")}</dt><dd>{uiText(workMethod(selected))}</dd></div>
            <div><dt>{uiText("Review")}</dt><dd>{uiText(workReviewState(selected))}</dd></div>
            <div><dt>{uiText("Scale")}</dt><dd>{uiText(scales[selected.sheet_id] ? scaleUnconfirmed[selected.sheet_id] === false ? "Set · needs confirmation" : "Set" : "Not set")}</dd></div>
            <div><dt>{uiText("Geometry")}</dt><dd>{uiText(selected.verts_norm?.length || 0)} {uiText("vertices · ")}{uiText(selected.verts_norm_holes?.length || 0)} {uiText("holes")}</dd></div>
            {evidence.matched_text && <div><dt>{uiText("Drawing text")}</dt><dd>{uiText(String(evidence.matched_text))}</dd></div>}
            {evidence.schedule_row_tag && <div><dt>{uiText("Schedule tag")}</dt><dd>{uiText(String(evidence.schedule_row_tag))}</dd></div>}
          </dl>
          <p className="workspace-receipt-note">{uiText("Recorded provenance. Review status does not verify measurement accuracy.")}</p>
          <div className="workspace-inspector-actions"><button type="button" onClick={() => onLocate(selected)}>{uiText("Show on plan")}</button>{selected.origin?.reviewed === false && <button type="button" className="workspace-primary" onClick={() => onReview(selected.id)}>{uiText("Mark reviewed")}</button>}</div>
        </section>}
        <footer className="workspace-footer"><span>{uiText(rows.length)} {uiText("of ")}{uiText(shapes.length)} {uiText("measurements")}</span><button type="button" onClick={onReport}>{uiText("Open report →")}</button></footer>
      </div>
    </aside>
  );
}
