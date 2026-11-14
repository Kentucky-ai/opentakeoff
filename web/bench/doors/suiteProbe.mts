// Probe the Doors suite's readers on a real plan set, outside the browser.
//   node --import tsx bench/doors/suiteProbe.mts <plans.pdf> <plan page> <schedule page> [specs.pdf]
// Pages are 1-based. Prints the schedule rows, the plan's doors and their marks,
// the hardware sets and the questions. Reads only; writes nothing.
import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractDoorVectors } from "../../src/lib/doorVectors.ts";
import { readDoors, splitDoors, DOOR_CUTOFFS } from "../../src/lib/doorReader.ts";
import { readDoorSchedule, readHardwareSets, matchDoorTags, textRuns, buildDoorSuite, countLine, heldBack, feetInches } from "../../src/lib/doorSuite.ts";
import { extractVectorGeometry } from "../../src/lib/oneclick.ts";

const [plans, planPage, schedPage, specs] = process.argv.slice(2);
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(plans)) }).promise;
const sp = await doc.getPage(Number(schedPage));
const svp = sp.getViewport({ scale: 1 });
const sched = readDoorSchedule(textRuns((await sp.getTextContent()).items as never, svp.transform));
console.log("schedule rows", sched?.rows.length ?? 0);
for (const r of sched?.rows || []) console.log(" ", r.mark, "|", r.fromRoom, "|", r.toRoom, "|", r.width, r.height, "| type", r.doorType, "| frame", r.frameType, r.frameMaterial, "| glass", r.glass, "| rating", r.rating, "| hw", r.hwSet);
const pp = await doc.getPage(Number(planPage));
const vp0 = pp.getViewport({ scale: 1, rotation: 0 });
const t0 = Date.now();
const v = extractDoorVectors(await pp.getOperatorList() as never, vp0.transform, pdfjs.OPS as never);
const reading = await readDoors(v);
const { committed, withheld } = splitDoors(reading, DOOR_CUTOFFS.foundFirst);
console.log("doors", reading.doors.length, "committed", committed.length, "withheld", withheld.length, "ms", Date.now() - t0, "fpp", reading.fpp);
const runs = textRuns((await pp.getTextContent()).items as never, vp0.transform);
const marks = new Set((sched?.rows || []).map((r) => r.mark));
const geo = extractVectorGeometry(await pp.getOperatorList() as never, vp0.transform, pdfjs.OPS as never);
const tm = matchDoorTags(reading.doors, runs, marks, { segs: geo.segs });
const tags = tm.marks;
console.log("ambiguous", JSON.stringify(tm.ambiguous));
let sets: ReturnType<typeof readHardwareSets> = [];
if (specs) {
  const sdoc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(specs)) }).promise;
  for (let i = 1; i <= sdoc.numPages; i++) {
    const tc = await (await sdoc.getPage(i)).getTextContent();
    let text = "", lastY: number | null = null;
    for (const it of tc.items as Array<{ str: string; transform: number[]; hasEOL?: boolean }>) { if (lastY != null && Math.abs(it.transform[5] - lastY) > 2) text += "\n"; text += it.str; lastY = it.transform[5]; if (it.hasEOL) { text += "\n"; lastY = null; } }
    const s = readHardwareSets(text);
    if (s.length) { sets = s.map((x) => ({ ...x, page: i })); break; }
  }
}
console.log("hardware sets", sets.map((s) => `${s.set}:[${s.marks.join(",")}]`).join(" "));
reading.doors.forEach((d, i) => console.log(" door", i, tags[i] ?? "-", d.pair ? "PAIR" : "", d.leaves.length, "leaves conf", d.confidence, d.doubts.join("; ")));
const view = buildDoorSuite({ doors: reading.doors, withheld: heldBack(reading.doors, DOOR_CUTOFFS.foundFirst), fpp: reading.fpp, marks: tags, ambiguous: tm.ambiguous, schedule: sched, sets, answers: {}, sheetLabel: "A101" });
for (const o of view.openings) console.log(" opening", o.door, o.mark ?? "-", "drawn", o.drawnFt == null ? "-" : feetInches(o.drawnFt), "scheduled", o.row?.width ?? "-", reading.doors[o.door].stall ? "STALL" : "");
console.log(countLine(view.counts), "matched", view.counts.matched, "questions", view.questions.length);
for (const q of view.questions) console.log(" Q", q.kind, q.text);
