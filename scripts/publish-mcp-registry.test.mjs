import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRegistryPublished } from "./publish-mcp-registry.mjs";

const manifest = {
  name: "io.github.Kentucky-ai/opentakeoff",
  title: "OpenTakeoff",
  description: "Construction takeoff for AI agents",
  websiteUrl: "https://opentakeoff.kentucky-ai.com",
  repository: { url: "https://github.com/Kentucky-ai/opentakeoff", source: "github" },
  version: "9.8.7",
  packages: [{
    registryType: "npm",
    identifier: "opentakeoff-mcp",
    version: "9.8.7",
    transport: { type: "stdio" },
    arguments: [{ name: "--trace", type: "string", description: "trace mode" }],
  }],
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function harness(sequence, { publishErrors = [] } = {}) {
  let fetchCalls = 0;
  let publishCalls = 0;
  let clock = 0;
  const sleeps = [];
  const urls = [];
  const logs = [];
  const fetchImpl = async (url, options) => {
    urls.push({ url, options });
    const item = sequence[Math.min(fetchCalls++, sequence.length - 1)];
    if (item instanceof Error) throw item;
    return typeof item === "function" ? item(url, options) : item;
  };
  const publish = async (published) => {
    publishCalls += 1;
    if (publishErrors.length) throw publishErrors.shift();
    return published;
  };
  return {
    fetchImpl,
    publish,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    log: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
    urls,
    sleeps,
    logs,
    fetchCalls: () => fetchCalls,
    publishCalls: () => publishCalls,
  };
}

function listed(body = manifest) { return response({ server: body, _meta: { indexedAt: "later", cursor: "opaque" } }); }
function missing(status = 404) { return response({ error: "not found" }, status); }

test("exact existing manifest is accepted without publishing", async () => {
  const h = harness([listed()]);
  await ensureRegistryPublished({ manifest, ...h, maxAttempts: 2, intervalMs: 1, deadlineMs: 50 });
  assert.equal(h.publishCalls(), 0);
  assert.equal(h.urls[0].url, "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.Kentucky-ai%2Fopentakeoff/versions/9.8.7");
});

test("missing version publishes once and verifies after a stale 404", async () => {
  const h = harness([missing(), missing(), listed()]);
  await ensureRegistryPublished({ manifest, ...h, intervalMs: 2, deadlineMs: 50 });
  assert.equal(h.publishCalls(), 1);
  assert.equal(h.fetchCalls(), 3);
  assert.deepEqual(h.sleeps, [2]);
});

test("transient 429, 5xx, and network failures retry, without hidden publish retries", async () => {
  const h = harness([missing(), response({}, 429), response({}, 503), new Error("socket reset"), listed()]);
  await ensureRegistryPublished({ manifest, ...h, intervalMs: 1, deadlineMs: 50 });
  assert.equal(h.publishCalls(), 1);
  assert.equal(h.fetchCalls(), 5);
  assert.equal(h.sleeps.length, 3);
});

test("all semantic manifest fields are checked while envelope metadata is ignored", async () => {
  for (const [label, changed] of [
    ["name", { name: "io.github.example/other" }],
    ["version", { version: "9.8.8" }],
    ["package identifier", { packages: [{ ...manifest.packages[0], identifier: "other" }] }],
    ["transport", { packages: [{ ...manifest.packages[0], transport: { type: "sse" } }] }],
    ["arguments", { packages: [{ ...manifest.packages[0], arguments: [] }] }],
    ["extra semantic field", { extra: "must be preserved" }],
  ]) {
    const h = harness([listed({ ...manifest, ...changed })]);
    await assert.rejects(
      ensureRegistryPublished({ manifest, ...h, maxAttempts: 1, deadlineMs: 50 }),
      /mismatch|different|unexpected|semantic|exactly match/i,
      label,
    );
    assert.equal(h.publishCalls(), 0, label);
  }
});

test("a duplicate publish race is resolved by verification", async () => {
  const duplicate = new Error("invalid version: cannot publish duplicate version");
  const h = harness([missing(), listed()], { publishErrors: [duplicate] });
  await ensureRegistryPublished({ manifest, ...h, maxAttempts: 2, intervalMs: 1, deadlineMs: 50 });
  assert.equal(h.publishCalls(), 1);
  assert.equal(h.fetchCalls(), 2);
});

test("unrelated publish failures propagate and are not retried", async () => {
  const failure = Object.assign(new Error("registry credentials rejected"), { status: 403 });
  const h = harness([missing()], { publishErrors: [failure] });
  await assert.rejects(ensureRegistryPublished({ manifest, ...h, maxAttempts: 1, deadlineMs: 50 }), (error) => {
    assert.equal(error, failure);
    return true;
  });
  assert.equal(h.publishCalls(), 1);
  assert.equal(h.fetchCalls(), 1);
});

test("verifyOnly never invokes publish", async () => {
  const h = harness([missing(), missing()]);
  const { publish: _publish, ...verifyOnlyHarness } = h;
  await assert.rejects(ensureRegistryPublished({ manifest, ...verifyOnlyHarness, verifyOnly: true, maxAttempts: 2, intervalMs: 1, deadlineMs: 50 }));
  assert.equal(h.publishCalls(), 0);
});

test("deadline and attempt limits bound retries and sleeps", async () => {
  const h = harness([missing()]);
  await assert.rejects(ensureRegistryPublished({ manifest, ...h, maxAttempts: 3, intervalMs: 100, deadlineMs: 10 }), /attempts|10ms|deadline/i);
  assert.equal(h.fetchCalls(), 2);
  assert.deepEqual(h.sleeps, [10]);
  assert.equal(h.publishCalls(), 1);

  const limited = harness([missing(), missing(), missing(), missing()]);
  await assert.rejects(ensureRegistryPublished({ manifest, ...limited, maxAttempts: 2, intervalMs: 1, deadlineMs: 50 }), /2 attempts/i);
  assert.equal(limited.fetchCalls(), 2); // one precheck and one post-publish attempt
  assert.equal(limited.publishCalls(), 1);
});

test("does not publish when the deadline is reached after the precheck", async () => {
  let calls = 0;
  const h = harness([missing()]);
  const now = () => (calls++ === 0 ? 0 : 10);
  await assert.rejects(ensureRegistryPublished({ manifest, ...h, now, deadlineMs: 10, maxAttempts: 1 }), /deadline|10ms|attempt/i);
  assert.equal(h.publishCalls(), 0);
});

test("classifies HTTP statuses before decoding non-success bodies", async () => {
  let decoded = 0;
  const h = harness([{
    ok: false,
    status: 401,
    json: async () => { decoded += 1; throw new Error("HTML is not JSON"); },
  }]);
  await assert.rejects(ensureRegistryPublished({ manifest, ...h, maxAttempts: 1, deadlineMs: 50 }), /401|verification/i);
  assert.equal(decoded, 0);
  assert.equal(h.publishCalls(), 0);
});

test("a thrown error carrying status 404 is not mistaken for an absent record", async () => {
  const notFoundError = Object.assign(new Error("transport failure"), { status: 404 });
  const h = harness([notFoundError, listed()]);
  await ensureRegistryPublished({ manifest, ...h, maxAttempts: 2, intervalMs: 1, deadlineMs: 50 });
  assert.equal(h.publishCalls(), 0);
  assert.equal(h.fetchCalls(), 2);
});

test("a matching response completed at the deadline is rejected", async () => {
  let calls = 0;
  const h = harness([listed()]);
  const now = () => (calls++ === 0 ? 0 : 10);
  await assert.rejects(
    ensureRegistryPublished({ manifest, ...h, now, deadlineMs: 10, maxAttempts: 1 }),
    /deadline|10ms|attempt/i,
  );
  assert.equal(h.publishCalls(), 0);
});

test("verify-only can poll from 404 to an exact match without a publisher", async () => {
  const h = harness([missing(), listed()]);
  const { publish: _publish, ...withoutPublisher } = h;
  await ensureRegistryPublished({ manifest, ...withoutPublisher, verifyOnly: true, maxAttempts: 2, intervalMs: 1, deadlineMs: 50 });
  assert.equal(h.publishCalls(), 0);
  assert.equal(h.fetchCalls(), 2);
});

test("transient precheck failures can settle on an existing exact record without publishing", async () => {
  const h = harness([response({}, 429), new Error("connection reset"), listed()]);
  await ensureRegistryPublished({ manifest, ...h, maxAttempts: 3, intervalMs: 1, deadlineMs: 50 });
  assert.equal(h.publishCalls(), 0);
  assert.equal(h.fetchCalls(), 3);
});

test("a successful publish is followed by semantic verification", async () => {
  for (const [label, changed] of [
    ["package version", { packages: [{ ...manifest.packages[0], version: "9.8.8" }] }],
    ["metadata", { description: "a different published description" }],
  ]) {
    const h = harness([missing(), listed({ ...manifest, ...changed })]);
    await assert.rejects(
      ensureRegistryPublished({ manifest, ...h, maxAttempts: 2, intervalMs: 1, deadlineMs: 50 }),
      /exactly match|mismatch|metadata/i,
      label,
    );
    assert.equal(h.publishCalls(), 1, label);
  }
});

test("all non-2xx statuses classify without decoding malformed bodies", async () => {
  for (const status of [400, 401, 403, 404, 429, 503]) {
    let decoded = 0;
    const malformed = {
      ok: false,
      status,
      json: async () => { decoded += 1; throw new Error("malformed body"); },
    };
    const h = harness([malformed]);
    if (status === 404) {
      await assert.rejects(ensureRegistryPublished({ manifest, ...h, maxAttempts: 1, deadlineMs: 50 }), /attempt|verification/i);
      assert.equal(h.publishCalls(), 1);
    } else if (status === 429 || status === 503) {
      await assert.rejects(ensureRegistryPublished({ manifest, ...h, maxAttempts: 1, deadlineMs: 50 }), /attempt|verification|HTTP/i);
      assert.equal(h.publishCalls(), 0);
    } else {
      await assert.rejects(ensureRegistryPublished({ manifest, ...h, maxAttempts: 1, deadlineMs: 50 }), new RegExp(String(status)));
      assert.equal(h.publishCalls(), 0);
    }
    assert.equal(decoded, 0, `HTTP ${status} must classify before JSON decoding`);
  }
});

test("CLI rejects unknown and duplicate flags before attempting network work", () => {
  const script = fileURLToPath(new URL("./publish-mcp-registry.mjs", import.meta.url));
  const manifestPath = fileURLToPath(new URL("../mcp/server.json", import.meta.url));
  for (const args of [[manifestPath, "--unknown"], [manifestPath, "--verify-only", "--verify-only"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage|unknown|duplicate|flag/i);
  }
});

test("CLI passes the exact manifest path to mcp-publisher and recovers a duplicate", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-cli-"));
  try {
    const fixture = join(dir, "alternate-name.json");
    const capture = join(dir, "argv.json");
    const preload = join(dir, "mock-fetch.mjs");
    const publisher = join(dir, "mcp-publisher");
    writeFileSync(fixture, JSON.stringify(manifest));
    writeFileSync(preload, `import { readFileSync } from "node:fs";
const expected = JSON.parse(readFileSync(process.env.MATCH_MANIFEST, "utf8"));
let calls = 0;
globalThis.fetch = async () => calls++ === 0
  ? { ok: false, status: 404, json: async () => ({}) }
  : { ok: true, status: 200, json: async () => ({ server: expected, _meta: { cursor: "test" } }) };
`);
    writeFileSync(publisher, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));
console.error("invalid version: cannot publish duplicate version");
process.exit(1);
`);
    chmodSync(publisher, 0o755);
    const result = spawnSync(process.execPath, [
      "--import", preload, fileURLToPath(new URL("./publish-mcp-registry.mjs", import.meta.url)), fixture,
    ], {
      cwd: dir,
      timeout: 10000,
      encoding: "utf8",
      env: {
        ...process.env,
        MATCH_MANIFEST: fixture,
        CAPTURE: capture,
        REGISTRY_AVAILABILITY_DEADLINE_MS: "5000",
        REGISTRY_AVAILABILITY_INTERVAL_MS: "1",
        REGISTRY_AVAILABILITY_MAX_ATTEMPTS: "3",
        REGISTRY_AVAILABILITY_REQUEST_TIMEOUT_MS: "1000",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.action, "recovered");
    assert.equal(output.publishAttempts, 1);
    assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), ["publish", fixture]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI verify-only confirms an exact record without running mcp-publisher", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-cli-verify-"));
  try {
    const fixture = join(dir, "alternate-name.json");
    const marker = join(dir, "publisher-ran");
    const preload = join(dir, "mock-fetch.mjs");
    const publisher = join(dir, "mcp-publisher");
    writeFileSync(fixture, JSON.stringify(manifest));
    writeFileSync(preload, `import { readFileSync } from "node:fs";
const expected = JSON.parse(readFileSync(process.env.MATCH_MANIFEST, "utf8"));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ server: expected }) });
`);
    writeFileSync(publisher, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.MARKER, "ran");
`);
    chmodSync(publisher, 0o755);
    const result = spawnSync(process.execPath, [
      "--import", preload, fileURLToPath(new URL("./publish-mcp-registry.mjs", import.meta.url)), fixture, "--verify-only",
    ], {
      cwd: dir,
      timeout: 10000,
      encoding: "utf8",
      env: { ...process.env, MATCH_MANIFEST: fixture, MARKER: marker, REGISTRY_AVAILABILITY_MAX_ATTEMPTS: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).action, "verified");
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow wiring points at this test file and keeps publishing tag-gated", () => {
  const publishWorkflow = readFileSync(new URL("../.github/workflows/publish-mcp.yml", import.meta.url), "utf8");
  const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(publishWorkflow, /node \.\.\/scripts\/publish-mcp-registry\.mjs server\.json/);
  const publishStep = publishWorkflow.split("      - name:").find((step) => step.includes("node ../scripts/publish-mcp-registry.mjs"));
  assert.match(publishStep, /if:\s*github\.ref_type\s*==\s*'tag'/);
  assert.doesNotMatch(publishWorkflow, /run: \.\/mcp-publisher publish/);
  assert.match(ciWorkflow, /node --test scripts\/publish-mcp-registry\.test\.mjs/);
});

test("a request whose promise never settles is aborted at the request timeout", async () => {
  let aborted = false;
  const h = harness([(_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  })]);
  await assert.rejects(ensureRegistryPublished({ manifest, ...h, requestTimeoutMs: 5, maxAttempts: 1, deadlineMs: 30 }));
  assert.equal(aborted, true);
});

test("a response body whose json promise never settles is aborted", async () => {
  let aborted = false;
  const h = harness([(_url, { signal }) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  }]);
  await assert.rejects(ensureRegistryPublished({ manifest, ...h, requestTimeoutMs: 5, maxAttempts: 1, deadlineMs: 30 }));
  assert.equal(aborted, true);
});

test("invalid arguments and retry options fail before making a request", async () => {
  const h = harness([listed()]);
  for (const options of [
    {},
    { manifest: null },
    { manifest, requestTimeoutMs: 0 },
    { manifest, deadlineMs: 0 },
    { manifest, intervalMs: -1 },
    { manifest, maxAttempts: 1.5 },
    { manifest, fetchImpl: null },
    { manifest, publish: null },
  ]) {
    await assert.rejects(ensureRegistryPublished({ ...h, ...options }));
  }
  assert.equal(h.fetchCalls(), 0);
});
