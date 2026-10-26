// Page text → the spans the sheet graph reads. PURE and pdfjs-free (the
// textjoin.ts / sheets.ts precedent): it takes a page's textContent items and
// its viewport transform, so the canvas (Import from schedule, the agent's
// read_schedule) builds EXACTLY the spans the MCP server hands
// buildSheetGraph — mcp/src/pdf.ts rawSpans + joinAbuttingSpans, the same
// rotation hull, the same toFixed(1) rounding, the same height fallback.
// mcp/test/pageSpans.test.ts holds the two to equality on the demo sheet.
//
// The one difference is the render scale: the MCP always renders at
// RENDER_SCALE, the canvas at its own per-sheet scale, so it is a parameter.
import { joinAbuttingSpans } from "./textjoin.ts";

/** A pdf.js text item, as much of it as the builder reads. */
export interface PageTextItem { str?: string; transform: number[]; width?: number; height?: number }

/** A joined span in image px: the graph's box ({x, y, w, h}, y down; `rot`
 *  the reading direction in degrees, only when nonzero) plus the joined run's
 *  baseline origin (ox, oy) — the point a marquee crop tests. */
export interface PageSpan { str: string; x: number; y: number; w: number; h: number; rot?: number; ox: number; oy: number }

/** pdf.js Util.transform(a, b), inlined so this module stays pdfjs-free. */
const mul = (a: number[], b: number[]): number[] => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

type RawSpan = { str: string; ox: number; oy: number; x0: number; y0: number; x1: number; y1: number; rot?: number };

/** Every non-blank text item as one joined span per run a reader sees as one
 *  string ("VCT" + "-" + "1" → "VCT-1"), in the page's reading order.
 *  `viewportTransform` is the viewport the page renders through; `scale` its
 *  px-per-pt (item widths/heights are user-space units). */
export function pageSpans(items: readonly PageTextItem[], viewportTransform: number[], scale: number): PageSpan[] {
  const raw: RawSpan[] = [];
  for (const it of items || []) {
    const str = it.str || "";
    if (!str.trim()) continue;
    const t = mul(viewportTransform, it.transform);
    const x = t[4], y = t[5];
    const w = (it.width || 0) * scale;
    // pdf.js gives height on most items; the composed transform's column
    // norm is the font's device height when it doesn't
    const h = (it.height || 0) * scale || Math.hypot(t[2], t[3]);
    const dn = Math.hypot(t[0], t[1]) || 1;
    const un = Math.hypot(t[2], t[3]) || 1;
    const dx = t[0] / dn, dy = t[1] / dn;   // along the run
    const ux = t[2] / un, uy = t[3] / un;   // glyph ascent
    const xs = [x, x + w * dx, x + h * ux, x + w * dx + h * ux];
    const ys = [y, y + w * dy, y + h * uy, y + w * dy + h * uy];
    const rot = ((Math.round((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
    raw.push({
      str, ox: +x.toFixed(1), oy: +y.toFixed(1),
      x0: +Math.min(...xs).toFixed(1), y0: +Math.min(...ys).toFixed(1),
      x1: +Math.max(...xs).toFixed(1), y1: +Math.max(...ys).toFixed(1),
      ...(rot ? { rot } : {}),
    });
  }
  return joinAbuttingSpans(raw).map((s) => ({
    str: s.str, x: s.x0, y: s.y0, w: s.x1 - s.x0, h: s.y1 - s.y0,
    ...(s.rot ? { rot: s.rot } : {}),
    ox: s.ox, oy: s.oy,
  }));
}

/** The spans a marquee holds: a span is inside when its baseline origin is
 *  (edges inclusive — extractRegionText's test), whichever corner the drag
 *  started from. */
export function spansInRect<T extends { ox: number; oy: number }>(spans: readonly T[], rect: { x0: number; y0: number; x1: number; y1: number }): T[] {
  const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
  return spans.filter((s) => s.ox >= x0 && s.ox <= x1 && s.oy >= y0 && s.oy <= y1);
}

/** The graph's input: the box without the origin fields (what the MCP session
 *  hands buildSheetGraph). */
export function graphSpans(spans: readonly PageSpan[]): Array<{ str: string; x: number; y: number; w: number; h: number; rot?: number }> {
  return spans.map(({ ox: _ox, oy: _oy, ...s }) => s);
}
