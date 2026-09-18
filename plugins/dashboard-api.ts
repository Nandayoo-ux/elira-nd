import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { POLICY } from './windows-tools.ts'

export const name = 'dashboard-api'
export const inject = ['agents', 'tools', 'sessions']

export function apply(ctx: Context) {
  // Generate a local dashboard token
  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  // Support both Windows absolute paths and posix
  const rootDir = path.resolve(process.platform === 'win32' && __dirname.startsWith('/') ? __dirname.substring(1) : __dirname, '..')
  
  const token = crypto.randomBytes(32).toString('hex')
  const runtimeDir = path.resolve(rootDir, '.runtime')
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true })
  }
  fs.writeFileSync(path.join(runtimeDir, 'dashboard-token.txt'), token, 'utf8')
  console.log(`[ELARA-DASHBOARD] Token generated and saved to .runtime/dashboard-token.txt`)

  const dashboardDir = path.resolve(rootDir, 'apps', 'dashboard')
  
  // Track SSE clients
  const clients = new Set<http.ServerResponse>()

  function broadcastEvent(type: string, data: any) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of clients) {
      client.write(payload)
    }
  }

  // Subscribe to runtime events for SSE
  ctx.on('agent/error', (payload: any) => broadcastEvent('runtime.error', payload))
  ctx.on('tools/result', (exec: any, result: any) => broadcastEvent('tool.completed', {
    tool: exec.name,
    isError: result.isError,
    value: typeof result.value === 'object' ? result.value : String(result.value),
    error: result.error?.message
  }))
  // Also we can listen to general tool executions if DSH emits them, but we'll stick to what we know
  // Or we can track manually when our API is used, but we need native events.
  // We'll also emit agent status updates if they exist. Let's emit a generic event for everything we can.

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    
    // CORS & SSE headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    if (url.pathname.startsWith('/api/')) {
      const authHeader = req.headers.authorization
      const reqToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null
      
      // Protect mutating endpoints
      if (req.method === 'POST') {
        if (reqToken !== token) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Unauthorized' }))
        }
      }

      try {
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const cpus = os.cpus()
          const cpuLoad = cpus.reduce((acc, cpu) => {
            const total = Object.values(cpu.times).reduce((a, b) => a + b, 0)
            const idle = cpu.times.idle
            return acc + ((total - idle) / total)
          }, 0) / cpus.length

          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({
            status: 'running',
            uptime: process.uptime(),
            pc: {
              hostname: os.hostname(),
              platform: process.platform,
              cpu: cpuLoad,
              memory: {
                total: os.totalmem(),
                free: os.freemem()
              },
              cwd: process.cwd()
            }
          }))
        }

        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          // Attempt to list agents if iterable, otherwise return an empty array gracefully
          const agents = []
          try {
            if (ctx.agents && typeof (ctx.agents as any)[Symbol.iterator] === 'function') {
              for (const agent of (ctx.agents as any)) {
                agents.push({
                  id: agent.session?.id || agent.id,
                  status: agent.status,
                  provider: agent.options?.provider,
                  model: agent.options?.model
                })
              }
            } else if (ctx.agents && typeof (ctx.agents as any).values === 'function') {
              for (const agent of (ctx.agents as any).values()) {
                agents.push({
                  id: agent.session?.id || agent.id,
                  status: agent.status,
                  provider: agent.options?.provider,
                  model: agent.options?.model
                })
              }
            }
          } catch (e) {
            console.error('[ELARA-DASHBOARD] Error listing agents:', e)
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ sessions: agents }))
        }

        if (req.method === 'GET' && url.pathname === '/api/tools') {
          const tools = []
          try {
            const toolList = typeof (ctx.tools as any).view === 'function' 
              ? Array.from((ctx.tools as any).view())
              : []
            
            for (const tool of toolList) {
              tools.push({ name: (tool as any).name, description: (tool as any).description, parameters: (tool as any).parameters || {} })
            }
          } catch (e) {
            console.error('[ELARA-DASHBOARD] Error listing tools:', e)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ tools }))
        }

        if (req.method === 'POST' && url.pathname === '/api/chat') {
          const body = await parseJsonBody(req)
          if (!body.sessionId || !body.message) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ error: 'Missing sessionId or message' }))
          }

          const agent = ctx.agents.get(body.sessionId)
          if (!agent) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ error: 'Session not found' }))
          }

          const userMsg = createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: body.message }],
          })

          broadcastEvent('chat.sent', { sessionId: body.sessionId, message: body.message })

          await ctx.agents.withInitiator(agent, async () => {
            agent.followup(userMsg)
            // yield to microtask queue
            await new Promise(r => setTimeout(r, 0))
            await agent.whenIdle()
          })

          await ctx.sessions.flush(agent.session)

          // Get the latest assistant messages
          const allMsgs = agent.session.deriveMessages()
          const responseText = allMsgs
            .filter((m: any) => m.role === 'assistant')
            .flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text) : [])
            .join('')

          broadcastEvent('chat.response', { sessionId: body.sessionId, message: responseText })

          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ response: responseText }))
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/project/')) {
          const action = url.pathname.split('/').pop()
          const allowedActions = ['typecheck', 'test', 'build']
          if (!allowedActions.includes(action!)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ error: 'Invalid action' }))
          }

          const toolName = `elara_project_${action}`
          let foundTool = null
          try {
            if (ctx.tools && typeof (ctx.tools as any).values === 'function') {
              for (const t of (ctx.tools as any).values()) {
                if (t.name === toolName) foundTool = t;
              }
            } else if (ctx.tools && typeof (ctx.tools as any).get === 'function') {
              foundTool = (ctx.tools as any).get(toolName)
            }
          } catch(e) {}
          
          if (!foundTool) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ error: 'Tool not found in registry' }))
          }

          // Execute tool
          const result = await foundTool.execute({ cwd: process.cwd() })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ result }))
        }

      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: e.message }))
      }
      
      res.writeHead(404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Not found' }))
    }

    // Serve static files
    let staticPath = path.join(dashboardDir, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!staticPath.startsWith(dashboardDir)) {
      res.writeHead(403)
      return res.end()
    }

    fs.readFile(staticPath, (err, data) => {
      if (err) {
        res.writeHead(404)
        return res.end('File not found')
      }
      const ext = path.extname(staticPath)
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css'
      }
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' })
      res.end(data)
    })
  })

  server.listen(31337, '127.0.0.1', () => {
    console.log('[ELARA-DASHBOARD] Control Center running at http://127.0.0.1:31337')
  })

  ctx.on('dispose', () => {
    server.close()
  })
}

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
      if (body.length > 1e6) { req.destroy(); reject(new Error('Body too large')) }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
    })
  })
}
