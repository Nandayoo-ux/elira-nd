import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ACCESS_SCHEMA_VERSION, type DecisionRecord, type OriginChannel, type SessionBinding } from './contracts.ts'

export class AccessStore {
  readonly db: DatabaseSync

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_bindings (
        session_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        origin_channel TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policy_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        principal_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        target_device_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_policy_decisions_session_time
        ON policy_decisions(session_id, created_at DESC);
    `)
  }

  bindingFor(sessionId: string): SessionBinding | undefined {
    const row = this.db.prepare(`
      SELECT session_id, principal_id, origin_channel, created_at, schema_version
      FROM session_bindings WHERE session_id = ?
    `).get(sessionId) as any
    if (!row) return undefined
    return {
      sessionId: row.session_id,
      principalId: row.principal_id,
      originChannel: row.origin_channel as OriginChannel,
      createdAt: row.created_at,
      schemaVersion: row.schema_version,
    }
  }

  bindSession(sessionId: string, principalId: string, originChannel: OriginChannel): SessionBinding {
    const existing = this.bindingFor(sessionId)
    if (existing) {
      if (existing.principalId !== principalId || existing.originChannel !== originChannel) {
        throw new Error('SESSION_OWNER_CONFLICT')
      }
      return existing
    }
    const binding: SessionBinding = {
      sessionId,
      principalId,
      originChannel,
      createdAt: Date.now(),
      schemaVersion: ACCESS_SCHEMA_VERSION,
    }
    try {
      this.db.prepare(`
        INSERT INTO session_bindings (session_id, principal_id, origin_channel, created_at, schema_version)
        VALUES (?, ?, ?, ?, ?)
      `).run(binding.sessionId, binding.principalId, binding.originChannel, binding.createdAt, binding.schemaVersion)
    } catch {
      const raced = this.bindingFor(sessionId)
      if (!raced || raced.principalId !== principalId || raced.originChannel !== originChannel) {
        throw new Error('SESSION_OWNER_CONFLICT')
      }
      return raced
    }
    return binding
  }

  record(record: DecisionRecord): void {
    this.db.prepare(`
      INSERT INTO policy_decisions (
        principal_id, session_id, capability_id, target_device_id,
        decision, reason_code, policy_version, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.principalId, record.sessionId, record.capabilityId, record.targetDeviceId,
      record.decision, record.reasonCode, record.policyVersion, record.source, record.createdAt,
    )
  }

  close(): void {
    this.db.close()
  }
}
