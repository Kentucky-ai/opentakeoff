// Every order the index entries of one hybrid sheet can arrive in (#489), up
// to five arrivals: a measured text pass (the walk, the thumbnails), one
// whose op list failed (pictures "failed"), the canvas's label-loop pass (not
// measured), a kept thumbnail record with the pictures (seeded into an empty
// slot, else adopted: thumbIndexStep), and a read. Run both as the app runs them (a text pass only when needsTextPass
// asks for one) and ungated.
// Whatever the order, once a read is in, it is found as OCR and the text
// layer's own words as text; once a measured pass or record has arrived,
// the entry has its pictures: a real measurement's (an array) when any
// arrived, whichever came first ("failed" is the weakest measurement), else
// "failed" (never measured again); until then, it still asks for a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSheetIndex, type Rect, type SheetIndex } from "../src/lib/planIndex.ts";
import { galleryReadView, needsRead, needsTextPass, putSheetIndex, runPlanSearch, thumbIndexStep } from "../src/lib/planSearch.ts";

const K = "h.pdf";
const P: Rect = { x0: 1, y0: 2, x1: 300, y1: 400 };
const runs = (...s: string[]) => s.map((str) => ({ str }));
const textRuns = runs(...Array.from({ length: 12 }, (_, i) => (i === 0 ? "STAIRWELL CPT-1" : `ROOM NOTE ${i}`)));
const ocrRuns = runs("VCT-1 CPT-1", "BROADLOOM");

type Arrival = { name: string; mk: (have: SheetIndex | undefined) => SheetIndex | null; text?: boolean; measured?: Rect[] | "failed" };
const REC = { textLayer: true, pictures: [P] };
/** A kept record, as the gallery applies it: a seed, its pictures adopted, or nothing. */
function record(have: SheetIndex | undefined): SheetIndex | null {
  const step = thumbIndexStep(REC, K, () => have, () => false);
  if (step.kind === "seed") return step.ix;
  if (step.kind !== "adopt") return null;
  const { kind: _k, ...fields } = step;
  return { ...have!, ...fields };
}
const ARRIVALS: Arrival[] = [
  { name: "Tm", text: true, measured: [P], mk: () => ({ ...buildSheetIndex(K, textRuns, "text"), textLayer: true, pictures: [P] }) },
  { name: "Tf", text: true, measured: "failed", mk: () => ({ ...buildSheetIndex(K, textRuns, "text"), textLayer: true, pictures: "failed" }) },
  { name: "Tu", text: true, mk: () => ({ ...buildSheetIndex(K, textRuns, "text"), textLayer: true }) },
  { name: "R", measured: [P], mk: record },
  { name: "O", mk: () => buildSheetIndex(K, ocrRuns, "ocr") },
];

/** Every sequence of 1..n arrivals. */
function orders(n: number): Arrival[][] {
  let out: Arrival[][] = [[]];
  const all: Arrival[][] = [];
  for (let i = 0; i < n; i++) {
    out = out.flatMap((s) => ARRIVALS.map((a) => [...s, a]));
    all.push(...out);
  }
  return all;
}

const src = (map: Map<string, SheetIndex>, q: string) => runPlanSearch(q, map, [K]).hits.map((h) => h.source).join("|") || "none";

test("hybrid: every arrival order, gated as the app gates it and ungated, ends found, measured when anything measured, else still asking", () => {
  const problems: string[] = [];
  for (const gated of [true, false]) {
    for (const seq of orders(5)) {
      const name = seq.map((a) => a.name).join(",") + (gated ? " [gated]" : "");
      const map = new Map<string, SheetIndex>();
      const applied: Arrival[] = [];
      for (const a of seq) {
        if (gated && a.text && !needsTextPass(map.get(K))) continue;
        const ix = a.mk(map.get(K));
        if (!ix) { applied.push(a); continue; }
        const before = JSON.stringify(map.get(K));
        const changed = putSheetIndex(map, K, ix);
        if (!changed && before !== JSON.stringify(map.get(K))) problems.push(`${name}: returned false but changed at ${a.name}`);
        applied.push(a);
      }
      const ix = map.get(K);
      if (!ix) continue;
      const read = applied.some((a) => a.name === "O");
      const text = applied.some((a) => a.text);
      const real = applied.find((a) => Array.isArray(a.measured))?.measured;
      const expected = real ?? applied.find((a) => a.measured)?.measured;
      const measured = expected !== undefined;
      const hybrid = Array.isArray(expected);
      if (measured && JSON.stringify(ix.pictures) !== JSON.stringify(expected)) problems.push(`${name}: pictures ${JSON.stringify(ix.pictures)}`);
      if (!read) {
        if (needsRead(ix) !== hybrid) problems.push(`${name}: needsRead ${needsRead(ix)}`);
        continue;
      }
      if (ix.source !== "ocr") problems.push(`${name}: not ocr`);
      if (src(map, "VCT-1") !== "ocr") problems.push(`${name}: VCT-1 ${src(map, "VCT-1")}`);
      if (needsRead(ix)) problems.push(`${name}: needsRead after the read`);
      if (!text) continue;
      if (src(map, "STAIRWELL") !== "text") problems.push(`${name}: STAIRWELL ${src(map, "STAIRWELL")}`);
      if (ix.textLayer !== true) problems.push(`${name}: textLayer ${ix.textLayer}`);
      if (measured) {
        if (needsTextPass(ix)) problems.push(`${name}: measured, still needsTextPass`);
        if (galleryReadView(ix, "available", undefined).what !== (hybrid ? "picture" : "page")) problems.push(`${name}: reads as a ${galleryReadView(ix, "available", undefined).what}`);
      } else if (!needsTextPass(ix)) problems.push(`${name}: never measured, and no pass asked for`);
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});
