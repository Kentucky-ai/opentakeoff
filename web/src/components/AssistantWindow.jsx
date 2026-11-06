// The Assistant window — talk to YOUR OWN AI (Claude Desktop, Claude Code,
// Codex, Cursor, …) from inside the canvas. No API key: the model runs in the
// AI app you already use, on the plan you already pay for; the OpenTakeoff MCP
// server in that app carries the conversation here over a private link on this
// computer (lib/assistantLink.js ↔ mcp/src/assistantBridge.ts).
//
// The header says who is answering ("Powered by Claude Code") from the name the
// app announced, and the vector star pulses while it works. Every tool it calls
// shows as a quiet line between messages, so the person sees the work happen.
import { useCallback, useEffect, useRef, useState } from "react";
import { ScanStar } from "../brand/marks.jsx";
import ChatMarkdown from "./ChatMarkdown.jsx";
import { Z } from "../lib/ui.js";
import {
  ASSISTANT_PROMPT, LISTEN_PROMPT, connect, forgetLink, pair, poweredByName, readPairingHash, readPairingInput, savedLink, send,
} from "../lib/assistantLink.js";
import "./assistantWindow.css";

function CopyChip({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="ot-asst-copy" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* selectable anyway */ } }}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

export default function AssistantWindow({ open, onOpen, onClose, onConnectHelp, launcher = true }) {
  const [link, setLink] = useState(() => savedLink());
  const [conn, setConn] = useState("idle");          // idle | connecting | live | lost | expired
  const [client, setClient] = useState(null);         // { name, version } as the AI app announced it
  const [bridgeState, setBridgeState] = useState("paused");
  const [events, setEvents] = useState([]);
  const [draft, setDraft] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);            // pairing has hung — usually Chrome's local-network prompt
  useEffect(() => { if (!busy) { setSlow(false); return undefined; } const t = setTimeout(() => setSlow(true), 2500); return () => clearTimeout(t); }, [busy]);
  const listRef = useRef(null);
  const name = poweredByName(client);

  const doPair = useCallback(async (p) => {
    setBusy(true); setErr("");
    try {
      const r = await pair(p);
      setClient(r.poweredBy || null); setEvents([]); setLink(r.link);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }, []);

  // a link from assistant_open (#assistant=PORT.CODE) opens the window and pairs it
  useEffect(() => {
    const fromHash = readPairingHash(window.location.hash);
    if (!fromHash) return;
    history.replaceState(null, "", window.location.pathname + window.location.search);
    onOpen?.();
    doPair(fromHash);
  }, [doPair, onOpen]);

  // the live stream
  useEffect(() => {
    if (!link) return undefined;
    setConn("connecting");
    const close = connect(link, {
      onOpen: () => setConn("live"),
      onLost: (why) => setConn(why === "retrying" ? "lost" : "expired"),
      onEvent: (ev) => {
        if (ev.type === "hello") { setClient(ev.powered_by); setBridgeState(ev.state); setEvents([]); return; }
        if (ev.type === "state") { setBridgeState(ev.state); return; }
        setEvents((list) => (list.some((x) => x.id === ev.id) ? list : [...list, ev]));
      },
    });
    return close;
  }, [link]);

  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [events, bridgeState, open]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || !link) return;
    setDraft(""); setErr("");
    try { await send(link, text); }
    catch (e) { setErr(e.message); setDraft(text); if (e.expired) { forgetLink(); setLink(null); } }
  };

  const working = conn === "live" && bridgeState === "working";
  const paired = !!link && conn !== "expired";
  if (!open && !launcher) return null;
  if (!open) {
    // closed: the launcher, which still shows the star working while the AI does something
    return (
      <button type="button" className="ot-asst-launch" onClick={onOpen} title={paired ? `Assistant — ${name}` : "Assistant — talk to your own AI here"}
        style={{ zIndex: Z.drawer }}>
        <ScanStar size={18} working={working} />
        <span>Assistant</span>
      </button>
    );
  }

  return (
    <section className="ot-asst" role="dialog" aria-label="Assistant" style={{ zIndex: Z.modal - 1 }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onClose(); }}>
      <header className="ot-asst-head">
        <ScanStar size={20} working={working} title={working ? `${name} is working` : undefined} />
        <div className="ot-asst-title">
          <strong>Assistant</strong>
          <small>{paired ? <>Powered by <b>{name}</b>{client?.version ? <span className="ot-asst-ver"> {client.version}</span> : null}</> : "Your own AI, inside OpenTakeoff"}</small>
        </div>
        {paired && <span className={`ot-asst-dot is-${conn === "live" ? bridgeState : conn}`} title={conn === "live" ? bridgeState : conn} />}
        <button type="button" className="ot-asst-x" onClick={onClose} aria-label="Close the Assistant">×</button>
      </header>

      {!paired ? (
        <div className="ot-asst-setup">
          <p>Talk to the AI you already use — Claude, Codex, Cursor and others — right here, on its own subscription. No API key.</p>
          <ol>
            <li>Add OpenTakeoff to your AI app once. <button type="button" className="ot-asst-linkbtn" onClick={onConnectHelp}>How to connect</button></li>
            <li>In your AI, say: <span className="ot-asst-say">{ASSISTANT_PROMPT}</span> <CopyChip text={ASSISTANT_PROMPT} /></li>
            <li>Open the link it gives you — or type its code here:</li>
          </ol>
          <form className="ot-asst-pair" onSubmit={(e) => { e.preventDefault(); const p = readPairingInput(code); if (p) doPair(p); else setErr("That isn't a 6-character code."); }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABC123" aria-label="Pairing code" autoComplete="off" spellCheck={false} />
            <button type="submit" disabled={busy || !code.trim()}>{busy ? "Pairing…" : "Pair"}</button>
          </form>
          {slow && <p className="ot-asst-note">Waiting on your browser — if it asks to let this site <b>reach apps and services on this device</b>, choose <b>Allow</b>. That's how the window reaches your AI on this computer; nothing goes online.</p>}
          {conn === "expired" && <p className="ot-asst-note">The last link ended (your AI app restarted). Ask it again to open the assistant.</p>}
        </div>
      ) : (
        <div className="ot-asst-log" ref={listRef} aria-live="polite">
          {!events.length && <p className="ot-asst-empty">Connected to <b>{name}</b>. Ask it anything about this takeoff.</p>}
          {events.map((ev) => (
            ev.type === "user" ? <div key={ev.id} className="ot-asst-msg is-user">{ev.text}</div>
              : ev.type === "say" ? <div key={ev.id} className="ot-asst-msg is-ai"><ChatMarkdown text={ev.text} /></div>
              : ev.type === "activity" ? <div key={ev.id} className={`ot-asst-act${ev.ok ? "" : " is-err"}`}>{ev.ok ? "✓" : "✕"} {ev.tool.replace(/_/g, " ")} <span>· {fmtMs(ev.ms)}</span></div>
              : null
          ))}
          {working && <div className="ot-asst-working"><ScanStar size={16} working /> {name} is working…</div>}
        </div>
      )}

      {paired && (
        <footer className="ot-asst-foot">
          {bridgeState === "paused" && conn === "live" && (
            <div className="ot-asst-note">{name} stopped listening after a quiet spell. Say <span className="ot-asst-say">{LISTEN_PROMPT}</span> in {name} to bring it back. <CopyChip text={LISTEN_PROMPT} /></div>
          )}
          {conn === "lost" && <div className="ot-asst-note">Reconnecting to {name}…</div>}
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder={`Message ${name}…`} aria-label={`Message ${name}`}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
            <button type="submit" disabled={!draft.trim()}>Send</button>
          </form>
          <div className="ot-asst-meta">
            <span>Runs in {name} on this computer — no API key.</span>
            <button type="button" className="ot-asst-linkbtn" onClick={() => { forgetLink(); setLink(null); setEvents([]); setClient(null); setConn("idle"); }}>Disconnect</button>
          </div>
        </footer>
      )}
      {err && <p className="ot-asst-err" role="alert">{err}</p>}
    </section>
  );
}
