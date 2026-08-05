// Minimal CDP driver for headless Chrome (no deps — Node 24 global WebSocket).
// Usage: node cdp.mjs <cmd> [...args]
//   nav <url> | shot <out.png> | click <x> <y> [shift] | dblclick <x> <y>
//   key <key> [code] [keyCode] | type <text> | eval <js> (reads stdin if "-")
const port = 9222;
const [, , cmd, ...args] = process.argv;

const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++mid; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (cmd === "nav") {
  await send("Page.enable");
  await send("Page.navigate", { url: args[0] });
  await sleep(2500);
  console.log("navigated");
} else if (cmd === "shot") {
  const { result } = await send("Page.captureScreenshot", { format: "png" });
  const fs = await import("node:fs");
  fs.writeFileSync(args[0], Buffer.from(result.data, "base64"));
  console.log(args[0]);
} else if (cmd === "click" || cmd === "dblclick") {
  const x = +args[0], y = +args[1];
  const modifiers = args[2] === "shift" ? 8 : 0;
  const clicks = cmd === "dblclick" ? 2 : 1;
  for (let c = 1; c <= clicks; c++) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: c, modifiers });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: c, modifiers });
  }
  console.log(`${cmd} ${x},${y}${modifiers ? " +shift" : ""}`);
} else if (cmd === "move") {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: +args[0], y: +args[1] });
  console.log(`move ${args[0]},${args[1]}`);
} else if (cmd === "key") {
  const key = args[0];
  const wc = { Enter: 13, Escape: 27, Backspace: 8 }[key];
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: args[1] || key, windowsVirtualKeyCode: wc });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: args[1] || key, windowsVirtualKeyCode: wc });
  console.log(`key ${key}`);
} else if (cmd === "type") {
  for (const ch of args.join(" ")) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
  console.log("typed");
} else if (cmd === "eval") {
  let expr = args.join(" ");
  if (expr === "-") expr = (await import("node:fs")).readFileSync(0, "utf8");
  const { result } = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(result.result?.value ?? result.result, null, 1));
} else {
  console.error("unknown cmd");
}
ws.close();
