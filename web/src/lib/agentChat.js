// Agent chat — the PURE half of the chat window (components/AgentChat.jsx).
// No React, no DOM, no network: the agent loop's event stream (lib/agentLoop
// onEvent) folds into conversation TURNS here, the turns turn back into the
// model's prior-message history here, and the per-project persistence goes
// through an injected {get, put} key-value pair (the canvas hands it
// store.js metaGet/metaPut, the tests hand it a Map).
//
// A turn is one user message and everything the agent did about it:
//   { id, goal, ts, status, text, steps, staged, rejected, error, live? }
//   status: "running" | "done" | "error" | "stopped" | "capped"
//   text:   the assistant's answer (its last reply text) — while a reply is
//           streaming, the text received so far
//   live:   the streaming reply's raw text so far (never persisted)
//   steps:  [{ kind: "tool", name, label, status: "running"|"done"|"failed"|"stopped", detail }
//            | { kind: "say", text }]   — the "show every step" list
//   staged: proposals this turn put at the Accept / Reject gate
//
// Nothing here talks to a model. The model is the user's own (ai.js), and
// what is persisted is only this browser's own conversation record.

export const CHAT_SCHEMA = 1;
export const MAX_TURNS = 50;          // persisted per project; oldest drop first
export const MAX_STEPS = 80;          // per turn
export const MAX_TEXT = 20000;        // chars of answer text kept per turn
export const HISTORY_TURNS = 8;       // prior turns re-sent to the model as context (the default)
export const HISTORY_TURNS_MAX = 20;  // the "Conversation memory" setting's ceiling

/** Any stored / typed value → a whole number of earlier turns in 0..20.
 *  Blank, missing or unreadable → the default (8); 0 is a real choice. */
export function clampHistoryTurns(v) {
  if (v === "" || v == null) return HISTORY_TURNS;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return HISTORY_TURNS;
  return Math.min(HISTORY_TURNS_MAX, Math.max(0, Math.round(n)));
}
const DETAIL_MAX = 160;

