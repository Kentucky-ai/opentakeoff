// The Doors suite's side panel: what was found on the sheet, what the
// documents leave open (To review), every opening (All doors) and the hardware
// sets. Plain language for someone opening it for the first time.
//
// Stateless about the takeoff: the canvas owns the reading (lib/doorSuite.ts)
// and the answers; this renders them and reports clicks.
import React from "react";
import { countLine, doorSetColor as setColor } from "../lib/doorSuite.ts";
import "./doorsSuitePanel.css";

function Elevation({ opening, color }) {
  const r = opening.row;
  const glass = r && r.glass && r.glass !== "-";
  const leaves = opening.leaves;
  const W = 112, H = 196, pad = 10, gap = 2;
  const lw = (W - pad * 2 - gap * (leaves - 1)) / leaves;
  return (
    <svg className="ds-elev" width={W} height={H + 16} viewBox={`0 0 ${W} ${H + 16}`} role="img"
      aria-label={`Door ${opening.mark || ""} drawn from its schedule row: ${leaves === 2 ? "a pair, two leaves in one frame" : "one leaf"}${glass ? ", with a glass lite" : ""}. A size schematic, not the architect's elevation.`}>
      <rect x={2} y={2} width={W - 4} height={H - 2} fill="none" stroke="currentColor" strokeWidth={2.5} opacity={0.7} />
      {Array.from({ length: leaves }, (_, k) => {
        const x = pad + k * (lw + gap);
        const knobX = leaves === 2 ? (k === 0 ? x + lw - 8 : x + 8) : x + lw - 8;
        return (
          <g key={k}>
            <rect x={x} y={pad} width={lw} height={H - pad} fill="var(--paper-bright)" stroke={color} strokeWidth={2} />
            {glass && <rect x={x + lw * 0.22} y={pad + 18} width={lw * 0.56} height={(H - pad) * 0.34} fill="none" stroke={color} strokeWidth={1.4} opacity={0.8} />}
            <circle cx={knobX} cy={pad + (H - pad) * 0.52} r={2.6} fill={color} />
          </g>
        );
      })}
      <text x={W / 2} y={H + 13} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.75}>{r ? `${r.width} × ${r.height}` : "size not scheduled"}</text>
    </svg>
  );
}

function scheduledLabel(r) {
  const pair = /\b[A-Z]{1,3}\s?2$/.test((r.doorType || "").split(",")[0].trim()) || /^[6-9]'/.test(r.width || "");
  return [pair ? "Pair" : "Single", r.width && `${r.width} × ${r.height}`, r.hwSet && `set ${r.hwSet}`].filter(Boolean).join(" · ");
}

function Btn({ kind = "plain", children, ...rest }) {
  return <button type="button" className={`ds-btn ds-btn-${kind}`} {...rest}>{children}</button>;
}

