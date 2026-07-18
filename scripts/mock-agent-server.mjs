#!/usr/bin/env node
// Mock agent endpoint — a stdlib HTTP server speaking the Anthropic-style
// messages wire (POST /v1/messages) that scripts ONE deterministic agent run,
// so the full in-canvas agent UX can be exercised end-to-end with no real key.
//
// Usage (two lines):
//   node scripts/mock-agent-server.mjs                         # listens on http://localhost:8787
//   # in the app (or via the AI settings dialog): endpoint http://localhost:8787,
//   # API style "Anthropic-style", model "mock", any non-empty key — i.e.
//   #   localStorage.setItem("opentakeoff_ai_endpoint", "http://localhost:8787");
//   #   localStorage.setItem("opentakeoff_ai_provider", "anthropic");
//   #   localStorage.setItem("opentakeoff_ai_model", "mock");
//   #   localStorage.setItem("opentakeoff_ai_key", "dummy");
//
// The scripted sequence (each turn keyed off how many tool results the request
// carries, so the server stays stateless):
//   list_sheets → read_schedule → get_conditions → one_click ×2 →
//   propose_shapes (with evidence) → end-turn summary.
// Seeds and regions are fixed fractions of the first open sheet; the proposal
// turn reuses whatever rings one_click actually returned, so the e2e drives the
// REAL deterministic engines — the mock only plays the model's role.

import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const SEEDS = [[0.35, 0.5], [0.65, 0.5]];

// ── read the transcript back out of the request ─────────────────────────────
const textOf = (content) =>
  typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
  : "";

/** All tool_result blocks in order, parsed as JSON where possible. */
function toolResults(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== "tool_result") continue;
      const raw = textOf(b.content);
      let json = null;
      try { json = JSON.parse(raw); } catch { /* keep raw */ }
      out.push({ id: b.tool_use_id, json, raw });
    }
  }
  return out;
}

// ── the script ──────────────────────────────────────────────────────────────
function scriptTurn(messages) {
  const results = toolResults(messages);
  const step = results.length;
  const turn = (text, tool) => ({
    id: `msg_mock_${step}`,
    type: "message",
    role: "assistant",
    model: "mock",
    content: [{ type: "text", text }, ...(tool ? [{ type: "tool_use", id: `toolu_step${step}`, name: tool.name, input: tool.input }] : [])],
    stop_reason: tool ? "tool_use" : "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  });

  const sheets = results[0]?.json?.sheets || [];
  const sheet = sheets[0]?.sheet;
  if (step === 0) return turn("Let me see what's open on the canvas.", { name: "list_sheets", input: {} });
  if (!sheet) return turn("No sheets are open on the canvas — open a plan sheet and run me again.");
  if (!sheets[0].scale_set) return turn(`Set the scale for ${sheet} first — I never assume a scale. Calibrate it (or pick the sheet scale), then run me again.`);
  if (step === 1) return turn(`Reading the finish schedule on ${sheet}.`, { name: "read_schedule", input: { sheet, region: { x0: 0, y0: 0, x1: 1, y1: 1 } } });
  if (step === 2) return turn("Checking which conditions exist.", { name: "get_conditions", input: {} });
  if (step === 3) return turn("Measuring the first room with the one-click engine.", { name: "one_click", input: { sheet, x: SEEDS[0][0], y: SEEDS[0][1] } });
  if (step === 4) return turn("Measuring a second room.", { name: "one_click", input: { sheet, x: SEEDS[1][0], y: SEEDS[1][1] } });
  if (step === 5) {
    const rows = results[1]?.json?.rows || [];
    const conds = results[2]?.json?.conditions || [];
    const cond = conds.find((c) => rows.some((r) => r.finish_tag === c.finish_tag)) || conds[0];
    if (!cond) return turn("No conditions exist and I couldn't read a schedule — add a condition, then run me again.");
    const tag = rows.find((r) => r.finish_tag === cond.finish_tag)?.finish_tag || cond.finish_tag;
    const shapes = [];
    for (let i = 0; i < 2; i++) {
      const oc = results[3 + i]?.json;
      if (!oc || oc.error || !Array.isArray(oc.verts_norm)) continue;
      shapes.push({
        sheet,
        verts_norm: oc.verts_norm,
        condition_id: cond.id,
        measure_role: "floor_area",
        evidence: { schedule_row_tag: tag, matched_text: tag, seed_norm: oc.seed_norm || SEEDS[i] },
      });
    }
    if (!shapes.length) {
      const errs = [3, 4].map((i) => results[i]?.json?.error).filter(Boolean).join(" / ");
      return turn(`Neither seed produced a room (${errs || "no rings returned"}) — zoom me differently or seed the rooms yourself.`);
    }
    return turn(`Staging ${shapes.length} proposal${shapes.length === 1 ? "" : "s"} for ${tag} — review the dashed outlines.`, { name: "propose_shapes", input: { shapes } });
  }
  const staged = results[5]?.json?.staged ?? 0;
  return turn(`Done. Staged ${staged} proposal${staged === 1 ? "" : "s"} citing the schedule row and one-click seeds. Accept them on the canvas (⏎ accepts all visible) or reject from the Agent panel.`);
}

// ── the server ──────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, authorization",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === "GET") {
    res.writeHead(200, { ...CORS, "Content-Type": "text/plain" });
    res.end("mock agent endpoint — POST /v1/messages (Anthropic-style)\n");
    return;
  }
  if (req.method !== "POST" || !req.url.endsWith("/v1/messages")) {
    res.writeHead(404, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "POST /v1/messages only" } }));
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "body was not JSON" } }));
      return;
    }
    const reply = scriptTurn(payload.messages);
    const call = reply.content.find((b) => b.type === "tool_use");
    console.log(`[mock] step → ${call ? `${call.name} ${JSON.stringify(call.input).slice(0, 120)}` : `end_turn: ${reply.content[0].text.slice(0, 80)}`}`);
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});

server.listen(PORT, () => {
  console.log(`mock agent endpoint listening on http://localhost:${PORT}`);
  console.log(`point the app at it: endpoint http://localhost:${PORT}, API style Anthropic-style, model "mock", key "dummy"`);
});
