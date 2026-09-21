import { spawn } from 'child_process';

async function runTest() {
  console.log('Starting DSH...');
  const child = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', '.\\scripts\\run-local.ps1'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stdout.on('data', (d) => process.stdout.write(d.toString()));
  child.stderr.on('data', (d) => process.stderr.write(d.toString()));

  await new Promise(r => setTimeout(r, 15000));

  console.log('\n>>> Sending mock message to test agent creation...');
  child.stdin.write(JSON.stringify({
    type: 'mock_whatsapp',
    upsert: {
      type: 'notify',
      messages: [{
        key: { remoteJid: '12345678@s.whatsapp.net', id: 'TEST_1' },
        message: { conversation: 'Halo nama kamu siapa' }
      }]
    }
  }) + '\n');

  await new Promise(r => setTimeout(r, 15000));
  child.kill();
  console.log('Test completed.');
}

runTest();