export default function DoorsSuitePanel({
  sheetLabel, status, view, schedule, sets, setOrder, answers, sel,
  coach, onDismissCoach, tab, onTab, onAnswer, onUndo, onSelect, onShowDoor, onShowRow, onShowElevation,
  onShowSet, onAdd, added, onClose,
  compareOn, canCompare, onCompare, selMark, hoverMark, onHoverRow, onPickRow, placed, checks, onCheck, onNote,
}) {
  const rowRefs = React.useRef(new Map());
  // the selected door's row stays in view in the Schedule list
  React.useEffect(() => { const el = selMark && rowRefs.current.get(selMark); if (el) el.scrollIntoView({ block: "nearest" }); }, [selMark, tab]);
  const rows = schedule?.rows || [];
  const checkedN = rows.filter((r) => (checks || {})[`check:${r.mark}`] === "Checked").length;
  const busy = status && status.busy;
  const c = view ? view.counts : null;
  const open = view ? view.questions.filter((q) => !answers[q.id]) : [];
  const done = view ? view.questions.filter((q) => answers[q.id]) : [];
  const total = view ? view.questions.length : 0;
  const pct = total ? Math.round(100 * (total - open.length) / total) : 100;
  // the door card replaces the list, except while checking the schedule row by row
  const opening = view && sel != null && tab !== "schedule" ? view.openings.find((o) => o.door === sel) : null;
  const setMap = new Map((sets || []).map((s) => [s.set, s]));
  const tabs = [
    { id: "review", label: `To review (${open.length})` },
    { id: "doors", label: `All doors (${view ? view.openings.length : 0})` },
    { id: "sets", label: `Hardware sets (${setOrder.length})` },
    ...(rows.length ? [{ id: "schedule", label: `Schedule (${checkedN}/${rows.length})` }] : []),
  ];
  return (
    <aside className="ds-panel" aria-label="Doors suite" data-doors-dock=""
      onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <header className="ds-head">
        <div className="ds-title-row">
          <h2>Doors on {sheetLabel}</h2>
          <button type="button" className="ds-x" aria-label="Close the doors suite (switch the trade back to All trades)" title="Close (back to All trades)" onClick={onClose}>×</button>
        </div>
        {busy && <p className="ds-status" role="status">{status.text}</p>}
        {c && <p className="ds-summary">
          <strong>{countLine(c)}</strong> found on this sheet · <strong>{c.matched}</strong> match the door schedule
          {status?.docsBusy ? null : <>{" · "}<strong className={open.length ? "ds-warn" : "ds-ok"}>{open.length ? `${open.length} need${open.length === 1 ? "s" : ""} your answer` : "nothing left to answer"}</strong></>}
        </p>}
        {c && <div className="ds-bar" aria-hidden="true"><div style={{ width: `${pct}%` }} /></div>}
        {status && status.note && <p className="ds-note">{status.note}</p>}
        {c && (
          <div className="ds-compare">
            <Btn kind="primary" disabled={!c.openings} onClick={onAdd}>{added ? "Update estimate" : `Add ${c.openings} opening${c.openings === 1 ? "" : "s"} to estimate`}</Btn>
            <span className="ds-muted">{open.length ? `answer ${open.length} more to finish` : `${countLine(c)} ready`}</span>
          </div>
        )}
        {canCompare && (
          <div className="ds-compare">
            <Btn kind={compareOn ? "ghost" : "plain"} aria-pressed={!!compareOn} onClick={() => { onCompare(); if (!compareOn) onTab("schedule"); }}>
              {compareOn ? "Close the schedule" : `Compare with schedule (${schedule?.label || "schedule sheet"})`}
            </Btn>
            {rows.length > 0 && <span className="ds-muted">{checkedN} of {rows.length} rows checked</span>}
          </div>
        )}
      </header>

      {coach && (
        <section className="ds-coach" aria-label="How the doors suite works">
          <strong>How this works</strong>
          <ol>
            <li>Every door is read from the drawing itself: its swing and leaf are traced on the plan, colored by hardware set.</li>
            <li>Each door is matched to the door schedule by its tag, and the hardware sets to spec section 08 71 00. Anything the documents leave open shows up under <b>To review</b>.</li>
            <li>Answer those in one click, then add the doors to your estimate: openings, frames and door leaves count separately.</li>
          </ol>
          <Btn kind="ghost" onClick={onDismissCoach}>Got it</Btn>
        </section>
      )}

      <nav className="ds-tabs" aria-label="Doors views">
        {tabs.map((t) => (
          <button key={t.id} type="button" aria-pressed={tab === t.id && !opening} className={tab === t.id && !opening ? "on" : ""} onClick={() => onTab(t.id)}>{t.label}</button>
        ))}
      </nav>

      <div className="ds-body">
        {opening && (() => {
          const r = opening.row;
          const color = setColor(r?.hwSet, setOrder);
          // a question still open on this door: the card shows it, not a verdict
          const pendingQ = view.questions.find((q) => q.door === opening.door && !answers[q.id]) || null;
          const set = r?.hwSet ? setMap.get(String(r.hwSet).toUpperCase()) : null;
          return (
            <section className="ds-card" aria-label="Door details">
              <Btn onClick={() => onSelect(null)}>← All doors</Btn>
              <div className="ds-card-title">
                <span className="ds-dot" style={{ background: color }} />
                <h3>{opening.mark ? `Door ${opening.mark}` : "Door with no number"}</h3>
                <span className="ds-muted">{pendingQ ? "Needs your answer" : opening.withheld ? "Not sure it's a door" : r ? "On the plan, in the schedule" : "On the plan, not in the schedule"}</span>
              </div>
              <p className="ds-counts-as">Counts as: <b>1 opening · 1 frame · {opening.leaves === 2 ? "2 door leaves" : "1 door leaf"}</b>{pendingQ ? " · not counted until you answer below" : opening.leftOut ? " · left out by your answer" : ""}</p>
              {pendingQ && (
                <div className="ds-q ds-q-inline">
                  <p>{pendingQ.text}</p>
                  <p className="ds-why">{pendingQ.why}</p>
                  <div className="ds-actions">
                    <Btn kind="primary" onClick={() => onAnswer(pendingQ.id, pendingQ.answers[0])}>{pendingQ.answers[0]}</Btn>
                    <Btn onClick={() => onAnswer(pendingQ.id, pendingQ.answers[1])}>{pendingQ.answers[1]}</Btn>
                  </div>
                </div>
              )}
              <div className="ds-card-grid">
                <Elevation opening={opening} color={color} />
                <dl>
                  <dt>Door</dt><dd>{opening.pair ? "Pair (2 leaves)" : "Single"}{r?.doorType ? ` · type ${r.doorType}` : ""}</dd>
                  <dt>Size</dt><dd className="ds-mono">{r ? `${r.width} × ${r.height}` : "Not scheduled"}</dd>
                  <dt>Material</dt><dd>{r ? [r.material, r.finish].filter(Boolean).join(", ") || "Not stated" : "Not scheduled"}</dd>
                  <dt>Glass</dt><dd>{r ? (r.glass && r.glass !== "-" ? r.glass : "None") : "Not scheduled"}</dd>
                  <dt>Frame</dt><dd>{r ? [r.frameType, r.frameMaterial, r.frameFinish].filter((x) => x && x !== "-").join(", ") || "Not stated" : "Not scheduled"}</dd>
                  <dt>Fire rating</dt><dd>{r ? (r.rating && !/^(0|-|NONE|N\/A)$/i.test(r.rating) ? r.rating : "None listed") : "Not scheduled"}</dd>
                  <dt>Rooms</dt><dd>{r ? [r.fromRoom, r.toRoom].filter(Boolean).join(" to ") || "Not stated" : "Not scheduled"}</dd>
                  <dt>Hardware</dt><dd>{r?.hwSet ? `Set ${r.hwSet}` : "Not scheduled"}</dd>
                </dl>
              </div>
              {set && <p className="ds-set-line" style={{ borderLeftColor: color }}><b>Set {set.set}{set.label ? ` · ${set.label}` : ""}:</b> {set.items}</p>}
              <p className="ds-source">{r ? `From the door schedule on ${schedule?.label || "the schedule sheet"}, row ${r.mark}.` : "Read from the plan's linework; no schedule row carries this door."}{set ? " Hardware from spec section 08 71 00, 2.1." : ""}</p>
              <div className="ds-actions">
                <Btn onClick={() => onShowDoor(opening.door)}>Show on plan</Btn>
                {r && <Btn onClick={() => onShowRow(r.mark)}>Show schedule row</Btn>}
                {r?.doorType && <Btn onClick={() => onShowElevation(r.doorType)}>Show door type {r.doorType.split(",")[0].trim()} elevation</Btn>}
              </div>
            </section>
          );
        })()}

        {!opening && tab === "review" && (
          <>
            {!busy && !status?.docsBusy && view && open.length === 0 && <p className="ds-done">Nothing left to review on this sheet. Add the doors to your estimate below.</p>}
            {open.map((q) => (
              <article key={q.id} className="ds-q">
                <span className={`ds-tag ds-tag-${q.kind}`}>{({ withheld: "Not sure it's a door", untagged: "Door with no number", unplaced: "Scheduled, not found", hardware: "Hardware set", pair: "Pair or single", ambiguous: "Which tag?" })[q.kind]}</span>
                <p>{q.text}</p>
                <p className="ds-why">{q.why}</p>
                <div className="ds-actions">
                  <Btn kind="primary" onClick={() => onAnswer(q.id, q.answers[0])}>{q.answers[0]}</Btn>
                  <Btn onClick={() => onAnswer(q.id, q.answers[1])}>{q.answers[1]}</Btn>
                  <button type="button" className="ds-link" onClick={() => (q.door != null ? onShowDoor(q.door) : onShowRow(q.mark))}>Show me</button>
                </div>
              </article>
            ))}
            {done.length > 0 && <>
              <h4 className="ds-sub">Answered</h4>
              {done.map((q) => (
                <div key={q.id} className="ds-answered">
                  <span>{q.mark ? `Door ${q.mark}` : q.kind === "withheld" ? "Unsure swing" : q.kind === "ambiguous" ? "Door tag" : "Door with no number"}: <b>{answers[q.id]}</b></span>
                  <Btn onClick={() => onUndo(q.id)}>Undo</Btn>
                </div>
              ))}
            </>}
          </>
        )}

        {!opening && tab === "doors" && view && (
          <table className="ds-table">
            <thead><tr><th>Door</th><th>Type</th><th>Size</th><th>Set</th><th>Status</th></tr></thead>
            <tbody>
              {[...view.openings].sort((a, b) => (a.mark ? 0 : 1) - (b.mark ? 0 : 1) || String(a.mark || "").localeCompare(String(b.mark || ""), undefined, { numeric: true })).map((o) => {
                const q = view.questions.find((x) => x.door === o.door && !answers[x.id]);
                return (
                  <tr key={o.door} className={o.leftOut ? "ds-out" : ""}>
                    <td><button type="button" className="ds-row-btn" onClick={() => onSelect(o.door)}>
                      <span className="ds-dot" style={{ background: setColor(o.row?.hwSet, setOrder), opacity: o.withheld ? 0.5 : 1 }} />{o.mark || "no number"}</button></td>
                    <td>{o.pair ? "Pair (2 leaves)" : "Single"}{o.row?.doorType ? ` · ${o.row.doorType}` : ""}</td>
                    <td className="ds-mono">{o.row ? o.row.width : "—"}</td>
                    <td>{o.row?.hwSet || "—"}</td>
                    <td className={q ? "ds-warn" : o.leftOut ? "ds-muted" : "ds-ok"}>{q ? "Question" : o.leftOut ? "Left out" : "Counted"}</td>
                  </tr>
                );
              })}
              {view.unplaced.map((r) => (
                <tr key={`u-${r.mark}`}>
                  <td><button type="button" className="ds-row-btn" onClick={() => onShowRow(r.mark)}><span className="ds-dot" style={{ background: "transparent", border: `2px solid ${setColor(r.hwSet, setOrder)}` }} />{r.mark}</button></td>
                  <td>{r.doorType || "—"}</td><td className="ds-mono">{r.width}</td><td>{r.hwSet || "—"}</td>
                  <td className="ds-warn">Not found on plan</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!opening && tab === "schedule" && (
          <>
            <p className="ds-muted">{compareOn ? "The schedule sheet is open below the plan. Each row is boxed in its door's color; dashed amber means no door was found for it. Click a row to see its door." : "Open the schedule beside the plan to check each row against its door."}</p>
            <ul className="ds-rows">
              {rows.map((r) => {
                const chk = (checks || {})[`check:${r.mark}`] || null;
                const note = (checks || {})[`note:${r.mark}`] || "";
                const on = placed && placed.has(r.mark);
                return (
                  <li key={r.mark} ref={(el) => { if (el) rowRefs.current.set(r.mark, el); else rowRefs.current.delete(r.mark); }}
                    className={`ds-srow${selMark === r.mark ? " sel" : ""}${hoverMark === r.mark ? " hot" : ""}`}
                    onPointerEnter={() => onHoverRow(r.mark)} onPointerLeave={() => onHoverRow(null)}>
                    <button type="button" className="ds-srow-main" onClick={() => onPickRow(r.mark)} aria-label={`Door ${r.mark}: show it on the plan and in the schedule`}>
                      <span className="ds-dot" style={on ? { background: setColor(r.hwSet, setOrder) } : { background: "transparent", border: "2px dashed #d97706" }} />
                      <b>{r.mark}</b>
                      <span className="ds-muted">{scheduledLabel(r)}</span>
                      {!on && <span className="ds-warn ds-small">not on plan</span>}
                    </button>
                    <div className="ds-checks" role="group" aria-label={`Check row ${r.mark}`}>
                      <button type="button" aria-pressed={chk === "Checked"} className={`ds-chk${chk === "Checked" ? " ok" : ""}`} onClick={() => onCheck(r.mark, "Checked")}>Checked</button>
                      <button type="button" aria-pressed={chk === "Needs a look"} className={`ds-chk${chk === "Needs a look" ? " look" : ""}`} onClick={() => onCheck(r.mark, "Needs a look")}>Needs a look</button>
                    </div>
                    {chk === "Needs a look" && (
                      <input className="ds-note-in" type="text" aria-label={`Note for row ${r.mark}`} placeholder="What needs a look? (optional)" defaultValue={note}
                        onBlur={(e) => onNote(r.mark, e.target.value.trim())} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {!opening && tab === "sets" && (
          <>
            <p className="ds-muted">{sets && sets.length ? "Read from spec section 08 71 00. Each set's color matches its doors on the plan and its rows in the schedule." : "No spec section 08 71 00 found in the loaded files. Sets come from the door schedule's hardware column; add the project manual PDF to see each set's items."}</p>
            {setOrder.map((n) => {
              const s = setMap.get(n);
              const doors = (schedule?.rows || []).filter((r) => String(r.hwSet).toUpperCase() === n).map((r) => r.mark);
              return (
                <article key={n} className="ds-set" style={{ borderLeftColor: setColor(n, setOrder) }}>
                  <div className="ds-set-head"><b>Hardware set {n}</b>{s?.label ? <span className="ds-muted"> · {s.label}</span> : null}<span className="ds-muted ds-right">{doors.length} opening{doors.length === 1 ? "" : "s"}</span></div>
                  {s ? <p>{s.items}</p> : <p className="ds-muted">Not in the spec that's loaded.</p>}
                  <div className="ds-chips">{doors.map((m) => <button key={m} type="button" className="ds-chip" onClick={() => onShowSet(m)}>{m}</button>)}</div>
                </article>
              );
            })}
          </>
        )}
      </div>

    </aside>
  );
}
