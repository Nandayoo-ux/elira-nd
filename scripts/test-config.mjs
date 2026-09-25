import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const template = fs.readFileSync(new URL('../profiles/cordis.patch.template.yml', import.meta.url), 'utf8')
const plugins = [
  ['elara-access', '__ELARA_ACCESS_PLUGIN_PATH__'],
  ['elara-core', '__ELARA_CORE_PLUGIN_PATH__'],
  ['elara-memory', '__ELARA_MEMORY_PLUGIN_PATH__'],
  ['elara-windows-tools', '__ELARA_WINDOWS_PLUGIN_PATH__'],
  ['whatsapp-baileys', '__ELARA_WHATSAPP_PLUGIN_PATH__'],
  ['dashboard-api', '__ELARA_DASHBOARD_PLUGIN_PATH__'],
  ['companion-api', '__ELARA_COMPANION_PLUGIN_PATH__'],
]

function assertPatchShape(contents) {
  assert.equal((contents.match(/^- insert:/gm) || []).length, 1)
  assert.doesNotMatch(contents, /^\s*- modify:/m)
  assert.match(contents, /^- id: web-search-deepseek$/m)
  assert.match(contents, /^- id: agent-presets$/m)
  assert.match(contents, /^\s+default: elara$/m)
  assert.match(contents, /^\s+apiKeyEnv: 'ROUTER9_API_KEY'$/m)
}

test('portable Cordis template keeps custom inserts and direct overrides separate', () => {
  assertPatchShape(template)
  for (const [id, placeholder] of plugins) {
    assert.equal((template.match(new RegExp(`^    - id: ${id}$`, 'gm')) || []).length, 1)
    assert.equal((template.match(new RegExp(`^- id: ${id}$`, 'gm')) || []).length, 0)
    assert.equal(template.split(placeholder).length - 1, 1)
  }
})

test('synthetic path substitution retains exactly one access plugin', () => {
  let generated = template
  for (const [id, placeholder] of plugins) {
    generated = generated.replace(placeholder, `C:/synthetic-fixture/${id}.ts`)
  }
  assertPatchShape(generated)
  assert.doesNotMatch(generated, /__ELARA_[A-Z_]+__/)
  assert.equal((generated.match(/^    - id: elara-access$/gm) || []).length, 1)
})
