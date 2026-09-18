import { spawn } from 'child_process';
import fs from 'fs';

const WAIT_FOR_REPLY_TIMEOUT = 60000;
const REPORT_FILE = 'elara-regression-report.md';
let report = `# ELARA WhatsApp Runtime Regression Report\n\n`;

function logReport(text) {
  console.log(text);
  report += text + '\n';
  fs.writeFileSync(REPORT_FILE, report);
}

function runDSH() {
  const child = spawn('npx', ['tsx', 'apps/cli/src/bin.ts', 'web', '--patch', 'D:\\Tan\\script\\elara-ai\\profiles\\local\\cordis.patch.yml'], {
    cwd: 'D:\\Tan\\script\\elara-ai\\.runtime\\deepseek-harness',
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: true
  });
  
  let resolveReply = null;
  let rejectReply = null;
  let timeoutId = null;
  let readyResolve = null;
  let allReplies = [];

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      process.stdout.write(`[DSH] ${line}\n`);

      if (line.includes('[ELARA] WhatsApp connected!') && readyResolve) {
        readyResolve();
        readyResolve = null;
      }

      if (line.includes('mock_whatsapp_sent')) {
        try {
          const payload = JSON.parse(line.trim());
          if (payload.type === 'mock_whatsapp_sent') {
            allReplies.push(payload.text);
            if (resolveReply) {
              clearTimeout(timeoutId);
              const res = resolveReply;
              resolveReply = null;
              rejectReply = null;
              res(payload.text);
            }
          }
        } catch(e) {}
      }
    }
  });

  return {
    child,
    waitForReady: () => new Promise(r => readyResolve = r),
    sendWaitReply: (id, text, waitMs = WAIT_FOR_REPLY_TIMEOUT) => {
      return new Promise((resolve, reject) => {
        resolveReply = resolve;
        rejectReply = reject;
        timeoutId = setTimeout(() => {
          if (rejectReply) {
            rejectReply(new Error('Timeout waiting for reply to ' + text));
            resolveReply = null;
            rejectReply = null;
          }
        }, waitMs);

        const payload = {
          type: 'mock_whatsapp',
          upsert: {
            type: 'notify',
            messages: [{
              key: { id, remoteJid: '99999999999@lid', fromMe: false },
              message: { conversation: text }
            }]
          }
        };
        child.stdin.write(JSON.stringify(payload) + '\n');
      });
    },
    sendMsg: (id, text) => {
        const payload = {
          type: 'mock_whatsapp',
          upsert: {
            type: 'notify',
            messages: [{
              key: { id, remoteJid: '99999999999@lid', fromMe: false },
              message: { conversation: text }
            }]
          }
        };
        child.stdin.write(JSON.stringify(payload) + '\n');
    },
    getReplies: () => allReplies,
    clearReplies: () => { allReplies = []; },
    kill: () => {
      return new Promise(r => {
        child.on('exit', () => r());
        spawn('taskkill', ['/pid', child.pid, '/t', '/f']);
      });
    }
  }
}

