// Build a Smithery-only .mcpb — NOT the artifact attached to GitHub releases or
// published anywhere else. Exists because of a genuine spec conflict:
//
//   - Anthropic's own MCPB validator (`@anthropic-ai/mcpb validate`, what
//     `npm run mcpb` gates on) REJECTS a `tools[].inputSchema` key outright
//     ("Unrecognized key(s)"). The real MCPB spec's `tools` array is display
//     metadata only (name + description); a client discovers the live
//     inputSchema over the wire at runtime.
//   - Smithery's registry does the opposite: publishing a bundle with an empty
//     or absent `tools` array succeeds but the server page shows "No
//     capabilities found" and scores low; publishing real tools WITHOUT
//     inputSchema is rejected 400 "No values to set" (smithery-ai/cli#770,
//     #797); Smithery only accepts tools that DO carry inputSchema — the
//     inverse of what the official validator allows (smithery-ai/cli#787).
//
// No manifest satisfies both validators. The canonical `npm run mcpb` bundle
// (dist-mcpb/opentakeoff-mcp.mcpb) stays spec-compliant for Claude Desktop /
// the official registry / Glama. This script produces a SEPARATE bundle, with
// live-introspected tools + inputSchema baked in, packed with a plain zip
// (bypassing `mcpb validate`, which would reject it) — publish it by hand:
//
//   node scripts/build-smithery-mcpb.mjs
//   smithery mcp publish dist-smithery/opentakeoff-mcp.mcpb -n Kentucky-ai/opentakeoff
//
// Re-run after any tool signature changes so the Smithery listing doesn't go
// stale. Revisit/delete this script if smithery-ai/cli#787 ever ships a fix
// that lets a single manifest satisfy both sides.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { once } from 'node:events'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')
const outDir = resolve(packageDir, 'dist-smithery')
const staging = resolve(outDir, 'staging')

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} failed (exit ${r.status})`)
    process.exit(r.status ?? 1)
  }
}

async function listToolsFromDist(cwd) {
  const child = spawn(process.execPath, ['dist/server.js'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const responses = new Map()
  const pending = new Map()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => { stderr += c })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    let nl
    while ((nl = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, nl).replace(/\r$/, '')
      stdout = stdout.slice(nl + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.id !== undefined) {
        responses.set(message.id, message)
        pending.get(message.id)?.()
      }
    }
  })

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const responseFor = async (id) => {
    if (!responses.has(id)) await new Promise((r) => pending.set(id, r))
    const response = responses.get(id)
    if (!response || response.error) throw new Error(`tools/list introspection failed: ${JSON.stringify(response?.error ?? 'no response')}. stderr:\n${stderr}`)
    return response.result
  }

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'opentakeoff-smithery-build', version: '0.0.0' } } })
  await responseFor(1)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const listed = await responseFor(2)

  child.stdin.end()
  await once(child, 'close')
  return listed.tools
}

const pkg = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
if (!existsSync(resolve(packageDir, 'dist', 'server.js'))) {
  console.error('dist/server.js missing — run `npm run build` first.')
  process.exit(1)
}

const liveTools = await listToolsFromDist(packageDir)
if (!liveTools?.length) {
  console.error('tools/list introspection returned no tools — refusing to ship a capability-less manifest.')
  process.exit(1)
}
console.log(`introspected ${liveTools.length} tools from dist/server.js`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

cpSync(resolve(packageDir, 'dist'), resolve(staging, 'dist'), { recursive: true })
cpSync(resolve(packageDir, 'package.json'), resolve(staging, 'package.json'))
cpSync(resolve(packageDir, 'README.md'), resolve(staging, 'README.md'))

writeFileSync(resolve(staging, 'manifest.json'), JSON.stringify({
  manifest_version: '0.2',
  name: pkg.name,
  display_name: 'OpenTakeoff',
  version: pkg.version,
  description: pkg.description,
  long_description: 'Construction takeoff for AI agents: load plan PDFs, browse the sheet set as resources, set and verify drawing scale, one-click room areas, measure, and export takeoff quantities with provenance. The same measuring engine as the OpenTakeoff web app.',
  author: { name: 'Kentucky AI', url: 'https://github.com/Kentucky-ai' },
  repository: { type: 'git', url: 'https://github.com/Kentucky-ai/opentakeoff' },
  homepage: 'https://opentakeoff.kentucky-ai.com',
  documentation: 'https://github.com/Kentucky-ai/opentakeoff/blob/main/mcp/README.md',
  license: pkg.license,
  keywords: ['construction', 'takeoff', 'estimating', 'blueprints', 'measurement'],
  // Non-spec: real inputSchema per tool, required by Smithery's registry,
  // rejected by the official mcpb validator. See file header.
  tools: liveTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  server: {
    type: 'node',
    entry_point: 'dist/server.js',
    mcp_config: { command: 'node', args: ['${__dirname}/dist/server.js'], env: {} },
  },
  compatibility: { runtimes: { node: '>=20' } },
}, null, 2) + '\n')

run('npm', ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], staging)

// Deliberately NOT `mcpb validate` — it would reject inputSchema. Pack with a
// plain zip instead (an .mcpb is just a zip with manifest.json at its root).
const bundlePath = resolve(outDir, `${pkg.name}.mcpb`)
run('zip', ['-q', '-r', '-X', bundlePath, 'manifest.json', 'package.json', 'README.md', 'dist', 'node_modules'], staging)

console.log(`\nbuilt ${bundlePath}`)
console.log(`publish: smithery mcp publish ${bundlePath} -n Kentucky-ai/opentakeoff`)
