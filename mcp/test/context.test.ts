// sheet_context (issue #29) — vectors + text + hatch families of one region,
// one frame, over the real demo plan through a real client/server pair.
//
// The contracts pinned here are the ones the design comment called
// expensive-to-reverse:
//   - structured-only reply, region echoed post-clamp (frame agreement is a
//     contract on ONE rect, not on a second renderer);
//   - clip-don't-transform: every returned segment actually intersects the
//     requested region, endpoints exactly as drawn;
//   - decimation is declared, ordered, and COUNTED: kept + dropped always
//     reconciles to total_in_region, and the cap keeps the LONGEST segments;
//   - the aligned arrays (segments / meta / family) never drift in length.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

async function pair(): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(new Session());
  await server.connect(st);
  const client = new Client({ name: "context-test", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

interface Reply { isError: boolean; data: any }
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const res: any = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
}

const segLen = (s: number[]): number => Math.hypot(s[2] - s[0], s[3] - s[1]);

test("sheet_context: full sheet — counts reconcile, arrays align, region echoes the clamp", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  // an oversized region clamps to the sheet and the reply SAYS so
  const r = await call(client, "sheet_context", { sheet: KEY, region: { x0: -500, y0: -500, x1: 99999, y1: 99999 } });
  assert.equal(r.isError, false);
  const d = r.data;
  assert.equal(d.has_vector_linework, true);
  assert.deepEqual(d.region, [0, 0, d.sheet_px[0], d.sheet_px[1]], "post-clamp region echoed, full sheet");

  // the decimation ledger always reconciles — this is the honesty contract
  const v = d.vectors;
  assert.ok(v.kept > 0, "the demo plan has visible linework");
  assert.equal(v.kept + v.dropped.short + v.dropped.cap, v.total_in_region, "kept + dropped === total, always");
  assert.equal(v.truncated, v.dropped.short + v.dropped.cap > 0);

  // aligned arrays: one meta byte and one family slot per segment, no drift
  assert.equal(v.segments.length, v.kept);
  assert.equal(v.meta.length, v.kept);
  assert.equal(v.family.length, v.kept);
  for (const m of v.meta) assert.ok(Number.isInteger(m) && m >= 0 && m <= 255, "meta is the engine's byte, verbatim");
  for (const f of v.family) assert.ok(f === null || /^h-a/.test(f), "family is a hatch id or null");

  // text arrived in the same frame, with real boxes
  assert.ok(d.text.count > 0, "the demo plan has labels and a title block");
  for (const sp of d.text.spans) assert.ok(sp.x1 >= sp.x0 && sp.y1 >= sp.y0, "spans are well-formed boxes");
});

test("sheet_context: clip keeps exactly the segments that intersect the region", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  const full = (await call(client, "sheet_context", { sheet: KEY })).data;

  // a window around room 101's label — found from the text layer, not
  // hardcoded. pdf.js folds one show-text op into one item, so the label
  // arrives as "OFFICE 101"; the (^|\s) guard keeps the title block's
  // "A-101" from matching.
  const label = full.text.spans.find((sp: any) => /(^|\s)101$/.test(sp.str.trim()));
  assert.ok(label, "the demo plan labels room 101");
  const cx = (label.x0 + label.x1) / 2, cy = (label.y0 + label.y1) / 2;
  const region = { x0: cx - 150, y0: cy - 150, x1: cx + 150, y1: cy + 150 };

  const r = (await call(client, "sheet_context", { sheet: KEY, region })).data;
  assert.deepEqual(r.region, [region.x0, region.y0, region.x1, region.y1], "in-bounds region echoes verbatim");
  assert.ok(r.text.spans.some((sp: any) => /(^|\s)101$/.test(sp.str.trim())), "the label is inside its own window");
  assert.ok(r.vectors.total_in_region < full.vectors.total_in_region, "a window sees fewer segments than the sheet");

  // clip-don't-transform: every returned segment truly overlaps the region box,
  // and its endpoints are untouched (present verbatim in the full-sheet set)
  const fullSet = new Set(full.vectors.segments.map((s: number[]) => s.join(",")));
  for (const s of r.vectors.segments) {
    const inX = Math.max(s[0], s[2]) >= region.x0 && Math.min(s[0], s[2]) <= region.x1;
    const inY = Math.max(s[1], s[3]) >= region.y0 && Math.min(s[1], s[3]) <= region.y1;
    assert.ok(inX && inY, `segment ${s} overlaps the region's bbox`);
    assert.ok(fullSet.has(s.join(",")), "endpoints exactly as drawn — never rewritten by the clip");
  }

  // a far-corner window must NOT contain the label
  const far = (await call(client, "sheet_context", { sheet: KEY, region: { x0: 0, y0: 0, x1: 40, y1: 40 } })).data;
  assert.ok(!far.text.spans.some((sp: any) => /(^|\s)101$/.test(sp.str.trim())), "containment is real, not decorative");
});

