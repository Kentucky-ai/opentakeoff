// How much real text an image may carry and still be read on-device. A leaf
// with no imports, so the light modules that need it (scheduleRoute.ts,
// pictureParams.ts) don't load the search index.

/** The one limit for "a few stray labels" (a scanner label, a stamp, a title
 *  typed over a picture), used in three places:
 *  - a page is a scan when its text layer has at most this many lines
 *    (planIndex SCAN_MAX_TEXT_LINES, indexIsScanLike);
 *  - a picture is unread when at most this many text-layer lines lie over it
 *    (pictures.ts unreadPictures);
 *  - an Import from schedule box whose text holds no table goes to the
 *    on-device reader when it has at most this many text runs, else it gets
 *    the re-drag hint (scheduleRoute STRAY_TEXT_MAX_RUNS).
 *  Why the box counts runs and the others lines: by lines, most sloppy boxes
 *  on vector sheets would start the reader (first use: a ~36 MB download)
 *  instead of getting the instant re-drag hint. In a grid sweep of boxes with
 *  text but no table on the demo plan, 152 of 290 on sheet 1 and 255 of 400
 *  on sheet 2 that get the hint by runs would start the reader by lines;
 *  none went the other way, except one box placed by hand at an edge.
 *  Provenance: chosen for the import box (#470), adopted for pages (#471) and
 *  pictures (#489); not measured on pages or pictures. */
export const STRAY_TEXT_MAX = 8;
