// Unit tests for the Gemini-failure → client-status/operator-log mapping in the
// gated schedule reader (netlify/functions/parse-schedule.mjs). This pins the one
// rule that matters most: a Gemini KEY rejection (401/403) is an operator problem
// and MUST NOT reach the client as 401/403 — that client branch reads "your
// sign-in doesn't have access," which would be a lie. Only a real rate limit (429)
// is propagated; everything else stays the generic 502 it always was, but now with
// a distinct server log so quota exhaustion is distinguishable from an outage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapGeminiHttpFailure } from "../netlify/functions/parse-schedule.mjs";

test("429 propagates as 429 and warns (transient, retryable)", () => {
  const m = mapGeminiHttpFailure(429);
  assert.equal(m.statusCode, 429);
  assert.equal(m.logLevel, "warn");
});

test("401/403 (key rejection) becomes a 502 to the client, error to the operator", () => {
  for (const status of [401, 403]) {
    const m = mapGeminiHttpFailure(status);
    assert.equal(m.statusCode, 502, `Gemini ${status} must not surface as ${status} to the client`);
    assert.equal(m.clientMsg, "couldn't read the schedule");
    assert.equal(m.logLevel, "error");
    assert.match(m.logMsg, /GEMINI_API_KEY/); // operator-actionable
  }
});

test("5xx and other statuses collapse to 502 + error log naming the status", () => {
  for (const status of [500, 503, 400, 418]) {
    const m = mapGeminiHttpFailure(status);
    assert.equal(m.statusCode, 502);
    assert.equal(m.logLevel, "error");
    assert.match(m.logMsg, new RegExp(String(status)));
  }
});