test("sheet_context: the cap keeps the LONGEST segments and confesses the rest", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  const full = (await call(client, "sheet_context", { sheet: KEY, max_segments: 20000 })).data;
  const capped = (await call(client, "sheet_context", { sheet: KEY, max_segments: 5 })).data;

  assert.equal(capped.vectors.kept, 5);
  assert.equal(capped.vectors.truncated, true);
  assert.ok(capped.vectors.dropped.cap > 0);
  assert.match(capped.vectors.note, /SHORTEST segments were dropped/, "truncation explains itself");
  assert.equal(capped.vectors.kept + capped.vectors.dropped.short + capped.vectors.dropped.cap,
    capped.vectors.total_in_region, "the ledger reconciles even under a tiny cap");

  // longest-first is checkable: the five kept are the five longest visible ones
  const wantTop = full.vectors.segments.map(segLen).sort((a: number, b: number) => b - a).slice(0, 5);
  const got = capped.vectors.segments.map(segLen).sort((a: number, b: number) => b - a);
  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(got[i] - wantTop[i]) < 0.5, `kept[${i}] is the ${i + 1}th-longest segment (${got[i]} vs ${wantTop[i]})`);
  }
});

test("sheet_context: min_len_px is a real floor, and the degenerate region refuses", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  const strict = (await call(client, "sheet_context", { sheet: KEY, min_len_px: 1e9 })).data;
  assert.equal(strict.vectors.kept, 0);
  assert.equal(strict.vectors.dropped.short, strict.vectors.total_in_region, "everything below an absurd floor is 'short'");

  const empty = await call(client, "sheet_context", { sheet: KEY, region: { x0: 500, y0: 500, x1: 500, y1: 500 } });
  assert.equal(empty.isError, true);
  assert.match(empty.data.error, /Empty context region/);

  const ghost = await call(client, "sheet_context", { sheet: "nope.pdf" });
  assert.equal(ghost.isError, true);
  assert.match(ghost.data.error, /Unknown sheet/);
});

test("sheet_context: frame agreement with the write path — a context wall bounds a one_click room", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });

  // trace room 101 through the flood, then ask sheet_context about the ring's
  // bbox: the flood's boundary linework must be present as vector segments in
  // the SAME coordinates — the two tools are two views of one frame.
  const clicked = (await call(client, "one_click", { sheet: KEY, x: 600, y: 1084, return_verts: true })).data;
  assert.ok(clicked.verts?.length >= 4);
  const xs = clicked.verts.map((v: number[]) => v[0]), ys = clicked.verts.map((v: number[]) => v[1]);
  const region = { x0: Math.min(...xs) - 10, y0: Math.min(...ys) - 10, x1: Math.max(...xs) + 10, y1: Math.max(...ys) + 10 };
  const ctx = (await call(client, "sheet_context", { sheet: KEY, region })).data;
  assert.ok(ctx.vectors.kept >= 4, "the room's boundary linework is in its own bbox");
  // every traced vertex sits ON the linework sheet_context returned — on a
  // segment, not necessarily at an endpoint: a corner at a T-junction lands
  // mid-span of the through wall. Point-to-segment distance is the real claim.
  const distToSeg = (px: number, py: number, s: number[]): number => {
    const dx = s[2] - s[0], dy = s[3] - s[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / L2)) : 0;
    return Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy));
  };
  for (const v of clicked.verts) {
    const near = ctx.vectors.segments.some((s: number[]) => distToSeg(v[0], v[1], s) <= 8);
    assert.ok(near, `traced vertex ${v} lands on the linework sheet_context returned`);
  }
});
