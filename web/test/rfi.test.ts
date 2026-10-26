import { test } from "node:test";
import assert from "node:assert/strict";
// rfi.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { nextRfiNumber, rfisToCsv, rfisToJson, linkedMarkups, rfiStatus, RFI_STATUSES, liveRfis, rfiPending } from "../src/lib/rfi.js";

test("nextRfiNumber: empty list starts at RFI-001", () => {
  assert.equal(nextRfiNumber([]), "RFI-001");
  assert.equal(nextRfiNumber(), "RFI-001");
});

test("nextRfiNumber: max + 1, gaps tolerated (not a count)", () => {
  assert.equal(nextRfiNumber([{ number: "RFI-001" }, { number: "RFI-004" }]), "RFI-005");
});

test("nextRfiNumber: RFI-009 rolls to RFI-010 (three-digit padding)", () => {
  assert.equal(nextRfiNumber([{ number: "RFI-009" }]), "RFI-010");
});

test("nextRfiNumber: only the trailing integer counts; garbage ignored", () => {
  assert.equal(nextRfiNumber([{ number: "RFI-2024-007" }, { number: "n/a" }, {}]), "RFI-008");
});

test("nextRfiNumber: past 999 keeps counting (padStart only floors width)", () => {
  assert.equal(nextRfiNumber([{ number: "RFI-999" }]), "RFI-1000");
});

test("rfiStatus: known ids resolve; blank/unknown falls back to Open", () => {
  assert.equal(rfiStatus("answered").label, "Answered");
  assert.equal(rfiStatus("void").color, "#b03a26");
  assert.equal(rfiStatus("nope").id, "open");
  assert.equal(rfiStatus(undefined).id, "open");
});

test("RFI_STATUSES: the four lifecycle states in order", () => {
  assert.deepEqual(RFI_STATUSES.map((s) => s.id), ["open", "answered", "closed", "void"]);
});

test("linkedMarkups: matches on rfi_id === rfi.id; blank id → none", () => {
  const markups = [
    { id: "m1", rfi_id: "r1", sheet_id: "sh1" },
    { id: "m2", rfi_id: "r2", sheet_id: "sh1" },
    { id: "m3", rfi_id: "r1", sheet_id: "sh2" },
  ];
  assert.deepEqual(linkedMarkups({ id: "r1" }, markups).map((m: any) => m.id), ["m1", "m3"]);
  assert.deepEqual(linkedMarkups({ id: "" }, markups), []);
});

test("rfisToCsv: title, semantics line, exact header, derived counts + sheets", () => {
  const rfis = [
    { id: "r1", number: "RFI-001", subject: "Slab crack", status: "open", to: "GC", priority: "high", cost_impact: true, schedule_impact: false, date: "7/8", question: "Repair spec?", response: "", response_date: "" },
  ];
  const markups = [
    { id: "m1", rfi_id: "r1", sheet_id: "sh1" },
    { id: "m2", rfi_id: "r1", sheet_id: "sh2" },
    { id: "m3", rfi_id: "other", sheet_id: "sh3" },
  ];
  const csv = rfisToCsv(rfis, markups, "Job 42", (id: string) => `Sheet ${id}`);
  const lines = csv.split("\n");
  assert.equal(lines[0], "# Job 42 — OpenTakeoff RFI log");
  assert.equal(lines[1], "# RFI log — one row per RFI; linked markups/sheets derived from markup.rfi_id");
  assert.equal(lines[2], "Number,Subject,Status,Ball in court,Priority,Cost impact,Schedule impact,Date,Question,Response,Response date,Linked markups,Linked sheets");
  // Status renders the label, cost flag "yes"/blank, 2 linked markups, both sheets joined
  assert.equal(lines[3], 'RFI-001,Slab crack,Open,GC,high,yes,,7/8,Repair spec?,,,2,Sheet sh1; Sheet sh2');
  assert.ok(csv.endsWith("\n"));
});

test("rfisToCsv: no title line without a project name; empty list is header only", () => {
  const csv = rfisToCsv([], [], "");
  const lines = csv.split("\n");
  assert.ok(lines[0].startsWith("# RFI log"));
  assert.equal(lines[1], "Number,Subject,Status,Ball in court,Priority,Cost impact,Schedule impact,Date,Question,Response,Response date,Linked markups,Linked sheets");
  assert.equal(lines[2], "");
  assert.equal(lines.length, 3);
});

test("rfisToCsv: quoting + formula-injection guard survive round trip", () => {
  const rfis = [{ id: "r1", number: "RFI-001", subject: "Detail 3, revised", status: "answered", question: "=SUM(A1)" }];
  const csv = rfisToCsv(rfis, [], "");
  assert.ok(csv.includes('"Detail 3, revised"'));
  assert.ok(csv.includes("'=SUM(A1)"));   // leading apostrophe neutralizes the formula
});

test("rfisToJson: schema envelope wraps the records", () => {
  const rfis = [{ id: "r1", number: "RFI-001" }];
  const j = rfisToJson(rfis, "Job 42");
  assert.equal(j.schema, "opentakeoff.rfis.v1");
  assert.equal(j.project_name, "Job 42");
  assert.equal(j.generated_with, "OpenTakeoff");
  assert.deepEqual(j.rfis, rfis);
  assert.equal(rfisToJson(rfis, "").project_name, null);
});

// ── tombstones + agent provenance (RFIs over MCP) ────────────────────────────

test("liveRfis: a withdrawn RFI is a tombstone — hidden everywhere, number still reserved", () => {
  const rfis = [{ id: "a", number: "RFI-001" }, { id: "b", number: "RFI-002", deleted: true }, { id: "c", number: "RFI-003" }];
  assert.deepEqual(liveRfis(rfis).map((r) => r.number), ["RFI-001", "RFI-003"]);
  assert.deepEqual(liveRfis(), []);
  assert.deepEqual(liveRfis([null, undefined]), []);
  // the gap is permanent: the next number reads past the tombstone
  assert.equal(nextRfiNumber(rfis), "RFI-004");
  assert.equal(nextRfiNumber([{ number: "RFI-001" }, { number: "RFI-002", deleted: true }]), "RFI-003", "deleting the newest never reissues its number");
});

test("rfisToCsv / rfisToJson: tombstones never print", () => {
  const rfis = [{ id: "a", number: "RFI-001", subject: "live" }, { id: "b", number: "RFI-002", subject: "gone", deleted: true }];
  const csv = rfisToCsv(rfis, []);
  assert.match(csv, /RFI-001/);
  assert.doesNotMatch(csv, /RFI-002/);
  assert.deepEqual(rfisToJson(rfis).rfis.map((r) => r.number), ["RFI-001"]);
});

test("rfiPending: agent-raised and unreviewed is pending; accepted or panel-raised is not", () => {
  assert.equal(rfiPending({ origin: { actor: "agent", reviewed: false } }), true);
  assert.equal(rfiPending({ origin: { actor: "agent" } }), true);
  assert.equal(rfiPending({ origin: { actor: "agent", reviewed: true } }), false);
  assert.equal(rfiPending({ id: "panel-raised" }), false);
  assert.equal(rfiPending(null), false);
});
