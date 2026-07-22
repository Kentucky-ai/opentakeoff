// Reply and error helpers. Every tool reply carries the payload twice, per the
// spec's back-compat rule for tools with an output schema: structuredContent
// (typed, validated against the tool's outputSchema) plus a single content text
// item of the same compact JSON. Failures are { isError: true, ... } — never a
// thrown protocol error, and exempt from the structuredContent requirement.

/** A message meant for the calling agent (bad input, missing scale, …). */
export class UserError extends Error {}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolReply {
  [k: string]: unknown;
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const ok = (payload: unknown): ToolReply => ({
  structuredContent: payload as Record<string, unknown>,
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

/** Image tool reply: the PNG plus a JSON meta text item. Image tools declare
 * no outputSchema, so there is no structuredContent — the meta item is the
 * machine-readable half. */
export const okImage = (png: Uint8Array, meta: unknown): ToolReply => ({
  content: [
    { type: "image", data: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64"), mimeType: "image/png" },
    { type: "text", text: JSON.stringify(meta) },
  ],
});

export const fail = (err: unknown): ToolReply => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
});

/** SF/LF round to 2dp; raw px quantities to 1dp. */
export const round2 = (n: number): number => +n.toFixed(2);
export const round1 = (n: number): number => +n.toFixed(1);
