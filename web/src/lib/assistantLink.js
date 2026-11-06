// The canvas half of the Assistant window link (mcp/src/assistantBridge.ts).
//
// The person's own AI app (Claude Desktop, Claude Code, Codex, Cursor, …) runs
// the OpenTakeoff MCP server; calling assistant_open there starts a private
// link on 127.0.0.1 and hands out a one-time code. This file pairs with it,
// streams what the AI says and does (server-sent events), and sends what the
// person types. Nothing goes anywhere but this computer.

const STORE = "ot.assistant.link.v1";
export const ASSISTANT_PROMPT = "Open the OpenTakeoff assistant";
export const LISTEN_PROMPT = "listen";

/** The AI app's own name at MCP initialize → the name people know it by. */
const CLIENT_NAMES = [
  [/^claude-ai$/i, "Claude Desktop"],
  [/^claude-code/i, "Claude Code"],
  [/codex/i, "Codex"],
  [/cursor/i, "Cursor"],
  [/windsurf|codeium/i, "Windsurf"],
  [/gemini/i, "Gemini CLI"],
  [/visual studio code|vscode|copilot/i, "VS Code"],
  [/^zed/i, "Zed"],
  [/goose/i, "Goose"],
  [/cline/i, "Cline"],
  [/chatgpt|openai/i, "ChatGPT"],
];
export function poweredByName(client) {
  const raw = String(client?.name || "").trim();
  if (!raw) return "your AI";
  for (const [re, label] of CLIENT_NAMES) if (re.test(raw)) return label;
  return raw;
}

/** `#assistant=47615.ABC123` → { port, code } (the link assistant_open hands out). */
export function readPairingHash(hash) {
  const m = /(?:^#|&)assistant=(\d{4,5})\.([A-Za-z0-9]{6})(?:&|$)/.exec(hash || "");
  return m ? { port: Number(m[1]), code: m[2].toUpperCase() } : null;
}

/** "47615 ABC123", "ABC123", or a pasted link → { port?, code } */
export function readPairingInput(text) {
  const t = String(text || "").trim();
  const fromLink = readPairingHash(t.includes("#") ? t.slice(t.indexOf("#")) : "");
  if (fromLink) return fromLink;
  const m = /(?:(\d{4,5})\D+)?([A-Za-z0-9]{6})$/.exec(t);
  return m ? { port: m[1] ? Number(m[1]) : null, code: m[2].toUpperCase() } : null;
}

export function savedLink() {
  try { const v = JSON.parse(localStorage.getItem(STORE) || "null"); return v && v.port && v.token ? v : null; } catch { return null; }
}
export function forgetLink() { try { localStorage.removeItem(STORE); } catch { /* storage blocked */ } }

const base = (port) => `http://127.0.0.1:${port}`;
export const BRIDGE_PORTS = [47615, 47616, 47617, 47618, 47619];

/** Pair with a code. Without a port, tries the bridge's ports in order. */
export async function pair({ port, code }) {
  const ports = port ? [port] : BRIDGE_PORTS;
  let last = "No OpenTakeoff assistant is running on this computer — ask your AI to open it first.";
  for (const p of ports) {
    let res;
    try {
      res = await fetch(`${base(p)}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    } catch { continue; }   // nothing on that port
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.token) {
      const link = { port: p, token: body.token };
      try { localStorage.setItem(STORE, JSON.stringify(link)); } catch { /* storage blocked: this tab only */ }
      return { link, poweredBy: body.powered_by, state: body.state };
    }
    last = body.error || `Pairing failed (${res.status}).`;
  }
  throw new Error(last);
}

/** Stream the window's events; returns a close function. */
export function connect(link, { onEvent, onOpen, onLost }) {
  const es = new EventSource(`${base(link.port)}/events?token=${encodeURIComponent(link.token)}`);
  es.onopen = () => onOpen?.();
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* malformed frame */ } };
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) onLost?.(); else onLost?.("retrying"); };
  return () => es.close();
}

export async function send(link, text) {
  const res = await fetch(`${base(link.port)}/send`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${link.token}` }, body: JSON.stringify({ text }),
  });
  if (res.status === 401) throw Object.assign(new Error("The link expired — your AI app restarted. Ask it to open the OpenTakeoff assistant again."), { expired: true });
  if (!res.ok) throw new Error(`Couldn't send (${res.status}).`);
  return res.json();
}
