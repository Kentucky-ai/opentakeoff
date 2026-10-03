// Pictures on a vector sheet (#489): a raster image pasted onto a page that
// has a text layer, such as a schedule exported as a picture. The scan rule
// (planIndex indexIsScanLike) looks at the whole page, so a picture among
// hundreds of lines of vector text is never offered a read, and its codes
// never reach search. This module finds such pictures.
//
// THE rule: an unread picture is a picture region of at least
// PICTURE_MIN_SQIN over which the text layer holds at most
// SCAN_MAX_TEXT_LINES lines. A region is a cluster of image placements that
// overlap or touch (PICTURE_MERGE_SLACK_PT): its bounding box plus the
// member rects. Lines over it are counted on the member rects, so text in
// the empty corner of an L-shaped cluster doesn't count against it.
//
// Units: rects are points at viewport scale 1 (1/72 in; pdf.js's viewport
// applies UserUnit, so this holds on a page that sets one), top-left origin,
// in the page's rotated frame. The op walk runs in whatever transform it is
// handed (a viewport's, at its scale), and measurePage divides by the
// viewport's scale before anything is merged or stored.
//
// The floor is physical, not a fraction of the page: logos and seals keep
// their size from sheet to sheet. Measured on every tracked PDF (21 files,
// 37 pages), the largest logo or seal is 11.2 sq in and the one raster table
// on a vector sheet (Porterville A1-101) 18.81. Known limits: a clipped
// image counts at its full placement size, and images on a hidden optional
// content layer count as painted.
//
// Everything here is pure except measurePage, which does the page I/O
// (getTextContent, getOperatorList) on the pdf.js page it is handed. pdf.js's
// OPS table is passed in, as extractVectorGeometry takes it.
import type { OpList, OpsTable } from "./oneclick";
import { buildSheetIndex, indexIsScanLike, SCAN_MAX_TEXT_LINES, type IndexedTextItem, type Rect, type SheetIndex } from "./planIndex";
import { PICTURE_MERGE_SLACK_PT, PICTURE_MIN_SQIN } from "./pictureParams";
import { pageRuns, pageTextIndex } from "./pageTextIndex";
import type { extractRegionText } from "./sheets";

export type { Rect };
export { PICTURE_MERGE_SLACK_PT, PICTURE_MIN_SQIN, PICTURE_PARAMS_HASH } from "./pictureParams";

/** One picture: the bounding box of its placements, the placements
 *  themselves, and the box's area in square inches. */
export interface PictureRegion { bbox: Rect; rects: Rect[]; sqin: number }

type TextContent = Parameters<typeof extractRegionText>[0];
type Viewport = Parameters<typeof extractRegionText>[1] & { scale: number; width: number; height: number; offsetX?: number; offsetY?: number };

/** The two calls measurePage makes on a pdf.js page. */
export interface MeasurablePage {
  getTextContent(): Promise<TextContent>;
  getOperatorList(): Promise<OpList>;
}

const mul = (a: number[], b: number[]): number[] => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

/** Bounds of the unit square under transform t: where an image lands, since
 *  every image paint op draws its image into the unit square. */
