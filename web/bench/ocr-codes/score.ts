// Compare a recognition to the code in THAT cell, not any code in the table.
// Keep punctuation: P-1, P1 and P.1 are different identities for this probe.
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

export function summarize(rows: ReturnType<typeof scoreRows>) {
  return {
    total: rows.length,
    exact: rows.filter((r) => r.ok).length,
    unflaggedWrong: rows.filter((r) => !r.ok && !r.cells.some((c) => c.codeAlternate !== undefined)).length,
    flaggedCorrect: rows.filter((r) => r.ok && r.cells.some((c) => c.codeAlternate !== undefined)).length,
    missing: rows.filter((r) => !r.cells.length).length,
    thresholds: [0.8, 0.9, 0.95, 0.99].map((threshold) => ({
      threshold,
      correctAtOrAbove: rows.filter((r) => r.ok && (r.confidence ?? -1) >= threshold).length,
      wrongAtOrAbove: rows.filter((r) => !r.ok && (r.confidence ?? -1) >= threshold).length,
    })),
  };
}
