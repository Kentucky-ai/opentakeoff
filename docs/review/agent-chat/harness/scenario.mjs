export default async function ({ ev, send, shot, sleep, clickText, waitFor, logs }) {
  const openAgent = async () => {
    if (!(await ev("!!document.getElementById('workspace-agent-tab') && document.getElementById('workspace-agent-tab').offsetParent !== null"))) await clickText("button", "Work");
    await waitFor("!!document.getElementById('workspace-agent-tab')");
    await ev("document.getElementById('workspace-agent-tab').click()");
    await sleep(500);
  };
  const type = async (text) => { for (const ch of text) await send("Input.dispatchKeyEvent", { type: "char", text: ch }); };
  const enter = async (shift = false) => {
    const m = shift ? 8 : 0;
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: m });
    await send("Input.dispatchKeyEvent", { type: "char", text: "\r", modifiers: m });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: m });
  };
  // 1. no model configured
  await ev("localStorage.removeItem('opentakeoff_ai_endpoint'); localStorage.removeItem('opentakeoff_ai_model'); true");
  await openAgent();
  console.log("connect state:", await ev("document.querySelector('.ac-connect')?.innerText.replace(/\\s+/g,' ')"));
  console.log("textarea disabled:", await ev("document.querySelector('.ac-input')?.disabled"));
  await shot("1-connect");
  await clickText(".ac-connect button", "Connect your AI");
  await sleep(500);
  console.log("ConnectAI opened:", await ev("document.body.innerText.includes('Claude Desktop')"));
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  // 1b. no plan open yet → the refusal lands in the chat as a turn (configure first)
  await ev("localStorage.setItem('opentakeoff_ai_endpoint','http://localhost:5189'); localStorage.setItem('opentakeoff_ai_model','mock-model'); localStorage.setItem('opentakeoff_ai_provider','anthropic'); localStorage.setItem('opentakeoff_ai_key','test'); true");
  await send("Page.reload"); await sleep(3000);
  await openAgent();
  await ev("document.querySelector('.ac-input').focus(); true");
  await type("List the sheets");
  await enter(false);
  await sleep(400);
  console.log("no-plan turn:", await ev("document.querySelector('.ac-turn')?.innerText.replace(/\\s+/g,' ')"));
  await shot("1b-no-plan");
  await clickText(".ac-bar button", "New chat");
  await sleep(300);
  // load the bundled sample plan through the real file input
  const { root } = (await send("DOM.getDocument", { depth: -1, pierce: true })).result;
  const q = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file]" });
  await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [process.env.SAMPLE_PDF] });
  console.log("plan ready:", await waitFor("!document.body.innerText.includes('No PDFs yet')", 20000));
  await sleep(2500);
  // 2. configure the mock model, reload
  await ev("localStorage.setItem('opentakeoff_ai_endpoint','http://localhost:5189'); localStorage.setItem('opentakeoff_ai_model','mock-model'); localStorage.setItem('opentakeoff_ai_provider','anthropic'); localStorage.setItem('opentakeoff_ai_key','test'); true");
  await openAgent();
  console.log("empty state:", await ev("document.querySelector('.ac-empty')?.innerText.replace(/\\s+/g,' ')"));
  await shot("2-empty");
  // 3. suggestion prefills; Shift+Enter adds a newline; Enter sends
  await clickText(".ac-starter", "List the sheets");
  await sleep(300);
  console.log("prefilled:", await ev("document.querySelector('.ac-input').value"));
  console.log("focused:", await ev("document.activeElement === document.querySelector('.ac-input')"));
  await enter(true);
  console.log("after shift+enter has newline:", await ev("document.querySelector('.ac-input').value.endsWith('\\n')"));
  await enter(false);
  await sleep(250);
  console.log("cleared after send:", await ev("document.querySelector('.ac-input').value === ''"));
  console.log("running:", await ev("!!document.querySelector('.ac-send-stop')"), await ev("document.querySelector('.ac-reply')?.innerText.replace(/\\s+/g,' ')"));
  await shot("3-running");
  await waitFor("!document.querySelector('.ac-send-stop')", 15000);
  await sleep(300);
  await clickText(".ac-steps-toggle", "Show every step");
  await sleep(300);
  console.log("turn 1:", await ev("document.querySelector('.ac-turn')?.innerText.replace(/\\s+/g,' ')"));
  await shot("4-answer-steps");
  // 4. second message carries history
  await ev("document.querySelector('.ac-input').focus(); true");
  await type("And the schedule?");
  await enter(false);
  await waitFor("document.querySelectorAll('.ac-turn').length === 2 && !document.querySelector('.ac-send-stop')", 15000);
  await sleep(300);
  console.log("turn 2:", await ev("document.querySelectorAll('.ac-turn')[1]?.innerText.replace(/\\s+/g,' ')"));
  // 5. Stop mid-run
  await ev("document.querySelector('.ac-input').focus(); true");
  await type("Trace the rooms on this sheet");
  await enter(false);
  await sleep(400);
  await clickText(".ac-send-stop", "Stop");
  await waitFor("!document.querySelector('.ac-send-stop')", 5000);
  console.log("turn 3:", await ev("document.querySelectorAll('.ac-turn')[2]?.innerText.replace(/\\s+/g,' ')"));
  await shot("5-stopped");
  // 6. persistence across reload
  await sleep(800);
  await send("Page.reload"); await sleep(3000);
  await openAgent();
  console.log("after reload turns:", await ev("document.querySelectorAll('.ac-turn').length"));
  await shot("6-reloaded");
  // 7. light theme sanity
  await ev("(() => { const raw = JSON.parse(localStorage.getItem('ot.workspace-layout.v1') || '{}'); localStorage.setItem('ot.workspace-layout.v1', JSON.stringify({ ...raw, look: 'light' })); return true; })()");
  await send("Page.reload"); await sleep(3000);
  await openAgent();
  await shot("7-light");
}
