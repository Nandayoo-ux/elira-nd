import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import * as path from 'node:path'

export const name = 'whatsapp-baileys'
export const inject = ['agents', 'sessions', 'memory']

function splitIntoBubbles(text: string, maxBubbles = 4, hardMax = 6): string[] {
  if (!text.trim()) return []
  
  if (text.length < 80 && !text.includes('\n\n')) {
    return [text.trim()]
  }

  const codeBlocks: string[] = []
  let placeholderIndex = 0
  const textWithPlaceholders = text.replace(/```[\s\S]*?```/g, (match) => {
    const placeholder = `\n\n__CODE_BLOCK_${placeholderIndex}__\n\n`
    codeBlocks.push(match)
    placeholderIndex++
    return placeholder
  })

  const rawChunks = textWithPlaceholders.split(/\n\n+/).map(c => c.trim()).filter(Boolean)
  const bubbles: string[] = []
  
  for (const chunk of rawChunks) {
    let finalChunk = chunk
    for (let i = 0; i < codeBlocks.length; i++) {
      finalChunk = finalChunk.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i])
    }
    if (finalChunk.trim()) {
      bubbles.push(finalChunk.trim())
    }
  }
  
  let mergedBubbles = bubbles;
  if (mergedBubbles.length > maxBubbles) {
      const optimized: string[] = []
      let current = ""
      for (const b of mergedBubbles) {
          if (!current) {
              current = b;
          } else if ((current.length + b.length) < 300) {
              current += '\n\n' + b;
          } else {
              optimized.push(current);
              current = b;
          }
      }
      if (current) optimized.push(current);
      mergedBubbles = optimized;
  }
  
  if (mergedBubbles.length > hardMax) {
    const allowed = mergedBubbles.slice(0, hardMax - 1)
    const remainder = mergedBubbles.slice(hardMax - 1).join('\n\n')
    allowed.push(remainder)
    return allowed
  }
  
  return mergedBubbles
}

