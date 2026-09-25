import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { auditId, type AuditRecord } from '../packages/policy/audit.ts'
import type { SessionAdmission, StopStatus, TrustedSessionContext } from '../packages/policy/contracts.ts'
import type {} from './elara-access.ts'

export const name = 'elara-control'
export const inject = ['agents', 'access']

export interface ControlService {
  admit(context: TrustedSessionContext, sessionId: string): SessionAdmission
  assertCurrent(admission: SessionAdmission): void
  requestStop(context: TrustedSessionContext, sessionId: string): StopStatus
  getStopStatus(context: TrustedSessionContext, stopRequestId: string): StopStatus
  listAudit(context: TrustedSessionContext, sessionId: string, cursor?: number, limit?: number): AuditRecord[]
  assertAgentCurrent(agent: Agent | undefined): void
  runDirect<T>(admission: SessionAdmission, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  trackLocal<T>(agent: Agent | undefined, operation: Promise<T>): Promise<T>
  markUnconfirmed(agent: Agent | undefined): void
  markDirectUnconfirmed(admission: SessionAdmission): void
  health(): { audit: 'healthy' | 'degraded' }
}

declare module '@deepseek-ai/cordis' { interface Context { control: ControlService } }

export function apply(ctx: Context) {
  const generations = new Map<string, number>()
  const active = new Map<string, StopStatus>()
  const stops = new Map<string, StopStatus>()
  const stoppingAgents = new Set<Agent>()
  const localOperations = new Map<string, Set<Promise<unknown>>>()
  const directOperations = new Map<string, Set<{ controller: AbortController; settlement: Promise<unknown> }>>()
  const unconfirmed = new Set<string>()
  let disposed = false

  function authorize(context: TrustedSessionContext, sessionId: string): void {
    const binding = ctx.access.bindingForSession(sessionId)
    if (!binding || binding.principalId !== context.principalId || binding.originChannel !== context.originChannel) {
      throw new Error('SESSION_NOT_FOUND')
    }
  }
  function currentStop(sessionId: string): StopStatus | undefined {
    const live = active.get(sessionId)
    if (live) return live
    const recovered = ctx.access.latestStopStatus(sessionId)
    if (recovered?.outcome === 'unconfirmed') {
      active.set(sessionId, recovered)
      stops.set(recovered.id, recovered)
      return recovered
    }
    return undefined
  }
  function rootFor(agent: Agent | undefined): string | undefined {
    if (!agent) return undefined
    for (const rootId of active.keys()) {
      const root = ctx.agents.list().find(candidate => String(candidate.id) === rootId)
      if (root && (agent === root || ctx.agents.isOwnedBy(agent.id, root))) return rootId
    }
    const ancestors = ctx.agents.list().filter(candidate => (candidate === agent
      || ctx.agents.isOwnedBy(agent.id, candidate)) && ctx.access.bindingForSession(String(candidate.id)))
    const root = ancestors.find(candidate => !ancestors.some(other => other !== candidate
      && ctx.agents.isOwnedBy(candidate.id, other)))
    return root ? String(root.id) : undefined
  }
  function observe(status: StopStatus, eventType: 'stop_requested' | 'stop_settled', reasonCode: string) {
    const binding = ctx.access.bindingForSession(status.sessionId)!
    ctx.access.recordAudit({ schemaVersion: 1, operationId: status.id, stopRequestId: status.id,
      principalId: binding.principalId, sessionId: binding.sessionId, originChannel: binding.originChannel,
      eventType, reasonCode, outcome: status.outcome, createdAt: Date.now(),
      durationMs: status.settledAt === undefined ? undefined : status.settledAt - status.requestedAt })
  }
  const service: ControlService = {
    admit(context, sessionId) {
      if (disposed) throw new Error('CONTROL_DISPOSED')
      authorize(context, sessionId)
      if (currentStop(sessionId)?.outcome === 'stopping') throw new Error('SESSION_STOPPING')
      if (currentStop(sessionId)?.outcome === 'unconfirmed') throw new Error('SESSION_UNCONFIRMED')
      active.delete(sessionId)
      unconfirmed.delete(sessionId)
      return { sessionId, generation: generations.get(sessionId) ?? 0, operationId: auditId() }
    },
    assertCurrent(admission) {
      if ((generations.get(admission.sessionId) ?? 0) !== admission.generation) throw new Error('SESSION_STOPPED')
      if (active.get(admission.sessionId)?.outcome === 'stopping') throw new Error('SESSION_STOPPING')
      if (active.get(admission.sessionId)?.outcome === 'unconfirmed') throw new Error('SESSION_UNCONFIRMED')
    },
    requestStop(context, sessionId) {
      if (disposed) throw new Error('CONTROL_DISPOSED')
      authorize(context, sessionId)
      const existing = currentStop(sessionId)
      if (existing) return { ...existing }
      const root = ctx.agents.list().find(candidate => String(candidate.id) === sessionId)
      const agents = root ? [root, ...ctx.agents.list().filter(agent => agent !== root && ctx.agents.isOwnedBy(agent.id, root))] : []
      const direct = [...(directOperations.get(sessionId) ?? [])]
      const pendingLocal = [...(localOperations.get(sessionId) ?? [])]
      const status: StopStatus = { id: auditId(), sessionId,
        outcome: agents.length || direct.length || pendingLocal.length ? 'stopping' : 'idle', requestedAt: Date.now() }
      // The generation fence is installed before the first asynchronous boundary.
      generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1)
      active.set(sessionId, status)
      stops.set(status.id, status)
      try { observe(status, 'stop_requested', 'USER_STOP') }
      catch { /* Cancellation must continue even if durable storage is unavailable. */ }
      const ids = agents.map(agent => String(agent.id))
      ctx.access.cancelSessionApprovals([sessionId, ...ids])
      ctx.access.revokeSessionGrants([sessionId, ...ids], status.id)
      for (const entry of direct) entry.controller.abort()
      if (status.outcome === 'idle') {
        status.settledAt = Date.now()
        try { observe(status, 'stop_settled', 'NO_LIVE_AGENT') } catch { /* degraded */ }
        return { ...status }
      }
      for (const agent of agents) {
        stoppingAgents.add(agent)
        agent.cancel({ kind: 'user' })
      }
      // This continuation runs outside DSH lifecycle listeners.
      const settlement = Promise.allSettled([...agents.map(agent => agent.whenIdle()), ...pendingLocal,
        ...direct.map(entry => entry.settlement)])
      const deadline = new Promise<'timeout'>(resolve => {
        const timer = setTimeout(() => resolve('timeout'), 15_000)
        timer.unref()
        void settlement.then(() => clearTimeout(timer))
      })
      void Promise.race([settlement, deadline]).then(result => {
        if (disposed) return
        status.outcome = result === 'timeout' || unconfirmed.has(sessionId)
          || (Array.isArray(result) && result.slice(0, agents.length).some(item => item.status === 'rejected')) ? 'unconfirmed' : 'stopped'
        status.settledAt = Date.now()
        for (const agent of agents) stoppingAgents.delete(agent)
        try { observe(status, 'stop_settled', status.outcome === 'stopped' ? 'DSH_IDLE' : 'SETTLEMENT_UNCONFIRMED') }
        catch { /* degraded */ }
      })
      void settlement.then(results => {
        if (disposed || status.outcome !== 'unconfirmed' || unconfirmed.has(sessionId)
          || results.slice(0, agents.length).some(result => result.status === 'rejected')) return
        status.outcome = 'stopped'
        status.settledAt = Date.now()
        try { observe(status, 'stop_settled', 'LATE_SETTLEMENT_CONFIRMED') } catch { /* degraded */ }
      })
      return { ...status }
    },
    getStopStatus(context, id) {
      const status = stops.get(id) ?? ctx.access.stopStatus(id)?.status
      if (!status) throw new Error('STOP_NOT_FOUND')
      authorize(context, status.sessionId)
      return { ...status }
    },
    listAudit(context, sessionId, cursor, limit) {
      authorize(context, sessionId)
      return ctx.access.listAudit(context.principalId, context.originChannel, sessionId, cursor, limit)
    },
    assertAgentCurrent(agent) {
      if (agent && stoppingAgents.has(agent)) throw new Error('SESSION_STOPPING')
      const root = rootFor(agent)
      if (root && ['stopping', 'unconfirmed'].includes(currentStop(root)?.outcome ?? '')) throw new Error('SESSION_STOPPING')
    },
    runDirect(admission, operation) {
      service.assertCurrent(admission)
      const controller = new AbortController()
      let resolveSettlement!: () => void
      const settlement = new Promise<void>(resolve => { resolveSettlement = resolve })
      const entry = { controller, settlement }
      let pending = directOperations.get(admission.sessionId)
      if (!pending) { pending = new Set(); directOperations.set(admission.sessionId, pending) }
      pending.add(entry)
      const finish = () => {
        pending!.delete(entry)
        if (pending!.size === 0) directOperations.delete(admission.sessionId)
        resolveSettlement()
      }
      try {
        service.assertCurrent(admission)
        return Promise.resolve(operation(controller.signal)).catch(error => {
          if (error instanceof Error && error.message.includes('PROCESS_TERMINATION_UNCONFIRMED')) {
            unconfirmed.add(admission.sessionId)
          }
          throw error
        }).finally(finish)
      } catch (error) {
        finish()
        return Promise.reject(error)
      }
    },
    trackLocal(agent, operation) {
      const root = rootFor(agent)
      if (!root) return operation
      let pending = localOperations.get(root)
      if (!pending) { pending = new Set(); localOperations.set(root, pending) }
      pending.add(operation)
      void operation.catch(error => {
        if (error instanceof Error && error.message.includes('PROCESS_TERMINATION_UNCONFIRMED')) unconfirmed.add(root)
      }).finally(() => {
        pending!.delete(operation)
        if (pending!.size === 0) localOperations.delete(root)
      })
      return operation
    },
    markUnconfirmed(agent) { const root = rootFor(agent); if (root) unconfirmed.add(root) },
    markDirectUnconfirmed(admission) { unconfirmed.add(admission.sessionId) },
    health() { return { audit: ctx.access.auditHealthy() ? 'healthy' : 'degraded' } },
  }
  ctx.provide('control', service)
  ctx.access.setStopGuard(service.assertAgentCurrent)
  ctx.access.setScopeResolver(rootFor)
  ctx.on('agent/created', ({ agent }) => {
    const root = rootFor(agent)
    if (root && active.get(root)?.outcome === 'stopping') agent.cancel({ kind: 'user' })
    return undefined
  })
  ctx.effect(() => () => { disposed = true; for (const status of active.values()) {
    if (status.outcome === 'stopping') { status.outcome = 'unconfirmed'; status.settledAt = Date.now() }
  } })
}
