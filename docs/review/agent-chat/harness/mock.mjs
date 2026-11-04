// Mock Anthropic-style endpoint: scripted tool_use then a markdown answer.
import http from "node:http";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
let n = 0;
http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
    const j = JSON.parse(body || "{}"); n++;
    const last = j.messages?.[j.messages.length - 1];
    const isNewGoal = last && last.role === "user" && typeof last.content === "string";
    console.log(`req ${n}: ${j.messages.length} messages, last=${isNewGoal ? JSON.stringify(last.content.slice(0, 120)) : "tool_result"}`);
    const delay = isNewGoal ? 1200 : 400;
    const reply = isNewGoal
      ? { content: [{ type: "text", text: "Checking what's open first." }, { type: "tool_use", id: `toolu_${n}a`, name: "list_sheets", input: {} }, { type: "tool_use", id: `toolu_${n}b`, name: "get_conditions", input: {} }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: `Here's what I found (history sent: **${j.messages.length - 3}** prior messages).\n\n- **${(last.content?.[0]?.content?.[0]?.text || "").slice(0, 60).replace(/[*`]/g, "")}**\n- The \`get_conditions\` call returned your condition list.\n\nNo proposals staged — ask me to *trace the rooms* when the sheet has a scale.` }], stop_reason: "end_turn" };
    setTimeout(() => { res.writeHead(200, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(reply)); }, delay);
  });
}).listen(5189, () => console.log("mock on 5189"));
