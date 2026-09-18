import { mock } from 'node:test';
import { EventEmitter } from 'node:events';

const sockEv = new EventEmitter();
const sock = { ev: sockEv, end: () => {}, sendMessage: () => {} };

mock.module('@whiskeysockets/baileys', {
  namedExports: {
    makeWASocket: () => sock,
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
    DisconnectReason: { loggedOut: 401 }
  }
});

// Import the plugins after mocking
const { Context } = await import('@deepseek-ai/cordis');
const { default: corePlugin } = await import('./plugins/elara-core.ts');
const { default: whatsappPlugin } = await import('./channels/whatsapp-baileys/plugin.ts');

const ctx = new Context();
ctx.plugin(corePlugin);
ctx.plugin(whatsappPlugin);

await ctx.start();

console.log('App started. Emitting ELARA-TEST-001...');

sockEv.emit('messages.upsert', {
  type: 'notify',
  messages: [
    {
      key: { id: 'test_msg_1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
      message: { conversation: 'ELARA-TEST-001' }
    }
  ]
});

// Give it time to process
await new Promise(r => setTimeout(r, 10000));
console.log('Test complete.');
process.exit(0);
