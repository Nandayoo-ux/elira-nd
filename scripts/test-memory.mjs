import { test } from 'node:test'
import * as assert from 'node:assert'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const runtimeDir = path.resolve(process.cwd(), '.runtime')
const dbPath = path.resolve(runtimeDir, 'elara-memory.db')

// Delete db if exists for clean test
if (fs.existsSync(dbPath)) {
  try { fs.unlinkSync(dbPath) } catch (e) {}
}

import { apply as applyMemory } from '../plugins/elara-memory.ts'

test('ELARA Smart Memory Tests', async (t) => {
  const ctx = {
    _providers: {},
    provide(key, val) { this._providers[key] = val; this[key] = val },
    on() {},
  }
  
  applyMemory(ctx)
  const memory = ctx.memory

  await t.test('STORAGE 1-5: Create, Persist, Update, Delete', () => {
    const id = memory.remember('personal', 'User prefers casual Indonesian')
    assert.ok(id > 0)
    
    const mems = memory.list()
    assert.strictEqual(mems.length, 1)
    assert.strictEqual(mems[0].content, 'User prefers casual Indonesian')
    
    // Duplicate check
    const id2 = memory.remember('personal', 'User prefers casual Indonesian', 'system', 5)
    assert.strictEqual(id, id2) // Should reuse id
    
    const updated = memory.list()[0]
    assert.strictEqual(updated.importance, 5)
    
    const deleted = memory.forget(id)
    assert.ok(deleted)
    assert.strictEqual(memory.list().length, 0)
  })

  await t.test('RETRIEVAL 11-15: Relevance and Scoping', () => {
    memory.remember('personal', 'I love eating pizza', 'user')
    memory.remember('project', 'Project backend uses 9Router gateway', 'user')
    memory.remember('explicit', 'My secret key is 123', 'user') // Just for testing retrieval
    
    const r1 = memory.search('What does the backend use?')
    assert.ok(r1.length > 0)
    assert.ok(r1.some(m => m.content.includes('9Router')))
    
    const r2 = memory.search('What do I love eating?')
    assert.ok(r2.some(m => m.content.includes('pizza')))
    
    const r3 = memory.search('unrelated nonsense without keywords')
    assert.strictEqual(r3.length, 0) // Should retrieve nothing
  })

  await t.test('TOKEN OVERHEAD TEST 24: Bounded memory scaling', () => {
    // Insert 5000 memories
    memory._db.exec('BEGIN TRANSACTION')
    for (let i = 0; i < 5000; i++) {
       // Insert manually to bypass checks and speed up
       memory._db.prepare('INSERT INTO memories (type, content, importance, source, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?, ?)')
         .run('personal', `Random generated memory fact number ${i}`, 1, 'system', Date.now(), Date.now())
    }
    memory._db.exec('COMMIT')
    
    const total = memory._db.prepare('SELECT COUNT(*) as c FROM memories').get().c
    assert.ok(total >= 5000)
    
    const r = memory.search('pizza fact', 5) // max 5
    assert.ok(r.length <= 5) // Token overhead is bounded!
    
    const noKeywords = memory.search('halo bro') // common words < 3 chars
    assert.strictEqual(noKeywords.length, 0) 
  })
})
