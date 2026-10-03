// The picture rule's parameters (#489) and their hash, apart from
// pictures.ts so the stores that keep measured pictures or picture reads
// (thumbnail records, ocr/pageCache) can check the hash without bringing in
// pdf.js. pictures.ts re-exports all of it.
import { SCAN_MAX_TEXT_LINES } from "./planIndex";

/** Smallest picture worth a read, in square inches (bounding box). */
export const PICTURE_MIN_SQIN = 15;
/** Placements this close (pt) or closer are one picture: a table exported
 *  as abutting strips or tiles leaves hairline gaps between them. */
export const PICTURE_MERGE_SLACK_PT = 2;

/** Revision of the walk and merge rules (imageRectsOf, placementRects,
 *  mergePlacements, linesOverRegion). Any change to what they produce for the
 *  same page bumps it, so pictures measured under the old rules re-measure. */
const PICTURE_RULES_REV = 1;

/** 8 hex chars (FNV-1a 32) of the rule's revision and parameters, stored
 *  beside measured pictures so a change to the rule re-measures them (as
 *  ocr/pageCache's OCR_CACHE_OPTS does for reads). */
export const PICTURE_PARAMS_HASH = (() => {
  const s = JSON.stringify({ rev: PICTURE_RULES_REV, minSqIn: PICTURE_MIN_SQIN, slackPt: PICTURE_MERGE_SLACK_PT, maxLines: SCAN_MAX_TEXT_LINES });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
})();