export function apply(ctx: Context) {
  // Maintain AgentHandle references
  const agentHandles = new Map<string, any>()

  // Dispose all agent handles on shutdown
  ctx.on('dispose', async () => {
    for (const handle of agentHandles.values()) {
      await handle.dispose()
    }
    agentHandles.clear()
  })

  // Start connection
  async function connectToWhatsApp() {
    const authDir = path.resolve(process.cwd(), '.baileys_auth_info')
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    
    // We use a silent pino logger so it doesn't spam stdout
    const logger = pino({ level: 'silent' })

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update
      if (qr) {
        qrcode.generate(qr, { small: true })
      }
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut
        console.log('[ELARA] WhatsApp connection closed. Reconnecting:', shouldReconnect)
        if (shouldReconnect) {
          connectToWhatsApp()
        }
      } else if (connection === 'open') {
        console.log('[ELARA] WhatsApp connected!')
      }
    })

    // Allow external tests to inject mock whatsapp messages via Cordis events or stdin
    ctx.on('elara/test-whatsapp-upsert', (payload) => {
      sock.ev.emit('messages.upsert', payload)
    })
    process.stdin.on('data', (data) => {
      try {
        const lines = data.toString().split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          const payload = JSON.parse(line)
          if (payload.type === 'mock_whatsapp') {
            sock.ev.emit('messages.upsert', payload.upsert)
          }
        }
      } catch (e) {}
    })

    const seenMessageIds = new Set<string>()
    const activeRequests = new Map<string, number>()

    const sendWA = async (jid: string, content: any, options?: any) => {
      if (process.env.ELARA_MOCK_WA) {
        console.log(`[MOCK_WA] sendMessage to ${jid}`);
        return;
      }
      return sock.sendMessage(jid, content, options);
    };

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return
      for (const msg of m.messages) {
        if (!msg.message || msg.key.fromMe) continue

        const remoteJid = msg.key.remoteJid
        if (!remoteJid) continue

        // GROUP CHAT RULE: IMMEDIATE RETURN
        if (remoteJid.endsWith('@g.us')) continue

        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text
        if (!textMessage) continue

        const msgId = msg.key.id
        if (!msgId) continue
        if (seenMessageIds.has(msgId)) continue

        seenMessageIds.add(msgId)
        if (seenMessageIds.size > 1000) {
          const first = seenMessageIds.values().next().value
          if (first !== undefined) {
            seenMessageIds.delete(first)
          }
        }

        const sessionId = `whatsapp:${remoteJid}`
        console.log(`[ELARA] WhatsApp message received from ${remoteJid}: ${textMessage}`)

        // DOT COMMANDS
        if (textMessage.trim().startsWith('.')) {
          const cmd = textMessage.trim().split(' ')[0].toLowerCase()
          if (['.help', '.status', '.pc', '.dashboard', '.new', '.refresh', '.mood', '.remember', '.memories', '.forget', '.searchmemory'].includes(cmd)) {
            if (cmd === '.mood') {
              await sendWA(remoteJid, { text: `Mood: neutral` }, { quoted: msg })
            } else if (cmd === '.new' || cmd === '.refresh') {
              const handle = agentHandles.get(sessionId)
              if (handle) {
                await handle.dispose()
                agentHandles.delete(sessionId)
              }
              await sendWA(remoteJid, { text: `Session refreshed. New context started.` }, { quoted: msg })
            } else if (cmd === '.remember') {
              const text = textMessage.trim().substring('.remember'.length).trim();
              if (text) {
                ctx.memory.remember('explicit', text, 'user', 10);
                await sendWA(remoteJid, { text: `oke, aku inget` }, { quoted: msg })
              } else {
                await sendWA(remoteJid, { text: `Mau inget apa?` }, { quoted: msg })
              }
            } else if (cmd === '.memories') {
               const mems = ctx.memory.list();
               if (mems.length === 0) {
                 await sendWA(remoteJid, { text: `Belum ada ingatan.` }, { quoted: msg })
               } else {
                 let res = 'MEMORY\n\n';
                 const per = mems.filter(m => m.type === 'personal');
                 if (per.length) res += `Personal\n${per.map(m => `${m.id}. ${m.content}`).join('\n')}\n\n`;
                 const proj = mems.filter(m => m.type === 'project');
                 if (proj.length) res += `Project\n${proj.map(m => `${m.id}. ${m.content}`).join('\n')}\n\n`;
                 const expl = mems.filter(m => m.type === 'explicit');
                 if (expl.length) res += `Explicit\n${expl.map(m => `${m.id}. ${m.content}`).join('\n')}\n\n`;
                 await sendWA(remoteJid, { text: res.trim() }, { quoted: msg })
               }
            } else if (cmd === '.forget') {
               const idPart = textMessage.trim().split(' ')[1];
               if (idPart && !isNaN(Number(idPart))) {
                 const id = Number(idPart);
                 const ok = ctx.memory.forget(id);
                 await sendWA(remoteJid, { text: ok ? `Memory ${id} dihapus.` : `Memory itu nggak ketemu` }, { quoted: msg })
               } else {
                 await sendWA(remoteJid, { text: `ID memory nggak valid.` }, { quoted: msg })
               }
            } else if (cmd === '.searchmemory') {
               const q = textMessage.trim().substring('.searchmemory'.length).trim();
               const mems = ctx.memory.search(q);
               if (mems.length === 0) {
                 await sendWA(remoteJid, { text: `Nggak ketemu.` }, { quoted: msg })
               } else {
                 await sendWA(remoteJid, { text: mems.map(m => `${m.id}. ${m.content}`).join('\n') }, { quoted: msg })
               }
            } else {
              await sendWA(remoteJid, { text: `Command ${cmd} acknowledged.` }, { quoted: msg })
              console.log(`Command ${cmd} acknowledged.`)
            }
            continue // Skip LLM completely
          }
        }

        const activeCount = (activeRequests.get(sessionId) || 0) + 1
        activeRequests.set(sessionId, activeCount)
        if (activeCount === 1) {
          console.log(`[ELARA-PRESENCE] sendPresenceUpdate('composing', '${remoteJid}')`)
          sock.sendPresenceUpdate('composing', remoteJid).catch(err => {
            console.error(`[ELARA] Failed to send composing presence to ${remoteJid}:`, err)
          })
        }

        try {
          // Check if we already have the agent handle
          let handle = agentHandles.get(sessionId)
          let agent = handle ? handle.agent : ctx.agents.get(sessionId)
          
          if (!agent) {
            const agentOpts = {
              provider: 'router9',
              model: 'grip/deepseek-v4.1-flash',
            } as const
            console.log(`[ELARA-DIAG] requested provider=${agentOpts.provider}`)
            console.log(`[ELARA-DIAG] requested model=${agentOpts.model}`)

            try {
              handle = await ctx.agents.resume({
                resumeSessionId: sessionId,
                agentOptions: agentOpts,
              })
              agent = handle.agent
              agentHandles.set(sessionId, handle)
            } catch (err: any) {
              console.log(`[ELARA-DIAG] resume failed for ${sessionId}:`, err.message);
              if (err.name === 'SessionAlreadyOwnedError' || (err.message && err.message.includes('already owned'))) {
                // It's likely being restored asynchronously by DSH core. Wait and grab it.
                console.log(`[ELARA-DIAG] waiting for core to finish restoring ${sessionId}...`);
                for (let i = 0; i < 20; i++) {
                  await new Promise(r => setTimeout(r, 100));
                  agent = ctx.agents.get(sessionId);
                  if (agent) break;
                }
                if (!agent) {
                  console.log(`[ELARA-DIAG] Failed to get agent after wait.`);
                } else {
                  console.log(`[ELARA-DIAG] Successfully acquired restored agent ${sessionId}`);
                  // Note: handle might not be available here, but we have agent.
                  // For DSH we can use agent directly.
                }
              }

              if (!agent) {
                try {
                  handle = await ctx.agents.create({
                    sessionId,
                    meta: { cwd: process.cwd() },
                    agentOptions: agentOpts,
                  })
                  agent = handle.agent
                  agentHandles.set(sessionId, handle)
                } catch (createErr) {
                  console.error(`[ELARA] Failed to create agent as fallback:`, createErr);
                }
              }
            }

            console.log(`[ELARA-DIAG] actual provider=${agent.options?.provider}`)
            console.log(`[ELARA-DIAG] actual model=${agent.options?.model}`)
          } else if (!handle) {
            // It exists in registry but we don't have the handle (e.g. created outside this plugin instance).
            // We can just use the agent directly without disposing it ourselves.
          }

          if (!agent) continue

          // DIAGNOSTICS BEFORE
          console.log(`[ELARA-DIAG] BEFORE FOLLOWUP`);
          console.log(`[ELARA-DIAG] agent.id: ${agent.id}`);
          console.log(`[ELARA-DIAG] agent.session.id: ${agent.session.id}`);
          console.log(`[ELARA-DIAG] agent.status: ${agent.status}`);
          console.log(`[ELARA-DIAG] agent model config: provider=${agent.options?.provider}, model=${agent.options?.model}`);

          // 1. Before sending the user message:
          const before = agent.session.deriveMessages();

          await ctx.agents.withInitiator(agent, async () => {
            // Listen for agent errors that might be swallowed
            ctx.on('agent/error', (payload: any) => {
              console.log(`[ELARA-DIAG] agent/error: turn=${payload.turn} step=${payload.step} error=${payload.error?.stack || String(payload.error)}`);
            });

            // Listen for tool results
            ctx.on('tools/result', (exec, result) => {
              console.log(`[ELARA-DIAG] tools/result for '${exec.name}': isError=${result.isError}, value=${typeof result.value === 'object' ? JSON.stringify(result.value) : String(result.value)}`);
              if (result.isError) {
                 console.log(`[ELARA-DIAG] tools/result error: ${result.error?.message}`);
              } else {
                 console.log(`[ELARA-DIAG] tools/result content: ${JSON.stringify(result.content)}`);
              }
            });

            // 2. Send:
            const relevantMems = ctx.memory.search(textMessage, 5);
            let injectedText = textMessage;
            if (relevantMems.length > 0) {
              const memStr = relevantMems.map(m => `- ${m.content}`).join('\n');
              injectedText = `[SYSTEM: Relevant Memories]\n${memStr}\n\n[USER]\n${textMessage}`;
              for (const m of relevantMems) {
                ctx.memory.updateLastUsed(m.id);
              }
            }

            const userMsg = createUserMessage({
              source: { kind: 'user' },
              content: [{ type: 'text', text: injectedText }],
            });
            agent.followup(userMsg);
            console.log(`[ELARA-DIAG] AFTER FOLLOWUP`);
            console.log(`[ELARA-DIAG] agent.status after followup: ${agent.status}`);
            console.log(`[ELARA-DIAG] agent.inbox.nextTurn.length: ${agent.inbox.nextTurn.length}`);
            console.log(`[ELARA-DIAG] agent.inbox.nextStep.length: ${agent.inbox.nextStep.length}`);

            // yield to microtask queue so wakeDriver's kick() can begin
            await new Promise(r => setTimeout(r, 0));
            console.log(`[ELARA-DIAG] agent.status after yield: ${agent.status}`);

            // 3. Await:
            await agent.whenIdle();
            console.log(`[ELARA-DIAG] AFTER WHENIDLE`);
          });

          // 4. Persist:
          await ctx.sessions.flush(agent.session);
          console.log(`[ELARA-DIAG] AFTER FLUSH`);

          // 5. Read:
          const after = agent.session.deriveMessages();

          // 6. Determine which assistant messages were added by this turn.
          const beforeIds = new Set(before.map((m: any) => m.id));
          const addedMessages = after.filter((m: any) => !beforeIds.has(m.id));

          // 7. Select the newly generated assistant/model message(s).
          const assistantMessages = addedMessages.filter((m: any) => m.role === 'assistant');

          // 8. Extract their text blocks only.
          let responseText = '';
          if (assistantMessages.length > 0) {
            const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
            if (lastAssistantMsg.content && Array.isArray(lastAssistantMsg.content)) {
              responseText = lastAssistantMsg.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('');
            }
          }

          // 9. If a final assistant message exists, send that text back to WhatsApp.
          if (responseText) {
            const bubbles = splitIntoBubbles(responseText)
            
            for (let i = 0; i < bubbles.length; i++) {
              const bubbleText = bubbles[i]
              console.log(`[ELARA] Replying bubble ${i+1}/${bubbles.length} to ${remoteJid}: ${bubbleText}`)
              
              if (i === 0) {
                await sendWA(remoteJid, { text: bubbleText }, { quoted: msg })
              } else {
                await sendWA(remoteJid, { text: bubbleText })
              }
              
              ctx.emit('elara/test-whatsapp-sent' as any, { remoteJid, text: bubbleText })
              console.log(JSON.stringify({ type: 'mock_whatsapp_sent', remoteJid, text: bubbleText }))
              
              if (i < bubbles.length - 1) {
                await new Promise(r => setTimeout(r, 600))
              }
            }
          } else {
            // 10. If no assistant message exists, log safe primitive info
            console.log(`[ELARA] No text response generated for ${sessionId}. Added messages: ${addedMessages.length}, Roles: ${addedMessages.map((m: any) => m.role).join(',')}`);
          }

        } catch (err) {
          console.error(`[ELARA] WhatsApp adapter error for ${sessionId}:`, err)
        } finally {
          const newCount = Math.max(0, (activeRequests.get(sessionId) || 1) - 1)
          activeRequests.set(sessionId, newCount)
          if (newCount === 0) {
            console.log(`[ELARA-PRESENCE] sendPresenceUpdate('paused', '${remoteJid}')`)
            sock.sendPresenceUpdate('paused', remoteJid).catch(err => {
              console.error(`[ELARA] Failed to clear composing presence for ${remoteJid}:`, err)
            })
          }
        }
      }
    })
    
    // Dispose socket on plugin shutdown
    ctx.on('dispose', () => {
      sock.end(undefined)
    })
  }

  connectToWhatsApp()
}
