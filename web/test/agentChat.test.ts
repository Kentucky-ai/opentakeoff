// Agent chat (lib/agentChat.js) — the pure half of the chat window:
//   - agentLoop events fold into a turn: steps with labels + running/done/failed,
//     the answer text, the staged-proposal count, terminal statuses;
//   - prior turns become strictly alternating user/assistant history;
//   - per-project persistence round-trips through an injected {get, put},
//     settles a turn left running, and drops junk rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newTurn, foldEvent, foldEvents, settleTurn, toolLabel, resultDetail, stagedNote,
  historyMessages, withViewContext, notReadyMessage, chatKey, sanitizeChat, loadChat, saveChat, MAX_TURNS,
} from "../src/lib/agentChat.js";
import { runAgentLoop, priorMessages } from "../src/lib/agentLoop.js";

const T0 = { id: "t1", ts: "2026-11-03T12:00:00.000Z" };

test("fold: a full run — narration, tool steps, staged count, final answer", () => {
  const turn = foldEvents(newTurn("Trace the rooms on this sheet", T0), [
    { type: "text", text: "Looking at the sheets first." },
    { type: "tool_start", name: "list_sheets", args: {} },
    { type: "tool_end", name: "list_sheets", result: { sheets: [{ sheet: "A-101", scale_set: true }, { sheet: "A-102", scale_set: false }] } },
    { type: "tool_start", name: "read_schedule", args: { sheet: "A-101", region: { x: 0, y: 0, w: 1, h: 1 } } },
    { type: "tool_end", name: "read_schedule", result: { rows: [{}, {}, {}] } },
    { type: "tool_start", name: "propose_shapes", args: { shapes: [{}, {}, {}] } },
    { type: "tool_end", name: "propose_shapes", result: { staged: 2, rejected: [{ index: 2, why: "no evidence" }] } },
    { type: "text", text: "Staged **2** rooms as CPT-1." },
    { type: "done", text: "Staged **2** rooms as CPT-1." },
  ]);
  assert.equal(turn.status, "done");
  assert.equal(turn.text, "Staged **2** rooms as CPT-1.");
  assert.equal(turn.staged, 2);
  assert.equal(turn.rejected, 1);
  const tools = turn.steps.filter((s: any) => s.kind === "tool");
  assert.deepEqual(tools.map((s: any) => [s.label, s.status, s.detail]), [
    ["List the sheets", "done", "2 sheets, 1 without a scale"],
    ["Read the schedule on A-101", "done", "3 rows"],
    ["Stage 3 proposals", "done", "2 staged, 1 rejected"],
  ]);
  // the narration before the tools stays a step; the final answer is not duplicated as one
  const says = turn.steps.filter((s: any) => s.kind === "say").map((s: any) => s.text);
  assert.deepEqual(says, ["Looking at the sheets first."]);
  assert.match(stagedNote(turn), /^Staged 2 proposals for review \(1 refused for missing evidence\)/);
});

test("fold: running step, failed tool, error ends the turn and fails what was running", () => {
  let t = newTurn("Read the finish schedule", T0);
  t = foldEvent(t, { type: "tool_start", name: "view_region", args: { sheet: "A-101" } });
  assert.equal(t.steps[0].status, "running");
  assert.equal(t.steps[0].label, "Look at A-101");
  const before = t;
  t = foldEvent(t, { type: "tool_end", name: "view_region", result: { error: "Sheet A-101 isn't open on the canvas" } });
  assert.equal(before.steps[0].status, "running", "fold never mutates its input");
  assert.equal(t.steps[0].status, "failed");
  assert.match(t.steps[0].detail, /isn't open/);
  t = foldEvent(t, { type: "tool_start", name: "one_click", args: { sheet: "A-101", x: 0.5, y: 0.5 } });
  t = foldEvent(t, { type: "error", message: "AI request failed (HTTP 401)." });
  assert.equal(t.status, "error");
  assert.equal(t.error, "AI request failed (HTTP 401).");
  assert.equal(t.steps[1].status, "failed");
  assert.equal(stagedNote(t), "");
});

test("fold: abort → stopped, the step cap → capped with a note, unknown events ignored", () => {
  const started = foldEvent(newTurn("x", T0), { type: "tool_start", name: "list_sheets", args: {} });
  const stopped = foldEvent(started, { type: "aborted" });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.steps[0].status, "stopped");
  const capped = foldEvent(started, { type: "max_iterations", limit: 24 });
  assert.equal(capped.status, "capped");
  assert.match(capped.error, /24-step cap/);
  assert.equal(foldEvent(started, { type: "mystery" }), started);
  assert.equal(settleTurn(started).status, "stopped");
  assert.equal(settleTurn(stopped), stopped);
});

