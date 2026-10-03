// The one limit for "a few stray labels" (strayText.ts): a scan page and an
// unread picture count it in lines, an Import from schedule box with no table
// in text runs. The bounds are one value. (pictures.test.ts checks
// unreadPictures at SCAN_MAX_TEXT_LINES and pins PICTURE_PARAMS_HASH.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { STRAY_TEXT_MAX } from "../src/lib/strayText.ts";
import { SCAN_MAX_TEXT_LINES } from "../src/lib/planIndex.ts";
import { STRAY_TEXT_MAX_RUNS } from "../src/lib/scheduleRoute.ts";

test("the scan, picture and import-box limits are one value", () => {
  assert.equal(STRAY_TEXT_MAX, 8);
  assert.equal(SCAN_MAX_TEXT_LINES, STRAY_TEXT_MAX);
  assert.equal(STRAY_TEXT_MAX_RUNS, STRAY_TEXT_MAX);
});
