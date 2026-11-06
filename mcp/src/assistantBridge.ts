// The Assistant window bridge — lets the person talk to THEIR OWN AI (Claude
// Desktop, Claude Code, Codex, Cursor, …) from inside the OpenTakeoff canvas.
//
// MCP only runs one way: the AI app calls our tools. So the window doesn't call
// the AI; the AI listens to the window. assistant_open starts a tiny HTTP server
// on 127.0.0.1 (no dependencies — node:http + server-sent events), the canvas
// pairs with it by a one-time code, and from then on:
//   - assistant_listen waits for what the person types in the window,
//   - assistant_say puts the AI's reply in the window,
//   - every other tool call shows in the window as it happens (the vector star
//     pulses while the AI works).
// Nothing leaves the machine: the model runs in the person's own AI app on the
// plan they already pay for; this bridge only carries text between that app
// and a browser tab on the same computer.
//
// Safety: a page on ANY website can try to reach 127.0.0.1, and a message that
// reaches the agent is a prompt with the agent's file access. So every request
// must come from an allowed Origin (the hosted app, or a local dev server) AND
// carry the pairing token handed out with the code. The code is shown only to
// the agent's user (in their AI app) and is good for one pairing.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

export const ASSISTANT_APP_URL = "https://opentakeoff.kentucky-ai.com/";
export const PORTS = [47615, 47616, 47617, 47618, 47619];
/** After this long with nothing typed in the window, assistant_listen tells the agent to stop. */
export const IDLE_SLEEP_MS = 10 * 60 * 1000;
export const LISTEN_DEFAULT_S = 45;
export const LISTEN_MAX_S = 240;
const MAX_TEXT = 20_000;

const DEFAULT_ORIGINS = ["https://opentakeoff.kentucky-ai.com"];
export function originAllowed(origin: string | undefined, extra: string[] = []): boolean {
  if (!origin) return false;
  if (DEFAULT_ORIGINS.includes(origin) || extra.includes(origin)) return true;
  // a local dev server / self-hosted build on this machine
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)
    || /^https:\/\/deploy-preview-\d+--opentakeoff\.netlify\.app$/.test(origin);
}

export type WindowEvent =
  | { type: "hello"; powered_by: ClientId; state: BridgeState }
  | { type: "state"; state: BridgeState }
  | { type: "say"; id: string; text: string; at: number }
  | { type: "user"; id: string; text: string; at: number }
  | { type: "activity"; id: string; tool: string; ok: boolean; ms: number; at: number };
export type BridgeState = "listening" | "working" | "paused";
export type ClientId = { name: string; version: string };

type Waiter = { resolve: (text: string | null) => void; timer: NodeJS.Timeout };

export class AssistantBridge {
  server: Server | null = null;
  port = 0;
  code = "";
  token = "";
  paired = false;
  state: BridgeState = "paused";
  private inbox: string[] = [];
  private waiter: Waiter | null = null;
  private clients = new Set<ServerResponse>();
  private history: WindowEvent[] = [];
  private lastUserAt = Date.now();
  private seq = 0;
  constructor(private client: () => ClientId, private extraOrigins: string[] = (process.env.OPENTAKEOFF_ASSISTANT_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)) {}

  get active(): boolean { return !!this.server; }

