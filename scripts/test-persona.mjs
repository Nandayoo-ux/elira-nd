import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const fixture = fs.readFileSync(new URL('../tests/fixtures/runtime/agent-presets/elara/agent.cordis.yml', import.meta.url), 'utf8')
const core = fs.readFileSync(new URL('../plugins/elara-core.ts', import.meta.url), 'utf8')

test('the synthetic ELARA preset provides one identity and core does not duplicate it', () => {
  assert.equal((fixture.match(/You are ELARA/g) || []).length, 1)
  assert.equal((core.match(/You are ELARA/g) || []).length, 0)
})
