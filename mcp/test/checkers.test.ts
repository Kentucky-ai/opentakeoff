import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const checker = resolve(repo, "scripts/check-version-consistency.mjs");
const fields = {
  mcpPackage: "mcp/package.json", mcpLock: "mcp/package-lock.json", server: "mcp/server.json",
  manifest: "web/public/.well-known/mcp.json", webPackage: "web/package.json", webLock: "web/package-lock.json",
};

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "ot-version-check-"));
  await mkdir(resolve(root, "mcp"), { recursive: true });
  await mkdir(resolve(root, "web/public/.well-known"), { recursive: true });
  await mkdir(resolve(root, "scripts"), { recursive: true });
  await writeFile(resolve(root, "scripts/check-version-consistency.mjs"), await readFile(checker));
  const source = {
    [fields.mcpPackage]: { version: "0.9.83" },
    [fields.mcpLock]: { version: "0.9.83", packages: { "": { version: "0.9.83" } } },
    [fields.server]: { version: "0.9.83", packages: [{ version: "0.9.83" }] },
    [fields.manifest]: { version: "0.9.83", packages: [{ version: "0.9.83" }] },
    [fields.webPackage]: { version: "0.1.0" },
    [fields.webLock]: { version: "0.1.0", packages: { "": { version: "0.1.0" } } },
  };
  for (const [path, value] of Object.entries(source)) {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await writeFile(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
}

test("version checker rejects every field independently and never writes with --write", async () => {
  const root = await fixture();
  try {
    await mkdir(resolve(root, "scripts"), { recursive: true });
    const run = (write = false) => spawnSync(process.execPath, ["scripts/check-version-consistency.mjs", ...(write ? ["--write"] : [])], { cwd: root, encoding: "utf8" });
    assert.equal(run().status, 0);
    const mutations = [
      [fields.mcpPackage, ["version"], "0.9.84"], [fields.mcpLock, ["version"], "0.9.84"],
      [fields.mcpLock, ["packages", "", "version"], "0.9.84"], [fields.server, ["version"], "0.9.84"],
      [fields.server, ["packages", "0", "version"], "0.9.84"], [fields.manifest, ["version"], "0.9.84"],
      [fields.manifest, ["packages", "0", "version"], "0.9.84"], [fields.webPackage, ["version"], "0.2.0"],
      [fields.webLock, ["version"], "0.2.0"], [fields.webLock, ["packages", "", "version"], "0.2.0"],
    ] as const;
    for (const [path, keys, value] of mutations) {
      const target = resolve(root, path); const before = await readFile(target, "utf8");
      const json = JSON.parse(before) as Record<string, any>; let cursor = json;
      for (const key of keys.slice(0, -1)) cursor = cursor[key];
      cursor[keys[keys.length - 1]] = value;
      const mutated = `${JSON.stringify(json, null, 2)}\n`; await writeFile(target, mutated);
      const result = run(true);
      assert.equal(result.status, 1, `${path} ${keys.join(".")} must fail`);
      assert.ok(result.stderr.includes(path), `diagnostic must name ${path}`);
      assert.match(result.stderr, /mismatch|missing/); assert.match(result.stderr, /--write is refused/);
      assert.equal(await readFile(target, "utf8"), mutated);
      await writeFile(target, before); assert.equal(run().status, 0);

      for (const bad of [undefined, 123]) {
        const invalid = JSON.parse(before) as Record<string, any>; let invalidCursor = invalid;
        for (const key of keys.slice(0, -1)) invalidCursor = invalidCursor[key];
        if (bad === undefined) delete invalidCursor[keys[keys.length - 1]];
        else invalidCursor[keys[keys.length - 1]] = bad;
        const invalidText = `${JSON.stringify(invalid, null, 2)}\n`; await writeFile(target, invalidText);
        const invalidResult = run(true);
        assert.equal(invalidResult.status, 1, `${path} ${keys.join(".")} invalid value must fail`);
        assert.ok(invalidResult.stderr.includes(path), `diagnostic must name ${path}`);
        assert.match(invalidResult.stderr, /missing or not a string/);
        assert.match(invalidResult.stderr, /--write is refused/);
        assert.equal(await readFile(target, "utf8"), invalidText);
        await writeFile(target, before); assert.equal(run().status, 0);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("check-tool-count --write refuses before mutating a stale marker on version mismatch", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ot-tool-count-check-"));
  try {
    const copy = async (path: string) => {
      await mkdir(resolve(root, path, ".."), { recursive: true });
      await cp(resolve(repo, path), resolve(root, path), { recursive: true });
    };
    for (const path of [
      "mcp/scripts/check-tool-count.mjs", "mcp/scripts/check-tool-inventory.mjs", "mcp/src", "mcp/server.ts", "mcp/package.json", "mcp/package-lock.json", "mcp/server.json",
      "mcp/README.md", "web/src", "README.md", "FEATURES.md", "AGENT_BRIEF.md", "README.zh-Hans.md", "README.ja.md", "README.ko.md", "README.th.md",
      "docs/USER_GUIDE.md", "docs/MCP.md", "docs/AGENT_GUIDE.md", "docs/MCP_TOOL_INDEX.md",
      "web/package.json", "web/package-lock.json", "web/public/.well-known/mcp.json",
    ]) await copy(path);
    await cp(checker, resolve(root, "scripts/check-version-consistency.mjs"));
    await symlink(resolve(repo, "mcp/node_modules"), resolve(root, "node_modules"), "junction");
    const marker = resolve(root, "README.md");
    const before = await readFile(marker, "utf8");
    await writeFile(marker, before.replace(/<!--tool-count-->\d+<!--\/tool-count-->/, "<!--tool-count-->0<!--/tool-count-->"));
    const stale = await readFile(marker, "utf8");
    const generatedDocs = ["README.md", "FEATURES.md", "AGENT_BRIEF.md", "README.zh-Hans.md", "README.ja.md", "README.ko.md", "README.th.md", "docs/USER_GUIDE.md", "mcp/README.md", "docs/MCP.md", "docs/AGENT_GUIDE.md", "docs/MCP_TOOL_INDEX.md"];
    const snapshots = new Map(await Promise.all(generatedDocs.map(async (path) => [path, await readFile(resolve(root, path), "utf8")] as const)));
    const pkgPath = resolve(root, "mcp/package.json");
    const pkgBefore = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(pkgBefore); pkg.version = `${pkg.version}-test-mismatch`;
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const result = spawnSync(process.execPath, ["--import", "tsx", "mcp/scripts/check-tool-count.mjs", "--write"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("mcp/package-lock.json") || result.stderr.includes("mcp/server.json"));
    assert.match(result.stderr, /--write is refused/);
    for (const [path, before] of snapshots) assert.equal(await readFile(resolve(root, path), "utf8"), before, `${path} changed despite version refusal`);
    assert.equal(await readFile(marker, "utf8"), stale, "version refusal must precede count writes");
    await writeFile(pkgPath, pkgBefore);
    const repaired = spawnSync(process.execPath, ["--import", "tsx", "mcp/scripts/check-tool-count.mjs", "--write"], { cwd: root, encoding: "utf8" });
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(await readFile(marker, "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
