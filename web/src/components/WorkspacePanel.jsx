import { useEffect, useMemo, useState } from "react";
import { filterWork, workActor, workQuantity, workReviewState } from "../lib/workReview.js";
import { Z } from "../lib/ui.js";
import "./workspacePanel.css";

export default function WorkspacePanel({ shapes, conditions, selectedId, sheetLabel, fmtArea, fmtLength,
  scales, scaleUnconfirmed, running, proposalCount, onLocate, onReview, onClose, onReport, children }) {
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
    <aside className="workspace-panel" aria-label="Work and review" style={{ zIndex: Z.drawer }}>
      <header className="workspace-heading">
        <div><span className="workspace-eyebrow">Shared workspace</span><h2>Work and review</h2></div>
        <button type="button" onClick={onClose} aria-label="Close work panel">×</button>
      </header>
      <div className="workspace-summary">
        <div><strong>{shapes.length}</strong><span>measurements</span></div>
        <div><strong>{pending}</strong><span>need review</span></div>
        <div><strong>{new Set(shapes.map((s) => s.sheet_id)).size}</strong><span>sheets with work</span></div>
      </div>
      <div className="workspace-tabs" role="tablist" aria-label="Workspace views">
        <button type="button" role="tab" id="workspace-work-tab" aria-controls="workspace-work-view" aria-selected={tab === "work"} onClick={() => setTab("work")}>Measurements</button>
        <button type="button" role="tab" id="workspace-agent-tab" aria-controls="workspace-agent-view" aria-selected={tab === "agent"} onClick={() => setTab("agent")}>Agent {running ? "· Working" : proposalCount ? `· ${proposalCount} proposals` : ""}</button>
      </div>
      <div id="workspace-agent-view" role="tabpanel" aria-labelledby="workspace-agent-tab" hidden={tab !== "agent"} className="workspace-agent-view">{children}</div>
      <div id="workspace-work-view" role="tabpanel" aria-labelledby="workspace-work-tab" hidden={tab !== "work"} className="workspace-work-view">
        <div className="workspace-filters">
          <label className="workspace-search"><span>Find work</span><input name="work-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Condition, sheet, label, or author" /></label>
          <div className="workspace-filter-buttons" aria-label="Filter measurements">
            {[["all", "All work"], ["pending", `Needs review · ${pending}`], ["agent", "Agent"]].map(([id, label]) =>
              <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
          </div>
        </div>
        <div className="workspace-list" aria-label="Measurements">
          {!rows.length && <div className="workspace-empty"><h3>{shapes.length ? "No matching work" : "Your measurements appear here"}</h3><p>{shapes.length ? "Change the filter or search to see more measurements." : "Measure on the plan or import an agent’s takeoff. Inspect either actor’s work here, then open its boundary on the drawing."}</p></div>}
          {rows.slice(0, limit).map((shape) => <button type="button" className="workspace-row" key={shape.id} aria-pressed={selectedId === shape.id} onClick={() => onLocate(shape)}>
            <span className="workspace-row-top"><strong>{conditions[shape.condition_id]?.finish_tag || "Unassigned"}{shape.label ? ` · ${shape.label}` : ""}</strong><span className="workspace-quantity">{quantity(shape)}</span></span>
            <span className="workspace-sheet">{sheetLabel(shape.sheet_id)}</span>
            <span className="workspace-row-bottom"><span>{shape.author || workActor(shape)}</span><span className={workReviewState(shape) === "Needs review" ? "workspace-pending" : ""}>{workReviewState(shape)}</span></span>
          </button>)}
          {rows.length > limit && <button type="button" className="workspace-more" onClick={() => setLimit((n) => n + 50)}>Show more · {rows.length - limit} remaining</button>}
        </div>
        {selected && <section className="workspace-inspector" aria-label="Selected measurement">
          <div className="workspace-inspector-title"><h3>Measurement receipt</h3><strong className="workspace-quantity">{quantity(selected)}</strong></div>
          <dl>
            <div><dt>Source</dt><dd>{workActor(selected)}{selected.author ? ` · ${selected.author}` : ""}</dd></div>
            <div><dt>Method</dt><dd>{selected.origin?.method || "Not recorded"}</dd></div>
            <div><dt>Review</dt><dd>{workReviewState(selected)}</dd></div>
            <div><dt>Scale</dt><dd>{scales[selected.sheet_id] ? scaleUnconfirmed[selected.sheet_id] === false ? "Set · needs confirmation" : "Set" : "Not set"}</dd></div>
            <div><dt>Geometry</dt><dd>{selected.verts_norm?.length || 0} vertices · {selected.verts_norm_holes?.length || 0} holes</dd></div>
            {evidence.matched_text && <div><dt>Drawing text</dt><dd>{String(evidence.matched_text)}</dd></div>}
            {evidence.schedule_row_tag && <div><dt>Schedule tag</dt><dd>{String(evidence.schedule_row_tag)}</dd></div>}
          </dl>
          <p className="workspace-receipt-note">Recorded provenance. Review status does not verify measurement accuracy.</p>
          <div className="workspace-inspector-actions"><button type="button" onClick={() => onLocate(selected)}>Show on plan</button>{selected.origin?.reviewed === false && <button type="button" className="workspace-primary" onClick={() => onReview(selected.id)}>Mark reviewed</button>}</div>
        </section>}
        <footer className="workspace-footer"><span>{rows.length} of {shapes.length} measurements</span><button type="button" onClick={onReport}>Open report →</button></footer>
      </div>
    </aside>
  );
}
