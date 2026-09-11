#!/usr/bin/env node
// Publish a server manifest once, then verify the exact record through the
// registry's version endpoint.  The core is dependency-injected so release
// retries can be tested without contacting the live registry.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const DEFAULTS = Object.freeze({
  requestTimeoutMs: 10_000,
  deadlineMs: 15 * 60 * 1_000,
  intervalMs: 15_000,
  maxAttempts: 60,
});
const REGISTRY = "https://registry.modelcontextprotocol.io/v0.1/servers";

function positive(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${value}`);
  return value;
}

function envPositive(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return positive(parsed, name);
}

export function optionsFromEnvironment(env = process.env) {
  return {
    requestTimeoutMs: envPositive(env.REGISTRY_AVAILABILITY_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, "REGISTRY_AVAILABILITY_REQUEST_TIMEOUT_MS"),
    deadlineMs: envPositive(env.REGISTRY_AVAILABILITY_DEADLINE_MS, DEFAULTS.deadlineMs, "REGISTRY_AVAILABILITY_DEADLINE_MS"),
    intervalMs: envPositive(env.REGISTRY_AVAILABILITY_INTERVAL_MS, DEFAULTS.intervalMs, "REGISTRY_AVAILABILITY_INTERVAL_MS"),
    maxAttempts: envPositive(env.REGISTRY_AVAILABILITY_MAX_ATTEMPTS, DEFAULTS.maxAttempts, "REGISTRY_AVAILABILITY_MAX_ATTEMPTS"),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("manifest must be an object");
  if (typeof manifest.name !== "string" || !manifest.name) throw new Error("manifest.name is required");
  if (typeof manifest.version !== "string" || !manifest.version) throw new Error("manifest.version is required");
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error("manifest.packages must contain at least one package");
  const pkg = manifest.packages[0];
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("manifest.packages[0] must be an object");
  for (const field of ["registryType", "identifier", "version"]) {
    if (typeof pkg[field] !== "string" || !pkg[field]) throw new Error(`manifest.packages[0].${field} is required`);
  }
  if (pkg.version !== manifest.version) throw new Error("manifest.packages[0].version must match manifest.version");
  return { name: manifest.name, version: manifest.version };
}

function endpoint({ name, version }) {
  return `${REGISTRY}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
}