test("labels: every registry tool gets a short human label; unknown names pass through", () => {
  assert.equal(toolLabel("read_sheet_text", { sheet: "A-101", region: {} }), "Read the text in a region on A-101");
  assert.equal(toolLabel("read_sheet_text", { sheet: "A-101" }), "Read the text on A-101");
  assert.equal(toolLabel("get_conditions", {}), "Check the conditions");
  assert.equal(toolLabel("create_condition", { finish_tag: "LVT-1" }), "Create condition LVT-1");
  assert.equal(toolLabel("one_click", { sheet: "A-101" }), "Flood-fill a room on A-101");
  assert.equal(toolLabel("propose_shapes", { shapes: [{}] }), "Stage 1 proposal");
  assert.equal(toolLabel("something_new", null), "something_new");
  assert.equal(resultDetail("one_click", { area_sf: 1234.4 }), "1,234 SF ring");
  assert.equal(resultDetail("read_schedule", { rows: [], note: "No schedule table found" }), "No schedule table found");
  assert.equal(resultDetail("view_region", { image_data_url: "data:…", width: 800, height: 600 }), "800 × 600 px image");
});

test("history: finished turns alternate user/assistant; running and empty turns stay out", () => {
  const done = foldEvents(newTurn("List the sheets", { id: "a" }), [{ type: "done", text: "Two sheets." }]);
  const staged = { ...foldEvents(newTurn("Trace them", { id: "b" }), [{ type: "done", text: "Done." }]), staged: 3 };
  const failed = foldEvents(newTurn("Again", { id: "c" }), [{ type: "error", message: "HTTP 500" }]);
  const live = newTurn("Still going", { id: "d" });
  const stopped = foldEvents(newTurn("Trace the rooms", { id: "e" }), [{ type: "text", text: "Reading A-101." }, { type: "aborted" }]);
  const h = historyMessages([done, staged, failed, live, stopped]);
  assert.deepEqual(h.map((m: any) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
  assert.equal(h[0].content, "List the sheets");
  assert.equal(h[1].content, "Two sheets.");
  assert.match(h[3].content, /3 proposals staged/);
  assert.equal(h[4].content, "Trace the rooms", "the failed turn (no answer) and the running one stay out");
  assert.match(h[5].content, /^Reading A-101\.\n\n\[This run ended early: stopped by the estimator\.\]$/);
  assert.equal(historyMessages([done, staged, failed], 1).length, 2, "only the last N turns ride along");
  assert.equal(notReadyMessage("ready"), "");
  assert.match(notReadyMessage("empty"), /No plan is open yet/);
  assert.match(notReadyMessage("loading"), /still loading/);
  assert.equal(withViewContext("Trace the rooms on this sheet", { sheetKey: "plan.pdf#2", sheetLabel: "A-102" }),
    "Trace the rooms on this sheet\n\n[The estimator is looking at sheet A-102 (key plan.pdf#2).]");
  assert.equal(withViewContext("  hi  ", {}), "hi");
});

test("agentLoop: chat history is sent ahead of the new message, malformed history is dropped", async () => {
  const bodies: any[] = [];
  const fetchFn = async (_u: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Sure." }], stop_reason: "end_turn" }) };
  };
  const history: any[] = [{ role: "user", content: "List the sheets" }, { role: "assistant", content: "Two sheets." }];
  const res = await runAgentLoop({
    cfg: { endpoint: "http://localhost:9", model: "m", provider: "anthropic" }, goal: "Now the schedule", history,
    tools: [], execute: () => ({}), fetchFn: fetchFn as any,
  });
  assert.equal(res.status, "done");
  assert.deepEqual(bodies[0].messages, [...history, { role: "user", content: "Now the schedule" }]);
  // two users in a row, a leading assistant, a dangling user, non-strings: all filtered to a valid alternation
  assert.deepEqual(priorMessages([
    { role: "assistant", content: "orphan" }, { role: "user", content: "a" }, { role: "user", content: "dup" },
    { role: "assistant", content: "b" }, { role: "tool", content: "x" }, { role: "user", content: 7 }, { role: "user", content: "dangling" },
  ]), [{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
  assert.deepEqual(priorMessages(undefined), []);
});

const mapMeta = () => {
  const m = new Map<string, any>();
  return { m, get: async (k: string) => structuredClone(m.get(k)), put: async (k: string, v: any) => { m.set(k, structuredClone(v)); } };
};

test("persistence: per-project keys, round-trip, a running turn comes back stopped", async () => {
  assert.equal(chatKey(""), "agent_chat:local");
  assert.equal(chatKey(null), "agent_chat:local");
  assert.equal(chatKey("folder123"), "agent_chat:folder123");
  const meta = mapMeta();
  const done = foldEvents(newTurn("List the sheets", T0), [
    { type: "tool_start", name: "list_sheets", args: {} },
    { type: "tool_end", name: "list_sheets", result: { sheets: [] } },
    { type: "done", text: "No sheets are open." },
  ]);
  const live = foldEvent(newTurn("Trace the rooms", { id: "t2" }), { type: "tool_start", name: "read_sheet_text", args: { sheet: "A-101" } });
  assert.equal(await saveChat(meta, "p1", [done, live]), true);
  assert.deepEqual([...meta.m.keys()], ["agent_chat:p1"]);
  assert.equal(meta.m.get("agent_chat:p1").schema, 1);
  const back = await loadChat(meta, "p1");
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], done);
  assert.equal(back[1].status, "stopped");
  assert.equal(back[1].steps[0].status, "stopped");
  assert.deepEqual(await loadChat(meta, "other-project"), [], "projects don't share a conversation");
});

test("persistence: junk on disk is dropped, the list is capped, a failing store never throws", async () => {
  const rows = sanitizeChat({ turns: [
    null, { goal: "" }, { goal: 42 },
    { id: "ok", goal: "Read the finish schedule", status: "weird", steps: [{ kind: "tool", name: "x", status: "zzz" }, { kind: "bogus" }, { kind: "say", text: "" }], staged: -3 },
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "done");
  assert.deepEqual(rows[0].steps, [{ kind: "tool", name: "x", label: "x", status: "done", detail: "" }]);
  assert.equal(rows[0].staged, 0);
  assert.deepEqual(sanitizeChat(undefined), []);
  assert.deepEqual(sanitizeChat({ turns: "nope" }), []);
  const many = Array.from({ length: MAX_TURNS + 7 }, (_, i) => ({ ...newTurn(`q${i}`, { id: `t${i}` }), status: "done" }));
  const capped = sanitizeChat({ turns: many });
  assert.equal(capped.length, MAX_TURNS);
  assert.equal(capped[capped.length - 1].goal, `q${MAX_TURNS + 6}`, "oldest drop first");
  const broken = { get: async () => { throw new Error("idb gone"); }, put: async () => { throw new Error("quota"); } };
  assert.deepEqual(await loadChat(broken, "p"), []);
  assert.equal(await saveChat(broken, "p", many), false);
});
