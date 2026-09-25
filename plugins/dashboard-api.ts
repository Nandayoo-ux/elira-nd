import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { executeReviewedWindowsTool } from './windows-tools.ts'

export const name = 'dashboard-api'
export const inject = ['agents', 'sessions', 'access', 'agentDefaultModel', 'agentPresets']

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function bodyOf(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
      if (body.length > 256 * 1024) { reject(new Error('Body too large')); req.destroy() }
    })
    req.on('end', () => { try { resolve(body.trim() ? JSON.parse(body) : {}) } catch (error) { reject(error) } })
    req.on('error', reject)
  })
}

export function apply(ctx: Context) {
  const root = path.resolve(process.env.ELARA_ROOT || process.cwd())
  const runtime = path.join(root, '.runtime')
  const dashboard = path.join(root, 'apps', 'dashboard')
  const port = Number(process.env.ELARA_DASHBOARD_PORT || 31337)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid dashboard port')
  fs.mkdirSync(runtime, { recursive: true })
  const tokenFile = path.join(runtime, 'dashboard-token.txt')
  const configured = process.env.ELARA_DASHBOARD_TOKEN?.trim()
  if (configured && configured.length < 16) throw new Error('Dashboard token is too short')
  const token = configured || (fs.existsSync(tokenFile)
    ? fs.readFileSync(tokenFile, 'utf8').trim() : crypto.randomBytes(32).toString('hex'))
  if (!configured && !fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, token, { mode: 0o600 })
  const clients = new Set<http.ServerResponse>()
  const queues = new Map<string, Promise<void>>()
  const handles = new Set<{ dispose: () => Promise<void> }>()
  const event = (name: string, value: unknown) => {
    for (const client of clients) client.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)
  }
  ctx.on('tools/result', (exec, result) => {
    const binding = ctx.access.bindingForSession(String(exec.agent?.id || ''))
    if (binding?.originChannel !== 'dashboard'
      || binding.principalId !== ctx.access.dashboardPrincipal()?.id) return undefined
    event('tool.completed', { sessionId: String(exec.agent?.id || ''), tool: exec.name,
      isError: result.isError, error: result.error?.message })
    return undefined
  })

  async function chat(sessionId: string, message: string, principalId: string, expectedTool?: string): Promise<{ response: string; toolResult?: { isError: boolean; error?: string } }> {
    const agent = ctx.agents.get(SessionId(sessionId))
    if (!agent) throw new Error('SESSION_NOT_FOUND')
    const binding = ctx.access.bindingForSession(sessionId)
    if (binding?.principalId !== principalId || binding.originChannel !== 'dashboard') {
      throw new Error('SESSION_OWNER_CONFLICT')
    }
    const previous = queues.get(sessionId) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => current)
    queues.set(sessionId, tail)
    await previous.catch(() => undefined)
    let toolResult: { isError: boolean; error?: string } | undefined
    const stopTool = ctx.on('tools/result', (exec, result) => {
      if (exec.agent === agent && exec.name === expectedTool) {
        toolResult = { isError: result.isError, error: result.error?.message }
      }
      return undefined
    })
    try {
      const before = new Set(agent.session.deriveMessages().map((item: any) => item.id))
      await ctx.agents.withInitiator(agent, async () => {
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: message }] }))
        await Promise.resolve()
        await agent.whenIdle()
      })
      await ctx.sessions.flush(agent.session)
      const response = agent.session.deriveMessages()
        .filter((item: any) => !before.has(item.id) && item.role === 'assistant').at(-1)
        ?.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('').trim() || ''
      return { response, toolResult }
    } finally {
      stopTool()
      release()
      if (queues.get(sessionId) === tail) queues.delete(sessionId)
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'")
    if (url.pathname.startsWith('/api/')) {
      const supplied = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7) : url.searchParams.get('token')
      if (supplied !== token) return json(res, 401, { error: 'Unauthorized' })
      const principal = ctx.access.dashboardPrincipal()
      if (!principal) return json(res, 503, { error: 'Managed execution disabled' })
      try {
        if (req.method === 'GET' && url.pathname === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
          res.write(': connected\n\n')
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const sessionId = 'dashboard:control'
          ctx.access.bindRootSession(sessionId, principal.id, 'dashboard')
          const request = { principalId: principal.id, sessionId,
            originChannel: 'dashboard', targetDeviceId: ctx.access.defaultTarget('dashboard'),
            source: 'dashboard:status', capabilityId: 'system.status' } as const
          const summary = await executeReviewedWindowsTool(ctx, request, 'elara_windows_status', {})
          return json(res, 200, { status: 'running', uptime: process.uptime(), pc: { summary } })
        }
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const sessions = ctx.agents.list().filter(agent => {
            const binding = ctx.access.bindingForSession(String(agent.id))
            return binding?.principalId === principal.id && binding.originChannel === 'dashboard'
          }).map(agent => ({ id: String(agent.id), status: agent.status,
            provider: agent.options?.provider, model: agent.options?.model }))
          return json(res, 200, { sessions })
        }
        if (req.method === 'POST' && url.pathname === '/api/sessions') {
          const sessionId = `dashboard:${crypto.randomUUID()}`
          ctx.access.bindRootSession(sessionId, principal.id, 'dashboard')
          const selection = ctx.agentDefaultModel.currentSelection()
          const handle = await ctx.agents.create({
            sessionId: SessionId(sessionId),
            meta: { cwd: root, agentPreset: 'elara' },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: async scope => { await ctx.agentPresets.mount(scope, 'elara') },
          })
          handles.add(handle)
          return json(res, 201, { sessionId })
        }
        if (req.method === 'GET' && url.pathname === '/api/tools') {
          return json(res, 200, { tools: ctx.tools.schemas().map(tool => ({
            name: tool.name, description: tool.description, parameters: tool.parameters,
          })) })
        }
        if (req.method === 'GET' && url.pathname === '/api/approvals') {
          return json(res, 200, { approvals: ctx.access.pendingApprovals(principal.id, 'dashboard') })
        }
        if (req.method === 'POST' && url.pathname === '/api/approvals/answer') {
          const body = await bodyOf(req)
          if (typeof body.id !== 'string' || typeof body.allow !== 'boolean') return json(res, 400, { error: 'Invalid answer' })
          const accepted = ctx.access.answerApproval(body.id, principal.id, 'dashboard', body.allow)
          return json(res, accepted ? 200 : 404, { accepted })
        }
        if (req.method === 'POST' && (url.pathname === '/api/chat' || url.pathname.startsWith('/api/project/'))) {
          const body = await bodyOf(req)
          const action = url.pathname.startsWith('/api/project/') ? url.pathname.split('/').at(-1) : undefined
          if (action && !['test', 'build', 'typecheck'].includes(action)) return json(res, 400, { error: 'Invalid action' })
          if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
            return json(res, action ? 409 : 400, { error: 'Dashboard session required',
              decision: 'approval_required', reasonCode: 'P2A_APPROVAL_REQUIRED' })
          }
          const message = action ? `Run elara_project_${action} in this session workspace.` : body.message
          if (typeof message !== 'string' || !message.trim() || message.length > 64_000) {
            return json(res, 400, { error: 'Invalid message' })
          }
          if (!ctx.agents.get(SessionId(body.sessionId))) return json(res, 404, { error: 'Session not found' })
          try {
            const outcome = await chat(body.sessionId, message, principal.id,
              action ? `elara_project_${action}` : undefined)
            if (action && !outcome.toolResult) {
              return json(res, 409, { error: 'The agent did not run the requested project action', response: outcome.response })
            }
            if (action && outcome.toolResult?.isError) {
              return json(res, 409, { error: outcome.toolResult.error || 'Project action failed' })
            }
            return json(res, 200, action ? { result: outcome.response } : { response: outcome.response })
          } catch (error) {
            if (error instanceof Error && ['SESSION_OWNER_CONFLICT', 'SESSION_OWNER_UNTRUSTED'].includes(error.message)) {
              return json(res, 403, { error: 'Session belongs to another principal', code: error.message })
            }
            throw error
          }
        }
        return json(res, 404, { error: 'Not found' })
      } catch (error) {
        return json(res, 500, { error: error instanceof Error ? error.message : 'Internal error' })
      }
    }
    const requestPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const target = path.resolve(dashboard, `.${requestPath}`)
    const relative = path.relative(dashboard, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return void res.writeHead(403).end()
    fs.readFile(target, (error, bytes) => {
      if (error) return void res.writeHead(404).end('Not found')
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' } as Record<string, string>)[path.extname(target)] || 'application/octet-stream' })
      res.end(bytes)
    })
  })
  server.listen(port, '127.0.0.1')
  server.unref()
  ctx.effect(() => async () => {
    for (const client of clients) client.end()
    await Promise.allSettled(queues.values())
    await Promise.allSettled([...handles].map(handle => handle.dispose()))
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  })
}
