// Mock model endpoint for the Agent chat harness: a scripted tool turn, then a
// markdown answer. Speaks both protocols (Anthropic-style on /v1/messages,
// OpenAI-style on /v1/chat/completions) and STREAMS when the request asks
// (`stream: true`): word by word, ~45 ms apart, the providers' own SSE shapes.
//   PORT=5189 (default)
//   MOCK_STREAM=refuse   answer `stream: true` with HTTP 400 (a runtime that
//                        doesn't stream) — the app must retry without it
//   MOCK_STREAM=json     ignore `stream` and answer plain JSON
import http from "node:http";
const PORT = Number(process.env.PORT || 5189);
const MODE = process.env.MOCK_STREAM || "sse";
const WORD_MS = Number(process.env.WORD_MS || 45);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

function script(j, openai) {
  const msgs = j.messages.filter((m) => m.role !== "system");
  const last = msgs[msgs.length - 1];
  const isNewGoal = last && last.role === "user" && typeof last.content === "string";
  if (isNewGoal) {
    return { isNewGoal, prior: msgs.length - 1, text: "Checking what's open first.", tools: [["list_sheets", {}], ["get_conditions", {}]] };
  }
  // after the tool results: messages = history + goal + assistant + tool result(s)
  const prior = openai ? msgs.length - 4 : msgs.length - 3;
  const toolText = openai ? (msgs.find((m) => m.role === "tool")?.content || "") : (last.content?.[0]?.content?.[0]?.text || "");
  return {
    isNewGoal, prior,
    text: `Here's what I found (history sent: **${prior}** prior messages).\n\n- **${toolText.slice(0, 60).replace(/[*`]/g, "")}**\n- The \`get_conditions\` call returned your condition list, and every finish code on it already has a condition.\n- The sheet you are looking at has a scale set, so tracing can start whenever you ask.\n\nNo proposals staged — ask me to *trace the rooms* when you're ready, and each room will land dashed on the plan for you to accept or reject.`,
    tools: [],
  };
}

function jsonReply(s, openai) {
  if (openai) {
    return {
      choices: [{
        index: 0, finish_reason: s.tools.length ? "tool_calls" : "stop",
        message: { role: "assistant", content: s.text, ...(s.tools.length ? { tool_calls: s.tools.map(([name, input], i) => ({ id: `call_${n}${i}`, type: "function", function: { name, arguments: JSON.stringify(input) } })) } : {}) },
      }],
    };
  }
  return { content: [{ type: "text", text: s.text }, ...s.tools.map(([name, input], i) => ({ type: "tool_use", id: `toolu_${n}${i}`, name, input }))], stop_reason: s.tools.length ? "tool_use" : "end_turn" };
}

async function streamReply(res, s, openai, closed) {
  res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const w = (str) => { if (!closed()) res.write(str); };
  const words = s.text.match(/\S+\s*|\s+/g) || [];
  if (openai) {
    const chunk = (delta, finish = null) => w(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: "assistant", content: "" });
    for (const word of words) { if (closed()) return false; chunk({ content: word }); await sleep(WORD_MS); }
    s.tools.forEach(([name, input], i) => {
      const args = JSON.stringify(input);
      chunk({ tool_calls: [{ index: i, id: `call_${n}${i}`, type: "function", function: { name, arguments: "" } }] });
      chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(0, 1) } }] });
      chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(1) } }] });
    });
    chunk({}, s.tools.length ? "tool_calls" : "stop");
    w("data: [DONE]\n\n");
  } else {
    const ev = (type, o = {}) => w(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", content: [], model: "mock-model", stop_reason: null } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const word of words) { if (closed()) return false; ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: word } }); await sleep(WORD_MS); }
    ev("content_block_stop", { index: 0 });
    s.tools.forEach(([name, input], k) => {
      const i = k + 1;
      const args = JSON.stringify(input);
      ev("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_${n}${k}`, name, input: {} } });
      ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: args.slice(0, 1) } });
      ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: args.slice(1) } });
      ev("content_block_stop", { index: i });
    });
    ev("message_delta", { delta: { stop_reason: s.tools.length ? "tool_use" : "end_turn" } });
    ev("message_stop");
  }
  res.end();
  return true;
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  let body = ""; req.on("data", (c) => body += c); req.on("end", async () => {
    const j = JSON.parse(body || "{}"); n++;
    const openai = req.url.includes("/chat/completions");
    const s = script(j, openai);
    console.log(`req ${n}: ${openai ? "openai" : "anthropic"} stream=${!!j.stream} ${j.messages.length} messages, prior=${s.prior}, last=${s.isNewGoal ? "goal" : "tool_result"}`);
    if (j.stream && MODE === "refuse") {
      console.log(`req ${n}: refusing stream (HTTP 400)`);
      res.writeHead(400, { ...cors, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "stream is not supported" } }));
    }
    await sleep(s.isNewGoal ? 600 : 300);
    if (j.stream && MODE === "sse") {
      let gone = false;
      res.on("close", () => { if (!res.writableEnded) gone = true; });
      const finished = await streamReply(res, s, openai, () => gone);
      if (!finished) console.log(`req ${n}: client closed the stream mid-reply (Stop)`);
      return;
    }
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify(jsonReply(s, openai)));
  });
}).listen(PORT, () => console.log(`mock on ${PORT} (${MODE})`));
