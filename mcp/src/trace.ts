import type { ToolReply } from "./format.ts";

const TRACE_ENV = "OPENTAKEOFF_MCP_TRACE";

/** Set while the Assistant window is open: every tool call is mirrored there (assistantBridge.ts). */
export const toolCallSinks: Array<(tool: string, ok: boolean, ms: number) => void> = [];

export function traceToolCall(tool: string, args: unknown, startedAt: bigint, reply: ToolReply): void {
  if (toolCallSinks.length && !tool.startsWith("assistant_")) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    for (const sink of toolCallSinks) { try { sink(tool, reply.isError !== true, ms); } catch { /* the window is best-effort */ } }
  }
  if (process.env[TRACE_ENV] !== "1") return;

  // result_size spans every part — for image tools that's meta + base64 bytes
  const text = reply.content.map((c) => ("text" in c ? c.text : c.data)).join("");
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const sheet =
    args && typeof args === "object" && "sheet" in args
      ? (args as { sheet?: unknown }).sheet
      : undefined;

  const event = {
    event: "opentakeoff_mcp_tool_call",
    tool,
    duration_ms: Math.round(durationMs * 100) / 100,
    sheet: typeof sheet === "string" ? sheet : null,
    result_size: text.length,
    is_error: reply.isError === true,
  };

  process.stderr.write(`${JSON.stringify(event)}\n`);
}
