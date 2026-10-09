// Connect your AI — the in-app front door to docs/CONNECT.md: put the
// OpenTakeoff MCP server into the AI app you already use, then ask it a first
// question about the same real plan the canvas demo opens.
//
// The commands and the expected answer are transcribed from docs/CONNECT.md,
// which is the source of truth; if a command changes there, it changes here.
// The browser-hosted apps (claude.ai, ChatGPT) get an honest "not yet" — they
// can only reach an MCP server at a public URL, and OpenTakeoff's runs on the
// user's own machine.
import { useEffect, useRef, useState } from "react";
import { Z } from "../lib/ui.js";
import { inOtherModal, otherModalOpen } from "../lib/modalKeys";
import { samplePlanUrl, SAMPLE_PLAN_NAME } from "../lib/samplePlan.js";

const CONNECT_URL = "https://github.com/Kentucky-ai/opentakeoff/blob/main/docs/CONNECT.md";
const AGENT_GUIDE_URL = "https://github.com/Kentucky-ai/opentakeoff/blob/main/docs/AGENT_GUIDE.md";
const MCPB_URL = "https://github.com/Kentucky-ai/opentakeoff/releases/latest/download/opentakeoff-mcp.mcpb";
const NODE_URL = "https://nodejs.org";

const MCP_JSON = `{
  "mcpServers": {
    "opentakeoff": {
      "command": "npx",
      "args": ["-y", "opentakeoff-mcp"]
    }
  }
}`;

const FIRST_ASK = `Using OpenTakeoff, load ${SAMPLE_PLAN_NAME} and tell me how many sheets it has, each sheet's number, and the detected scale.`;
const FIRST_ASK_DESKTOP = `Using OpenTakeoff, load /full/path/to/${SAMPLE_PLAN_NAME} and tell me how many sheets it has, each sheet's number, and the detected scale.`;

function Code({ text, label }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* clipboard blocked — the text is selectable */ }
  };
  return (
    <div style={{ position: "relative", margin: "6px 0 10px" }}>
      <pre style={{ margin: 0, padding: "10px 72px 10px 12px", background: "var(--paper-shadow)", border: "1px solid var(--ink-faint)", fontFamily: "var(--f-mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--ink)" }}>{text}</pre>
      <button type="button" onClick={copy} aria-label={`Copy ${label}`}
        style={{ position: "absolute", top: 6, right: 6, padding: "4px 9px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", color: copied ? "var(--c-positive)" : "var(--ink)", fontSize: 11.5, cursor: "pointer" }}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const P = ({ children }) => <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--ink-soft)", margin: "0 0 8px" }}>{children}</p>;
const A = ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: "var(--cobalt)" }}>{children}</a>;

const TABS = [
  {
    id: "desktop", label: "Claude Desktop", needs: "Nothing else to install",
    body: () => (
      <>
        <P>1. Download <A href={MCPB_URL}>opentakeoff-mcp.mcpb</A> — the link always points at the newest release.</P>
        <P>2. Double-click it. Claude Desktop opens an install prompt; confirm it.</P>
        <P>The bundle carries its own dependencies, so there's no Node or npm to install. It leaves out the optional sheet renderer: every measuring and export tool works, but the agent can't draw sheet images.</P>
      </>
    ),
  },
  {
    id: "claude-code", label: "Claude Code", node: true,
    body: () => (
      <>
        <P>Run this once in any terminal:</P>
        <Code label="Claude Code command" text="claude mcp add --scope user opentakeoff -- npx -y opentakeoff-mcp" />
        <P>Check it — you should see <code>opentakeoff: npx -y opentakeoff-mcp - ✔ Connected</code>:</P>
        <Code label="check command" text="claude mcp list" />
      </>
    ),
  },
  {
    id: "codex", label: "Codex CLI", node: true,
    body: () => (
      <>
        <Code label="Codex command" text={"codex mcp add opentakeoff -- npx -y opentakeoff-mcp\ncodex mcp list"} />
        <P>Codex asks before it runs OpenTakeoff's tools; approve them as they come up.</P>
      </>
    ),
  },
  {
    id: "other", label: "Cursor & others", node: true,
    body: () => (
      <>
        <P>Any app that runs local (“stdio”) MCP servers takes the same entry. In Cursor it goes in <code>~/.cursor/mcp.json</code> (every project) or <code>.cursor/mcp.json</code> (one project):</P>
        <Code label="MCP config" text={MCP_JSON} />
      </>
    ),
  },
  {
    id: "web", label: "claude.ai · ChatGPT", needs: "Not supported yet",
    body: () => (
      <>
        <P>claude.ai in a browser, the Claude mobile app and ChatGPT run in the cloud, not on your computer. They can only reach an MCP server at a public web address, and OpenTakeoff's server runs on your machine and reads your plan files from your disk.</P>
        <P>A hosted server isn't shipped yet. Until it is, use Claude Desktop or a terminal agent — the other tabs.</P>
      </>
    ),
  },
];

