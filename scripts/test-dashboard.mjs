import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

function runDSH() {
  const child = spawn('npx', ['tsx', 'apps/cli/src/bin.ts', 'web', '--patch', 'D:\\Tan\\script\\elara-ai\\profiles\\local\\cordis.patch.yml'], {
    cwd: 'D:\\Tan\\script\\elara-ai\\.runtime\\deepseek-harness',
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: true
  });
  
  let readyResolve = null;
  let allReplies = [];

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      process.stdout.write(`[DSH] ${line}\n`);

      if (line.includes('[ELARA-DASHBOARD] Control Center running at http://127.0.0.1:31337') && readyResolve) {
        readyResolve();
        readyResolve = null;
      }
    }
  });

  return {
    child,
    waitForReady: () => new Promise(r => readyResolve = r),
    kill: () => {
      return new Promise(r => {
        child.on('exit', () => r());
        spawn('taskkill', ['/pid', child.pid, '/t', '/f']);
      });
    }
  }
}

async function main() {
  console.log('[TEST] Starting ELARA-DASHBOARD-TEST-001');

  let dsh;
  try {
    dsh = runDSH();
    console.log('[TEST] Waiting for DSH to start...');
    await dsh.waitForReady();
    console.log('[TEST] Runtime started');

    const tokenPath = path.resolve('.runtime', 'dashboard-token.txt');
    if (!fs.existsSync(tokenPath)) {
      throw new Error('Dashboard token not generated');
    }
    const token = fs.readFileSync(tokenPath, 'utf8');

    async function apiGet(path) {
      return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:31337/api${path}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(data) });
            } catch(e) {
              resolve({ status: res.statusCode, data });
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

    async function apiPost(path, body, authToken = token) {
      const payload = JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:31337/api${path}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(data) });
            } catch(e) {
              resolve({ status: res.statusCode, data });
            }
          });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    }

    console.log('[TEST] Verifying endpoints...');
    
    const statusRes = await apiGet('/status');
    if (statusRes.status !== 200 || statusRes.data.status !== 'running') throw new Error('Status endpoint failed');

    const toolsRes = await apiGet('/tools');
    if (toolsRes.status !== 200) {
      throw new Error('Tools endpoint failed');
    }

    const unauthRes = await apiPost('/project/typecheck', {}, 'bad-token');
    if (unauthRes.status !== 401) throw new Error('Auth bypass possible on mutating endpoints');

    console.log('[TEST] Testing dashboard chat API on an unknown session (should 404)...');
    const chatRes = await apiPost('/chat', {
      sessionId: 'whatsapp:unknown@s.whatsapp.net',
      message: 'Hello'
    });

    if (chatRes.status !== 404) {
      throw new Error(`Chat API should have returned 404, got: ${chatRes.status}`);
    }
    
    console.log('[TEST] Verifying project execution safe tools...');
    const tcRes = await apiPost('/project/typecheck', {});
    if (tcRes.status !== 200 || tcRes.data.error) {
       throw new Error(`Project typecheck tool failed via API: ${JSON.stringify(tcRes.data)}`);
    }

    console.log('[TEST] All E2E constraints verified.');
  } finally {
    if (dsh) {
      await dsh.kill();
    }
  }
}

main().catch(err => {
  console.error('[TEST ERROR]', err);
  process.exit(1);
});
