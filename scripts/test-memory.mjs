import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply as applyMemory } from '../plugins/elara-memory.ts'

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-memory-suite-'))
const previousDb = process.env.ELARA_MEMORY_DB
process.env.ELARA_MEMORY_DB = path.join(fixtureRoot, 'memory.db')

after(() => {
  if (previousDb === undefined) delete process.env.ELARA_MEMORY_DB
  else process.env.ELARA_MEMORY_DB = previousDb
  const target = path.resolve(fixtureRoot)
  assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(target, { recursive: true, force: true })
})

function context() {
  return {
    provide(key, value) { this[key] = value },
    effect(setup) { this.dispose = setup() },
  }
}

test('ownerless legacy rows remain preserved but inaccessible after migration', () => {
  const db = new DatabaseSync(process.env.ELARA_MEMORY_DB)
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, content TEXT NOT NULL,
    importance INTEGER DEFAULT 1, source TEXT DEFAULT 'unknown',
    createdAt INTEGER NOT NULL, lastUsedAt INTEGER NOT NULL
  )`)
  db.prepare('INSERT INTO memories (type, content, importance, source, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('explicit', 'legacy synthetic note', 5, 'fixture', 1, 1)
  db.close()

  const ctx = context()
  applyMemory(ctx)
  try {
    const legacy = ctx.memory._db.prepare('SELECT id, owner, content FROM memories WHERE id = 1').get()
    assert.equal(legacy.content, 'legacy synthetic note')
    assert.equal(legacy.owner, '__elara_unattributed__')
    for (const owner of ['principal-a', 'principal-b']) {
      assert.deepEqual(ctx.memory.list(owner), [])
      assert.deepEqual(ctx.memory.search(owner, 'legacy'), [])
      assert.equal(ctx.memory.forget(owner, 1), false)
    }
    assert.throws(() => ctx.memory.list('legacy'), /owner/i)
    assert.throws(() => ctx.memory.list('__elara_unattributed__'), /owner/i)
  } finally {
    ctx.dispose()
  }
})

test('remember, recall, update, and delete stay within one principal', () => {
  const ctx = context()
  applyMemory(ctx)
  try {
    const memory = ctx.memory
    const a = memory.remember('principal-a', 'personal', 'pizza for principal a', 'user', 3)
    const b = memory.remember('principal-b', 'personal', 'pizza for principal a', 'user', 8)
    assert.notEqual(a, b, 'duplicate detection must be scoped to owner')
    assert.equal(memory.remember('principal-a', 'personal', 'pizza for principal a', 'user', 9), a)
    assert.equal(memory.list('principal-a').length, 1)
    assert.equal(memory.list('principal-b').length, 1)
    assert.equal(memory.search('principal-a', 'pizza')[0].id, a)
    assert.equal(memory.search('principal-b', 'pizza')[0].id, b)
    const before = memory._db.prepare('SELECT lastUsedAt FROM memories WHERE id = ?').get(b).lastUsedAt
    memory.updateLastUsed('principal-a', b)
    assert.equal(memory._db.prepare('SELECT lastUsedAt FROM memories WHERE id = ?').get(b).lastUsedAt, before)
    assert.equal(memory.forget('principal-a', b), false)
    assert.equal(memory.forget('principal-b', b), true)
    assert.equal(memory.list('principal-b').length, 0)
    assert.ok(memory.list('principal-a').some(row => row.id === a))
  } finally {
    ctx.dispose()
  }
})

test('previous shared legacy owner is quarantined without data loss', () => {
  const dbPath = path.join(fixtureRoot, 'prior-schema.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY, owner TEXT NOT NULL DEFAULT 'legacy', type TEXT NOT NULL,
    content TEXT NOT NULL, importance INTEGER, source TEXT,
    createdAt INTEGER NOT NULL, lastUsedAt INTEGER NOT NULL
  )`)
  db.prepare('INSERT INTO memories (owner, type, content, importance, source, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('legacy', 'explicit', 'old shared fixture', 1, 'fixture', 1, 1)
  db.prepare('INSERT INTO memories (owner, type, content, importance, source, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('principal-a', 'personal', 'attributed fixture', 2, 'fixture', 2, 2)
  db.close()
  const original = process.env.ELARA_MEMORY_DB
  process.env.ELARA_MEMORY_DB = dbPath
  const ctx = context()
  try {
    applyMemory(ctx)
    assert.equal(ctx.memory._db.prepare('SELECT owner FROM memories WHERE id = 1').get().owner, '__elara_unattributed__')
    assert.deepEqual(ctx.memory.search('principal-a', 'shared'), [])
    assert.equal(ctx.memory.search('principal-a', 'attributed')[0].content, 'attributed fixture')
  } finally {
    ctx.dispose?.()
    process.env.ELARA_MEMORY_DB = original
  }
})

test('search results stay bounded with many records and never include another owner', () => {
  const ctx = context()
  applyMemory(ctx)
  try {
    const insert = ctx.memory._db.prepare(`INSERT INTO memories
      (owner, type, content, importance, source, createdAt, lastUsedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    ctx.memory._db.exec('BEGIN')
    for (let index = 0; index < 5_000; index++) {
      insert.run('principal-a', 'personal', `synthetic pizza fact ${index}`, 1, 'fixture', index, index)
    }
    insert.run('principal-b', 'explicit', 'synthetic pizza secret for b', 10, 'fixture', 1, 1)
    ctx.memory._db.exec('COMMIT')
    const results = ctx.memory.search('principal-a', 'pizza fact', 5)
    assert.equal(results.length, 5)
    assert.ok(results.every(row => row.owner === 'principal-a'))
    assert.deepEqual(ctx.memory.search('principal-a', 'secret'), [])
  } finally {
    ctx.dispose()
  }
})