  /** Start (or restart pairing on) the local server. Returns where the window should connect. */
  async open(): Promise<{ port: number; code: string; link: string; powered_by: ClientId; already_paired: boolean }> {
    if (!this.server) await this.listen();
    if (!this.paired) { this.code = randomCode(); this.token = randomBytes(18).toString("base64url"); }
    this.lastUserAt = Date.now();
    this.setState("listening");
    return { port: this.port, code: this.code, link: `${ASSISTANT_APP_URL}#assistant=${this.port}.${this.code}`, powered_by: this.client(), already_paired: this.paired };
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tryPort = (i: number) => {
        if (i >= PORTS.length) { reject(new Error(`ports ${PORTS[0]}–${PORTS.at(-1)} on 127.0.0.1 are all in use — close another OpenTakeoff assistant and retry`)); return; }
        const srv = createServer((req, res) => this.handle(req, res));
        srv.once("error", () => tryPort(i + 1));
        srv.listen(PORTS[i], "127.0.0.1", () => { this.server = srv; this.port = PORTS[i]; srv.unref(); resolve(); });
      };
      tryPort(0);
    });
  }

  close(): void {
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.paired = false;
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.resolve(null); this.waiter = null; }
  }

  /** Wait for the person's next message. null = nothing yet (timeout); "sleep" when idle too long. */
  async waitForMessage(waitS: number, onTick?: (elapsedS: number) => void): Promise<{ status: "message" | "timeout" | "sleep"; message: string | null; idle_s: number }> {
    if (!this.active) throw new Error("the Assistant window is not open — call assistant_open first");
    const idle = () => Math.round((Date.now() - this.lastUserAt) / 1000);
    if (this.inbox.length) return this.deliver();
    if (Date.now() - this.lastUserAt >= IDLE_SLEEP_MS) { this.setState("paused"); return { status: "sleep", message: null, idle_s: idle() }; }
    this.setState("listening");
    const ms = Math.max(1, Math.min(LISTEN_MAX_S, waitS)) * 1000;
    const started = Date.now();
    const tick = onTick ? setInterval(() => onTick(Math.round((Date.now() - started) / 1000)), 10_000) : null;
    const got = await new Promise<string | null>((resolve) => {
      if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.resolve(null); }
      this.waiter = { resolve, timer: setTimeout(() => { this.waiter = null; resolve(null); }, ms) };
    });
    if (tick) clearInterval(tick);
    if (got !== null) return this.deliver();
    if (Date.now() - this.lastUserAt >= IDLE_SLEEP_MS) { this.setState("paused"); return { status: "sleep", message: null, idle_s: idle() }; }
    return { status: "timeout", message: null, idle_s: idle() };
  }

  private deliver() {
    const message = this.inbox.splice(0).join("\n\n");
    this.setState("working");
    return { status: "message" as const, message, idle_s: 0 };
  }

  say(text: string): { delivered_to: number } {
    if (!this.active) throw new Error("the Assistant window is not open — call assistant_open first");
    const t = String(text).slice(0, MAX_TEXT);
    this.push({ type: "say", id: this.id(), text: t, at: Date.now() });
    return { delivered_to: this.clients.size };
  }

  /** Mirror a tool call into the window (and keep the star pulsing while the agent works). */
  activity(tool: string, ok: boolean, ms: number): void {
    if (!this.active || !this.paired) return;
    if (this.state !== "working") this.setState("working");
    this.push({ type: "activity", id: this.id(), tool, ok, ms: Math.round(ms), at: Date.now() });
  }

  private setState(state: BridgeState) {
    if (this.state === state) return;
    this.state = state;
    this.broadcast({ type: "state", state });
  }
  private id() { this.seq += 1; return `e${this.seq}`; }
  private push(ev: WindowEvent) {
    this.history.push(ev);
    if (this.history.length > 400) this.history.splice(0, this.history.length - 400);
    this.broadcast(ev);
  }
  private broadcast(ev: WindowEvent) {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  // ── HTTP ────────────────────────────────────────────────────────────────
  private cors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (!originAllowed(origin, this.extraOrigins)) { res.writeHead(403).end(); return false; }
    res.setHeader("Access-Control-Allow-Origin", origin!);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    // Chrome's local-network preflight for a public page reaching 127.0.0.1
    if (req.headers["access-control-request-private-network"]) res.setHeader("Access-Control-Allow-Private-Network", "true");
    return true;
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    if (!this.cors(req, res)) return;
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const authed = () => {
      const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
      return !!this.token && bearer === this.token;
    };
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body)); };

    if (url.pathname === "/pair" && req.method === "POST") {
      return readBody(req).then((raw) => {
        let code = "";
        try { code = String(JSON.parse(raw).code || "").trim().toUpperCase(); } catch { /* bad json */ }
        if (!this.code || code !== this.code) { json(401, { error: "That code doesn't match — ask your AI for a fresh one (assistant_open)." }); return; }
        this.paired = true;
        this.code = "";                      // one pairing per code
        json(200, { token: this.token, powered_by: this.client(), state: this.state });
      });
    }
    if (url.pathname === "/events" && req.method === "GET") {
      if (!authed()) { json(401, { error: "not paired" }); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", powered_by: this.client(), state: this.state })}\n\n`);
      for (const ev of this.history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => { clearInterval(ping); this.clients.delete(res); });
      return;
    }
    if (url.pathname === "/send" && req.method === "POST") {
      if (!authed()) { json(401, { error: "not paired" }); return; }
      return readBody(req).then((raw) => {
        let text = "";
        try { text = String(JSON.parse(raw).text || "").trim().slice(0, MAX_TEXT); } catch { /* bad json */ }
        if (!text) { json(400, { error: "empty message" }); return; }
        const ev: WindowEvent = { type: "user", id: this.id(), text, at: Date.now() };
        this.push(ev);
        this.lastUserAt = Date.now();
        this.inbox.push(text);
        if (this.waiter) { clearTimeout(this.waiter.timer); const w = this.waiter; this.waiter = null; w.resolve(text); }
        json(200, { ok: true, id: ev.id, listening: this.state !== "paused" });
      });
    }
    json(404, { error: "not found" });
  }
}

function randomCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I
  const b = randomBytes(6);
  return [...b].map((x) => A[x % A.length]).join("");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { raw += c; if (raw.length > MAX_TEXT * 2) req.destroy(); });
    req.on("end", () => resolve(raw));
    req.on("error", () => resolve(""));
  });
}
