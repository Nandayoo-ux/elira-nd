import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isP2ARemoteCapability } from '../../packages/policy/evaluate.ts'
import { executeLocalTool } from '../../plugins/windows-tools-local.ts'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const rootDir = path.resolve(process.platform === 'win32' && __dirname.startsWith('/') ? __dirname.substring(1) : __dirname, '../..')
const runtimeDir = path.resolve(rootDir, '.runtime')

const tokenPath = path.join(runtimeDir, 'companion-token.txt')
const idPath = path.join(runtimeDir, 'companion-id.txt')

if (!fs.existsSync(tokenPath) || !fs.existsSync(idPath)) {
  console.error('[ELARA-COMPANION] Missing companion-token.txt or companion-id.txt in .runtime directory.')
  process.exit(1)
}

const companionSecret = fs.readFileSync(tokenPath, 'utf8').trim()
const companionId = fs.readFileSync(idPath, 'utf8').trim()

const SERVER_URL = 'http://127.0.0.1:31338'

function startSSEClient() {
  console.log('[ELARA-COMPANION] Connecting to ELARA Cloud...')
  
  const req = http.request(`${SERVER_URL}/api/companion/sync`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${companionSecret}`,
      'Accept': 'text/event-stream'
    }
  }, (res) => {
    if (res.statusCode === 401) {
      console.error('[ELARA-COMPANION] Unauthorized. Invalid companion secret.')
      process.exit(1)
    }
    
    if (res.statusCode !== 200) {
      console.error(`[ELARA-COMPANION] Failed to connect: ${res.statusCode}`)
      setTimeout(startSSEClient, 5000)
      return
    }

    console.log('[ELARA-COMPANION] Connected to ELARA Cloud via SSE.')

    let buffer = ''
    res.on('data', (chunk) => {
      buffer += chunk.toString()
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n\n')) >= 0) {
        const message = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 2)
        
        handleSSEMessage(message)
      }
    })

    res.on('end', () => {
      console.log('[ELARA-COMPANION] SSE connection closed.')
      setTimeout(startSSEClient, 5000)
    })
  })

  req.on('error', (err) => {
    console.error(`[ELARA-COMPANION] Connection error: ${err.message}`)
    setTimeout(startSSEClient, 5000)
  })

  req.end()
}

function handleSSEMessage(message: string) {
  let eventType = 'message'
  let dataStr = ''
  
  for (const line of message.split('\n')) {
    if (line.startsWith('event: ')) eventType = line.substring(7)
    if (line.startsWith('data: ')) dataStr = line.substring(6)
  }
  
  if (eventType === 'tool.request') {
    try {
      const data = JSON.parse(dataStr)
      handleToolRequest(data)
    } catch (e) {
      console.error('[ELARA-COMPANION] Failed to parse tool request:', e)
    }
  }
}

async function handleToolRequest(req: { id: string, method: string, args: any }) {
  if (!isP2ARemoteCapability(req.method)) {
    console.error('[ELARA-COMPANION] Disabled remote capability rejected')
    return
  }
  console.log(`[ELARA-COMPANION] Received request ${req.id} for ${req.method}`)
  
  // 1. Send ACK
  try {
    await postJson('/api/companion/ack', { id: req.id })
    console.log(`[ELARA-COMPANION] ACK sent for ${req.id}`)
  } catch (err: any) {
    console.error(`[ELARA-COMPANION] Failed to ACK ${req.id}:`, err.message)
    // If we can't ACK, we should probably abort to avoid uncertain state
    return
  }
  
  // 2. Execute
  let result;
  let ok = true;
  let errorMsg;
  try {
    result = await executeLocalTool(req.method, req.args)
  } catch (err: any) {
    ok = false;
    errorMsg = err.message
  }
  
  // 3. Send Result
  const payload = {
    id: req.id,
    companionId,
    ok,
    result,
    error: errorMsg
  }
  
  try {
    await postJson('/api/companion/result', payload)
    console.log(`[ELARA-COMPANION] Result sent for ${req.id}`)
  } catch (err: any) {
    console.error(`[ELARA-COMPANION] Failed to send result for ${req.id}:`, err.message)
    // Here we DO NOT automatically retry execution as per Phase 9 rules.
  }
}

function postJson(path: string, body: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${companionSecret}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let resBody = ''
      res.on('data', chunk => resBody += chunk)
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve()
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${resBody}`))
        }
      })
    })
    
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// Start
startSSEClient()