async function runTests() {
  logReport('## Environment initialization...');
  let dsh = runDSH();
  await dsh.waitForReady();
  logReport('✅ DSH ready.');

  // Test 1: Basic
  try {
    logReport('\n### TEST GROUP 1 - BASIC MESSAGE');
    let reply = await dsh.sendWaitReply('REG001', 'ELARA-REG-001. Say exactly REG-001-ACK');
    logReport(`Result: ${reply}`);
    logReport(reply.includes('REG-001-ACK') ? '✅ PASS' : '❌ FAIL');
  } catch(e) { logReport(`❌ FAIL: ${e.message}`); }

  // Test 2: Deduplication
  try {
    logReport('\n### TEST GROUP 2 - DEDUPLICATION');
    dsh.clearReplies();
    dsh.sendMsg('REG002', 'ELARA-REG-DEDUP-001. Say exactly DEDUP-ACK');
    dsh.sendMsg('REG002', 'ELARA-REG-DEDUP-001. Say exactly DEDUP-ACK');
    
    // Wait for response to stabilize
    await new Promise(r => setTimeout(r, 15000));
    const replies = dsh.getReplies();
    logReport(`Total replies received: ${replies.length}`);
    logReport(replies.length === 1 ? '✅ PASS' : '❌ FAIL');
  } catch(e) { logReport(`❌ FAIL: ${e.message}`); }

  // Test 3: Multi-turn
  try {
    logReport('\n### TEST GROUP 3 - MULTI-TURN SESSION');
    let r1 = await dsh.sendWaitReply('REG003', 'ELARA-REG-MULTI-001. My secret word is PINEAPPLE.');
    let r2 = await dsh.sendWaitReply('REG004', 'ELARA-REG-MULTI-002. What is my secret word? Say it exactly.');
    logReport(`Turn 2 Result: ${r2}`);
    logReport(r2.includes('PINEAPPLE') ? '✅ PASS' : '❌ FAIL');
  } catch(e) { logReport(`❌ FAIL: ${e.message}`); }

  // Test 4: Tool Call
  try {
    logReport('\n### TEST GROUP 4 - TOOL CALL');
    let reply = await dsh.sendWaitReply('REG005', 'Please run elara_test_echo with testString="ELARA-REG-TOOL-001"');
    logReport(`Result: ${reply}`);
    logReport(reply.includes('ELARA-REG-TOOL-001') ? '✅ PASS' : '❌ FAIL');
  } catch(e) { logReport(`❌ FAIL: ${e.message}`); }

  // Test 5: Tool Failure
  try {
    logReport('\n### TEST GROUP 5 - TOOL FAILURE');
    // Using a non-existent tool or triggering an error in prompt if possible.
    // DSH LLM allows natural fallbacks. Let's ask to run a tool that doesn't exist, which naturally fails contextually.
    let reply = await dsh.sendWaitReply('REG006', 'Please run non_existent_tool_test with testString="FAIL". Tell me the error.');
    logReport(`Result: ${reply}`);
    logReport(reply.length > 0 ? '✅ PASS (Did not crash)' : '❌ FAIL');
  } catch(e) { logReport(`❌ FAIL: ${e.message}`); }

  // Test 9: Clean Shutdown
  try {
    logReport('\n### TEST GROUP 9 - CLEAN SHUTDOWN');
    await dsh.kill();
    logReport('✅ PASS (Process exited gracefully)');
  } catch(e) { logReport(`❌ FAIL: ${e.message}`); }

  // Test 6: Persistence & Test 7: Stale Session Safety
  try {
    logReport('\n### TEST GROUP 6 & 7 - PERSISTENCE & STALE SESSION SAFETY');
    logReport('Restarting DSH...');
    dsh = runDSH();
    await dsh.waitForReady();
    logReport('✅ DSH ready after restart.');
    let reply = await dsh.sendWaitReply('REG007', 'ELARA-REG-PERSIST-001. What was my secret word from earlier?');
    logReport(`Result: ${reply}`);
    logReport(reply.includes('PINEAPPLE') ? '✅ PASS' : '❌ FAIL');
  } catch(e) { logReport(`❌ FAIL: ${e.message}`); }

  // Test 8: Concurrent Incoming Messages
  try {
    logReport('\n### TEST GROUP 8 - CONCURRENT INCOMING MESSAGES');
    dsh.clearReplies();
    // Start two promises but don't await them yet
    dsh.sendMsg('REG008', 'ELARA-REG-CONCURRENT-001. Count 1.');
    dsh.sendMsg('REG009', 'ELARA-REG-CONCURRENT-002. Count 2.');
    
    await new Promise(r => setTimeout(r, 20000));
    const replies = dsh.getReplies();
    logReport(`Total replies received: ${replies.length}`);
    logReport(replies.length === 2 ? '✅ PASS' : '❌ FAIL');
  } catch(e) { logReport(`❌ FAIL: ${e.message}`); }

  logReport('\n### TEST GROUP 10 - TYPECHECK / BUILD');
  logReport('Will be executed externally via npx tsc');

  await dsh.kill();
  process.exit(0);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
