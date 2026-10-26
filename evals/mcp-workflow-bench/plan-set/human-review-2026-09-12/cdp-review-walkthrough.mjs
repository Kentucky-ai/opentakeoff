// Headless CDP walkthrough of the human review loop on an agent takeoff (P3-D evidence).
// Usage: node cdp-review-walkthrough.mjs <cdp-port> <vite-port> <plan.pdf> <agent.takeoff.json> <out-dir> [otk-to-open]
// Phase A (no otk arg): load plan, adopt scale, import the agent takeoff, inspect, correct one vertex, accept the batch,
//   export takeoff JSON, export the project archive (.otk), open the report, download the marked set. Numbered screenshots.
// Phase B (otk arg): in a FRESH browser profile, open the .otk, screenshot the restored work, export takeoff JSON.
import { writeFileSync, mkdirSync } from "node:fs";
const [cdpPort, vitePort, PLAN, TAKEOFF, OUT, OTK] = process.argv.slice(2); // run from web/ with a Vite dev server up; a FRESH headless Chrome profile per phase
mkdirSync(OUT, { recursive: true }); mkdirSync(`${OUT}/downloads`, { recursive: true });
const ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => ws.onopen = r);
let id = 0; const pending = new Map(); const events = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); } else if (d.method) events.push(d); };
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
const ev = (m, p) => send(m, p, sid);
await ev("Page.enable"); await ev("Runtime.enable"); await ev("DOM.enable");
await ev("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: `${OUT}/downloads`, eventsEnabled: true });
const evalJs = async (expr) => { const r = await ev("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception?.description).slice(0, 300)); return r.result.value; };
const until = async (expr, label, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJs(expr)) return; await sleep(400); } throw new Error("timeout waiting: " + label); };
const mouse = async (x, y) => { await ev("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse" }); await ev("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, pointerType: "mouse" }); await ev("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, pointerType: "mouse" }); await sleep(350); };
const drag = async (x0, y0, x1, y1) => { await ev("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, pointerType: "mouse" }); await ev("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, pointerType: "mouse" }); for (let i = 1; i <= 8; i++) { await ev("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + (x1 - x0) * i / 8, y: y0 + (y1 - y0) * i / 8, button: "left", buttons: 1, pointerType: "mouse" }); await sleep(30); } await ev("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1, pointerType: "mouse" }); await sleep(400); };
const key = (k) => evalJs(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true })), true`);
const findRect = (sel, text) => evalJs(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => (e.textContent || "").includes(${JSON.stringify(text)}) || (e.getAttribute("title") || "").includes(${JSON.stringify(text)}) || (e.getAttribute("aria-label") || "").includes(${JSON.stringify(text)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
const clickText = async (sel, text) => { const r = await findRect(sel, text); if (!r) throw new Error("no element with text: " + text); await mouse(r.x, r.y); return r; };
let shotN = 0; const log = [];
const shot = async (name, note) => { shotN += 1; const s = await ev("Page.captureScreenshot", { format: "png" }); const f = `${OUT}/${String(shotN).padStart(2, "0")}-${name}.png`; writeFileSync(f, Buffer.from(s.data, "base64")); const msg = await evalJs(`document.body.innerText.match(/(Accepted|Rejected|Imported|Exported|Marked set|Couldn't|Opened)[^\\n]{0,160}/)?.[0] || ""`); log.push({ shot: f.split("/").pop(), note, status: msg }); console.log(`[${shotN}] ${name}: ${note}${msg ? " | " + msg : ""}`); };
const setFileInPage = async (selector, file, mime) => { const { readFileSync } = await import("node:fs"); const b64 = readFileSync(file).toString("base64"); const name = file.split("/").pop(); await evalJs(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} })); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); return input.files.length; })()`); };
const setFile = async (selector, file) => { const r = await ev("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` }); if (!r.result?.objectId) throw new Error("no input " + selector); await ev("DOM.setFileInputFiles", { files: [file], objectId: r.result.objectId }); };
const snapDl = async () => { const { readdirSync } = await import("node:fs"); return new Set(readdirSync(`${OUT}/downloads`)); };
const waitDownload = async (label, before, ms = 180000) => { const { readdirSync, statSync } = await import("node:fs"); const ok = (f) => !f.startsWith(".") && !f.endsWith(".crdownload") && !f.endsWith(".tmp") && !f.endsWith(".html"); const size = (f) => { try { return statSync(`${OUT}/downloads/${f}`).size; } catch { return -1; } }; const t0 = Date.now(); while (Date.now() - t0 < ms) { const fresh = readdirSync(`${OUT}/downloads`).filter((f) => !before.has(f) && ok(f)); if (fresh.length) { const f = fresh[0]; const s1 = size(f); await sleep(1200); const s2 = size(f); if (s1 > 0 && s1 === s2) { console.log(`download ${label}: ${f} (${s2} bytes)`); return f; } } await sleep(400); } throw new Error("download timeout: " + label); };
const openSheetMenuItem = async (label) => { await clickText("button", "Sheet — the sheets in this set"); await until(`[...document.querySelectorAll("button")].some(e => (e.textContent||"").trim() === ${JSON.stringify(label)})`, "menu item " + label, 10000); const r = await evalJs(`(() => { const el = [...document.querySelectorAll("button")].find(e => (e.textContent||"").trim() === ${JSON.stringify(label)}); const b = el.getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 }; })()`); await mouse(r.x, r.y); };

