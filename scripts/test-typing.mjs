async function runTypingTests() {
  console.log('--- STARTING TYPING TESTS ---');

  const { Context } = await import('@deepseek-ai/cordis');
  const waPlugin = await import('../channels/whatsapp-baileys/plugin.ts');

  const ctx = new Context();

  // Mock memory
  ctx.provide('memory');
  ctx.memory = {
    search: () => [],
    list: () => [],
    forget: () => true,
    remember: () => {},
    updateLastUsed: () => {}
  };

  // Mock sessions
  ctx.provide('sessions');
  ctx.sessions = {
    flush: async () => {}
  };

  // Mock agents
  ctx.provide('agents');
  
  let currentMessages = [];
  let whenIdleResolver = null;
  let currentAgent = {
    id: 'mock-agent-1',
    status: 'idle',
    session: {
      id: 'mock-session-1',
      deriveMessages: () => [...currentMessages]
    },
    inbox: {
      nextTurn: [],
      nextStep: []
    },
    options: {
      provider: 'router9',
      model: 'grip/deepseek-v4.1-flash'
    },
    followup: (msg) => {
      currentMessages.push(msg);
    },
    whenIdle: async () => {
       if (whenIdleResolver) {
         await new Promise(r => whenIdleResolver = r);
       }
    }
  };

  ctx.agents = {
    get: () => currentAgent,
    create: async () => ({ agent: currentAgent, dispose: async () => {} }),
    resume: async () => ({ agent: currentAgent, dispose: async () => {} }),
    withInitiator: async (agent, fn) => {
      await fn();
    }
  };

  // Set up WA plugin
  ctx.plugin(waPlugin.default || waPlugin);

  // We don't have to wait for Cordis, synchronous is fine for basic services,
  // but let's wait 1 tick.
  await new Promise(r => setTimeout(r, 100));

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  
  console.log = (...args) => {
    logs.push(args.join(' '));
    originalLog(...args);
  };
  console.error = (...args) => {
    logs.push('ERROR: ' + args.join(' '));
    originalError(...args);
  };

  function sendMock(jid, text) {
    const payload = {
      type: 'mock_whatsapp',
      upsert: {
        type: 'notify',
        messages: [{
          key: { remoteJid: jid, fromMe: false, id: `msg-${Date.now()}-${Math.random()}` },
          message: { conversation: text }
        }]
      }
    };
    process.stdin.emit('data', Buffer.from(JSON.stringify(payload) + '\n'));
  }

  async function waitLogsFor(pattern, maxWait = 5000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (logs.some(l => l.includes(pattern))) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Timeout waiting for: ${pattern}`);
  }

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      originalLog(`\n### Test: ${name}`);
      logs.length = 0;
      await fn();
      originalLog(`✅ PASS`);
      passed++;
    } catch (e) {
      originalLog(`❌ FAIL: ${e.stack}`);
      failed++;
    }
  }

  await test('1-3, 8-10. Private message full lifecycle & Multi-bubble', async () => {
    currentMessages = [];
    currentAgent.whenIdle = async () => {
      // Simulate LLM processing
      await new Promise(r => setTimeout(r, 100));
      // Add assistant message
      currentMessages.push({
        id: 'ast-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello.\n\nThis is bubble 2.\n\nAnd bubble 3.' }]
      });
    };

    sendMock('user1@s.whatsapp.net', 'Hello');
    await waitLogsFor("sendPresenceUpdate('composing', 'user1@s.whatsapp.net')");
    await waitLogsFor("sendPresenceUpdate('paused', 'user1@s.whatsapp.net')");
    
    const composingStarts = logs.filter(l => l.includes("sendPresenceUpdate('composing'"));
    const composingPauses = logs.filter(l => l.includes("sendPresenceUpdate('paused'"));
    const bubbles = logs.filter(l => l.includes("mock_whatsapp_sent"));
    
    if (composingStarts.length !== 1) throw new Error('Expected 1 composing start');
    if (composingPauses.length !== 1) throw new Error('Expected 1 composing pause');
    if (bubbles.length < 3) throw new Error('Expected at least 3 bubbles for the multi-bubble split');
  });

  await test('4-6. Processing failure / exception / timeout', async () => {
    currentAgent.whenIdle = async () => {
      throw new Error('Simulated failure');
    };

    sendMock('user2@s.whatsapp.net', 'FAIL_NOW');
    await waitLogsFor("sendPresenceUpdate('composing', 'user2@s.whatsapp.net')");
    await waitLogsFor("sendPresenceUpdate('paused', 'user2@s.whatsapp.net')");
    
    const errors = logs.filter(l => l.includes('ERROR:'));
    if (errors.length === 0) throw new Error('Expected an error to be logged');
  });

  await test('7. Deterministic command', async () => {
    sendMock('user3@s.whatsapp.net', '.status');
    await waitLogsFor('Command .status acknowledged');
    if (logs.some(l => l.includes('sendPresenceUpdate'))) throw new Error('Should not send presence for fast commands');
  });

  await test('11-16. Group message rules', async () => {
    sendMock('12345@g.us', 'Hello everyone');
    sendMock('12345@g.us', '.pc');
    await new Promise(r => setTimeout(r, 1000));
    if (logs.some(l => l.includes('sendPresenceUpdate'))) throw new Error('Group chat must not send typing presence');
    if (logs.some(l => l.includes('agent.status'))) throw new Error('Group chat must not process LLM or start sessions');
  });

  await test('17. Concurrent private requests', async () => {
    let proceed;
    const waitPromise = new Promise(r => proceed = r);
    currentAgent.whenIdle = async () => {
      await waitPromise;
    };

    sendMock('user4@s.whatsapp.net', 'Msg 1');
    sendMock('user4@s.whatsapp.net', 'Msg 2');
    await waitLogsFor("sendPresenceUpdate('composing', 'user4@s.whatsapp.net')");
    
    proceed();
    await waitLogsFor("sendPresenceUpdate('paused', 'user4@s.whatsapp.net')");
    
    const starts = logs.filter(l => l.includes("sendPresenceUpdate('composing', 'user4@s.whatsapp.net')"));
    const pauses = logs.filter(l => l.includes("sendPresenceUpdate('paused', 'user4@s.whatsapp.net')"));
    
    if (starts.length !== 1) throw new Error(`Expected exactly 1 start for concurrent requests, got ${starts.length}`);
    if (pauses.length !== 1) throw new Error(`Expected exactly 1 pause for concurrent requests, got ${pauses.length}`);
  });

  originalLog(`\n--- SUMMARY ---`);
  originalLog(`Passed: ${passed}`);
  originalLog(`Failed: ${failed}`);

  ctx.emit('dispose');
  if (failed > 0) process.exit(1);
  else process.exit(0);
}

runTypingTests().catch(e => {
  console.error(e);
  process.exit(1);
});
