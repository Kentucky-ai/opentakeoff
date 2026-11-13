// The Doors suite's readers (lib/doorSuite.ts): the door schedule from a
// sheet's text runs, the 08 71 00 hardware sets, tags to plan doors, and the
// openings / questions / counts. Runs are laid out like a real schedule
// (two-line headings, a FRAME group after the door columns).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readDoorSchedule, readHardwareSets, matchDoorTags, buildDoorSuite, scheduledPair, feetOf, estimateGroups, countLine, textRuns,
  type TextRun,
} from "../src/lib/doorSuite.ts";
import type { ReadDoor } from "../src/lib/doorReader.ts";

const run = (str: string, x: number, y: number, w = str.length * 5, h = 8): TextRun => ({ str, x, y, w, h });

function scheduleRuns(): TextRun[] {
  const R: TextRun[] = [run("DOOR SCHEDULE", 100, 40, 120, 14)];
  // group headings
  R.push(run("DOOR", 330, 60), run("FRAME", 520, 60), run("FIRE", 600, 64), run("HARDWARE", 640, 72));
  R.push(run("IDENTITY", 360, 72), run("IDENTITY", 520, 72), run("GLASS", 470, 72), run("RATIN", 600, 72));
  // label row
  const y = 82;
  R.push(run("DOOR NO.", 100, y), run("FROM ROOM", 160, y), run("TO ROOM", 230, y), run("W", 300, y, 5), run("HT", 320, y, 10),
    run("TYPE", 350, y), run("MATL", 380, y), run("FINISH", 410, y), run("TYPE", 470, y), run("TYPE", 500, y), run("MATL", 530, y), run("FINISH", 560, y),
    run("G", 605, y, 5), run("SET NO.", 645, y));
  const rows: string[][] = [
    ["100A", "VESTIBULE", "", "6'-0\"", "7'-0\"", "FG 2", "HM", "PT-3", "GL-4", "-", "HM", "PT-3", "0", "1"],
    ["101", "CONFERENCE", "HALLWAY", "3'-0\"", "7'-0\"", "F", "HM", "PT-3", "-", "-", "HM", "PT-3", "20 MIN", "3"],
    ["112", "TRAINING", "DISPATCH", "3'-0\"", "7'-0\"", "F", "HM", "PT-3", "-", "-", "HM", "PT-3", "0", "8"],
  ];
  const xs = [100, 160, 230, 296, 318, 350, 380, 410, 470, 500, 530, 560, 602, 655];
  rows.forEach((r, i) => r.forEach((v, j) => { if (v) R.push(run(v, xs[j], 96 + i * 10)); }));
  return R;
}

test("readDoorSchedule: columns by heading, the second TYPE/MATL/FINISH is the frame's", () => {
  const s = readDoorSchedule(scheduleRuns());
  assert.ok(s);
  assert.deepEqual(s.rows.map((r) => r.mark), ["100A", "101", "112"]);
  const a = s.rows[0];
  assert.equal(a.width, "6'-0\"");
  assert.equal(a.height, "7'-0\"");
  assert.equal(a.doorType, "FG 2");
  assert.equal(a.glass, "GL-4");
  assert.equal(a.frameMaterial, "HM");
  assert.equal(a.hwSet, "1");
  assert.equal(s.rows[1].rating, "20 MIN");
  assert.equal(s.rows[1].toRoom, "HALLWAY");
});

test("readDoorSchedule: no title, no schedule", () => {
  assert.equal(readDoorSchedule(scheduleRuns().slice(1)), null);
});

test("readHardwareSets: label words and door marks out of the parenthesis", () => {
  const sets = readHardwareSets(`SECTION 08 71 00\nDOOR HARDWARE\n2.1 HARDWARE SETS\nA. Set 1 (secure vestibule pair, 100A): continuous hinges, exit devices.\nB. Set 6 (main operations and 911 call center, 106A, 111B): 3 hinges, storeroom lockset.\nC. Set 8 (ham radio, 107): 3 hinges.\n2.2 PRODUCTS\n`);
  assert.deepEqual(sets.map((s) => [s.set, s.label, s.marks]), [["1", "secure vestibule pair", ["100A"]], ["6", "main operations and 911 call center", ["106A", "111B"]], ["8", "ham radio", ["107"]]]);
  assert.match(sets[0].items, /continuous hinges/);
  assert.deepEqual(readHardwareSets("no section here, Set 1 (a, 101): x"), []);
});

