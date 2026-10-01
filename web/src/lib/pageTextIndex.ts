// One page's text layer → its plan-search index entry. The pdf.js-touching
// half of search, kept apart so planIndex.ts / planSearch.ts stay pdfjs-free.
//
// The whole page is read through extractRegionText over the full viewport
// rect, the same token reader Copy text uses, so search and copy see the same
// runs. A page with no text still gets an entry
// (tokenCount 0): that is how search knows a sheet was checked and has no text
// layer, as opposed to not checked yet.
import { extractRegionText } from "./sheets";
import { buildSheetIndex, type SheetIndex } from "./planIndex";

type TextContent = Parameters<typeof extractRegionText>[0];
type PageViewport = Parameters<typeof extractRegionText>[1];

export function pageTextIndex(key: string, textContent: TextContent, viewport: PageViewport): SheetIndex {
  const items = extractRegionText(textContent, viewport, { x0: 0, y0: 0, x1: viewport.width, y1: viewport.height });
  return buildSheetIndex(key, items, "text");
}
