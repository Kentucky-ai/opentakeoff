// reltime.ts — compact relative-age + explicit-UTC-timestamp helpers for the
// Captures panel row. Both take their "now" (or read Date.parse of `iso`)
// deterministically, so every test pins a fixed epoch — no real-clock flake.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeAge, absoluteUtc } from "../src/lib/reltime.ts";

// Fixed "now" used across every relativeAge case: 2026-08-25T19:58:00Z — the
// same instant the brief's absoluteUtc example ("Aug 25, 2026, 7:58 PM (UTC)")
// is built from, so a passing absoluteUtc test on this exact instant doubles
// as a sanity check that the two helpers agree.
const NOW = Date.UTC(2026, 7, 25, 19, 58, 0);
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const isoAt = (ms: number) => new Date(ms).toISOString();

// ── relativeAge: bucket boundaries ──────────────────────────────────────────
test("relativeAge: < 45s → just now (interior + right at the 44s edge)", () => {
  assert.equal(relativeAge(isoAt(NOW - 30 * SEC), NOW), "just now");
  assert.equal(relativeAge(isoAt(NOW - 44 * SEC), NOW), "just now");
});

test("relativeAge: 45s boundary flips just-now → minutes (rounds up to 1m, the 'min 1' floor)", () => {
  assert.equal(relativeAge(isoAt(NOW - 45 * SEC), NOW), "1m ago");
});

test("relativeAge: minutes bucket, interior + just-under-60m edge", () => {
  assert.equal(relativeAge(isoAt(NOW - 5 * MIN), NOW), "5m ago");
  assert.equal(relativeAge(isoAt(NOW - 59 * MIN), NOW), "59m ago");
});

test("relativeAge: 60m boundary flips minutes → hours", () => {
  assert.equal(relativeAge(isoAt(NOW - 60 * MIN), NOW), "1h ago");
});

test("relativeAge: hours bucket, interior + just-under-24h edge", () => {
  assert.equal(relativeAge(isoAt(NOW - 5 * HOUR), NOW), "5h ago");
  assert.equal(relativeAge(isoAt(NOW - 23 * HOUR), NOW), "23h ago");
});

test("relativeAge: 24h boundary flips hours → yesterday", () => {
  assert.equal(relativeAge(isoAt(NOW - 24 * HOUR), NOW), "yesterday");
});

test("relativeAge: yesterday bucket holds through the 47h edge", () => {
  assert.equal(relativeAge(isoAt(NOW - 47 * HOUR), NOW), "yesterday");
});

test("relativeAge: 48h boundary flips yesterday → days", () => {
  assert.equal(relativeAge(isoAt(NOW - 48 * HOUR), NOW), "2d ago");
});

test("relativeAge: days bucket, interior + just-under-7d edge", () => {
  assert.equal(relativeAge(isoAt(NOW - 3 * DAY), NOW), "3d ago");
  assert.equal(relativeAge(isoAt(NOW - 6 * DAY), NOW), "6d ago");
});

test("relativeAge: 7d boundary flips days → a plain UTC date", () => {
  // NOW - 7d = 2026-08-18T19:58:00Z
  assert.equal(relativeAge(isoAt(NOW - 7 * DAY), NOW), "Aug 18, 2026");
});

test("relativeAge: older date is formatted in UTC regardless of local wall-clock", () => {
  assert.equal(relativeAge("2020-01-01T00:00:00Z", NOW), "Jan 1, 2020");
});

// ── relativeAge: guards ─────────────────────────────────────────────────────
test("relativeAge: non-finite / unparseable iso → '' (never throw)", () => {
  assert.equal(relativeAge("", NOW), "");
  assert.equal(relativeAge("not-a-date", NOW), "");
  // deliberately wrong runtime type (a caller could pass one) — guard must not throw
  assert.equal(relativeAge(undefined as any, NOW), "");
  assert.equal(relativeAge(null as any, NOW), "");
});

// ── absoluteUtc ──────────────────────────────────────────────────────────────
test("absoluteUtc: explicit human timestamp, zone spelled out, formatted in UTC", () => {
  assert.equal(absoluteUtc("2026-08-25T19:58:00Z"), "Aug 25, 2026, 7:58 PM (UTC)");
  assert.equal(absoluteUtc("2026-01-05T00:05:00Z"), "Jan 5, 2026, 12:05 AM (UTC)");
});

test("absoluteUtc: unparseable → '' (never throw)", () => {
  assert.equal(absoluteUtc(""), "");
  assert.equal(absoluteUtc("garbage"), "");
  assert.equal(absoluteUtc(undefined as any), "");
});
