// The canvas half of the Assistant window link: names, pairing links and codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poweredByName, readPairingHash, readPairingInput } from "../src/lib/assistantLink.js";

test("the AI app is named the way people know it", () => {
  assert.equal(poweredByName({ name: "claude-ai" }), "Claude Desktop");
  assert.equal(poweredByName({ name: "claude-code" }), "Claude Code");
  assert.equal(poweredByName({ name: "codex-mcp-client" }), "Codex");
  assert.equal(poweredByName({ name: "cursor-vscode" }), "Cursor");
  assert.equal(poweredByName({ name: "Visual Studio Code" }), "VS Code");
  assert.equal(poweredByName({ name: "my-agent" }), "my-agent");
  assert.equal(poweredByName(null), "your AI");
});

test("the link from assistant_open and a typed code both pair", () => {
  assert.deepEqual(readPairingHash("#assistant=47615.abc234"), { port: 47615, code: "ABC234" });
  assert.equal(readPairingHash("#other=1"), null);
  assert.deepEqual(readPairingInput("https://opentakeoff.kentucky-ai.com/#assistant=47616.XYZ789"), { port: 47616, code: "XYZ789" });
  assert.deepEqual(readPairingInput(" xyz789 "), { port: null, code: "XYZ789" });
  assert.deepEqual(readPairingInput("47617 XYZ789"), { port: 47617, code: "XYZ789" });
  assert.equal(readPairingInput("nope"), null);
});
