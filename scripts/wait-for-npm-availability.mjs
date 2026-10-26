#!/usr/bin/env node
// Wait until npm exposes a package version through both of the registry
// endpoints used by installers and release tooling. npm can accept a publish
// while its metadata is still being indexed, so the version endpoint alone is
// not sufficient evidence that the MCP Registry can consume the release.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULTS = Object.freeze({
  requestTimeoutMs: 10_000,
  deadlineMs: 15 * 60 * 1_000,
  intervalMs: 15_000,
  maxAttempts: 60,
});

function asPositiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function optionsFromEnvironment(env = process.env) {
  return {
    requestTimeoutMs: asPositiveInteger(env.NPM_AVAILABILITY_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, "NPM_AVAILABILITY_REQUEST_TIMEOUT_MS"),
    deadlineMs: asPositiveInteger(env.NPM_AVAILABILITY_DEADLINE_MS, DEFAULTS.deadlineMs, "NPM_AVAILABILITY_DEADLINE_MS"),
    intervalMs: asPositiveInteger(env.NPM_AVAILABILITY_INTERVAL_MS, DEFAULTS.intervalMs, "NPM_AVAILABILITY_INTERVAL_MS"),
    maxAttempts: asPositiveInteger(env.NPM_AVAILABILITY_MAX_ATTEMPTS, DEFAULTS.maxAttempts, "NPM_AVAILABILITY_MAX_ATTEMPTS"),
  };
}

function endpointResults(packageName, version, metadata, versionData) {
  const metadataOk = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    && metadata.name === packageName
    && metadata.versions && typeof metadata.versions === "object" && !Array.isArray(metadata.versions)
    && metadata.versions[version] && typeof metadata.versions[version] === "object" && !Array.isArray(metadata.versions[version])
    && metadata.versions[version].name === packageName && metadata.versions[version].version === version;
  const versionOk = versionData && typeof versionData === "object" && !Array.isArray(versionData)
    && versionData.name === packageName && versionData.version === version;
  return { metadataOk: Boolean(metadataOk), versionOk: Boolean(versionOk) };
}

async function fetchJson(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    const error = new Error(`request exceeded ${timeoutMs}ms`);
    error.name = "AbortError";
    controller.abort(error);
    rejectTimeout(error);
  }, timeoutMs);
  try {
    const response = await Promise.race([
      fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } }),
      timeout,
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await Promise.race([response.json(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForNpmAvailability({
  packageName,
  version,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console,
  requestTimeoutMs = DEFAULTS.requestTimeoutMs,
  deadlineMs = DEFAULTS.deadlineMs,
  intervalMs = DEFAULTS.intervalMs,
  maxAttempts = DEFAULTS.maxAttempts,
} = {}) {
  if (!packageName || !version) throw new Error("packageName and version are required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  for (const [name, value] of Object.entries({ requestTimeoutMs, deadlineMs, intervalMs, maxAttempts })) {
    asPositiveInteger(value, value, name);
  }

  const startedAt = now();
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
  const versionUrl = `${metadataUrl}/${encodeURIComponent(version)}`;
  let lastReason = "no matching metadata";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const elapsed = now() - startedAt;
    if (elapsed >= deadlineMs) break;
    const remaining = deadlineMs - elapsed;
    const timeoutMs = Math.min(requestTimeoutMs, remaining);
    let metadata;
    let versionData;
    try {
      const results = await Promise.allSettled([
        fetchJson(metadataUrl, { fetchImpl, timeoutMs }),
        fetchJson(versionUrl, { fetchImpl, timeoutMs }),
      ]);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) throw rejected.reason;
      [metadata, versionData] = results.map((result) => result.value);
      const result = endpointResults(packageName, version, metadata, versionData);
      if (result.metadataOk && result.versionOk && now() - startedAt < deadlineMs) {
        log.info(`npm availability confirmed for ${packageName}@${version} (attempt ${attempt})`);
        return { attempt, elapsedMs: now() - startedAt };
      }
      lastReason = `metadata=${result.metadataOk ? "ok" : "pending"}, version=${result.versionOk ? "ok" : "pending"}`;
    } catch (error) {
      lastReason = error?.name === "AbortError" ? "request timeout" : error?.message || String(error);
    }

    const afterAttempt = now() - startedAt;
    if (afterAttempt >= deadlineMs || attempt === maxAttempts) break;
    const waitMs = Math.min(intervalMs, deadlineMs - afterAttempt);
    log.info(`npm availability pending for ${packageName}@${version} (attempt ${attempt}/${maxAttempts}: ${lastReason}; retrying in ${waitMs}ms)`);
    await sleep(waitMs);
  }

  const message = `npm availability failed for ${packageName}@${version} after ${maxAttempts} attempts or ${deadlineMs}ms: ${lastReason}`;
  log.error(message);
  throw new Error(message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [packageName, version] = process.argv.slice(2);
  if (!packageName || !version || process.argv.length !== 4) {
    console.error("usage: node scripts/wait-for-npm-availability.mjs <package> <version>");
    process.exit(2);
  }
  try {
    await waitForNpmAvailability({ packageName, version, ...optionsFromEnvironment() });
  } catch (error) {
    console.error(`npm availability wait failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
