import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { isP2ARemoteCapability } from '../packages/policy/evaluate.ts'

export const name = 'companion-api'

export interface CompanionService {
  executeTool(toolName: string, args: any, targetDeviceId: string): Promise<any>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    companion: CompanionService
  }
}

export function apply(ctx: Context) {
  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  const rootDir = path.resolve(process.platform === 'win32' && __dirname.startsWith('/') ? __dirname.substring(1) : __dirname, '..')
  const runtimeDir = path.resolve(rootDir, '.runtime')

  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true })
  }

  const tokenPath = path.join(runtimeDir, 'companion-token.txt')
  const idPath = path.join(runtimeDir, 'companion-id.txt')

  let companionSecret = ''
  let companionId = ''

  if (fs.existsSync(tokenPath) && fs.existsSync(idPath)) {
    companionSecret = fs.readFileSync(tokenPath, 'utf8').trim()
    companionId = fs.readFileSync(idPath, 'utf8').trim()
  } else {
    companionSecret = crypto.randomBytes(32).toString('hex')
    companionId = 'comp-' + crypto.randomBytes(8).toString('hex')
    fs.writeFileSync(tokenPath, companionSecret, 'utf8')
    fs.writeFileSync(idPath, companionId, 'utf8')
    console.log(`[ELARA-CLOUD] Provisioned new Companion ID: ${companionId}`)
  }

  // Request states: pending, accepted, executing, completed, failed, expired, uncertain
  type RequestState = 'pending' | 'accepted' | 'executing' | 'completed' | 'failed' | 'expired' | 'uncertain'

  interface PendingRequest {
    id: string;
    companionId: string;
    state: RequestState;
    createdAt: number;
    expiresAt: number;
    toolName: string;
    args: any;
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
  }

  const pendingRequests = new Map<string, PendingRequest>()
  const clients = new Set<http.ServerResponse>()
  
  let connected = false;
  let lastSeen = 0;

  function broadcastEvent(type: string, data: any) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of clients) {
      client.write(payload)
    }
  }

  ctx.provide('companion', {
    async executeTool(toolName: string, args: any, targetDeviceId: string): Promise<any> {
      if (!isP2ARemoteCapability(toolName)) throw new Error('REMOTE_CAPABILITY_DISABLED')
      if (targetDeviceId !== companionId) throw new Error('COMPANION_TARGET_MISMATCH')
      if (!connected || clients.size === 0) {
        throw new Error('Windows Companion is currently offline.')
      }

      const reqId = 'req-' + crypto.randomBytes(16).toString('hex')
      const now = Date.now()
      
      let resolveRef: (val: any) => void = () => {}
      let rejectRef: (reason?: any) => void = () => {}
      
      const promise = new Promise((resolve, reject) => {
        resolveRef = resolve
        rejectRef = reject
      })

      const pendingReq: PendingRequest = {
        id: reqId,
        companionId,
        state: 'pending',
        createdAt: now,
        expiresAt: now + 35000, // 35 seconds (30s process timeout + 5s overhead)
        toolName,
        args,
        resolve: resolveRef,
        reject: rejectRef
      }
      
      pendingRequests.set(reqId, pendingReq)

      // Send to companion
      broadcastEvent('tool.request', {
        id: reqId,
        method: toolName,
        args
      })

      // Timeout handler
      setTimeout(() => {
        const req = pendingRequests.get(reqId)
        if (req && (req.state === 'pending' || req.state === 'accepted' || req.state === 'executing')) {
          req.state = 'expired'
          req.reject(new Error(`Tool execution timed out (${req.state}).`))
          // Keep in map as expired to prevent late arrivals from messing up
        }
      }, 35000)

      return promise
    }
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    
    if (url.pathname.startsWith('/api/companion/')) {
      const authHeader = req.headers.authorization
      const reqToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null
      
      if (reqToken !== companionSecret) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Unauthorized companion' }))
      }

      // Update liveness
      lastSeen = Date.now()

      if (req.method === 'GET' && url.pathname === '/api/companion/sync') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })
        res.flushHeaders()
        res.write(': connected\n\n')
        clients.add(res)
        connected = true
        console.log('[ELARA-CLOUD] Companion connected.')
        
        req.on('close', () => {
          clients.delete(res)
          if (clients.size === 0) {
            connected = false
            console.log('[ELARA-CLOUD] Companion disconnected.')
            // Mark executing requests as uncertain
            for (const [id, r] of pendingRequests.entries()) {
              if (r.state === 'executing' || r.state === 'accepted') {
                r.state = 'uncertain'
                r.reject(new Error('Companion disconnected during execution. State is uncertain.'))
              }
            }
          }
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/companion/ack') {
        const body = await parseJsonBody(req)
        const pr = pendingRequests.get(body.id)
        if (!pr) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Request not found' }))
        }
        if (pr.state !== 'pending') {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Request not in pending state' }))
        }
        
        pr.state = 'accepted'
        
        // Companion says it will start executing now
        // Usually it acks then immediately executes, so we can transition to executing
        // or let it be 'accepted'. Let's say it transitions to executing.
        pr.state = 'executing'
        
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }

      if (req.method === 'POST' && url.pathname === '/api/companion/result') {
        const body = await parseJsonBody(req)
        const pr = pendingRequests.get(body.id)
        
        if (!pr) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Request not found' }))
        }
        
        // We only accept results if it's currently executing, expired, or uncertain
        // If it was expired/uncertain, it means we already rejected the promise,
        // but we can still record the final result in the state (though we can't resolve the promise).
        if (pr.state === 'completed' || pr.state === 'failed') {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Duplicate result' }))
        }

        if (body.companionId !== companionId) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Companion ID mismatch' }))
        }

        pr.state = body.ok ? 'completed' : 'failed'
        
        if (body.ok) {
          pr.resolve(body.result)
        } else {
          pr.reject(new Error(body.error || 'Unknown companion error'))
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
    }
    
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: 'Not found' }))
  })

  server.listen(31338, '127.0.0.1', () => {
    console.log('[ELARA-CLOUD] Companion API listening on 127.0.0.1:31338')
  })

  ctx.effect(() => () => { server.close() })
}

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
      if (body.length > 10 * 1024 * 1024) { req.destroy(); reject(new Error('Body too large')) }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
    })
  })
}
