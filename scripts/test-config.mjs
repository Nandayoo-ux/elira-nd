import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const localPatch = fs.readFileSync(new URL('../profiles/local/cordis.patch.yml', import.meta.url), 'utf8')
const templatePatch = fs.readFileSync(new URL('../profiles/cordis.patch.template.yml', import.meta.url), 'utf8')

function assertPatchShape(contents, label) {
  assert.equal((contents.match(/^- insert:/gm) || []).length, 1, `${label} must contain one insert block`)
  assert.doesNotMatch(contents, /^\s*- modify:/m, `${label} uses unsupported modify syntax`)
  assert.match(contents, /^- id: web-search-deepseek$/m)
  assert.match(contents, /^- id: agent-presets$/m)
  assert.match(contents, /^\s+default: elara$/m)
  assert.match(contents, /^\s+apiKeyEnv: 'ROUTER9_API_KEY'$/m)
}

test('local Cordis patch keeps custom inserts and direct overrides separate', () => {
  assertPatchShape(localPatch, 'local patch')
  for (const id of [
    'elara-core', 'elara-memory', 'elara-windows-tools',
    'whatsapp-baileys', 'dashboard-api', 'companion-api',
  ]) {
    assert.equal((localPatch.match(new RegExp(`^- id: ${id}$`, 'gm')) || []).length, 0)
    assert.equal((localPatch.match(new RegExp(`^    - id: ${id}$`, 'gm')) || []).length, 1)
  }
})

test('portable Cordis patch template contains every plugin placeholder', () => {
  assertPatchShape(templatePatch, 'patch template')
  for (const placeholder of [
    '__ELARA_CORE_PLUGIN_PATH__', '__ELARA_MEMORY_PLUGIN_PATH__',
    '__ELARA_WINDOWS_PLUGIN_PATH__', '__ELARA_WHATSAPP_PLUGIN_PATH__',
    '__ELARA_DASHBOARD_PLUGIN_PATH__', '__ELARA_COMPANION_PLUGIN_PATH__',
  ]) {
    assert.equal((templatePatch.match(new RegExp(placeholder, 'g')) || []).length, 1)
  }
})