const clip = (s, n) => {
  const t = typeof s === "string" ? s : s == null ? "" : String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

let seq = 0;
/** A fresh running turn for a user message. `id`/`ts` are injectable for tests. */
export function newTurn(goal, { id, ts } = {}) {
  seq += 1;
  return {
    id: id || `turn-${Date.now().toString(36)}-${seq}`,
    goal: clip(String(goal || "").trim(), MAX_TEXT),
    ts: ts || new Date().toISOString(),
    status: "running",
    text: "",
    steps: /** @type {any[]} */ ([]),
    staged: 0,
    rejected: 0,
    error: null,
  };
}

// ── step labels ──────────────────────────────────────────────────────────────
const n = (v) => (Array.isArray(v) ? v.length : 0);
const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** A short, human label for one tool call — what the estimator reads in the step list. */
export function toolLabel(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const sheet = typeof a.sheet === "string" && a.sheet ? clip(a.sheet, 40) : "";
  const on = sheet ? ` on ${sheet}` : "";
  switch (name) {
    case "list_sheets": return "List the sheets";
    case "read_sheet_text": return `Read the text${a.region ? " in a region" : ""}${on}`;
    case "read_schedule": return `Read the schedule${on}`;
    case "view_region": return `Look at ${sheet || "the sheet"}`;
    case "one_click": return `Flood-fill a room${on}`;
    case "get_conditions": return "Check the conditions";
    case "create_condition": return `Create condition ${clip(a.finish_tag || "", 24)}`.trim();
    case "propose_shapes": return `Stage ${plural(n(a.shapes), "proposal")}`;
    default: return clip(String(name || "tool"), 40);
  }
}

/** One tool result → a short status line for the step (never the raw payload). */
export function resultDetail(name, result) {
  const r = result && typeof result === "object" ? result : {};
  if (r.error) return clip(r.error, DETAIL_MAX);
  switch (name) {
    case "list_sheets": {
      const sheets = Array.isArray(r.sheets) ? r.sheets : [];
      const unscaled = sheets.filter((s) => s && s.scale_set === false).length;
      return `${plural(sheets.length, "sheet")}${unscaled ? `, ${unscaled} without a scale` : ""}`;
    }
    case "read_sheet_text": return plural(typeof r.count === "number" ? r.count : n(r.items), "text item");
    case "read_schedule": return n(r.rows) ? plural(n(r.rows), "row") : clip(r.note || "no rows", DETAIL_MAX);
    case "view_region": return r.width && r.height ? `${r.width} × ${r.height} px image` : "image";
    case "one_click": return typeof r.area_sf === "number" ? `${Math.round(r.area_sf).toLocaleString("en-US")} SF ring` : "ring";
    case "get_conditions": return plural(n(r.conditions), "condition");
    case "create_condition": return r.note ? `${r.finish_tag || ""} ${r.note}`.trim() : `${r.finish_tag || "condition"} created`;
    case "propose_shapes": {
      const staged = typeof r.staged === "number" ? r.staged : 0;
      return `${staged} staged${n(r.rejected) ? `, ${n(r.rejected)} rejected` : ""}`;
    }
    default: return "";
  }
}

// ── the fold ─────────────────────────────────────────────────────────────────
const settleSteps = (steps, to) => steps.map((s) => (s.kind === "tool" && s.status === "running" ? { ...s, status: to } : s));

/** agentLoop event → next turn (pure; the input turn is never mutated). */
export function foldEvent(turn, ev) {
  if (!turn || !ev || typeof ev !== "object") return turn;
  if (ev.type === "text_delta") {
    // a streamed piece of the current reply: the answer grows in place. Steps
    // are untouched (no copy); the reply's own "text" event closes it.
    const d = typeof ev.text === "string" ? ev.text : "";
    if (!d) return turn;
    const live = clip(`${turn.live || ""}${d}`, MAX_TEXT);
    const shown = live.replace(/^\s+/, "");
    return { ...turn, live, text: shown ? shown : turn.text };
  }
  const t = { ...turn, steps: turn.steps.slice() };
  if ("live" in t) delete t.live;   // any other event ends the reply that was streaming
  switch (ev.type) {
    case "text": {
      const text = clip(String(ev.text || "").trim(), MAX_TEXT);
      if (!text) return t;
      t.text = text;
      if (t.steps.length < MAX_STEPS) t.steps.push({ kind: "say", text: clip(text, 600) });
      return t;
    }
    case "tool_start": {
      if (t.steps.length >= MAX_STEPS) return t;
      t.steps.push({ kind: "tool", name: String(ev.name || ""), label: toolLabel(ev.name, ev.args), status: "running", detail: "" });
      return t;
    }
    case "tool_end": {
      // the last still-running step for this tool (the loop runs calls in order)
      for (let i = t.steps.length - 1; i >= 0; i--) {
        const s = t.steps[i];
        if (s.kind === "tool" && s.status === "running" && s.name === ev.name) {
          const failed = !!(ev.result && ev.result.error);
          t.steps[i] = { ...s, status: failed ? "failed" : "done", detail: resultDetail(ev.name, ev.result) };
          break;
        }
      }
      if (ev.name === "propose_shapes" && ev.result && !ev.result.error) {
        if (typeof ev.result.staged === "number") t.staged += ev.result.staged;
        if (Array.isArray(ev.result.rejected)) t.rejected += ev.result.rejected.length;
      }
      return t;
    }
    case "done": {
      const text = clip(String(ev.text || "").trim(), MAX_TEXT);
      if (text) t.text = text;
      // the final reply is the answer, not a step
      const last = t.steps[t.steps.length - 1];
      if (last && last.kind === "say" && last.text === clip(t.text, 600)) t.steps.pop();
      t.status = "done";
      t.steps = settleSteps(t.steps, "done");
      return t;
    }
    case "error":
      t.status = "error";
      t.error = clip(String(ev.message || "Something went wrong."), 600);
      t.steps = settleSteps(t.steps, "failed");
      return t;
    case "aborted":
      t.status = "stopped";
      t.steps = settleSteps(t.steps, "stopped");
      return t;
    case "max_iterations":
      t.status = "capped";
      t.error = `Stopped at the ${ev.limit || "step"}-step cap — review what's staged.`;
      t.steps = settleSteps(t.steps, "stopped");
      return t;
    default:
      return turn;
  }
}

/** Coalesce streamed text deltas so the chat re-renders a few times a second,
 *  not once per token. apply(id, ev): a text_delta is buffered per turn and
 *  handed to commit({[id]: text}) on the next schedule tick; any other event
 *  first commits that turn's buffered text, then itself, IN ORDER (commit
 *  receives a list of [id, event] pairs). schedule/cancel are injectable
 *  (default setTimeout, ~20 fps) so the tests drive the clock.
 * @param {(pairs: Array<[string, any]>) => void} commit
 * @param {{ schedule?: (fn: () => void) => any, cancel?: (handle: any) => void }} [opts] */
export function createDeltaBatcher(commit, { schedule = (fn) => setTimeout(fn, 50), cancel = (h) => clearTimeout(h) } = {}) {
  const pending = new Map();
  let handle = null;
  const drain = (onlyId) => {
    const out = [];
    for (const [id, text] of [...pending]) {
      if (onlyId !== undefined && id !== onlyId) continue;
      out.push([id, { type: "text_delta", text }]);
      pending.delete(id);
    }
    return out;
  };
  const tick = () => { handle = null; const out = drain(); if (out.length) commit(out); };
  return {
    apply(id, ev) {
      if (ev && ev.type === "text_delta") {
        if (typeof ev.text !== "string" || !ev.text) return;
        pending.set(id, (pending.get(id) || "") + ev.text);
        if (handle == null) handle = schedule(tick);
        return;
      }
      commit([...drain(id), [id, ev]]);
    },
    /** Commit everything buffered now (a run ending, the hook unmounting). */
    flush() { if (handle != null) { cancel(handle); handle = null; } const out = drain(); if (out.length) commit(out); },
    pendingText: (id) => pending.get(id) || "",
  };
}

/** Fold a whole event list (the tests' and a replay's entry point). */
export function foldEvents(turn, events) {
  return (events || []).reduce(foldEvent, turn);
}

/** A turn still "running" with no live run behind it (a reload mid-run, a
 *  finally after a loop that died) becomes "stopped". */
export function settleTurn(turn) {
  if (!turn || turn.status !== "running") return turn;
  return { ...turn, status: "stopped", steps: settleSteps(turn.steps, "stopped") };
}

/** What the turn tells the estimator about the gate. "" when nothing was staged. */
export function stagedNote(turn) {
  if (!turn || !(turn.staged > 0)) return turn && turn.rejected > 0 ? `${plural(turn.rejected, "shape")} refused for missing evidence.` : "";
  const head = `Staged ${plural(turn.staged, "proposal")} for review`;
  const tail = turn.rejected > 0 ? ` (${turn.rejected} refused for missing evidence)` : "";
  return `${head}${tail} — dashed on the plan; accept or reject each one below.`;
}

// ── model context ────────────────────────────────────────────────────────────
/** The AI settings disclosure's words for the Conversation memory setting. */
export function memoryPhrase(n) {
  const k = clampHistoryTurns(n);
  if (k === 0) return "no earlier messages (Conversation memory is off)";
  return `up to the last ${k} earlier ${k === 1 ? "question and answer" : "questions and answers"} in this project's chat (never their tool results)`;
}

/** Prior turns → plain user/assistant messages for the next run, strictly
 *  alternating and starting with "user" (both protocols want that). Only
 *  turns with an answer to show ride along; tool traffic never does. */
export function historyMessages(turns, maxTurns = HISTORY_TURNS) {
  const out = [];
  const keep = clampHistoryTurns(maxTurns);
  if (keep === 0) return out;   // memory off: each message stands alone
  // a turn with no answer (refused before it ran, transport error) carries
  // nothing the model can build on — it stays out
  const usable = (turns || []).filter((t) => t && t.status !== "running" && t.goal && t.text);
  for (const t of usable.slice(-keep)) {
    const reply = t.status === "done" ? t.text : `${t.text}\n\n[This run ended early: ${t.status === "stopped" ? "stopped by the estimator" : t.error || t.status}.]`;
    const tail = t.staged > 0 ? `\n\n[${plural(t.staged, "proposal")} staged for the estimator's review.]` : "";
    out.push({ role: "user", content: t.goal }, { role: "assistant", content: `${reply}${tail}` });
  }
  return out;
}

/** Why a message can't run yet, in the chat's words — "" when the canvas is
 *  ready. `status` is the canvas load status (loading | rendering | ready |
 *  empty | error). */
export function notReadyMessage(status) {
  if (status === "ready") return "";
  if (status === "empty") return "No plan is open yet — open a PDF (or the sample plan) first. The agent works on the sheets open on the canvas.";
  if (status === "error") return "The plan didn't load — reopen it, then ask again.";
  return "The sheet is still loading — send that again in a moment.";
}

/** The message actually sent for a turn: what the user typed, plus where they
 *  are looking (so "this sheet" means something to the model). */
export function withViewContext(text, { sheetKey, sheetLabel } = {}) {
  const t = String(text || "").trim();
  if (!sheetKey) return t;
  const label = sheetLabel && sheetLabel !== sheetKey ? `${sheetLabel} (key ${sheetKey})` : sheetKey;
  return `${t}\n\n[The estimator is looking at sheet ${label}.]`;
}

// ── persistence ──────────────────────────────────────────────────────────────
/** The meta-store key for a project's chat. "" / null = the local anonymous project. */
export function chatKey(projectId) {
  return `agent_chat:${projectId || "local"}`;
}

const STATUSES = new Set(["running", "done", "error", "stopped", "capped"]);
const STEP_STATUSES = new Set(["running", "done", "failed", "stopped"]);

function cleanStep(s) {
  if (!s || typeof s !== "object") return null;
  if (s.kind === "say") return typeof s.text === "string" && s.text ? { kind: "say", text: clip(s.text, 600) } : null;
  if (s.kind !== "tool") return null;
  return {
    kind: "tool",
    name: clip(s.name, 60),
    label: clip(s.label || s.name, 120),
    status: STEP_STATUSES.has(s.status) ? s.status : "done",
    detail: clip(s.detail, DETAIL_MAX),
  };
}

function cleanTurn(t) {
  if (!t || typeof t !== "object" || typeof t.goal !== "string" || !t.goal.trim()) return null;
  return settleTurn({
    id: clip(t.id || "", 80) || newTurn(t.goal).id,
    goal: clip(t.goal, MAX_TEXT),
    ts: typeof t.ts === "string" ? t.ts : "",
    status: STATUSES.has(t.status) ? t.status : "done",
    text: clip(t.text, MAX_TEXT),
    steps: (Array.isArray(t.steps) ? t.steps : []).map(cleanStep).filter(Boolean).slice(0, MAX_STEPS),
    staged: Number.isFinite(t.staged) && t.staged > 0 ? Math.floor(t.staged) : 0,
    rejected: Number.isFinite(t.rejected) && t.rejected > 0 ? Math.floor(t.rejected) : 0,
    error: t.error ? clip(t.error, 600) : null,
  });
}

/** Whatever came off disk → a safe turn list (bad rows dropped, running settled, capped). */
export function sanitizeChat(raw) {
  const turns = raw && typeof raw === "object" && Array.isArray(raw.turns) ? raw.turns : [];
  return turns.map(cleanTurn).filter(Boolean).slice(-MAX_TURNS);
}

/** @param {{get: (k: string) => Promise<any>}} meta */
export async function loadChat(meta, projectId) {
  try { return sanitizeChat(await meta.get(chatKey(projectId))); }
  catch { return []; }
}

/** @param {{put: (k: string, v: any) => Promise<void>}} meta */
export async function saveChat(meta, projectId, turns) {
  // sanitize settles a still-running turn to "stopped" — what a reload should
  // see, since the run that owned it does not survive the page
  const rec = { schema: CHAT_SCHEMA, turns: sanitizeChat({ turns: turns || [] }) };
  try { await meta.put(chatKey(projectId), rec); return true; }
  catch { return false; }
}