function unitSquare(t: number[]): Rect {
  const xs = [t[4], t[0] + t[4], t[2] + t[4], t[0] + t[2] + t[4]];
  const ys = [t[5], t[1] + t[5], t[3] + t[5], t[1] + t[3] + t[5]];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Where one image paint op places its image(s), given the current transform
 *  m. Argument shapes follow canvas.js: the single ops are preceded by their
 *  own `transform` (already in m); the *Repeat and *Group ops pdf.js folds
 *  runs of placements into carry each instance's transform in their args
 *  (extractVectorGeometry's imageArea reads the same shapes). Any other op
 *  places nothing, paintSolidColorImageMask included: canvas.js draws it as
 *  fillRect(0, 0, 1, 1), a filled rectangle in the current colour, not a
 *  picture. */
export function placementRects(fn: number, args: any, m: number[], OPS: OpsTable): Rect[] {
  if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
    return [unitSquare(m)];
  }
  const out: Rect[] = [];
  if (fn === OPS.paintImageXObjectRepeat) {
    // [objId, scaleX, scaleY, positions]: positions is a flat (x, y) list
    const [, sx, sy, pos] = args;
    for (let i = 0; pos && i + 1 < pos.length; i += 2) out.push(unitSquare(mul(m, [sx, 0, 0, sy, pos[i], pos[i + 1]])));
  } else if (fn === OPS.paintImageMaskXObjectRepeat) {
    // [img, scaleX, skewX, skewY, scaleY, positions]
    const [, sx, kx, ky, sy, pos] = args;
    for (let i = 0; pos && i + 1 < pos.length; i += 2) out.push(unitSquare(mul(m, [sx, kx, ky, sy, pos[i], pos[i + 1]])));
  } else if (fn === OPS.paintImageMaskXObjectGroup) {
    // [images]: each images[k].transform is that instance's own
    for (const im of args?.[0] || []) if (im?.transform) out.push(unitSquare(mul(m, im.transform)));
  } else if (fn === OPS.paintInlineImageXObjectGroup) {
    // [img, map]: each map[k].transform is that instance's own
    for (const mp of args?.[1] || []) if (mp?.transform) out.push(unitSquare(mul(m, mp.transform)));
  }
  return out;
}

/** Every image placement on a page, in the space of `transform` (a viewport
 *  transform: device px at its scale). The walk tracks the current transform
 *  the way canvas.js does, on one save stack:
 *  - save/restore and transform;
 *  - a form XObject: its begin is a save, then its matrix (and the result
 *    becomes the base transform for its span); its end is a restore. A form's
 *    surplus Q reaches the op list as a plain restore (pdf.js passes it
 *    through), so, as on the canvas, it pops the form's own save and the
 *    form's end pops whatever lies below;
 *  - a transparency group: its begin is a save and its end a restore (canvas.js
 *    beginGroup/endGroup). Its matrix is not applied: canvas.js uses it only to
 *    size the group's scratch canvas, which starts from the current transform.
 *    Confirmed for balanced content only: a surplus Q inside a group pops the
 *    shared state stack in canvas.js but restores the scratch canvas, which
 *    holds no saved transform, so there the walk pops and the canvas doesn't;
 *  - an annotation restarts from the base transform, whatever the page's
 *    content left unbalanced, then applies its own transform and its
 *    appearance's matrix. A surplus Q inside an appearance is malformed and is
 *    ignored: the walk empties the stack at each annotation, so it pops
 *    nothing. */
export function imageRectsOf(ol: OpList, transform: number[], OPS: OpsTable): Rect[] {
  const rects: Rect[] = [];
  let m = transform.slice();
  let base = m;
  const stack: number[][] = [];
  const bases: number[][] = [];
  const fns = ol.fnArray, A = ol.argsArray;
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i], args = A[i];
    if (fn === OPS.save || fn === OPS.beginGroup) stack.push(m);
    else if (fn === OPS.restore || fn === OPS.endGroup) { const p = stack.pop(); if (p) m = p; }
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(m);
      bases.push(base);
      if (args && args[0]) m = mul(m, args[0]);
      base = m;
    } else if (fn === OPS.paintFormXObjectEnd) {
      const p = stack.pop(); if (p) m = p;
      const b = bases.pop(); if (b) base = b;
    } else if (fn === OPS.beginAnnotation) {
      // [id, rect, transform, matrix, hasOwnCanvas]
      stack.length = 0;
      m = mul(mul(base, args[2]), args[3]);
    } else {
      const placed = placementRects(fn, args, m, OPS);
      for (const r of placed) rects.push(r);
    }
  }
  return rects;
}

const area = (r: Rect) => ((r.x1 - r.x0) / 72) * ((r.y1 - r.y0) / 72);

/** Placements (pt) that overlap or come within PICTURE_MERGE_SLACK_PT of
 *  each other, joined into regions, chains included (A touches B touches C).
 *  Sort-and-sweep along x with union-find: each placement is compared only
 *  with the earlier ones whose x span is still open, i.e. each pair whose x
 *  spans overlap (within the slack) is compared once. That is not a
 *  sub-quadratic bound: placements stacked in one x band all overlap in x.
 *  Measured on the demo (n = 12,433 placements a page): 3,220,769
 *  comparisons, about n²/48, each a pair of number compares. `stats` counts
 *  them (the tests bound the demo's count). No floor: pictureRegions
 *  applies it. */