const door = (x: number, y: number, leaves = 1, extra: Partial<ReadDoor> = {}): ReadDoor => ({
  box: [x, y, x + 36 * leaves, y + 36], pair: leaves > 1, stall: false, dashed: false, confidence: 1, doubts: [],
  leaves: Array.from({ length: leaves }, (_, k) => ({ hinge: [x + k * 72, y] as [number, number], radiusPt: 36, tip: [x + k * 72, y + 36] as [number, number], drawn: "curve" as const, sweepDeg: 90, misfitPt: 0, jambFt: 0.4, strike: true, leaf: "drawn" as const })),
  ...extra,
});

test("matchDoorTags: nearest scheduled tag, each mark once", () => {
  const doors = [door(0, 0), door(500, 0)];
  const runs = [run("101", 40, 10, 15), run("101", 300, 10, 15), run("112", 530, 50, 15), run("999", 10, 10, 15)];
  assert.deepEqual(matchDoorTags(doors, runs, new Set(["101", "112"])), ["101", "112"]);
});

test("buildDoorSuite: pairs, hardware conflicts, untagged and withheld doors, counts", () => {
  const schedule = readDoorSchedule(scheduleRuns())!;
  const sets = readHardwareSets("08 71 00\nA. Set 8 (ham radio, 107): hinges.\nB. Set 1 (vestibule, 100A): hinges.\nC. Set 3 (corridor, 101): hinges.\n");
  const doors = [door(0, 0, 2), door(200, 0), door(400, 0), door(600, 0), door(800, 0, 1, { confidence: -0.2, doubts: ["leaf under 2 ft"] })];
  const base = { doors, withheld: [false, false, false, false, true], marks: ["100A", "101", "112", null, null], schedule, sets, sheetLabel: "A101" };
  const v = buildDoorSuite({ ...base, answers: {} });
  const kinds = v.questions.map((q) => q.kind).sort();
  assert.deepEqual(kinds, ["hardware", "untagged", "withheld"]);
  assert.match(v.questions.find((q) => q.kind === "hardware")!.text, /Door 112 is on hardware set 8.*door 107 only|for door 107? only/);
  // 100A pair, 101, 112 counted; the untagged and the withheld door wait for an answer
  assert.deepEqual(v.counts, { openings: 3, frames: 3, leaves: 4, matched: 3, open: 3 });
  assert.equal(countLine(v.counts), "3 openings · 4 door leaves");
  const answered = buildDoorSuite({ ...base, answers: { "untagged:3": "Count it as a new door", "withheld:4": "It's a door, count it", "hardware:112": "Keep set 8, as scheduled" } });
  assert.deepEqual(answered.counts, { openings: 5, frames: 5, leaves: 6, matched: 3, open: 0 });
  const groups = estimateGroups(answered.openings);
  assert.equal(groups.reduce((s, g) => s + g.openings.length, 0), 5);
  assert.equal(groups.find((g) => g.type === "FG 2")!.leaves, 2);
});

test("buildDoorSuite: a plan pair against a single in the schedule is asked, and the answer sets the leaves", () => {
  const schedule = readDoorSchedule(scheduleRuns())!;
  const doors = [door(0, 0, 2)];
  const base = { doors, withheld: [false], marks: ["101"], schedule, sets: [], sheetLabel: "A101" };
  const q = buildDoorSuite({ ...base, answers: {} });
  assert.equal(q.questions[0].kind, "pair");
  assert.equal(q.counts.leaves, 2);
  const single = buildDoorSuite({ ...base, answers: { "pair:101": "Count it as a single, as scheduled" } });
  assert.equal(single.counts.leaves, 1);
});

test("scheduledPair and feetOf", () => {
  assert.equal(feetOf("3'-6\""), 3.5);
  assert.equal(feetOf("36\""), 3);
  assert.equal(scheduledPair({ doorType: "F 2", width: "6'-0\"" } as never), true);
  assert.equal(scheduledPair({ doorType: "F", width: "3'-0\"", remarks: "" } as never), false);
  assert.equal(scheduledPair({ doorType: "F", width: "6'-0\"", remarks: "" } as never), true);
});

test("textRuns: a rotated run keeps its true box", () => {
  const [r] = textRuns([{ str: "101", transform: [0, 10, -10, 0, 50, 50], width: 20, height: 10 }], [1, 0, 0, -1, 0, 100]);
  assert.ok(r.w < r.h, "vertical text is tall, not wide");
  assert.equal(r.str, "101");
});
