import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

async function runTest() {
  console.log('Starting DSH...');
  const child = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', '.\\scripts\\run-local.ps1'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (d) => {
    const s = d.toString();
    output += s;
    process.stdout.write(s);
  });
  child.stderr.on('data', (d) => {
    process.stderr.write(d.toString());
  });

  // Wait for ready
  await new Promise(r => setTimeout(r, 6000));

  function sendMockMessage(user, msgId, text) {
    console.log(`\n>>> Sending mock message ${msgId} from ${user}: ${text}`);
    child.stdin.write(JSON.stringify({
      type: 'mock_whatsapp',
      upsert: {
        type: 'notify',
        messages: [{
          key: { remoteJid: user, id: msgId },
          message: { conversation: text }
        }]
      }
    }) + '\n');
  }

  // 1. Concurrent Test
  console.log('\n--- STARTING CONCURRENT TEST ---');
  sendMockMessage('userA@s.whatsapp.net', 'A1', 'halo elara, ini user A');
  sendMockMessage('userB@s.whatsapp.net', 'B1', 'hai elara, ini user B');

  await new Promise(r => setTimeout(r, 10000));

  // 2. Sequential Test
  console.log('\n--- STARTING SEQUENTIAL TEST ---');
  sendMockMessage('userC@s.whatsapp.net', 'C1', 'pesan C1');
  sendMockMessage('userC@s.whatsapp.net', 'C2', 'pesan C2');

  await new Promise(r => setTimeout(r, 10000));

  child.kill();
  console.log('Test completed.');
}

runTest();
