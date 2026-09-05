// Equipment schedules + label-first counting (the MEP convention), over the
// official MCP client so every reply is validated against its own declared
// output schema — a server whose load_plan violates its schema fails HERE,
// not in a customer's agent.
//
// Fixture: test/fixtures/mep-set.pdf (scripts/make-mep-fixture.mjs) — a plan
// sheet with three baseboard heaters drawn to their own LENGTHS (no two share
// geometry), a fan, a register drawn tag-over-value, and a general note that
// MENTIONS a mark; a schedule sheet stacking three equipment schedules and a
// material schedule that says MARK and MANUFACTURER but carries no powered
// column.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("./fixtures/mep-set.pdf", import.meta.url));

async function client() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session(), {}).connect(st);
  const c = new Client({ name: "mep-test", version: "0.0.0" });
  await c.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await c.callTool({ name, arguments: args });   // validates structuredContent against outputSchema
    const data = JSON.parse(res.content[0].text);
    return { ok: !res.isError, data };
  };
  return call;
}

test("mep: the sheet graph reads every equipment schedule on the sheet, and the material schedule stays a finish table", async () => {
  const call = await client();
  const loaded = await call("load_plan", { path: PLAN });
  assert.ok(loaded.ok);
  const g = await call("sheet_graph", {});
  assert.ok(g.ok);
  const sched = g.data.sheets.flatMap((s: any) => s.schedules.map((t: any) => `${t.kind}:${t.title}:${t.rows}`)).sort();
  assert.deepEqual(sched, [
    "equipment:DIFFUSER, GRILLE, REGISTER SCHEDULE:1",
    "equipment:ELECTRIC BASEBOARD HEATER SCHEDULE:3",
    "equipment:FAN SCHEDULE:1",
    "finish:MATERIAL SCHEDULE:2",
  ]);
  assert.equal(g.data.counts.schedules, 4);
  const eq = await call("find_schedule", { kind: "equipment" });
  assert.ok(eq.ok);
  assert.equal(eq.data.matches.length, 3);
  const heaters = eq.data.matches.find((m: any) => /BASEBOARD/.test(m.title));
  assert.deepEqual(heaters.headers, ["ID", "MANUFACTURER", "MODEL", "WATTS", "VOLTS", "LENGTH", "REMARKS"]);
  // the kind word is loose on purpose — an agent says "mechanical" or "fan"
  assert.equal((await call("find_schedule", { kind: "mechanical" })).data.matches.length, 3);
  // the material schedule is a finish table — MARK + MANUFACTURER without a powered column
  const fin = await call("find_schedule", { kind: "material" });
  assert.deepEqual(fin.data.matches.map((m: any) => m.title), ["MATERIAL SCHEDULE"]);
  // the sheet number never keyed a row
  for (const m of eq.data.matches) assert.ok(m.rows <= 3);
});

test("mep: sweep_schedule_row counts a device by geometry when the marker recurs, and BY LABEL when the device is drawn to its own size", async () => {
  const call = await client();
  await call("load_plan", { path: PLAN });
  // EBB-1: its own bar anchors a fingerprint; the drawn tag corroborates it
  const a = await call("sweep_schedule_row", { tag: "EBB-1" });
  assert.ok(a.ok, JSON.stringify(a.data).slice(0, 200));
  assert.equal(a.data.row.table, "ELECTRIC BASEBOARD HEATER SCHEDULE");
  assert.equal(a.data.row.cells.WATTS, "750");
  assert.equal(a.data.found, 1);
  // the general note's bare "EBB-1" is a mention: no linework near it, never a count
  const bare = a.data.sheets.reduce((n: number, s: any) => n + s.text_only.length, 0);
  assert.equal(bare, 1, "the note's mention is text_only, not counted");
  // EBB-2 is a LONGER bar — different geometry, same convention: counted by label
  const b = await call("sweep_schedule_row", { tag: "EBB-2" });
  assert.ok(b.ok, JSON.stringify(b.data).slice(0, 200));
  assert.equal(b.data.found, 1);
  assert.equal(b.data.found_by_label, 1);
  assert.equal(b.data.counted_by, "label");
  assert.match(b.data.note, /BY LABEL/);
  const lo = b.data.sheets.flatMap((s: any) => s.label_only);
  assert.equal(lo.length, 1);
  assert.ok(lo[0].tag_at, "the counted tag's own bbox is cited");
  // EF-1: the fan's square is one drawn instance, tagged — label or geometry, exactly one
  const f = await call("sweep_schedule_row", { tag: "EF-1" });
  assert.ok(f.ok);
  assert.equal(f.data.found, 1);
  // a mark drawn on NO plan sheet still refuses with the reason — nothing invented
  const none = await call("sweep_schedule_row", { tag: "CPT-1" });
  assert.equal(none.ok, false);
  assert.match(none.data.error, /not drawn on any plan sheet/);
});

test("mep: sweep_schedule_row {commit} mints the row's condition and commits label-counted instances as EA", async () => {
  const call = await client();
  await call("load_plan", { path: PLAN });
  const b = await call("sweep_schedule_row", { tag: "EBB-2", commit: true });
  assert.ok(b.ok);
  assert.equal(b.data.committed, 1);
  assert.equal(b.data.condition, "EBB-2");
  const shapes = await call("list_shapes", { condition: "EBB-2" });
  assert.equal(shapes.data.count, 1);
  assert.equal(shapes.data.shapes[0].measure_role, "count");
  assert.equal(shapes.data.shapes[0].assignment, "schedule");
});

test("mep: count_marks censuses equipment marks BY LABEL, air devices by value, and withholds the bare mention", async () => {
  const call = await client();
  await call("load_plan", { path: PLAN });
  const cm = await call("count_marks", {});
  assert.ok(cm.ok, JSON.stringify(cm.data).slice(0, 200));
  const by = Object.fromEntries(cm.data.marks.map((m: any) => [m.mark, m]));
  for (const t of ["EBB-1", "EBB-2", "EBB-3", "EF-1"]) {
    assert.equal(by[t].count, 1, t);
    assert.equal(by[t].counted_by_label, 1, t);
    assert.equal(by[t].occurrences[0].by, "label");
    assert.equal(by[t].row.table.includes("SCHEDULE"), true);
  }
  // the register is the tag-over-value convention — counted by value, no label count
  assert.equal(by["SR-1"].count, 1);
  assert.equal(by["SR-1"].occurrences[0].by, "value");
  assert.equal(by["SR-1"].occurrences[0].value, "150");
  assert.equal(by["SR-1"].counted_by_label, undefined);
  // the note's bare mention of EBB-1 is withheld with the bare-text reason
  assert.equal(by["EBB-1"].withheld.length, 1);
  assert.match(by["EBB-1"].withheld[0].reason, /bare tag text/);
  // finish marks from the material schedule are censused too, and count nothing here
  assert.equal(by["CPT-1"].count, 0);
  assert.equal(cm.data.total, 5);
});
