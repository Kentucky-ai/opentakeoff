// Streaming + Conversation memory + fallback, against mock.mjs.
// Needs two mocks: `node mock.mjs` (port 5189, streams) and
// `PORT=5190 MOCK_STREAM=refuse node mock.mjs` (refuses `stream: true`).
// Prints PASS/FAIL lines; screenshots land in <out-dir>.
export default async function ({ ev, send, shot, sleep, clickText, waitFor }) {
  const results = [];
  const check = (name, ok, extra = "") => { results.push([name, ok]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); };
  const openAgent = async () => {
    if (!(await ev("!!document.getElementById('workspace-agent-tab') && document.getElementById('workspace-agent-tab').offsetParent !== null"))) await clickText("button", "Work");
    await waitFor("!!document.getElementById('workspace-agent-tab')");
    await ev("document.getElementById('workspace-agent-tab').click()");
    await sleep(600);
  };
  const type = async (text) => { for (const ch of text) await send("Input.dispatchKeyEvent", { type: "char", text: ch }); };
  const enter = async () => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  const ask = async (text) => { await ev("document.querySelector('.ac-input').focus(); true"); await type(text); await enter(); };
  const lastReply = "(() => { const t = [...document.querySelectorAll('.ac-turn')].at(-1); const md = t && t.querySelector('.ac-md'); return md ? md.innerText : ''; })()";
  const idle = "!document.querySelector('.ac-send-stop')";
  const configure = (endpoint, provider) => ev(`localStorage.setItem('opentakeoff_ai_endpoint','${endpoint}'); localStorage.setItem('opentakeoff_ai_model','mock-model'); localStorage.setItem('opentakeoff_ai_provider','${provider}'); localStorage.setItem('opentakeoff_ai_key','test'); true`);

  // the bundled sample plan through the real file input
  const { root } = (await send("DOM.getDocument", { depth: -1, pierce: true })).result;
  const q = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file]" });
  await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [process.env.SAMPLE_PDF] });
  await waitFor("!document.body.innerText.includes('No PDFs yet')", 20000); await sleep(2500);
  await configure("http://localhost:5189", "anthropic");
  await ev("localStorage.removeItem('opentakeoff_ai_history_turns'); true");
  await openAgent();

  // 1. Anthropic-style: the answer grows while the turn is still running
  await ask("List the sheets");
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const s = await ev(`({ running: !!document.querySelector('.ac-send-stop'), len: ${lastReply}.length, caret: !!document.querySelector('.ac-md-streaming') })`);
    samples.push(s);
    if (s.running && s.len > 120 && !samples.shotTaken) { samples.shotTaken = true; await shot("10-streaming-mid-reply"); }
    if (!s.running) break;
    await sleep(120);
  }
  const growing = [...new Set(samples.filter((s) => s.running && s.len > 0).map((s) => s.len))];
  check("anthropic: text grows token by token while running", growing.length >= 5, `${growing.length} distinct lengths while running: ${growing.slice(0, 8).join(", ")}…`);
  check("anthropic: streaming caret shows while running", samples.some((s) => s.running && s.caret));
  const final1 = await ev(lastReply);
  check("anthropic: final answer complete after the tool round", /history sent: 0 prior messages/.test(final1) && /accept or reject\.$/.test(final1.trim()), JSON.stringify(final1.slice(0, 60)));
  await clickText(".ac-steps-toggle", "Show every step"); await sleep(250);
  const steps1 = await ev("[...document.querySelectorAll('.ac-turn')].at(-1).querySelector('.ac-trace')?.innerText.replace(/\\s+/g,' ')");
  check("anthropic: tool calls assembled and ran (steps list)", /List the sheets/.test(steps1) && /Check the conditions/.test(steps1), steps1);
  await shot("11-streamed-answer-steps");

  // 2. Stop mid-stream keeps the partial answer
  await ask("And the schedule?");
  await waitFor(`(${lastReply}).includes('history sent')`, 15000);
  await sleep(500);
  await clickText(".ac-send-stop", "Stop");
  await waitFor(idle, 5000);
  const stopped = await ev("[...document.querySelectorAll('.ac-turn')].at(-1).innerText.replace(/\\s+/g,' ')");
  const partial = await ev(lastReply);
  check("stop mid-stream: turn shows Stopped with the partial answer", /Stopped\./.test(stopped) && /history sent: 2 prior messages/.test(partial) && !/accept or reject\.$/.test(partial.trim()), `${partial.length} chars kept`);
  await shot("12-stopped-mid-stream");

  // 3. Conversation memory: set it to 1 in AI settings, the next request carries 1 earlier turn
  await ev("document.querySelector('.ac-icon-btn[aria-label=\"AI settings\"]').click(); true"); await sleep(400);
  const before = await ev("document.querySelector('input[name=ai-history-turns]')?.value");
  check("AI settings: Conversation memory field defaults to 8", before === "8", `value=${before}`);
  await ev(`(() => { const el = document.querySelector('input[name=ai-history-turns]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '1'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(200);
  const disclosure = await ev("[...document.querySelectorAll('p')].map((p) => p.innerText).join(' | ')");
  check("AI settings: disclosure states the memory and browser-only chats", /up to the last 1 earlier question and answer/.test(disclosure) && /Chats stay in this browser/.test(disclosure));
  await shot("13-ai-settings-memory");
  await clickText("button", "Save"); await sleep(400);
  check("AI settings: Conversation memory saved", (await ev("localStorage.getItem('opentakeoff_ai_history_turns')")) === "1");
  await ask("Which sheet has the schedule?");
  await waitFor(`(${lastReply}).includes('accept or reject')`, 20000); await waitFor(idle, 5000);
  check("memory=1: the model got 2 prior messages (1 turn)", /history sent: 2 prior messages/.test(await ev(lastReply)));
  await ev("localStorage.setItem('opentakeoff_ai_history_turns','0'); true");
  await ask("Again, with no memory");
  await waitFor(`(${lastReply}).includes('accept or reject')`, 20000); await waitFor(idle, 5000);
  check("memory=0: no prior messages sent", /history sent: 0 prior messages/.test(await ev(lastReply)));
  await ev("localStorage.removeItem('opentakeoff_ai_history_turns'); true");

  // 4. OpenAI-style streaming on the same mock
  await clickText(".ac-bar button", "New chat"); await sleep(300);
  await configure("http://localhost:5189", "openai");
  await ask("List the sheets");
  const oSamples = [];
  const t1 = Date.now();
  while (Date.now() - t1 < 20000) {
    const s = await ev(`({ running: !!document.querySelector('.ac-send-stop'), len: ${lastReply}.length })`);
    oSamples.push(s); if (!s.running) break; await sleep(120);
  }
  const oGrowing = [...new Set(oSamples.filter((s) => s.running && s.len > 0).map((s) => s.len))];
  const oFinal = await ev(lastReply);
  check("openai: text grows while running, answer complete", oGrowing.length >= 5 && /history sent: 0 prior messages/.test(oFinal) && /accept or reject\.$/.test(oFinal.trim()), `${oGrowing.length} distinct lengths`);
  await shot("14-openai-streamed");

  // 5. Fallback: an endpoint that refuses `stream` still answers (plain JSON retry)
  await clickText(".ac-bar button", "New chat"); await sleep(300);
  await configure("http://localhost:5190", "anthropic");
  await ask("List the sheets");
  await waitFor(idle, 20000); await sleep(300);
  const fb = await ev(lastReply);
  const fbTurn = await ev("[...document.querySelectorAll('.ac-turn')].at(-1).innerText");
  check("fallback: refused stream → plain reply, no error", /accept or reject\.$/.test(fb.trim()) && !/failed|HTTP/.test(fbTurn), JSON.stringify(fb.slice(0, 50)));
  await shot("15-fallback-no-stream");

  // 6. reload: the chat persists in this browser
  await configure("http://localhost:5189", "anthropic");
  await sleep(800);
  await send("Page.reload"); await sleep(3500);
  await openAgent();
  check("reload: the chat comes back from this browser", (await ev("document.querySelectorAll('.ac-turn').length")) === 1);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`SUMMARY ${results.length - failed}/${results.length} passed`);
}
