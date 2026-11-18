// The Assistant window bridge (src/assistantBridge.ts): origin + pairing gate,
// a typed message reaches assistant_listen, replies and tool activity reach the
// window, and a long-idle listen tells the agent to sleep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantBridge, originAllowed, IDLE_SLEEP_MS } from "../src/assistantBridge.ts";

const APP = "https://opentakeoff.kentucky-ai.com";
const call = (port: number, path: string, init: RequestInit & { origin?: string } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { origin: init.origin ?? APP, "content-type": "application/json", ...(init.headers || {}) } });

test("only the app, local dev servers and deploy previews may reach the bridge", () => {
  assert.equal(originAllowed(APP), true);
  assert.equal(originAllowed("http://localhost:5199"), true);
  assert.equal(originAllowed("https://deploy-preview-12--opentakeoff.netlify.app"), true);
  assert.equal(originAllowed("https://evil.example"), false);
  assert.equal(originAllowed("https://opentakeoff.kentucky-ai.com.evil.example"), false);
  assert.equal(originAllowed(undefined), false);
});

test("pairing, a message to listen, a reply and activity to the window", async () => {
  const b = new AssistantBridge(() => ({ name: "claude-code", version: "2.1.0" }), []);
  try {
    const o = await b.open();
    assert.match(o.code, /^[A-Z2-9]{6}$/);
    assert.ok(o.link.endsWith(`#assistant=${o.port}.${o.code}`));
    assert.equal((await call(o.port, "/pair", { method: "POST", body: JSON.stringify({ code: o.code }), origin: "https://evil.example" })).status, 403);
    assert.equal((await call(o.port, "/pair", { method: "POST", body: JSON.stringify({ code: "WRONG1" }) })).status, 401);
    const paired: any = await (await call(o.port, "/pair", { method: "POST", body: JSON.stringify({ code: o.code }) })).json();
    assert.equal(paired.powered_by.name, "claude-code");
    // the code is single-use
    assert.equal((await call(o.port, "/pair", { method: "POST", body: JSON.stringify({ code: o.code }) })).status, 401);
    // unauthenticated send is refused
    assert.equal((await call(o.port, "/send", { method: "POST", body: JSON.stringify({ text: "hi" }) })).status, 401);

    const auth = { authorization: `Bearer ${paired.token}` };
    const listening = b.waitForMessage(5);
    assert.equal((await call(o.port, "/send", { method: "POST", body: JSON.stringify({ text: "How many sheets?" }), headers: auth })).status, 200);
    const got = await listening;
    assert.deepEqual([got.status, got.message], ["message", "How many sheets?"]);
    assert.equal(b.state, "working");

    // the window's event stream replays history and carries the reply + activity
    const res = await call(o.port, `/events?token=${paired.token}`);
    const reader = res.body!.getReader();
    b.activity("sheet_info", true, 12.4);
    b.say("It has **3** sheets.");
    let text = "";
    while (!text.includes("It has **3** sheets.")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(text, /"type":"hello".*"claude-code"/);
    assert.match(text, /"type":"user".*How many sheets\?/);
    assert.match(text, /"type":"activity","id":"e\d+","tool":"sheet_info","ok":true,"ms":12/);
  } finally { b.close(); }
});

test("nothing typed: a short timeout, then sleep once the person has been away long enough", async () => {
  const b = new AssistantBridge(() => ({ name: "claude-ai", version: "1" }), []);
  try {
    await b.open();
    assert.equal((await b.waitForMessage(1)).status, "timeout");
    (b as unknown as { lastUserAt: number }).lastUserAt = Date.now() - IDLE_SLEEP_MS - 1000;
    const slept = await b.waitForMessage(1);
    assert.equal(slept.status, "sleep");
    assert.equal(b.state, "paused");
  } finally { b.close(); }
});
