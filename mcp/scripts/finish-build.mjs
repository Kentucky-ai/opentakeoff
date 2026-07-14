import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')
const output = resolve(packageDir, 'dist', 'server.js')

mkdirSync(dirname(output), { recursive: true })
copyFileSync(resolve(packageDir, 'bin.js'), output)

if (process.platform !== 'win32') {
  chmodSync(output, 0o755)
}
