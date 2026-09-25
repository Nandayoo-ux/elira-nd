import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { ApprovalInbox, type PendingApproval } from '../packages/policy/approvals.ts'
import { loadAccessConfig, type AccessConfigState } from '../packages/policy/config.ts'
import {
  AccessDeniedError,
  type DeviceKind,
  type ExecutionContext,
  type OriginChannel,
  type PolicyDecision,
  type Principal,
  type SessionBinding,
} from '../packages/policy/contracts.ts'
import {
  assessFilesystemTool,
  capabilityById,
  capabilityForTool,
  evaluatePolicy,
} from '../packages/policy/evaluate.ts'
import { AccessStore } from '../packages/policy/store.ts'

export const name = 'elara-access'
export const inject = ['tools', 'agents', 'approval']

export interface DirectExecutionRequest {
  principalId: string
  sessionId: string
  originChannel: OriginChannel
  targetDeviceId: string
  source: string
  capabilityId: string
  signal?: AbortSignal
}

export interface AccessService {
  readonly state: AccessConfigState
  principalForAlias(channel: OriginChannel, alias: string): Principal | undefined
  dashboardPrincipal(): Principal | undefined
  bindRootSession(sessionId: string, principalId: string, originChannel: OriginChannel): SessionBinding
  bindingForSession(sessionId: string): SessionBinding | undefined
  assertSessionOwner(sessionId: string, principalId: string): SessionBinding
  defaultTarget(channel: OriginChannel): string
  deviceKind(deviceId: string): DeviceKind | undefined
  contextForAgent(agent: Agent | undefined, source: string, signal?: AbortSignal): ExecutionContext | undefined
  decideDirect(request: DirectExecutionRequest): PolicyDecision
  executeDirect<T>(request: DirectExecutionRequest, operation: () => Promise<T>): Promise<T>
  pendingApprovals(principalId: string, channel: OriginChannel): PendingApproval[]
  answerApproval(id: string, principalId: string, channel: OriginChannel, allow: boolean): boolean
  onApproval(listener: (view: PendingApproval) => void | Promise<void>): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    access: AccessService
  }
}

function denialText(decision: PolicyDecision): string {
  return `ELARA access denied (${decision.reasonCode})`
}

