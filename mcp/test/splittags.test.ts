// Split finish tags (EXP-OT-TAG-01): CAD exports often set a tag's hyphen in
// a second font, so pdf.js hands back "WB" + "-" + "01" as three items. Every
// whole-run consumer missed those tags — find_text, the sheet graph's schedule
// keys, sweep_schedule_row. The text layer now joins touching runs
// (web/src/lib/textjoin.ts); these pin that on a fixture built the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";

const SET = fileURLToPath(new URL("./fixtures/split-tags.pdf", import.meta.url));
const PLAN = "split-tags.pdf";

async function load() {
  const s = new Session();
  await s.loadPlan(SET);
  return s;
}

test("the fixture really is split: pdf.js emits the tag as three items", async () => {
  const s = await load();
  const raw = ((s as any).sheet(PLAN).page.textContent.items as { str: string }[]).map((i) => i.str).filter((t) => t.trim());
  assert.ok(raw.includes("WB") && raw.includes("-") && raw.includes("01"), raw.join("|"));
  assert.ok(!raw.includes("WB-01"));
});

test("find_text finds every split tag, horizontal and vertical", async () => {
  const s = await load();
  const n = (q: string) => (s.findText(PLAN, q) as { count: number }).count;
  assert.equal(n("WB-01"), 4);
  assert.equal(n("TR-01"), 2);
  assert.equal(n("C-03"), 1);
});

test("ordinary word spacing is not glued", async () => {
  const s = await load();
  const words = s.readSheetText(PLAN).items.map((t) => t.str);
  assert.ok(words.includes("FLOOR") && words.includes("TILE"), words.join("|"));
  assert.equal((s.findText(PLAN, "FLOORTILE") as { count: number }).count, 0);
});

test("the schedule reads a split key as its row", async () => {
  const s = await load();
  const r = await s.findSchedule("finish");
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].rows, 4);
});

test("sweep_schedule_row counts split tags; an undrawn row still refuses", async () => {
  const s = await load();
  const found = async (t: string) => ((await s.sweepScheduleRow(t, {})) as { found: number }).found;
  assert.equal(await found("WB-01"), 4);
  assert.equal(await found("TR-01"), 2);
  assert.equal(await found("C-03"), 1);
  await assert.rejects(() => s.sweepScheduleRow("TR-03", {}), /not drawn/);
});
