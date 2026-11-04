// Agent chat — the Agent tab of the "Work and review" panel. A conversation
// with the user's OWN model (ai.js: their endpoint, their key) driving the
// app's deterministic tools (lib/agentTools) through lib/agentLoop. Each
// assistant turn shows its answer, a collapsible list of every tool step, and
// how many proposals it staged; staged proposals still land as dashed
// outlines behind the same Accept / Reject gate. No model configured → a
// connect state pointing at AI settings, and at Connect your AI for people
// who drive OpenTakeoff from Claude Desktop, Codex or Cursor over MCP.
//
// Styling: styles/agentChat.css (imported by the canvas so this file stays
// renderable in Node tests).
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { ScanStar } from "../brand/marks.jsx";
import ChatMarkdown from "./ChatMarkdown.jsx";
import { stagedNote } from "../lib/agentChat.js";

export const CHAT_SUGGESTIONS = [
  { title: "Read the finish schedule", hint: "Every finish code with its material and maker.", prompt: "Find the finish schedule in this set and list every finish code with its material and manufacturer." },
  { title: "Trace the rooms on this sheet", hint: "Staged as dashed proposals for you to accept.", prompt: "Trace the rooms on this sheet and stage each one as a proposal under its finish code from the schedule." },
  { title: "List the sheets", hint: "And which ones still need a scale.", prompt: "List the sheets in this project and say which ones still need a scale set." },
  { title: "Check the conditions", hint: "Schedule codes with no condition yet.", prompt: "List the takeoff conditions in this project and flag any finish code on the schedule that has no condition yet." },
];

const evidenceText = (ev) => {
  if (!ev) return "";
  const bits = [];
  if (ev.schedule_row_tag) bits.push(`schedule ${ev.schedule_row_tag}`);
  if (ev.matched_text && ev.matched_text !== ev.schedule_row_tag) bits.push(`“${ev.matched_text}”`);
  if (Array.isArray(ev.seed_norm)) bits.push(`seed (${(+ev.seed_norm[0]).toFixed(2)}, ${(+ev.seed_norm[1]).toFixed(2)})`);
  return bits.join(" · ");
};

const STEP_MARK = { running: null, done: "✓", failed: "✕", stopped: "–" };

