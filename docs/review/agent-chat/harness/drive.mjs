// Usage (from this folder): node mock.mjs & then
//   SAMPLE_PDF="$(cd ../../../../web/public/demo && pwd)/sample-finish-plan.pdf" APP_URL=http://localhost:5181/ node drive.mjs <out-dir> scenario.mjs   (absolute path, no "..": Chrome will not read it otherwise)
// Throwaway headless Chrome over CDP (own profile; never the user's browser).
import { spawn } from "node:child_process";
import fs from "node:fs";
const OUT = process.argv[2];
const URL0 = process.env.APP_URL || "http://localhost:5181/";
const prof = `${OUT}/prof-${Date.now()}`;
const chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9337", `--user-data-dir=${prof}`, "--window-size=1440,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(); const logs = [];
async function connect() {
  for (let i = 0; i < 50; i++) { try { const l = await (await fetch("http://127.0.0.1:9337/json/list")).json(); const p = l.find((t) => t.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); }
  throw new Error("no chrome");
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log("shot", name); };
const clickText = (sel, text) => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)}) && e.offsetParent !== null); if (!el) return false; el.click(); return true; })()`);
const waitFor = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(250); } return false; };
try {
  ws = new WebSocket(await connect());
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + JSON.stringify(d.params.exceptionDetails).slice(0, 300)); if (d.method === "Runtime.consoleAPICalled" && (d.params.type === "error")) logs.push("ERR " + d.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300)); });
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: URL0 });
  await sleep(2500);
  console.log("title:", await ev("document.title"));
  console.log("buttons:", (await ev("[...document.querySelectorAll('button,a')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,40).join(' | ')")));
  const step = process.argv[3] || "explore";
  if (step !== "explore") {
    const mod = await import(step.startsWith("/") ? step : `${process.cwd()}/${step}`);
    await mod.default({ ev, send, shot, sleep, clickText, waitFor, logs });
  }
  console.log("logs:", logs.slice(0, 20).join("\n"));
} finally { try { ws?.close(); } catch {} chrome.kill(); }
