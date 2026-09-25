import type { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import * as path from 'node:path'
import * as fs from 'node:fs'

export const name = 'elara-memory'
const UNATTRIBUTED_OWNER = '__elara_unattributed__'

export type MemoryType = 'personal' | 'project' | 'explicit'

export interface MemoryRecord {
  id: number
  owner: string
  type: MemoryType
  content: string
  importance: number
  source: string
  createdAt: number
  lastUsedAt: number
}

export interface MemoryService {
  remember(owner: string, type: MemoryType, content: string, source?: string, importance?: number): number
  forget(owner: string, id: number): boolean
  list(owner: string, limit?: number): MemoryRecord[]
  search(owner: string, query: string, limit?: number): MemoryRecord[]
  updateLastUsed(owner: string, id: number): void
  _db: DatabaseSync
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

function normalizeOwner(owner: string): string {
  if (typeof owner !== 'string') throw new Error('Memory owner must be a non-empty identifier')
  const value = owner.trim()
  if (!value || value.length > 255 || value === 'legacy' || value === UNATTRIBUTED_OWNER) {
    throw new Error('Memory owner must be a non-empty, attributed identifier')
  }
  return value
}

function extractKeywords(text: string): string[] {
  return [...new Set(
    text.toLocaleLowerCase('id-ID')
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(word => word.length >= 3),
  )]
}

export function apply(ctx: Context) {
  const rootDir = path.resolve(process.env.ELARA_ROOT || process.cwd())
  const configuredDb = process.env.ELARA_MEMORY_DB?.trim()
  const dbPath = configuredDb
    ? path.resolve(configuredDb)
    : path.resolve(rootDir, '.runtime', 'elara-memory.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL DEFAULT '__elara_unattributed__',
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER DEFAULT 1,
      source TEXT DEFAULT 'unknown',
      createdAt INTEGER NOT NULL,
      lastUsedAt INTEGER NOT NULL
    );
  `)

  const columns = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'owner')) {
    // Existing rows have no trustworthy attribution. This reserved owner
    // preserves them without assigning them to a guessed principal.
    db.exec("ALTER TABLE memories ADD COLUMN owner TEXT NOT NULL DEFAULT '__elara_unattributed__'")
  }
  // An earlier unpublished schema used a shared literal owner for old rows.
  // Keep those rows but make them inaccessible to normal principal queries.
  db.prepare("UPDATE memories SET owner = ? WHERE owner = 'legacy'").run(UNATTRIBUTED_OWNER)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_owner_rank
      ON memories(owner, importance DESC, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_owner_content
      ON memories(owner, content);
  `)

  const insertStmt = db.prepare(`
    INSERT INTO memories (owner, type, content, importance, source, createdAt, lastUsedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const deleteStmt = db.prepare('DELETE FROM memories WHERE owner = ? AND id = ?')
  const selectAllStmt = db.prepare(`
    SELECT * FROM memories WHERE owner = ?
    ORDER BY importance DESC, createdAt DESC LIMIT ?
  `)
  const updateLastUsedStmt = db.prepare('UPDATE memories SET lastUsedAt = ? WHERE owner = ? AND id = ?')
  const fetchAllStmt = db.prepare('SELECT * FROM memories WHERE owner = ?')
  const findDuplicateStmt = db.prepare('SELECT id FROM memories WHERE owner = ? AND content = ? LIMIT 1')
  const updateDuplicateStmt = db.prepare(`
    UPDATE memories SET type = ?, source = ?, importance = MAX(importance, ?), lastUsedAt = ?
    WHERE owner = ? AND id = ?
  `)

  const service: MemoryService = {
    _db: db,

    remember(owner, type, content, source = 'system', importance = 1) {
      const scopedOwner = normalizeOwner(owner)
      const safeContent = content.trim().slice(0, 1000)
      if (!safeContent) throw new Error('Memory content cannot be empty')
      const safeImportance = Math.max(1, Math.min(10, Math.trunc(importance)))
      const now = Date.now()
      const duplicate = findDuplicateStmt.get(scopedOwner, safeContent) as { id: number } | undefined
      if (duplicate) {
        updateDuplicateStmt.run(type, source, safeImportance, now, scopedOwner, duplicate.id)
        return duplicate.id
      }
      const result = insertStmt.run(scopedOwner, type, safeContent, safeImportance, source, now, now)
      return Number(result.lastInsertRowid)
    },

    forget(owner, id) {
      return deleteStmt.run(normalizeOwner(owner), id).changes > 0
    },

    list(owner, limit = 100) {
      const safeLimit = Math.max(1, Math.min(250, Math.trunc(limit)))
      return selectAllStmt.all(normalizeOwner(owner), safeLimit) as unknown as MemoryRecord[]
    },

    search(owner, query, limit = 5) {
      const keywords = extractKeywords(query)
      if (keywords.length === 0) return []
      const allMemories = fetchAllStmt.all(normalizeOwner(owner)) as unknown as MemoryRecord[]
      const now = Date.now()
      return allMemories
        .map(memory => {
          const words = extractKeywords(memory.content)
          let overlap = 0
          for (const keyword of keywords) {
            if (words.includes(keyword)) overlap += 2
            else if (words.some(word => word.length >= 4 && keyword.length >= 4
              && (word.includes(keyword) || keyword.includes(word)))) overlap += 1
          }
          if (overlap === 0) return { memory, score: 0 }
          const typeBoost = memory.type === 'explicit' ? 2 : memory.type === 'project' ? 1 : 0
          const recencyBoost = now - memory.lastUsedAt < 86_400_000 ? 1 : 0
          return { memory, score: overlap + typeBoost + Math.min(memory.importance, 5) * 0.5 + recencyBoost }
        })
        .filter(result => result.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(1, Math.min(20, Math.trunc(limit))))
        .map(result => result.memory)
    },

    updateLastUsed(owner, id) {
      updateLastUsedStmt.run(Date.now(), normalizeOwner(owner), id)
    },
  }

  ctx.provide('memory', service)
  ctx.effect(() => () => db.close())
  console.log('[ELARA] Memory service loaded')
}