export function mergePlacements(rects: readonly Rect[], stats?: { comparisons: number }): PictureRegion[] {
  const n = rects.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => rects[a].x0 - rects[b].x0);
  const s = PICTURE_MERGE_SLACK_PT;
  const open: number[] = [];
  for (const i of order) {
    const r = rects[i];
    // drop the spans that closed before r, compacting in place
    let k = 0;
    for (let t = 0; t < open.length; t++) {
      const j = open[t];
      if (rects[j].x1 + s < r.x0) continue;
      open[k++] = j;
      if (stats) stats.comparisons++;
      const q = rects[j];
      if (q.y0 - s <= r.y1 && r.y0 - s <= q.y1) parent[find(i)] = find(j);
    }
    open.length = k;
    open.push(i);
  }
  const groups = new Map<number, Rect[]>();
  for (let i = 0; i < n; i++) {
    const k = find(i);
    const g = groups.get(k);
    if (g) g.push(rects[i]); else groups.set(k, [rects[i]]);
  }
  return [...groups.values()].map((members) => {
    // a loop, not Math.min(...): a cluster can hold more members than a call takes arguments
    const bbox = { ...members[0] };
    for (const r of members) {
      if (r.x0 < bbox.x0) bbox.x0 = r.x0; if (r.y0 < bbox.y0) bbox.y0 = r.y0;
      if (r.x1 > bbox.x1) bbox.x1 = r.x1; if (r.y1 > bbox.y1) bbox.y1 = r.y1;
    }
    return { bbox, rects: members, sqin: area(bbox) };
  });
}

/** The picture regions of a page's placements (pt): merged first, then
 *  floored, so a picture drawn in strips counts at its whole size. */
export function pictureRegions(rects: readonly Rect[], stats?: { comparisons: number }): PictureRegion[] {
  return mergePlacements(rects, stats).filter((r) => r.sqin >= PICTURE_MIN_SQIN);
}

/** Lines of text over a region: the runs whose anchor point (extractRegionText's
 *  plain rule) lies inside any member rect, assembled into lines as the scan
 *  rule counts them. `items` are a page's runs in viewport px at `scale`;
 *  the region is in pt. */
export function linesOverRegion(items: readonly IndexedTextItem[], region: PictureRegion, scale = 1): number {
  const inside = items.filter((it) => {
    const x = (it.x ?? NaN) / scale, y = (it.y ?? NaN) / scale;
    return region.rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  });
  return buildSheetIndex("", inside).lineCount;
}

/** The regions the text layer can't read: at most SCAN_MAX_TEXT_LINES lines
 *  over them. */
export function unreadPictures(regions: readonly PictureRegion[], linesOver: (r: PictureRegion) => number): PictureRegion[] {
  return regions.filter((r) => linesOver(r) <= SCAN_MAX_TEXT_LINES);
}

/** One page's text-layer index and its unread pictures (bounding boxes, pt
 *  at scale 1), which the index carries too (SheetIndex pictures). Text
 *  first: a scan is decided by it alone and never fetches the op list (its
 *  read covers the whole page). Otherwise the op list is walked; if pdf.js
 *  can't produce it the pictures are "failed" and the text entry still
 *  stands.
 *
 *  `vp` must carry no transform but the page's own (rotation, the y flip,
 *  scale): the rects are stored in that frame divided by scale, and a
 *  viewport built with offsetX/offsetY (a crop) would shift every one of
 *  them. Such a viewport is refused with an Error. */
export async function measurePage(
  key: string,
  page: MeasurablePage,
  vp: Viewport,
  OPS: OpsTable,
): Promise<{ index: SheetIndex; pictures: Rect[] | "failed" }> {
  if (vp.offsetX || vp.offsetY) {
    throw new Error(`measurePage: the viewport has offsets (${vp.offsetX ?? 0}, ${vp.offsetY ?? 0}); pictures are stored in the page's own frame, so pass a viewport without offsetX/offsetY`);
  }
  const tc = await page.getTextContent();
  const items = pageRuns(tc, vp);
  const index = pageTextIndex(key, tc, vp, items);
  const done = (pictures: Rect[] | "failed") => ({ index: { ...index, pictures }, pictures });
  if (indexIsScanLike(index)) return done([]);
  let ol: OpList;
  try {
    ol = await page.getOperatorList();
  } catch {
    return done("failed");
  }
  const s = vp.scale;
  const placed = imageRectsOf(ol, vp.transform, OPS).map((r) => ({ x0: r.x0 / s, y0: r.y0 / s, x1: r.x1 / s, y1: r.y1 / s }));
  const regions = pictureRegions(placed);
  if (!regions.length) return done([]);
  return done(unreadPictures(regions, (r) => linesOverRegion(items, r, s)).map((r) => r.bbox));
}
