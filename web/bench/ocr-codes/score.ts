// Compare a recognition to the code in THAT cell, not any code in the table.
// Keep punctuation: P-1, P1 and P.1 are different identities for this probe.
import { comparable } from "../../src/lib/ocr/codeCheck.ts";

export type Rect = { x0: number; y0: number; x1: number; y1: number };
export type TruthRow = { expected: string; rect: Rect };
export type Read = { text: string; confidence?: number; codeAlternate?: string; rect: Rect };

export function scoreRows(rows: TruthRow[], reads: Read[]) {
  return rows.map((row) => {
    const cells = reads.filter(({ rect }) => {
      const x = (rect.x0 + rect.x1) / 2, y = (rect.y0 + rect.y1) / 2;
      return x >= row.rect.x0 && x < row.rect.x1 && y >= row.rect.y0 && y < row.rect.y1;
    }).sort((a, b) => a.rect.x0 - b.rect.x0);
    const actual = cells.map((c) => c.text.trim()).join(" ").trim().toUpperCase();
    // No average across boxes: confidence claims below concern one code box.
    const confidence = cells.length === 1 ? cells[0].confidence : undefined;
    return { ...row, actual, ok: actual === row.expected, confidence, cells };
  });
}

type Scored = ReturnType<typeof scoreRows>[number];

const flagged = (r: Scored) => r.cells.some((c) => c.codeAlternate !== undefined);
/** #519 point 3: an empty second view and a competing string are different
 * failures. A row with any non-empty alternate counts as "alternate". */
const flagKind = (r: Scored): "none" | "empty" | "alternate" =>
  !flagged(r) ? "none" : r.cells.some((c) => c.codeAlternate) ? "alternate" : "empty";
/** The row read with each flagged cell's alternate in place of its text. */
const rowAlternate = (r: Scored) => comparable(r.cells.map((c) => c.codeAlternate ?? c.text).join(" "));

export function summarize(rows: Scored[]) {
  const kind = (k: "empty" | "alternate") => rows.filter((r) => flagKind(r) === k);
  const alternates = kind("alternate");
  return {
    total: rows.length,
    exact: rows.filter((r) => r.ok).length,
    unflaggedWrong: rows.filter((r) => !r.ok && !flagged(r)).length,
    flaggedCorrect: rows.filter((r) => r.ok && flagged(r)).length,
    flaggedEmpty: { correct: kind("empty").filter((r) => r.ok).length, wrong: kind("empty").filter((r) => !r.ok).length },
    flaggedAlternate: {
      correct: alternates.filter((r) => r.ok).length,
      wrong: alternates.filter((r) => !r.ok).length,
      alternateIsTruth: alternates.filter((r) => rowAlternate(r) === comparable(r.expected)).length,
    },
    missing: rows.filter((r) => !r.cells.length).length,
    thresholds: [0.8, 0.9, 0.95, 0.99].map((threshold) => ({
      threshold,
      correctAtOrAbove: rows.filter((r) => r.ok && (r.confidence ?? -1) >= threshold).length,
      wrongAtOrAbove: rows.filter((r) => !r.ok && (r.confidence ?? -1) >= threshold).length,
    })),
  };
}

const tally = () => ({
  flagged: 0,
  // the second read against the printed code
  read: { correct: 0, wrong: 0, nothing: 0 },
  // #519 point 2: a blind read is disagreement evidence, not a vote. Clear
  // the flag only when it equals the primary read; equal to the alternate is
  // two reads against one and stays in front of the person; anything else
  // (a third string, or nothing usable) leaves the row on Check code.
  blind: { clearedCorrect: 0, clearedWrong: 0, twoVsOne: 0, twoVsOneAlternateRight: 0, keptThird: 0, keptNothing: 0 },
  // The counterfactual: take any usable second read as the code.
  naive: { settledCorrect: 0, settledWrong: 0, brokeCorrect: 0, kept: 0 },
});
export type SecondReadTally = ReturnType<typeof tally>;

/** #519 point 1: score a second read over FLAGGED rows only. `secondReads`
 * is aligned with `rows`; unflagged rows are never read or counted. `unit`
 * labels the crop the reader saw (a tight crop, a whole schedule row, …) so
 * two units print side by side. */
export function scoreSecondRead(rows: Scored[], secondReads: Array<string | null | undefined>, unit: string) {
  const out = { unit, all: tally(), empty: tally(), alternate: tally() };
  rows.forEach((row, i) => {
    const k = flagKind(row);
    if (k === "none") return;
    const second = comparable(secondReads[i] ?? "");
    const truth = comparable(row.expected), primary = comparable(row.actual), alternate = rowAlternate(row);
    for (const t of [out.all, out[k]]) {
      t.flagged++;
      if (!second) { t.read.nothing++; t.blind.keptNothing++; t.naive.kept++; continue; }
      if (second === truth) t.read.correct++; else t.read.wrong++;
      if (second === primary) {
        if (primary === truth) t.blind.clearedCorrect++; else t.blind.clearedWrong++;
      } else if (alternate && second === alternate) {
        t.blind.twoVsOne++;
        if (alternate === truth) t.blind.twoVsOneAlternateRight++;
      } else t.blind.keptThird++;
      if (second === truth) t.naive.settledCorrect++;
      else { t.naive.settledWrong++; if (row.ok) t.naive.brokeCorrect++; }
    }
  });
  return out;
}

const LINES: Array<[string, (t: SecondReadTally) => number]> = [
  ["flagged rows read", (t) => t.flagged],
  ["second read = printed code", (t) => t.read.correct],
  ["second read wrong", (t) => t.read.wrong],
  ["second read: nothing usable", (t) => t.read.nothing],
  ["blind rule: flags cleared correctly", (t) => t.blind.clearedCorrect],
  ["blind rule: flags cleared wrongly", (t) => t.blind.clearedWrong],
  ["blind rule: two reads vs one, shown", (t) => t.blind.twoVsOne],
  ["  of which the alternate is the printed code", (t) => t.blind.twoVsOneAlternateRight],
  ["blind rule: third string, kept", (t) => t.blind.keptThird],
  ["blind rule: nothing usable, kept", (t) => t.blind.keptNothing],
  ["naive rule: settled correctly", (t) => t.naive.settledCorrect],
  ["naive rule: settled wrongly", (t) => t.naive.settledWrong],
  ["  of which a correct primary turned wrong", (t) => t.naive.brokeCorrect],
];

/** A Markdown table: one row per measure, one column per crop unit. */
export function formatSecondReadTable(results: Array<ReturnType<typeof scoreSecondRead>>, kind: "all" | "empty" | "alternate" = "all") {
  const label = (s: string) => s.replace(/^  /, "↳ ");
  return [
    `| ${kind === "all" ? "flagged rows" : `flagged rows, ${kind === "empty" ? "empty second view" : "real alternate"}`} | ${results.map((r) => r.unit).join(" | ")} |`,
    `|---|${results.map(() => "---:").join("|")}|`,
    ...LINES.map(([name, get]) => `| ${label(name)} | ${results.map((r) => get(r[kind])).join(" | ")} |`),
  ].join("\n");
}
