// Agent chat rendering — the markdown basics (lib/chatMarkdown + the
// ChatMarkdown component) and the chat window's states (components/AgentChat):
// the connect state with no model, the empty state's suggestion cards, and an
// assistant turn with its answer, step toggle and staged count.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseMarkdown, parseInline } from "../src/lib/chatMarkdown.js";
import ChatMarkdown from "../src/components/ChatMarkdown.jsx";
import AgentChat, { CHAT_SUGGESTIONS } from "../src/components/AgentChat.jsx";
import { foldEvents, newTurn } from "../src/lib/agentChat.js";

test("markdown: paragraphs, headings, lists, fenced code", () => {
  const blocks = parseMarkdown("Two sheets are open.\nBoth have a scale.\n\n## Finish codes\n- **CPT-1** carpet\n- `LVT-1` plank\n\n1. first\n2. second\n\n```\nA-101  1/8\" = 1'-0\"\n```");
  assert.deepEqual(blocks.map((b: any) => b.type), ["p", "h", "ul", "ol", "code"]);
  assert.deepEqual(blocks[0].inline, [{ t: "text", v: "Two sheets are open. Both have a scale." }]);
  assert.equal(blocks[1].level, 2);
  assert.deepEqual(blocks[2].items[0], [{ t: "b", v: "CPT-1" }, { t: "text", v: " carpet" }]);
  assert.deepEqual(blocks[2].items[1], [{ t: "code", v: "LVT-1" }, { t: "text", v: " plank" }]);
  assert.equal(blocks[3].items.length, 2);
  assert.equal(blocks[4].text, "A-101  1/8\" = 1'-0\"");
  const ol = parseMarkdown("3. third\n4. fourth");
  assert.equal(ol[0].start, 3);
});

test("markdown: a fence with a longer info string opens a code block and ends at the bare fence", () => {
  const blocks = parseMarkdown("Here is the export:\n```csv title=takeoff.csv\nCode,Qty\nCPT-1,1200\n```\nThe **CPT-1** total is 1,200 SF.\n\n- next step");
  assert.deepEqual(blocks.map((b: any) => b.type), ["p", "code", "p", "ul"]);
  assert.equal(blocks[1].lang, "csv");
  assert.equal(blocks[1].text, "Code,Qty\nCPT-1,1200");
  assert.deepEqual(blocks[2].inline, [{ t: "text", v: "The " }, { t: "b", v: "CPT-1" }, { t: "text", v: " total is 1,200 SF." }]);
  const cs = parseMarkdown("```c#\nvar x = 1;\n```\nDone.");
  assert.deepEqual(cs.map((b: any) => [b.type, b.lang ?? null]), [["code", "c#"], ["p", null]]);
  assert.equal(cs[0].text, "var x = 1;");
});

test("markdown: inline emphasis, and markers that are not emphasis stay literal", () => {
  assert.deepEqual(parseInline("a *b* and __c__"), [{ t: "text", v: "a " }, { t: "i", v: "b" }, { t: "text", v: " and " }, { t: "b", v: "c" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ t: "text", v: "2 * 3 * 4" }]);
  assert.deepEqual(parseInline("ROOM_101_A"), [{ t: "text", v: "ROOM_101_A" }]);
  assert.deepEqual(parseInline("**unclosed"), [{ t: "text", v: "**unclosed" }]);
  assert.deepEqual(parseInline("`x"), [{ t: "text", v: "`x" }]);
});

test("ChatMarkdown: renders the basics and escapes any HTML the model writes", () => {
  const html = renderToStaticMarkup(React.createElement(ChatMarkdown as any, { text: "**CPT-1** is <b>carpet</b>\n\n- one\n- `two`\n\n```\n<script>x</script>\n```" }));
  assert.match(html, /<p><strong>CPT-1<\/strong> is &lt;b&gt;carpet&lt;\/b&gt;<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li><code class="ac-md-code">two<\/code><\/li><\/ul>/);
  assert.match(html, /<pre class="ac-md-pre"><code>&lt;script&gt;x&lt;\/script&gt;<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script>|<b>/);
});

const noop = () => {};
const base = {
  configured: true, modelLabel: "claude-opus-5-5", running: false, turns: [] as any[], proposals: [] as any[], condById: {},
  sheetLabel: (k: string) => k, fmtArea: (sf: number) => `${sf} SF`,
  onSend: noop, onStop: noop, onAccept: noop, onReject: noop, onAcceptAll: noop, onRejectAll: noop,
  onOpenSettings: noop, onOpenConnect: noop, onClear: noop,
};
const render = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(AgentChat as any, { ...base, ...props }));

test("AgentChat: no model → connect state with AI settings and the MCP pointer; composer disabled", () => {
  const html = render({ configured: false });
  assert.match(html, /Connect your model to chat/);
  assert.match(html, /AI settings…/);
  assert.match(html, /Claude Desktop, Codex or Cursor/);
  assert.match(html, />Connect your AI</);
  assert.match(html, /No model connected/);
  assert.match(html, /<textarea[^>]*disabled/);
  assert.doesNotMatch(html, /What should we work on\?/);
});

test("AgentChat: empty conversation → the greeting and every suggestion card", () => {
  const html = render({});
  assert.match(html, /What should we work on\?/);
  for (const s of CHAT_SUGGESTIONS) assert.ok(html.includes(s.title), s.title);
  assert.ok(CHAT_SUGGESTIONS.length >= 3 && CHAT_SUGGESTIONS.length <= 4);
  assert.match(html, /placeholder="Ask about this project…"/);
  assert.match(html, /claude-opus-5-5/);
  assert.match(html, />Send</);
  assert.doesNotMatch(html, /New chat/);
});

test("AgentChat: a finished turn shows the ask, the answer, the step toggle and the staged count", () => {
  const turn = foldEvents(newTurn("Trace the rooms on this sheet", { id: "t1" }), [
    { type: "tool_start", name: "list_sheets", args: {} },
    { type: "tool_end", name: "list_sheets", result: { sheets: [{ sheet: "A-101", scale_set: true }] } },
    { type: "tool_start", name: "propose_shapes", args: { shapes: [{}, {}] } },
    { type: "tool_end", name: "propose_shapes", result: { staged: 2 } },
    { type: "done", text: "Staged **2** rooms." },
  ]);
  const html = render({ turns: [turn], proposals: [{ id: "p1", sheet_id: "A-101", condition_id: "c1", area_sf: 120, evidence: { schedule_row_tag: "CPT-1" } }], condById: { c1: { finish_tag: "CPT-1", color: "#f00" } } });
  assert.match(html, /class="ac-ask-text">Trace the rooms on this sheet</);
  assert.match(html, /Staged <strong>2<\/strong> rooms\./);
  assert.match(html, /2 steps/);
  assert.match(html, /Show every step/);
  assert.match(html, /Staged 2 proposals for review/);
  assert.match(html, /Waiting for review · 1/);
  assert.match(html, /schedule CPT-1/);
  assert.match(html, /New chat/);
  assert.doesNotMatch(html, /What should we work on\?/);
});

test("AgentChat: while running → spinner on the current step, Stop instead of Send", () => {
  const turn = foldEvents(newTurn("Read the finish schedule", { id: "t1" }), [
    { type: "tool_start", name: "read_schedule", args: { sheet: "A-601" } },
  ]);
  const html = render({ turns: [turn], running: true });
  assert.match(html, /Read the schedule on A-601/);
  assert.match(html, /ac-spin/);
  assert.match(html, /Stop/);
  assert.doesNotMatch(html, />Send</);
  assert.match(html, /Thinking…/);
});
