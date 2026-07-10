// Reply and error helpers. Every tool reply is a single content text item of
// compact JSON (no pretty-print); every failure is { isError: true, ... } —
// never a thrown protocol error.

/** A message meant for the calling agent (bad input, missing scale, …). */
export class UserError extends Error {}

export interface ToolReply {
  [k: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const ok = (payload: unknown): ToolReply => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

export const fail = (err: unknown): ToolReply => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
});

/** SF/LF round to 2dp; raw px quantities to 1dp. */
export const round2 = (n: number): number => +n.toFixed(2);
export const round1 = (n: number): number => +n.toFixed(1);