export default function ConnectAI({ onClose }) {
  const [tab, setTab] = useState("desktop");
  const dialogRef = useRef(null);
  // Same Esc ownership as the user guide (see UserGuide.jsx): the dialog closes
  // itself, capture phase, so the press can't also back out of a trace.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (inOtherModal(e.target, dialogRef.current) || otherModalOpen(document, dialogRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const cur = TABS.find((t) => t.id === tab);
  const desktop = tab === "desktop";
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: Z.modal, background: "var(--scrim)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", overflow: "auto" }}>
      <div ref={dialogRef} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Connect your AI" className="panel"
        style={{ width: "min(720px, 100%)", background: "var(--paper-bright)", color: "var(--ink)", border: "1px solid var(--ink-faint)", padding: "22px 26px 24px", boxShadow: "var(--shadow-2)", fontFamily: "var(--f-body)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 17, letterSpacing: "-0.02em" }}>Connect your AI</strong>
          <button type="button" onClick={onClose} title="Close (Esc)" aria-label="Close"
            style={{ background: "none", border: "none", color: "var(--ink-soft)", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <P>
          Give an AI agent the same takeoff engine this canvas runs: load a plan set, set the scale, measure rooms, export the marked set.
          It runs on your own computer — the agent reads plans from your disk, nothing is hosted, no account.
        </P>

        <div role="tablist" aria-label="Your AI app" style={{ display: "flex", flexWrap: "wrap", gap: 0, borderBottom: "1px solid var(--ink-faint)", margin: "14px 0 14px" }}>
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} onClick={() => setTab(t.id)}
              style={{ padding: "8px 12px", border: "none", borderBottom: t.id === tab ? "2px solid var(--cobalt)" : "2px solid transparent", marginBottom: -1, background: "transparent", color: t.id === tab ? "var(--ink)" : "var(--ink-muted)", fontWeight: t.id === tab ? 700 : 500, fontSize: 12.5, cursor: "pointer" }}>
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" aria-label={cur.label}>
          <div style={{ marginBottom: 8, fontSize: 12, color: "var(--ink-muted)" }}>
            {cur.node ? <>Needs <A href={NODE_URL}>Node 20+</A> — check with <code>node -v</code></> : cur.needs}
          </div>
          {cur.body()}
        </div>

        {tab !== "web" && (
          <div style={{ borderTop: "1px solid var(--ink-faint)", marginTop: 14, paddingTop: 14 }}>
            <div className="t-label" style={{ marginBottom: 8 }}>Your first question</div>
            <P>
              <a href={samplePlanUrl()} download={SAMPLE_PLAN_NAME} style={{ color: "var(--cobalt)", fontWeight: 700 }}>Download the sample plan</a>{" "}
              — the same VA finish plan the canvas demo opens.{" "}
              {desktop
                ? <>Then ask Claude, with the file's full path (on a Mac: right-click it in Finder, hold Option, <em>Copy … as Pathname</em>):</>
                : <>Start your agent in the folder it downloaded to, and ask:</>}
            </P>
            <Code label="first question" text={desktop ? FIRST_ASK_DESKTOP : FIRST_ASK} />
            <P>You should hear back about two sheets: <strong>AF101</strong> at <strong>1/8″ = 1′-0″</strong>, and <strong>AF600</strong> (the finish schedule) with no scale found. From there, ask it to set the scale and take off a room.</P>
          </div>
        )}

        <div style={{ borderTop: "1px solid var(--ink-faint)", marginTop: 12, paddingTop: 12, fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
          Step by step with troubleshooting: <A href={CONNECT_URL}>the connect guide</A>. How an agent runs a full takeoff: <A href={AGENT_GUIDE_URL}>the agent manual</A>.
        </div>
      </div>
    </div>
  );
}