export function apply(ctx: Context) {
  const rootDir = path.resolve(process.env.ELARA_ROOT || process.cwd())
  const state = loadAccessConfig(rootDir, process.env.ELARA_ACCESS_CONFIG)
  const dbPath = path.resolve(process.env.ELARA_CONTROL_DB?.trim() || path.join(rootDir, '.runtime', 'elara-control.db'))
  const store = new AccessStore(dbPath)
  const inbox = new ApprovalInbox()
  const grants = new Map<ToolExecution['token'], string>()
  const ownRequests = new WeakMap<ApprovalRequest, { exec: Readonly<ToolExecution>, accepted: boolean }>()
  const liveExecutions = new Map<ToolExecution['token'], Readonly<ToolExecution>>()
  const aliasIndex = new Map<string, Principal>()
  for (const principal of state.config?.principals ?? []) {
    for (const [channel, aliases] of Object.entries(principal.channelAliases)) {
      for (const alias of aliases ?? []) aliasIndex.set(`${channel}\u0000${alias}`, principal)
    }
  }

  function principalForAgent(agent: Agent | undefined, visited = new Set<string>()): Principal | undefined {
    if (!agent) return undefined
    const sessionId = String(agent.id)
    if (visited.has(sessionId)) return undefined
    visited.add(sessionId)
    const direct = store.bindingFor(sessionId)
    if (direct) return state.config?.principals.find(principal => principal.id === direct.principalId && principal.enabled)
    for (const possibleParent of ctx.agents.list()) {
      if (possibleParent === agent) continue
      if (ctx.agents.isOwnedBy(agent.id, possibleParent)) return principalForAgent(possibleParent, visited)
    }
    return undefined
  }

  function bindingForAgent(agent: Agent | undefined): SessionBinding | undefined {
    if (!agent) return undefined
    const direct = store.bindingFor(String(agent.id))
    if (direct) return direct
    for (const possibleParent of ctx.agents.list()) {
      if (possibleParent === agent) continue
      if (ctx.agents.isOwnedBy(agent.id, possibleParent)) return bindingForAgent(possibleParent)
    }
    return undefined
  }

  function targetFor(binding: SessionBinding | undefined): string {
    if (!binding) return 'unbound'
    return state.config?.authorities.channelDefaultDeviceIds[binding.originChannel] || 'unconfigured'
  }

  function record(context: ExecutionContext, decision: PolicyDecision): void {
    store.record({
      principalId: context.principalId || 'unbound',
      sessionId: context.sessionId || 'unbound',
      capabilityId: decision.capability.id,
      targetDeviceId: context.targetDeviceId || 'unbound',
      decision: decision.outcome,
      reasonCode: decision.reasonCode,
      policyVersion: decision.policyVersion,
      source: context.source.slice(0, 96),
      createdAt: Date.now(),
    })
  }

  function decisionForTool(exec: Readonly<ToolExecution>, shouldRecord: boolean): PolicyDecision {
    const binding = bindingForAgent(exec.agent)
    const principal = principalForAgent(exec.agent)
    const baseCapability = capabilityForTool(exec.name, exec.arguments)
    const selectedDeviceId = baseCapability.requiresDevice ? targetFor(binding) : 'control-plane'
    const targetDeviceId = baseCapability.executionLocation === 'host'
      ? state.config?.authorities.hostDeviceId || 'unconfigured'
      : selectedDeviceId
    const runtimeMode = process.env.ELARA_MODE || 'local'
    const mayResolveHostPath = baseCapability.executionLocation === 'host'
      && selectedDeviceId === targetDeviceId
      && runtimeMode !== 'cloud'
      && binding?.principalId === principal?.id
      && principal.allowedDeviceIds.includes(targetDeviceId)
    const assessment = mayResolveHostPath
      ? assessFilesystemTool(exec.name, exec.arguments, exec.agent?.session.header.cwd)
      : {}
    const capability = capabilityForTool(exec.name, exec.arguments, assessment)
    const context: ExecutionContext = {
      principalId: principal?.id || 'unbound',
      sessionId: exec.agent ? String(exec.agent.id) : 'unbound',
      targetDeviceId,
      selectedDeviceId,
      runtimeMode,
      denialReasonCode: assessment.denialReasonCode,
      source: exec.parent ? 'dsh:nested-tool' : 'dsh:tool',
      signal: exec.signal,
    }
    const decision = evaluatePolicy(state.config, context, capability, binding?.principalId)
    if (shouldRecord) record(context, decision)
    return decision
  }

  // Only reviewed host actions can use P2B. P2A search, protected reads,
  // companion mutation, and control-plane restrictions remain in force.
  const approvableTools = new Set([
    'write', 'edit', 'pwsh', 'bash', 'run_code',
    'elara_project_test', 'elara_project_build', 'elara_project_typecheck',
  ])
  function approvalScope(exec: Readonly<ToolExecution>): string | undefined {
    const decision = decisionForTool(exec, false)
    const binding = bindingForAgent(exec.agent)
    const principal = principalForAgent(exec.agent)
    if (exec.signal.aborted || !binding || !principal || !approvableTools.has(exec.name)
      || decision.outcome !== 'approval_required'
      || targetFor(binding) !== state.config?.authorities.hostDeviceId
      || process.env.ELARA_MODE === 'cloud') return undefined
    return JSON.stringify({ principal: principal.id, session: exec.agent?.id,
      binding, target: targetFor(binding), policy: state.config, mode: process.env.ELARA_MODE || 'local',
      tool: exec.name, call: exec.callId, cwd: exec.agent?.session.header.cwd, args: exec.arguments })
  }

  ctx.on('approval/request', async (request, next) => {
    const owned = ownRequests.get(request as ApprovalRequest)
    const candidates = [...liveExecutions.values()].filter(exec => exec.agent === request.agent
      && exec.callId === request.callId && exec.name === request.toolName)
    const exec = owned?.exec ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!exec) return bindingForAgent(request.agent as Agent) ? 'unavailable' : next()

    const scope = approvalScope(exec)
    const binding = bindingForAgent(exec.agent)
    if (!scope || !binding) return 'unavailable'
    const details = JSON.stringify({ cwd: exec.agent?.session.header.cwd, arguments: exec.arguments,
      reason: request.reason }, null, 2)
    // Never ask for an action whose full preview cannot be delivered.
    if (details.length > 6000) return 'unavailable'
    const result = await inbox.ask({ principalId: binding.principalId,
      originChannel: binding.originChannel, sessionId: String(exec.agent!.id),
      targetDeviceId: targetFor(binding), toolName: exec.name, details }, request.signal ?? exec.signal)
    if (result === 'allowed-once' && approvalScope(exec) !== scope) return 'cancelled'
    if (owned) owned.accepted = result === 'allowed-once'
    return result
  }, { prepend: true })

  const service: AccessService = {
    state,
    principalForAlias(channel, alias) {
      const principal = aliasIndex.get(`${channel}\u0000${alias}`)
      return principal?.enabled ? principal : undefined
    },
    dashboardPrincipal() {
      const id = state.config?.authorities.dashboardPrincipalId
      return state.config?.principals.find(principal => principal.id === id && principal.enabled)
    },
    bindRootSession(sessionId, principalId, originChannel) {
      if (!state.config) throw new Error('ACCESS_CONFIG_UNAVAILABLE')
      const principal = state.config.principals.find(candidate => candidate.id === principalId && candidate.enabled)
      if (!principal) throw new Error('PRINCIPAL_DISABLED_OR_UNKNOWN')
      return store.bindSession(sessionId, principalId, originChannel)
    },
    bindingForSession(sessionId) {
      return store.bindingFor(sessionId)
    },
    assertSessionOwner(sessionId, principalId) {
      const binding = store.bindingFor(sessionId)
      if (!binding || binding.principalId !== principalId) throw new Error('SESSION_OWNER_UNTRUSTED')
      return binding
    },
    defaultTarget(channel) {
      const target = state.config?.authorities.channelDefaultDeviceIds[channel]
      if (!target) throw new Error('ACCESS_CONFIG_UNAVAILABLE')
      return target
    },
    deviceKind(deviceId) {
      return state.config?.devices.find(device => device.id === deviceId && device.enabled)?.kind
    },
    contextForAgent(agent, source, signal) {
      const binding = bindingForAgent(agent)
      const principal = principalForAgent(agent)
      if (!binding || !principal) return undefined
      return {
        principalId: principal.id,
        sessionId: agent ? String(agent.id) : binding.sessionId,
        targetDeviceId: targetFor(binding),
        source,
        signal,
      }
    },
    decideDirect(request) {
      const binding = store.bindingFor(request.sessionId)
      const context: ExecutionContext = request
      const decision = evaluatePolicy(state.config, context, capabilityById(request.capabilityId), binding?.principalId)
      record(context, decision)
      return decision
    },
    async executeDirect(request, operation) {
      const initial = service.decideDirect(request)
      if (initial.outcome !== 'allow') throw new AccessDeniedError(initial)
      if (request.signal?.aborted) throw new Error('ABORTED_BEFORE_DISPATCH')
      const final = evaluatePolicy(
        state.config,
        request,
        capabilityById(request.capabilityId),
        store.bindingFor(request.sessionId)?.principalId,
      )
      if (final.outcome !== 'allow') {
        record(request, final)
        throw new AccessDeniedError(final)
      }
      return operation()
    },
    pendingApprovals(principalId, channel) {
      const principal = state.config?.principals.find(item => item.id === principalId && item.enabled)
      return principal ? inbox.list(principalId, channel) : []
    },
    answerApproval(id, principalId, channel, allow) {
      const principal = state.config?.principals.find(item => item.id === principalId && item.enabled)
      return !!principal && inbox.answer(id, principalId, channel, allow)
    },
    onApproval(listener) { return inbox.subscribe(listener) },
  }

  ctx.provide('access', service)
  ctx.on('agent/created', async (payload: any) => {
    const child = payload?.agent as Agent | undefined
    if (!child || store.bindingFor(String(child.id))) return undefined
    for (const possibleParent of ctx.agents.list()) {
      if (possibleParent === child || !ctx.agents.isOwnedBy(child.id, possibleParent)) continue
      const parentBinding = bindingForAgent(possibleParent)
      if (parentBinding) {
        store.bindSession(String(child.id), parentBinding.principalId, parentBinding.originChannel)
      }
      return undefined
    }
    return undefined
  })
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<any>) => {
    const decision = decisionForTool(exec, true)
    if (decision.outcome === 'allow') return next()
    const scope = approvalScope(exec)
    if (scope && exec.agent) {
      const request: ApprovalRequest = { agent: exec.agent, toolName: exec.name,
        callId: exec.callId, reason: 'ELARA sensitive operation requires one-time approval', signal: exec.signal }
      const owned = { exec, accepted: false }
      ownRequests.set(request, owned)
      try {
        const outcome = await ctx.approval.request(request)
        if (outcome === 'allowed-once' && owned.accepted && approvalScope(exec) === scope) {
          grants.set(exec.token, scope)
          liveExecutions.set(exec.token, exec)
          return await next()
        }
      } catch {
        // Missing active turn or failed audit cannot issue a grant.
      } finally {
        ownRequests.delete(request)
      }
      return { kind: 'deny' as const, reason: denialText(decision) }
    }
    return { kind: 'deny' as const, reason: denialText(decision) }
  })
  ctx.tools.guard(exec => {
    const decision = decisionForTool(exec, false)
    const grant = grants.get(exec.token)
    grants.delete(exec.token)
    if (grant && approvalScope(exec) === grant) return undefined
    return decision.outcome === 'allow' ? undefined : denialText(decision)
  })
  ctx.on('tools/result', exec => {
    grants.delete(exec.token)
    liveExecutions.delete(exec.token)
    return undefined
  })
  ctx.effect(() => () => { inbox.close(); grants.clear(); liveExecutions.clear() })
  ctx.effect(() => () => store.close())

  if (!state.enabled) console.error(`[ELARA-ACCESS] ${state.diagnostic}`)
  else console.log('[ELARA-ACCESS] Trusted identity and execution policy loaded')
}
