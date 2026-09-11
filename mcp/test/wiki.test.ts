import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { WIKI_PAGES, WIKI_VERSION } from "../src/wiki.generated.ts";
import { TOOL_NAMES } from "../src/staging.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("wiki resources route to packaged pages before load, preserve the session and honor tool staging", async () => {
  for (const stagedTools of [false, true]) {
    const session = new Session();
    const server = buildServer(session, { stagedTools, oneClick: false });
    const client = new Client({ name: "wiki-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const snapshot = () => structuredClone({ index: session.index(), shapes: session.shapes, conditions: session.conditions, markups: session.markups, approvals: session.approvals, rfis: session.rfis });
      const before = snapshot();
      const listed = await client.listResources();
      const wikiUris = listed.resources.filter(r => r.uri.startsWith("takeoff://wiki")).map(r => r.uri).sort();
      assert.equal(wikiUris.length, 9);
      for (const page of WIKI_PAGES) {
        assert.ok(wikiUris.includes(page.uri));
        const content = (await client.readResource({ uri: page.uri })).contents[0];
        assert.equal(content.mimeType, "text/markdown");
        assert.ok("text" in content);
        assert.ok(content.text.includes(page.text));
        assert.ok(content.text.includes(WIKI_VERSION));
        const source = (await readFile(resolve(root, page.source), "utf8")).replace(/\r\n/g, "\n");
        assert.equal(createHash("sha256").update(source).digest("hex"), page.source_sha256);
        // Every intra-wiki link can be read without guessing a filesystem path.
        for (const [, uri] of page.text.matchAll(/\]\((takeoff:\/\/wiki[^)]*)\)/g)) {
          assert.ok(wikiUris.includes(uri), `${page.key}: ${uri} is registered`);
        }
      }
      const unknown = ["takeoff://wiki/missing", "takeoff://wiki/../../AGENTS.md", "takeoff://wiki/%2e%2e%2fsecret", "takeoff://wiki/status?path=/etc/passwd"];
      for (const uri of unknown) await assert.rejects(client.readResource({ uri }));
      assert.deepEqual(snapshot(), before);
      const tools = (await client.listTools()).tools.map(t => t.name).sort();
      assert.ok(!tools.includes("one_click"));
      assert.ok(!tools.includes("detect_rooms"));
      if (!stagedTools) assert.deepEqual(tools, [...TOOL_NAMES]);
      else {
        assert.ok(tools.includes("open_tool_stage"));
        assert.ok(!tools.includes("measure_polygon"));
      }
    } finally { await client.close(); await server.close(); }
  }
});

test("wiki generation rejects changed source text and version until explicitly regenerated", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "ot-wiki-check-"));
  try {
    for (const path of ["mcp/package.json", "mcp/scripts/check-wiki.mjs", ...WIKI_PAGES.map(p => p.source)]) {
      await mkdir(dirname(resolve(temp, path)), { recursive: true });
      await copyFile(resolve(root, path), resolve(temp, path));
    }
    await mkdir(resolve(temp, "mcp/src"), { recursive: true });
    const run = (...args: string[]) => spawnSync(process.execPath, ["mcp/scripts/check-wiki.mjs", ...args], { cwd: temp, encoding: "utf8" });
    assert.equal(run().status, 1, "missing bundle fails");
    assert.equal(run("--write").status, 0);
    assert.equal(run().status, 0);
    // A Windows checkout must not change the packaged content or source hashes.
    for (const page of WIKI_PAGES) {
      const path = resolve(temp, page.source);
      const lf = (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
      await writeFile(path, lf.replace(/\n/g, "\r\n"));
    }
    const bundlePath = resolve(temp, "mcp/src/wiki.generated.ts");
    await writeFile(bundlePath, (await readFile(bundlePath, "utf8")).replace(/\n/g, "\r\n"));
    assert.equal(run().status, 0, "LF and CRLF checkouts produce the same bundle");
    const target = resolve(temp, "docs/wiki/status.md");
    await writeFile(target, await readFile(target, "utf8") + "\nA changed capability must reach packaged readers.\n");
    const stale = run();
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /is stale/);
    assert.equal(run("--write").status, 0);
    const pkgPath = resolve(temp, "mcp/package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    await writeFile(pkgPath, JSON.stringify({ ...pkg, version: "0.0.0-test" }));
    assert.equal(run().status, 1, "version drift also fails");
    assert.equal(run("--write").status, 0);
    assert.equal(run().status, 0);
    await writeFile(resolve(temp, "docs/wiki/unregistered.md"), "# New page\n");
    const missingMapping = run();
    assert.equal(missingMapping.status, 1);
    assert.match(missingMapping.stderr, /explicit resource allowlist differ/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
