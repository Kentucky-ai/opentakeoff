export default async function ({ ev, send, shot, sleep, clickText, waitFor }) {
  const openAgent = async () => {
    if (!(await ev("!!document.getElementById('workspace-agent-tab') && document.getElementById('workspace-agent-tab').offsetParent !== null"))) await clickText("button", "Work");
    await waitFor("!!document.getElementById('workspace-agent-tab')");
    await ev("document.getElementById('workspace-agent-tab').click()");
    await sleep(600);
  };
  const { root } = (await send("DOM.getDocument", { depth: -1, pierce: true })).result;
  const q = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file]" });
  await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [process.env.SAMPLE_PDF] });
  await waitFor("!document.body.innerText.includes('No PDFs yet')", 20000); await sleep(2500);
  await openAgent();
  console.log("connect visible:", await ev("!!document.querySelector('.ac-connect') && document.querySelector('.ac-connect').offsetParent !== null"));
  await shot("8-connect-graphite");
  await ev("(() => { const raw = JSON.parse(localStorage.getItem('ot.workspace-layout.v1') || '{}'); raw.layout = { ...(raw.layout || {}), look: 'light' }; localStorage.setItem('ot.workspace-layout.v1', JSON.stringify(raw)); localStorage.setItem('opentakeoff_ai_endpoint','http://localhost:5189'); localStorage.setItem('opentakeoff_ai_model','mock-model'); localStorage.setItem('opentakeoff_ai_provider','anthropic'); return true; })()");
  await send("Page.reload"); await sleep(3500);
  await openAgent();
  console.log("look:", await ev("document.querySelector('[data-workspace-look]')?.getAttribute('data-workspace-look')"));
  await clickText(".ac-starter", "Read the finish schedule"); await sleep(200);
  await clickText(".ac-send", "Send");
  await waitFor("document.querySelectorAll('.ac-turn').length === 1 && !document.querySelector('.ac-send-stop')", 15000);
  await sleep(300);
  await clickText(".ac-steps-toggle", "Show every step"); await sleep(300);
  await shot("9-light-answer");
}
