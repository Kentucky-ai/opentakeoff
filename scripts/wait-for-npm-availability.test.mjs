import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitForNpmAvailability } from "./wait-for-npm-availability.mjs";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function harness(sequence) {
  let calls = 0;
  let clock = 0;
  const logs = [];
  return {
    fetchImpl: async (url, options) => {
      const item = sequence[Math.min(calls++, sequence.length - 1)];
      if (item instanceof Error) throw item;
      return typeof item === "function" ? item(url, options) : item;
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
    logs,
    calls: () => calls,
  };
}

const metadata = { name: "opentakeoff-mcp", versions: { "1.2.3": { name: "opentakeoff-mcp", version: "1.2.3" } } };
const version = { name: "opentakeoff-mcp", version: "1.2.3" };

test("succeeds when both endpoints are immediately visible", async () => {
  const h = harness([response(metadata), response(version)]);
  const result = await waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", ...h, intervalMs: 5, deadlineMs: 50 });
  assert.equal(result.attempt, 1);
  assert.equal(h.calls(), 2);
});

test("waits for staggered metadata visibility", async () => {
  const missingVersion = { name: "opentakeoff-mcp", versions: { "1.2.2": { name: "opentakeoff-mcp", version: "1.2.2" } } };
  const h = harness([response(missingVersion), response(version), response(metadata), response(version)]);
  const result = await waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", ...h, intervalMs: 7, deadlineMs: 50 });
  assert.equal(result.attempt, 2);
  assert.ok(h.logs.some((line) => line.includes("pending")));
});

test("retries temporary fetch errors", async () => {
  const timeout = new Error("socket timed out");
  const h = harness([timeout, timeout, response(metadata), response(version)]);
  const result = await waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", ...h, intervalMs: 3, deadlineMs: 50 });
  assert.equal(result.attempt, 2);
});

test("aborts a response whose body never finishes", async () => {
  let bodyAborted = false;
  const h = harness([response({}), (_url, { signal }) => {
    signal.addEventListener("abort", () => { bodyAborted = true; });
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  }]);
  await assert.rejects(
    waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", ...h, requestTimeoutMs: 5, maxAttempts: 1, deadlineMs: 30 }),
    /after 1 attempts/,
  );
  assert.equal(bodyAborted, true);
});

test("aborts a request that never returns", async () => {
  let requestAborted = false;
  const h = harness([(_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { requestAborted = true; reject(signal.reason); });
  }), response(version)]);
  await assert.rejects(
    waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", ...h, requestTimeoutMs: 5, maxAttempts: 1, deadlineMs: 30 }),
    /after 1 attempts/,
  );
  assert.equal(requestAborted, true);
});

test("settles a fast-failing endpoint before retrying its pending peer", async () => {
  let peerSettled = false;
  let attempts = 0;
  const fetchImpl = async (url, { signal }) => {
    const isVersion = url.endsWith("/1.2.3");
    if (!isVersion) {
      attempts += 1;
      if (attempts === 1) throw new Error("fast 503");
      return response(metadata);
    }
    if (attempts === 1) {
      return new Promise((_, reject) => signal.addEventListener("abort", () => {
        peerSettled = true;
        reject(signal.reason);
      }));
    }
    assert.equal(peerSettled, true);
    return response(version);
  };
  const result = await waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", fetchImpl, requestTimeoutMs: 5, intervalMs: 1, deadlineMs: 5000, maxAttempts: 2, log: { info() {}, error() {} } });
  assert.equal(result.attempt, 2);
  assert.equal(peerSettled, true);
});

test("fails when the retry budget is exhausted", async () => {
  const h = harness([response({ name: "opentakeoff-mcp", versions: {} }), response({ name: "opentakeoff-mcp", version: "1.2.2" })]);
  await assert.rejects(
    waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", ...h, intervalMs: 4, maxAttempts: 2, deadlineMs: 50 }),
    /after 2 attempts/,
  );
});

test("rejects mismatched and invalid responses", async () => {
  const h = harness([response({ name: "other", versions: { "1.2.3": metadata.versions["1.2.3"] } }), response("not an object"), response(metadata), response({ name: "opentakeoff-mcp", version: "1.2.2" })]);
  await assert.rejects(
    waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", ...h, intervalMs: 2, maxAttempts: 2, deadlineMs: 20 }),
    /npm availability failed/,
  );
  assert.equal(h.calls(), 4);
});

test("rejects malformed exact-version entries", async () => {
  const malformed = [null, {}, "version", [], { name: "other", version: "1.2.3" }, { name: "opentakeoff-mcp", version: "1.2.2" }];
  for (const entry of malformed) {
    const h = harness([response({ name: "opentakeoff-mcp", versions: { "1.2.3": entry } }), response(version)]);
    await assert.rejects(
      waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", ...h, maxAttempts: 1, deadlineMs: 20 }),
      /npm availability failed/,
    );
  }
});

test("does not accept a success completed at the deadline", async () => {
  const h = harness([response(metadata), response(version)]);
  const lateNow = () => (h.calls() >= 2 ? 10 : 0);
  await assert.rejects(
    waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", ...h, now: lateNow, deadlineMs: 10, maxAttempts: 1 }),
    /after 1 attempts/,
  );
});

test("does not sleep beyond the total deadline", async () => {
  const h = harness([response({ name: "opentakeoff-mcp", versions: {} }), response(version)]);
  await assert.rejects(
    waitForNpmAvailability({ packageName: "opentakeoff-mcp", version: "1.2.3", ...h, now: h.now, intervalMs: 100, deadlineMs: 10, maxAttempts: 2 }),
    /after 2 attempts or 10ms/,
  );
  assert.equal(h.logs.filter((line) => line.includes("retrying in 10ms")).length, 1);
});

test("CLI reports invalid configuration and extra arguments", () => {
  const script = fileURLToPath(new URL("./wait-for-npm-availability.mjs", import.meta.url));
  const invalid = spawnSync(process.execPath, [script, "opentakeoff-mcp", "1.2.3"], {
    env: { ...process.env, NPM_AVAILABILITY_DEADLINE_MS: "0" },
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /NPM_AVAILABILITY_DEADLINE_MS must be a positive integer/);

  const extra = spawnSync(process.execPath, [script, "opentakeoff-mcp", "1.2.3", "extra"], { encoding: "utf8" });
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /usage:/);
});
