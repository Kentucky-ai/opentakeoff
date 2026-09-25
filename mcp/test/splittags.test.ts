// Split finish tags, pinned on a REAL sheet: the bundled St. Cloud VA floor
// finish plan (demo/sample-finish-plan.pdf). Its CAD export sets each tag's
// hyphen as its own text run, so pdf.js hands back "VCT" + "-" + "1"; before
// the text layer joined touching runs (web/src/lib/textjoin.ts, #457) the
// sheet had 7 finish tags readable as one run, and find_text found none of
// VCT-1 / P-1 / P-2 / P-3. The expected counts below are an independent
// census of the same page (PyMuPDF words), not this engine's own output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";

const PLAN_PDF = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));
const PLAN = "sample-finish-plan.pdf";

async function load() {
  const s = new Session();
  await s.loadPlan(PLAN_PDF);
  return s;
}
const exact = (s: Session, q: string) =>
  ((s.findText(PLAN, q, { limit: 500 }) as { hits?: { str: string }[] }).hits ?? []).filter((h) => h.str.trim() === q).length;

test("the real sheet really is split: no VCT-1 or P-1 arrives as one pdf.js item", async () => {
  const s = await load();
  const raw = ((s as any).sheet(PLAN).page.textContent.items as { str: string }[]).map((i) => i.str.trim());
  assert.equal(raw.filter((t) => t === "VCT-1").length, 0);
  assert.equal(raw.filter((t) => t === "P-1").length, 0);
  assert.ok(raw.includes("VCT") && raw.includes("-"));
});

test("find_text reads every split finish tag on the plan (independent census)", async () => {
  const s = await load();
  const census: Record<string, number> = { "CPT-1": 26, "CPT-2": 3, "VCT-1": 11, "P-1": 31, "P-2": 17, "P-3": 14, "WSF-1": 1 };
  for (const [tag, n] of Object.entries(census)) assert.equal(exact(s, tag), n, tag);
});

test("a tag never swallows the room number its label overlaps (VCT-1 | 170)", async () => {
  const s = await load();
  // on this sheet the "VCT-1" label runs 1.6 px into room number "170"
  assert.equal(exact(s, "170"), 1);
  assert.equal((s.findText(PLAN, "VCT-1170") as { count: number }).count, 0);
});

test("both schedules still read off the joined text", async () => {
  const s = await load();
  const room = await s.findSchedule("room finish");
  const mat = await s.findSchedule("finish");
  assert.equal(room.matches[0].rows, 29);
  assert.equal(mat.matches[0].rows, 44);
});
