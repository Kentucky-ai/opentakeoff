// Build the MCP Bundle (.mcpb) — the one-click Claude Desktop install artifact.
// Stages the published-package surface (dist/ + package.json + README) with its
// production dependencies and an MCPB manifest, then packs it with the official
// CLI. Native optionals are deliberately excluded (--omit=optional) so the
// bundle stays platform-neutral: every tool and text/metadata resource works
// everywhere; the sheet-image resource degrades gracefully where the optional
// canvas binary is absent, exactly as on any canvas-less install.
//
// Run via: npm run mcpb   (builds dist first; output in dist-mcpb/)
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')
const outDir = resolve(packageDir, 'dist-mcpb')
const staging = resolve(outDir, 'staging')

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} failed (exit ${r.status})`)
    process.exit(r.status ?? 1)
  }
}

const pkg = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
if (!existsSync(resolve(packageDir, 'dist', 'server.js'))) {
  console.error('dist/server.js missing — run `npm run build` first (or use `npm run mcpb`).')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

// The published-package surface, verbatim.
cpSync(resolve(packageDir, 'dist'), resolve(staging, 'dist'), { recursive: true })
cpSync(resolve(packageDir, 'package.json'), resolve(staging, 'package.json'))
cpSync(resolve(packageDir, 'README.md'), resolve(staging, 'README.md'))

// The MCPB manifest — version tracks package.json, always.
writeFileSync(resolve(staging, 'manifest.json'), JSON.stringify({
  manifest_version: '0.2',
  name: pkg.name,
  display_name: 'OpenTakeoff',
  version: pkg.version,
  description: pkg.description,
  long_description: 'Construction takeoff for AI agents: load plan PDFs, browse the sheet set as resources, set and verify drawing scale, one-click room areas, measure, and export takeoff quantities with provenance. The same measuring engine as the OpenTakeoff web app.',
  author: { name: 'Kentucky AI', url: 'https://github.com/Kentucky-ai' },
  repository: { type: 'git', url: 'https://github.com/Kentucky-ai/opentakeoff' },
  homepage: 'https://opentakeoff.netlify.app',
  documentation: 'https://github.com/Kentucky-ai/opentakeoff/blob/main/mcp/README.md',
  license: pkg.license,
  keywords: ['construction', 'takeoff', 'estimating', 'blueprints', 'measurement'],
  server: {
    type: 'node',
    entry_point: 'dist/server.js',
    mcp_config: { command: 'node', args: ['${__dirname}/dist/server.js'], env: {} },
  },
  compatibility: { runtimes: { node: '>=20' } },
}, null, 2) + '\n')

// Production dependencies only, no native optionals, no lifecycle scripts.
run('npm', ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], staging)

run('npx', ['-y', '@anthropic-ai/mcpb', 'validate', resolve(staging, 'manifest.json')], packageDir)
run('npx', ['-y', '@anthropic-ai/mcpb', 'pack', staging, resolve(outDir, `${pkg.name}.mcpb`)], packageDir)

console.log(`\nbuilt ${resolve(outDir, `${pkg.name}.mcpb`)}`)
