// Generate from tools/list, including gated/staged variants, so the docs use
// the same required arguments an actual client discovers. No plan is loaded.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../server.ts';
import { Session } from '../src/session.ts';
import { ALL_TOOL_NAMES, TOOL_NAMES, stageOf } from '../src/staging.ts';

const write = process.argv.includes('--write');
const target = fileURLToPath(new URL('../../docs/MCP_TOOL_INDEX.md', import.meta.url));
const server = buildServer(new Session(), { oneClick: true, stagedTools: false });
const client = new Client({ name: 'tool-docs', version: '1' });
const [ct, st] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(st);
  await client.connect(ct);
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...ALL_TOOL_NAMES].sort())) throw new Error('Runtime tool names differ from the stage inventory');
  const md = [
    '# MCP tool index', '',
    'Generated from runtime `tools/list` schemas and the source stage table. Do not edit by hand.',
    'Refresh with `npm run check:tool-count --prefix mcp -- --write`; CI fails on stale output.', '',
    'For the operating workflow, read [the agent guide](AGENT_GUIDE.md) and [geometry workflow](GEOMETRY_WORKFLOW.md).',
    'For behavior and optional arguments, use the [tool reference](../mcp/README.md#tools) and the discovered input schema.', '',
    `Default build: **${TOOL_NAMES.length} tools**. Coordinates, where present, are full-sheet image pixels at PDF render scale 2.0, top-left origin, y down.`, '',
    '| Tool | Stage | Availability | Required arguments |', '|---|---|---|---|',
    ...tools.sort((a,b) => a.name.localeCompare(b.name, 'en')).map(t => {
      const required = (t.inputSchema.required ?? []).map(k => '`' + k + '`').join(', ') || 'None';
      return `| \`${t.name}\` | ${stageOf(t.name)} | ${TOOL_NAMES.includes(t.name) ? 'Default' : 'One-Click gate lifted'} | ${required} |`;
    }), '',
    '`open_tool_stage {stage}` exists only when staged exposure is enabled. Setup starts open; measure, revise and handoff open on demand. This opener is not part of the default flat count.', '',
    'Schema-required fields are only the first validation layer: conditional requirements (such as annotation coordinates by type or exactly one calibration method) are explained by each tool and validated by its handler.', '',
    'Sources: [tool registrations](../mcp/src/tools.ts), [stage table](../mcp/src/staging.ts), [output schemas](../mcp/src/outputs.ts).', '',
  ].join('\n');
  let current = '';
  try { current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (current !== md) {
    if (write) writeFileSync(target, md);
    else { console.error('MCP_TOOL_INDEX.md is stale — run npm run check:tool-count -- --write'); process.exitCode = 1; }
  }
  // The hand-written descriptions must cover every real tool exactly once.
  const reference = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const rows = [...reference.matchAll(/^\| `([a-z_]+)` \|/gm)].map(m => m[1]).sort();
  if (JSON.stringify(rows) !== JSON.stringify(names)) {
    console.error('mcp/README.md tool rows differ from runtime tools/list; update missing, duplicate or obsolete descriptions');
    process.exitCode = 1;
  }
  console.log(`Runtime inventory: ${TOOL_NAMES.length} default tools, ${names.length} with gate lifted; schema inputs and reference rows checked.`);
} finally {
  await client.close();
  await server.close();
}