async function fetchJson(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`request exceeded ${timeoutMs}ms`);
        error.name = "AbortError";
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const response = await Promise.race([fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } }), timeout]);
    // Error responses from proxies are often HTML or empty. Their status is
    // authoritative, so classify it without attempting JSON decoding.
    if (!response.ok) {
      return { status: response.status, ok: response.ok, body: undefined };
    }
    const body = await Promise.race([response.json(), timeout]);
    return { status: response.status, ok: response.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

function classify(result, manifest) {
  if (result.status === 404) return { kind: "absent" };
  if (result.status === 429 || result.status >= 500) return { kind: "transient", reason: `HTTP ${result.status}` };
  if (!result.ok) {
    const error = new Error(`registry verification failed with HTTP ${result.status}`);
    error.retryable = false;
    throw error;
  }
  const server = result.body && typeof result.body === "object" && !Array.isArray(result.body)
    ? result.body.server : undefined;
  if (server && canonical(server) === canonical(manifest)) return { kind: "match" };
  const error = new Error("registry record metadata does not exactly match manifest");
  error.retryable = false;
  throw error;
}

function isDuplicate(error) {
  return String(error?.message || error).toLowerCase().includes("invalid version: cannot publish duplicate version");
}

export async function ensureRegistryPublished({
  manifest,
  fetchImpl = globalThis.fetch,
  publish,
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = console,
  requestTimeoutMs = DEFAULTS.requestTimeoutMs,
  deadlineMs = DEFAULTS.deadlineMs,
  intervalMs = DEFAULTS.intervalMs,
  maxAttempts = DEFAULTS.maxAttempts,
  verifyOnly = false,
} = {}) {
  const identity = validateManifest(manifest);
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  if (!verifyOnly && typeof publish !== "function") throw new Error("publish is required");
  for (const [name, value] of Object.entries({ requestTimeoutMs, deadlineMs, intervalMs, maxAttempts })) positive(value, name);
  const started = now();
  let verificationAttempts = 0;
  let lastReason = "unknown";

  const verify = async (phase) => {
    while (verificationAttempts < maxAttempts) {
      const elapsed = now() - started;
      if (elapsed >= deadlineMs) break;
      const timeoutMs = Math.min(requestTimeoutMs, deadlineMs - elapsed);
      verificationAttempts += 1;
      try {
        const result = await fetchJson(endpoint(identity), { fetchImpl, timeoutMs });
        if (now() - started >= deadlineMs) {
          lastReason = "deadline reached while reading the registry response";
          break;
        }
        const state = classify(result, manifest);
        if (state.kind === "match") return { state, attempt: verificationAttempts };
        if (state.kind === "absent" && phase === "precheck") return { state, attempt: verificationAttempts };
        lastReason = state.reason || "record not yet visible";
      } catch (error) {
        if (error?.retryable === false) {
          throw error;
        } else {
          lastReason = error?.message || String(error);
          // Network errors, timeouts, and HTTP 429/5xx are retryable. Other
          // HTTP errors and metadata mismatches are thrown by classify.
        }
      }
      const after = now() - started;
      if (after >= deadlineMs || verificationAttempts === maxAttempts) break;
      const waitMs = Math.min(intervalMs, deadlineMs - after);
      log.info?.(`registry verification pending (attempt ${verificationAttempts}/${maxAttempts}: ${lastReason}; retrying in ${waitMs}ms)`);
      await sleep(waitMs);
    }
    throw new Error(`registry verification failed after ${verificationAttempts} attempts or ${deadlineMs}ms: ${lastReason}`);
  };

  const precheck = await verify(verifyOnly ? "verifyonly" : "precheck");
  if (precheck.state.kind === "match") return { action: verifyOnly ? "verified" : "skipped", publishAttempts: 0, verificationAttempts, attempt: precheck.attempt, elapsedMs: now() - started };
  if (now() - started >= deadlineMs) throw new Error(`registry publish deadline exceeded after ${verificationAttempts} verification attempts`);

  const publishAttempts = 1;
  let recoveredDuplicate = false;
  try {
    await publish({ remainingMs: Math.max(0, deadlineMs - (now() - started)) });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    recoveredDuplicate = true;
    log.info?.("registry publish reported a duplicate version; verifying the existing exact record");
  }
  const verified = await verify("postpublish");
  return { action: recoveredDuplicate ? "recovered" : "published", publishAttempts, verificationAttempts, attempt: verified.attempt, elapsedMs: now() - started };
}

function runPublisher(manifestPath, { timeoutMs = DEFAULTS.requestTimeoutMs } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile("./mcp-publisher", ["publish", manifestPath], { cwd: dirname(manifestPath), timeout: timeoutMs, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`mcp-publisher publish failed: ${error.message}`)); return; }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function cli() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify-only");
  if (args.filter((arg) => arg === "--verify-only").length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--verify-only")) {
    throw new Error("usage: node scripts/publish-mcp-registry.mjs <server.json> [--verify-only]");
  }
  const paths = args.filter((arg) => arg !== "--verify-only");
  if (paths.length !== 1) throw new Error("usage: node scripts/publish-mcp-registry.mjs <server.json> [--verify-only]");
  const manifestPath = resolve(paths[0]);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const options = optionsFromEnvironment();
  const result = await ensureRegistryPublished({
    manifest,
    ...options,
    verifyOnly,
    log: { info: (message) => console.error(message) },
    publish: ({ remainingMs }) => runPublisher(manifestPath, { timeoutMs: Math.max(1, remainingMs) }),
  });
  console.log(JSON.stringify({ name: manifest.name, version: manifest.version, ...result }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await cli(); } catch (error) { console.error(`registry publish failed: ${error?.message || error}`); process.exitCode = 1; }
}
