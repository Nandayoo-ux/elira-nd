import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md',
  'docs/UPSTREAM.md',
  'plugins/elara-core.ts',
  'plugins/windows-tools.ts',
  'scripts/bootstrap-local.ps1',
  'scripts/run-local.ps1',
  'profiles/local/cordis.patch.yml',
]

const missing = required.filter((path) => !existsSync(join(root, path)))
if (missing.length) {
  console.error('Missing:', missing.join(', '))
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.name !== 'elara-ai') throw new Error('Unexpected package name')
if (pkg.packageManager !== 'pnpm@11.7.0') throw new Error('Unexpected pnpm pin')

const core = readFileSync(join(root, 'plugins/elara-core.ts'), 'utf8')
const win = readFileSync(join(root, 'plugins/windows-tools.ts'), 'utf8')
const patch = readFileSync(join(root, 'profiles/local/cordis.patch.yml'), 'utf8')

for (const marker of [
  "export const name = 'elara-core'",
  "export const inject = ['tools']",
  'defineTool',
  'elara_about',
]) {
  if (!core.includes(marker)) throw new Error(`Core plugin missing marker: ${marker}`)
}

for (const marker of [
  "export const name = 'elara-windows-tools'",
  "export const inject = ['tools']",
  'elara_windows_status',
  'powershell.exe',
]) {
  if (!win.includes(marker)) throw new Error(`Windows plugin missing marker: ${marker}`)
}

for (const marker of [
  '__ELARA_CORE_PLUGIN_PATH__',
  '__ELARA_WINDOWS_PLUGIN_PATH__',
]) {
  if (!patch.includes(marker)) throw new Error(`Patch missing bootstrap marker: ${marker}`)
}

console.log('ELARA scaffold verification: PASS')
console.log('Static validation only: upstream DSH runtime was not built in this environment.')