await ev("Page.navigate", { url: `http://localhost:${vitePort}/` });
await until(`document.readyState === "complete" && !!document.querySelector('input[type=file][accept*="pdf"]')`, "app loaded");
if (OTK) {
  // ---- Phase B: fresh workspace, open the archive
  await shot("fresh-workspace", "A fresh browser profile: nothing in it yet.");
  await setFile('input[name="sheet-file"]', OTK);
  await until(`/✓ 1\\/8" = 1'-0"/.test(document.body.innerText) && document.body.innerText.includes("shapes on sheet")`, "archive opened", 180000);
  await sleep(1500);
  await shot("archive-opened-gallery", "Opening the .otk on a clean machine: the plan, its scale and all six accepted shapes are back; the set's sheet gallery opens on top because the archive holds two sheets.");
  if (await evalJs(`document.body.innerText.includes("PICK ONE OR SEVERAL")`)) { const r = await evalJs(`(() => { const el = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Close"); const b = el.getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 }; })()`); await mouse(r.x, r.y); await sleep(1200); }
  await until(`!document.body.innerText.includes("PICK ONE OR SEVERAL") && [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "V")`, "gallery closed", 30000);
  await sleep(1500);
  await shot("archive-reopened", "The .otk opened on a clean machine: plan, scale, conditions and every accepted shape restored, ink not pencil.");
  const b0 = await snapDl(); await openSheetMenuItem("Export takeoff…"); const f = await waitDownload("takeoff-after-reopen", b0); log.push({ export_after_reopen: f });
  await shot("reopened-export", "Takeoff JSON exported again from the reopened archive for a byte-level comparison.");
} else {
  // ---- Phase A
  await shot("empty", "OpenTakeoff before anything is loaded.");
  await setFile('input[name="sheet-file"]', PLAN);
  await until(`!document.body.innerText.includes("PICK ONE OR SEVERAL") && document.body.innerText.includes("Set scale") && !document.body.innerText.includes("Rendering") && [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "V")`, "sheet opened + rendered", 120000);
  await sleep(1500);
  await shot("plan-open", "The finish plan is open; the scale bar asks for a scale.");
  await clickText("button", "Set scale"); await until(`[...document.querySelectorAll("button")].some(b => b.textContent.includes("Plan says"))`, "scale menu"); await clickText("button", "Plan says");
  await until(`/✓ 1\\/8" = 1'-0"/.test(document.body.innerText)`, "scale adopted"); await sleep(500);
  await shot("scale-adopted", "The human adopts the plan's own 1/8 in = 1 ft note (the same calibration the agent used).");
  await setFileInPage('input[name="takeoff-import"]', TAKEOFF, "application/json");
  await until(`!!document.querySelector('[data-proposal-pill]')`, "proposal pill after import", 60000); await sleep(1500);
  await shot("imported-pending", "Import takeoff: the agent's six rings land dashed (pencil) with ONE Accept pill for the batch. Nothing is approved.");
  // zoom in on the cluster with the wheel to inspect a ring (three notches)
  const stage = await evalJs(`(() => { const c = [...document.querySelectorAll("canvas")].sort((a,b) => b.width*b.height - a.width*a.height)[0]; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const pill = await findRect("[data-proposal-pill] button", "Accept");
  log.push({ pill_text: await evalJs(`document.querySelector('[data-proposal-pill]')?.innerText`) });
  // pick a vertex of a pending shape: read the first shape's first vertex in screen px through the SVG overlay (select tool first)
  await key("v");
  const target = await evalJs(`(() => { const svg = [...document.querySelectorAll("svg")].sort((a,b) => (b.getBoundingClientRect().width*b.getBoundingClientRect().height) - (a.getBoundingClientRect().width*a.getBoundingClientRect().height))[0]; const polys = [...svg.querySelectorAll("polygon,path")].filter(p => p.getAttribute("stroke-dasharray") || (p.getAttribute("style")||"").includes("dash")); const p = polys[0]; if (!p) return null; const r = p.getBoundingClientRect(); return { cx: r.x + r.width/2, cy: r.y + r.height/2, n: polys.length }; })()`);
  log.push({ dashed_shapes_on_screen: target?.n });
  if (target) { await mouse(target.cx, target.cy); await sleep(500); }
  await shot("shape-selected", "Select (V) and click a pending ring: its corner handles show. This is the review surface.");
  const handle = await evalJs(`(() => { const svgs = [...document.querySelectorAll("svg")]; let best = null; for (const svg of svgs) { for (const p of svg.querySelectorAll("polygon")) { const r = p.getBoundingClientRect(); if (r.x > 150 && r.width > 20 && r.width < 400 && r.height > 20 && r.height < 400 && p.points && p.points.length >= 3) { const pt = svg.createSVGPoint(); pt.x = p.points[0].x; pt.y = p.points[0].y; const sp = pt.matrixTransform(p.getScreenCTM()); best = { x: sp.x, y: sp.y, count: p.points.length, w: Math.round(r.width) }; break; } } if (best) break; } return best; })()`);
  log.push({ vertex0_screen: handle });
  if (handle) { await mouse(handle.x, handle.y); await sleep(300); await drag(handle.x, handle.y, handle.x + 4, handle.y + 3); await sleep(700); log.push({ after_drag_status: await evalJs(`document.body.innerText.match(/\\d[\\d.,]* SF · [^\\n]{0,40}/)?.[0]`) }); }
  await shot("vertex-corrected", "The human nudges one corner about a foot: the shape re-prices live and is graded as corrected in provenance; the agent's original ring is frozen beside it.");
  await key("Escape"); await sleep(300);
  await clickText("[data-proposal-pill] button", "Accept"); await sleep(800);
  await shot("batch-accepted", "The Accept pill: one click inks the whole batch (one undo). NOTE: in this walkthrough the click was issued by a script in a throwaway browser, so it demonstrates the control, not a human's approval.");
  const b1 = await snapDl(); await openSheetMenuItem("Export takeoff…"); const f1 = await waitDownload("takeoff-json", b1); log.push({ export_takeoff: f1 }); await sleep(800);
  { const { readFileSync } = await import("node:fs"); const ex = JSON.parse(readFileSync(`${OUT}/downloads/${f1}`, "utf8")); const summary = { shapes: ex.shapes.length, reviewed_true: ex.shapes.filter(x => x.origin?.reviewed === true).length, corrected: ex.shapes.filter(x => x.origin?.proposed_verts_norm || x.origin?.corrected || x.origin?.edited).length, approvals: (ex.approvals||[]).length, stamps: (ex.markups||[]).filter(m => /stamp|approv/i.test(JSON.stringify(m))).length, origin_actors: [...new Set(ex.shapes.map(x => x.origin?.actor))] }; log.push({ export_check: summary }); console.log("export check", JSON.stringify(summary)); if (summary.approvals || summary.stamps) throw new Error("an approval record exists in the export; the walkthrough must not fabricate human approval"); }
  await shot("takeoff-exported", "Sheet menu → Export takeoff… writes the editable JSON with the review state.");
  const b2 = await snapDl(); await openSheetMenuItem("Export project archive…"); const f2 = await waitDownload("otk", b2); log.push({ export_archive: f2 }); await sleep(500);
  await shot("archive-exported", "Sheet menu → Export project archive… writes the .otk (plan PDF + takeoff) for a clean machine.");
  await clickText("button", "Open the takeoff report"); await until(`[...document.querySelectorAll("button")].some(b => (b.getAttribute("title")||"").includes("generate the marked-set"))`, "report open"); await sleep(1200);
  await shot("report", "The Report: per-condition SF from the accepted rings.");
  await clickText("button", "generate the marked-set"); await until(`[...document.querySelectorAll("button")].some(b => b.textContent.includes("Download marked set"))`, "print menu"); const b3 = await snapDl(); await clickText("button", "Download marked set");
  const f3 = await waitDownload("marked-set", b3, 240000); log.push({ marked_set: f3 }); await sleep(800);
  await shot("marked-set", "Marked set PDF downloaded: the deliverable, with the accepted rings burned into the sheet.");
}
writeFileSync(`${OUT}/walkthrough-log.json`, JSON.stringify(log, null, 2)); console.log("done", OUT);
process.exit(0);
