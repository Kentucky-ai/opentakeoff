// The scan-path normalizer: turns a loosely-typed /ai/parse-schedule response
// (bring-your-own-model, so it may be partial/garbage) into the SAME validated
// ScheduleRow[] the vector parser emits. Invariants:
//   - accepts { rows: [...] } or a bare array; anything else → [];
//   - a row with no finish_tag is dropped (can't become a condition);
//   - unknown category → "other"; tags/sections upper-cased, fields trimmed;
//   - suggested honors an explicit boolean, else the category default
//     (ceiling/other start unchecked — same as the vector path);
//   - de-dupes by finish_tag (first wins), since the dialog keys on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeScanRows, postScanWithRetry, SCAN_ENDPOINT, SCAN_MAX_DIM, SCAN_RETRY_STATUS, scanRasterScale } from "../src/lib/scheduleScan.js";

test("normalizes a well-formed { rows } payload", () => {
  const rows = normalizeScanRows({
    rows: [
      { finish_tag: "cpt-1", section: "flooring", category: "floor", description: "Broadloom", manufacturer: "J+J", style: "Pay Day", spec_color: "1408", size: "" },
      { finish_tag: "act-1", category: "ceiling", description: "ACT" },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].finish_tag, "CPT-1");       // upper-cased
  assert.equal(rows[0].section, "FLOORING");
  assert.equal(rows[0].category, "floor");
  assert.equal(rows[0].suggested, true);           // floor default
  assert.equal(rows[1].category, "ceiling");
  assert.equal(rows[1].suggested, false);          // ceiling starts unchecked
});

test("accepts a bare array too", () => {
  const rows = normalizeScanRows([{ finish_tag: "RB-1", category: "base" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, "base");
  assert.equal(rows[0].suggested, true);
});

test("drops rows without a finish tag; fills missing fields with empty strings", () => {
  const rows = normalizeScanRows({ rows: [{ description: "no tag here" }, { finish_tag: "P-1" }] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    finish_tag: "P-1", section: "", category: "other", description: "",
    manufacturer: "", style: "", spec_color: "", size: "", suggested: false,
  });
});

test("unknown category falls back to other", () => {
  const [row] = normalizeScanRows({ rows: [{ finish_tag: "X-1", category: "roofing" }] });
  assert.equal(row.category, "other");
  assert.equal(row.suggested, false);
});

test("explicit suggested boolean overrides the category default", () => {
  const [ceil] = normalizeScanRows({ rows: [{ finish_tag: "ACT-1", category: "ceiling", suggested: true }] });
  assert.equal(ceil.suggested, true);
  const [flr] = normalizeScanRows({ rows: [{ finish_tag: "CPT-1", category: "floor", suggested: false }] });
  assert.equal(flr.suggested, false);
});

test("de-dupes by finish_tag, first wins", () => {
  const rows = normalizeScanRows({ rows: [
    { finish_tag: "CPT-1", manufacturer: "First" },
    { finish_tag: "cpt-1", manufacturer: "Second" },
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].manufacturer, "First");
});

test("garbage / empty shapes yield [] (nothing invented)", () => {
  assert.deepEqual(normalizeScanRows(null), []);
  assert.deepEqual(normalizeScanRows(undefined), []);
  assert.deepEqual(normalizeScanRows({}), []);
  assert.deepEqual(normalizeScanRows({ rows: "nope" }), []);
  assert.deepEqual(normalizeScanRows("string"), []);
  assert.deepEqual(normalizeScanRows({ rows: [null, 42, "x", {}] }), []);
});

test("endpoint constant is the takeoff-scoped AI route", () => {
  assert.equal(SCAN_ENDPOINT, "/ai/parse-schedule");
});

// scanRasterScale — the downscale guard that keeps a marquee raster within the
// server's SCAN_MAX_DIM per-side cap (else parse-schedule 400s "invalid image
// dimensions"). Never upscales; downscales only as far as the cap.
test("a region within the cap is sent at full resolution (factor 1)", () => {
  assert.equal(scanRasterScale(1000, 800), 1);
  assert.equal(scanRasterScale(SCAN_MAX_DIM, SCAN_MAX_DIM), 1); // exactly at the cap
});

test("an oversized side scales down so neither side exceeds the cap", () => {
  // 8192 wide → 0.5; the scaled sides land exactly on the cap, never above it
  const f = scanRasterScale(SCAN_MAX_DIM * 2, 1000);
  assert.equal(f, 0.5);
  assert.ok(Math.round(SCAN_MAX_DIM * 2 * f) <= SCAN_MAX_DIM);
  assert.ok(Math.round(1000 * f) <= SCAN_MAX_DIM);
});

test("the binding side drives the factor (portrait vs landscape)", () => {
  assert.equal(scanRasterScale(2000, SCAN_MAX_DIM * 4), SCAN_MAX_DIM / (SCAN_MAX_DIM * 4)); // tall
  assert.equal(scanRasterScale(SCAN_MAX_DIM * 4, 2000), SCAN_MAX_DIM / (SCAN_MAX_DIM * 4)); // wide
});

test("degenerate / non-positive dimensions never divide-by-zero or upscale", () => {
  assert.equal(scanRasterScale(0, 0), 1);
  assert.equal(scanRasterScale(-5, 10), 1);
});

// postScanWithRetry — the one-shot 504 retry that banks "warm retries succeed"
// (#102). Only a 504 (Netlify's cold-start gateway timeout) is retried; real
// responses/errors pass straight through. sleep is injected so tests don't wait.
const resp = (status: number) => ({ status }) as Response;      // helper only reads .status
const noSleep = () => Promise.resolve();

test("504 retry: success on the first attempt is returned, no retry", async () => {
  let calls = 0, retried = false;
  const res = await postScanWithRetry(() => { calls++; return Promise.resolve(resp(200)); },
    { sleep: noSleep, onRetry: () => { retried = true; } });
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.equal(retried, false);
});

test("504 retry: a 504 then a 200 retries once and returns the warm 200", async () => {
  const statuses = [SCAN_RETRY_STATUS, 200];
  let calls = 0, retried = 0;
  const res = await postScanWithRetry(() => Promise.resolve(resp(statuses[calls++])),
    { sleep: noSleep, onRetry: () => { retried++; } });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.equal(retried, 1);
});

test("504 retry: a thrown network error then a 200 retries and recovers", async () => {
  let calls = 0;
  const res = await postScanWithRetry(() => {
    if (calls++ === 0) return Promise.reject(new Error("network down"));
    return Promise.resolve(resp(200));
  }, { sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test("504 retry: two 504s exhaust the one retry and return the 504 for normal handling", async () => {
  let calls = 0;
  const res = await postScanWithRetry(() => { calls++; return Promise.resolve(resp(SCAN_RETRY_STATUS)); },
    { sleep: noSleep });
  assert.equal(res.status, SCAN_RETRY_STATUS);
  assert.equal(calls, 2);   // exactly two attempts, never a loop
});

test("504 retry: a non-504 error (e.g. 403) returns immediately, is NOT retried", async () => {
  let calls = 0;
  const res = await postScanWithRetry(() => { calls++; return Promise.resolve(resp(403)); },
    { sleep: noSleep });
  assert.equal(res.status, 403);
  assert.equal(calls, 1);   // real errors are not a 504 → no retry, no double-charge
});

test("504 retry: two thrown errors rethrow the last one", async () => {
  let calls = 0;
  await assert.rejects(
    postScanWithRetry(() => { calls++; return Promise.reject(new Error(`fail ${calls}`)); }, { sleep: noSleep }),
    /fail 2/,
  );
  assert.equal(calls, 2);
});

test("504 retry: a 504 then a thrown error returns the 504 (gateway copy wins over the throw)", async () => {
  let calls = 0;
  const res = await postScanWithRetry(() => {
    if (calls++ === 0) return Promise.resolve(resp(SCAN_RETRY_STATUS));
    return Promise.reject(new Error("network down"));
  }, { sleep: noSleep });
  assert.equal(res.status, SCAN_RETRY_STATUS);   // a seen 504 is preferred to a rethrow
  assert.equal(calls, 2);
});

test("504 retry: a thrown error then a 504 returns the 504", async () => {
  let calls = 0;
  const res = await postScanWithRetry(() => {
    if (calls++ === 0) return Promise.reject(new Error("network down"));
    return Promise.resolve(resp(SCAN_RETRY_STATUS));
  }, { sleep: noSleep });
  assert.equal(res.status, SCAN_RETRY_STATUS);
  assert.equal(calls, 2);
});