function Steps({ turn }) {
  const running = turn.status === "running";
  const tools = turn.steps.filter((s) => s.kind === "tool");
  const [open, setOpen] = useState(false);
  if (!turn.steps.length) return null;
  const current = running ? [...tools].reverse().find((s) => s.status === "running") : null;
  const failed = tools.filter((s) => s.status === "failed").length;
  const summary = running
    ? (current ? current.label : "Working")
    : `${tools.length} ${tools.length === 1 ? "step" : "steps"}${failed ? ` · ${failed} failed` : ""}`;
  return (
    <div className="ac-steps">
      <button type="button" className="ac-steps-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {running ? <span className="ac-spin" aria-hidden="true" /> : <span className="ac-steps-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>}
        <span className="ac-steps-sum">{summary}</span>
        <span className="ac-steps-more">{open ? "Hide steps" : "Show every step"}</span>
      </button>
      {open && (
        <ol className="ac-trace">
          {turn.steps.map((s, i) => s.kind === "say" ? (
            <li key={i} className="ac-step-say">{s.text}</li>
          ) : (
            <li key={i} className={`ac-step ac-step-${s.status}`}>
              <span className="ac-step-mark" aria-label={s.status}>{STEP_MARK[s.status] ?? <span className="ac-spin" />}</span>
              <span className="ac-step-text">
                {s.label}
                {s.detail ? <span className="ac-step-detail"> — {s.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// memo: a streaming reply replaces only its own turn object, so the turns
// above it don't re-render (or re-parse their markdown) on every token
const ChatTurn = memo(function ChatTurn({ turn }) {
  const running = turn.status === "running";
  const note = stagedNote(turn);
  return (
    <div className="ac-turn">
      <div className="ac-ask"><div className="ac-ask-text">{turn.goal}</div></div>
      <div className="ac-reply">
        <Steps turn={turn} />
        {turn.text ? <ChatMarkdown text={turn.text} className={running ? "ac-md-streaming" : ""} />
          : running ? <div className="ac-thinking"><ScanStar size={12} working /> Thinking…</div> : null}
        {note && <div className="ac-staged"><span className="ac-staged-pip" aria-hidden="true" />{note}</div>}
        {turn.error && <div className={`ac-error${turn.status === "capped" ? " ac-error-soft" : ""}`} role="alert">{turn.error}</div>}
        {turn.status === "stopped" && <div className="ac-note">Stopped.</div>}
      </div>
    </div>
  );
});

function ConnectState({ onOpenSettings, onOpenConnect, compact = false }) {
  return (
    <div className={`ac-connect${compact ? " ac-connect-compact" : ""}`}>
      {!compact && <div className="ac-connect-ico"><ScanStar size={18} /></div>}
      <h3>Connect your model to chat</h3>
      <p>
        The chat runs on a model you bring — your own API key and endpoint, or a local runtime.
        It reads this project with OpenTakeoff's own tools and stages dashed proposals you accept or reject.
        Nothing is sent anywhere until you connect one.
      </p>
      <button type="button" className="ac-btn ac-btn-primary" onClick={onOpenSettings}>AI settings…</button>
      <p className="ac-muted">
        Using Claude Desktop, Codex or Cursor? Connect them to OpenTakeoff over MCP instead.{" "}
        <button type="button" className="ac-link" onClick={onOpenConnect}>Connect your AI</button>
      </p>
    </div>
  );
}

function ProposalTray({ proposals, condById, sheetLabel, fmtArea, onAccept, onReject, onAcceptAll, onRejectAll }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="ac-tray">
      <div className="ac-tray-head">
        <button type="button" className="ac-tray-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> Waiting for review · {proposals.length}
        </button>
        <button type="button" className="ac-mini ac-mini-ok" onClick={onAcceptAll} title="Accept every visible proposal (⏎ on the canvas does the same)">Accept all</button>
        <button type="button" className="ac-mini ac-mini-bad" onClick={onRejectAll} title="Discard every pending proposal (local only — nothing is recorded)">Reject all</button>
      </div>
      {open && (
        <div className="ac-tray-list">
          {proposals.map((p) => {
            const cond = condById[p.condition_id];
            const ev = evidenceText(p.evidence);
            return (
              <div key={p.id} className="ac-prop">
                <span className="ac-prop-swatch" style={{ background: cond?.color || "var(--cobalt)" }} />
                <span className="ac-prop-body">
                  <span><strong>{cond?.finish_tag || "?"}</strong>{p.measure_role === "deduct" ? " (deduct)" : ""} · {sheetLabel(p.sheet_id)}{p.area_sf != null ? ` · ${fmtArea(p.area_sf)}` : ""}</span>
                  <small title={ev}>{ev || "no evidence"}</small>
                </span>
                <button type="button" className="ac-mini ac-mini-ok" onClick={() => onAccept(p.id)} title="Accept — commits as a takeoff (origin: agent, human-reviewed)" aria-label="Accept proposal">✓</button>
                <button type="button" className="ac-mini ac-mini-bad" onClick={() => onReject(p.id)} title="Reject — discard this proposal (local only)" aria-label="Reject proposal">✕</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Composer({ configured, running, draft, setDraft, inputRef, onSend, onStop }) {
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  }, [draft, inputRef]);
  const canSend = configured && !running && !!draft.trim();
  const send = () => { if (canSend) { onSend(draft.trim()); setDraft(""); } };
  return (
    <form className="ac-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <textarea
        ref={inputRef} name="agent-chat-input" className="ac-input" rows={1} value={draft}
        disabled={!configured}
        placeholder={configured ? "Ask about this project…" : "Connect a model to start chatting"}
        aria-label="Message the agent"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing) { e.preventDefault(); send(); }
        }}
      />
      <div className="ac-toolbar">
        <span className="ac-hint">{running ? "Working — proposals land dashed on the plan." : "Enter sends · Shift+Enter: new line"}</span>
        {running
          ? <button type="button" className="ac-send ac-send-stop" onClick={onStop}><span aria-hidden="true">■</span> Stop</button>
          : <button type="submit" className="ac-send" disabled={!canSend}>Send</button>}
      </div>
    </form>
  );
}

export default function AgentChat({
  configured, modelLabel = "", running, turns, proposals, condById, sheetLabel, fmtArea,
  onSend, onStop, onAccept, onReject, onAcceptAll, onRejectAll, onOpenSettings, onOpenConnect, onClear,
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);   // follow the stream unless the reader scrolled up

  const last = turns[turns.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [turns.length, last]);

  const pick = (s) => {
    setDraft(s.prompt);
    requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  };

  return (
    <div className="ac-panel">
      <div className="ac-bar">
        <span className={`ac-model${configured ? "" : " ac-model-off"}`} title={configured ? "Runs on your own model and key" : "No model connected"}>
          <span className="ac-model-dot" aria-hidden="true" />
          {configured ? <>Your model{modelLabel ? <> · <code>{modelLabel}</code></> : null}</> : "No model connected"}
        </span>
        <span className="ac-gap" />
        {turns.length > 0 && <button type="button" className="ac-mini" onClick={onClear} disabled={running} title="Clear this project's conversation">New chat</button>}
        <button type="button" className="ac-icon-btn" onClick={onOpenSettings} title="AI settings (endpoint / model / key)" aria-label="AI settings"><Icon name="sliders" size={13} /></button>
      </div>

      <div className="ac-scroll" ref={scrollRef}
        onScroll={(e) => { const el = e.currentTarget; pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
        {turns.length === 0 ? (
          configured ? (
            <div className="ac-empty">
              <div className="ac-hello">
                <h3>What should we work on?</h3>
                <p>Ask about this project. Your model reads the sheets with OpenTakeoff's tools; anything it measures lands as a dashed proposal for you to accept or reject.</p>
              </div>
              <div className="ac-starters">
                {CHAT_SUGGESTIONS.map((s) => (
                  <button key={s.title} type="button" className="ac-starter" onClick={() => pick(s)}>
                    <strong>{s.title}</strong><span>{s.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : <ConnectState onOpenSettings={onOpenSettings} onOpenConnect={onOpenConnect} />
        ) : (
          <>
            {turns.map((t) => <ChatTurn key={t.id} turn={t} />)}
            {!configured && <ConnectState compact onOpenSettings={onOpenSettings} onOpenConnect={onOpenConnect} />}
          </>
        )}
      </div>

      {proposals.length > 0 && (
        <ProposalTray proposals={proposals} condById={condById} sheetLabel={sheetLabel} fmtArea={fmtArea}
          onAccept={onAccept} onReject={onReject} onAcceptAll={onAcceptAll} onRejectAll={onRejectAll} />
      )}

      <Composer configured={configured} running={running} draft={draft} setDraft={setDraft} inputRef={inputRef} onSend={onSend} onStop={onStop} />
    </div>
  );
}
