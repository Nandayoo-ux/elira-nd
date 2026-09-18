import type { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import * as path from 'node:path'
import * as fs from 'node:fs'

export const name = 'elara-memory'

export interface MemoryRecord {
  id: number
  type: 'personal' | 'project' | 'explicit'
  content: string
  importance: number
  source: string
  createdAt: number
  lastUsedAt: number
}

export interface MemoryService {
  remember(type: MemoryRecord['type'], content: string, source?: string, importance?: number): number
  forget(id: number): boolean
  list(limit?: number): MemoryRecord[]
  search(query: string, limit?: number): MemoryRecord[]
  updateLastUsed(id: number): void
  _db: DatabaseSync // Expose for tests
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

export function apply(ctx: Context) {
  const rootDir = process.cwd()
  const runtimeDir = path.resolve(rootDir, '.runtime')

  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true })
  }

  const dbPath = path.resolve(runtimeDir, 'elara-memory.db')
  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER DEFAULT 1,
      source TEXT DEFAULT 'unknown',
      createdAt INTEGER NOT NULL,
      lastUsedAt INTEGER NOT NULL
    );
  `)

  // Pre-compile statements
  const insertStmt = db.prepare(`
    INSERT INTO memories (type, content, importance, source, createdAt, lastUsedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const deleteStmt = db.prepare('DELETE FROM memories WHERE id = ?')
  const selectAllStmt = db.prepare('SELECT * FROM memories ORDER BY importance DESC, createdAt DESC LIMIT ?')
  const updateLastUsedStmt = db.prepare('UPDATE memories SET lastUsedAt = ? WHERE id = ?')
  const fetchAllStmt = db.prepare('SELECT * FROM memories')
  
  // Find duplicate based on exact content
  const findDuplicateStmt = db.prepare('SELECT id FROM memories WHERE content = ? LIMIT 1')
  // Update duplicate
  const updateDuplicateStmt = db.prepare('UPDATE memories SET importance = MAX(importance, ?), lastUsedAt = ? WHERE id = ?')

  function extractKeywords(text: string): string[] {
    return text.toLowerCase().split(/[^\w\d]+/).filter(w => w.length >= 3)
  }

  const service: MemoryService = {
    _db: db,
    remember(type, content, source = 'system', importance = 1) {
      const now = Date.now()
      
      // Prevent duplicates
      const dup = findDuplicateStmt.get(content) as { id: number } | undefined
      if (dup) {
        updateDuplicateStmt.run(importance, now, dup.id)
        return dup.id
      }
      
      // Enforce limits
      const maxContentLen = 1000
      let safeContent = content.trim()
      if (safeContent.length > maxContentLen) {
        safeContent = safeContent.substring(0, maxContentLen) + '...'
      }
      
      const result = insertStmt.run(type, safeContent, importance, source, now, now)
      return result.lastInsertRowid as number
    },
    
    forget(id) {
      const result = deleteStmt.run(id)
      return result.changes > 0
    },
    
    list(limit = 100) {
      return selectAllStmt.all(limit) as MemoryRecord[]
    },
    
    search(query, limit = 5) {
      if (!query.trim()) return []
      
      const keywords = extractKeywords(query)
      const allMemories = fetchAllStmt.all() as MemoryRecord[]
      
      const scored = allMemories.map(mem => {
        const memWords = extractKeywords(mem.content)
        const memWordsSet = new Set(memWords)
        
        let overlap = 0
        for (const kw of keywords) {
          if (memWordsSet.has(kw)) overlap += 2 // exact match bonus
          else {
            // Partial match for longer words
            for (const mw of memWords) {
               if (mw.length >= 4 && kw.length >= 4 && (mw.includes(kw) || kw.includes(mw))) {
                 overlap += 1;
                 break;
               }
            }
          }
        }
        
        let score = overlap
        
        if (overlap > 0) {
          // Base relevance boosts
          if (mem.type === 'explicit') score += 2
          else if (mem.type === 'project') score += 1
          
          score += Math.min(mem.importance, 5) * 0.5
          
          // Recency boost (last 24 hours gets +1, drops off after)
          const ageHours = (Date.now() - mem.lastUsedAt) / (1000 * 60 * 60)
          if (ageHours < 24) score += 1
        }

        return { mem, score }
      })
      
      // Filter those with actual overlap or explicitly important
      const relevant = scored.filter(s => s.score > 0 || keywords.length === 0)
      
      relevant.sort((a, b) => b.score - a.score)
      
      return relevant.slice(0, limit).map(s => s.mem)
    },
    
    updateLastUsed(id) {
      updateLastUsedStmt.run(Date.now(), id)
    }
  }

  ctx.provide('memory', service)

  ctx.on('dispose', () => {
    db.close()
  })

  console.log('[ELARA] Memory service loaded')
}
