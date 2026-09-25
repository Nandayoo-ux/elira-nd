import type { PendingApproval } from '../../packages/policy/approvals.ts'

const BUTTON_PREFIX = 'elara:approval:'
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function approvalButtonId(id: string, allow: boolean): string {
  return `${BUTTON_PREFIX}${id}:${allow ? 'allow' : 'reject'}`
}

export function approvalButtonAnswer(message: any, extract: (content: any) => any):
  { id: string; allow: boolean } | undefined {
  const content = extract(message)
  const response = content?.interactiveResponseMessage?.nativeFlowResponseMessage
  if (!response || (response.name && response.name !== 'quick_reply') || typeof response.paramsJson !== 'string'
    || response.paramsJson.length > 4096) return undefined
  let id: unknown
  try { id = JSON.parse(response.paramsJson)?.id } catch { return undefined }
  if (typeof id !== 'string' || !id.startsWith(BUTTON_PREFIX)) return undefined
  const match = /^elara:approval:([0-9a-f-]+):(allow|reject)$/i.exec(id)
  if (!match || !APPROVAL_ID.test(match[1])) return undefined
  return { id: match[1], allow: match[2] === 'allow' }
}

export function approvalReactionAnswer(message: any, extract: (content: any) => any):
  { messageId: string; allow: boolean } | undefined {
  const reaction = extract(message)?.reactionMessage
  const messageId = reaction?.key?.id
  if (typeof messageId !== 'string' || !messageId || (reaction?.text !== '✅' && reaction?.text !== '❌')) {
    return undefined
  }
  return { messageId, allow: reaction.text === '✅' }
}

export function approvalQuotedAnswer(message: any, extract: (content: any) => any):
  { messageId: string; allow: boolean } | undefined {
  const reply = extract(message)?.extendedTextMessage
  const command = typeof reply?.text === 'string' ? reply.text.trim().toLowerCase() : ''
  const messageId = reply?.contextInfo?.stanzaId
  if ((command !== '.approve' && command !== '.reject') || typeof messageId !== 'string' || !messageId) {
    return undefined
  }
  return { messageId, allow: command === '.approve' }
}

export function approvalPreviewText(view: PendingApproval): string {
  let details: any
  try { details = JSON.parse(view.details) } catch { details = undefined }
  const args = details?.arguments
  const monospace = (value: string) => value.includes('```') ? value : `\`\`\`${value}\`\`\``
  const lines = ['🔐 *Persetujuan ELARA*', '_Sekali pakai · berlaku 2 menit_', '',
    `*Alat:* ${view.toolName}`, `*Perangkat:* ${view.targetDeviceId}`]
  if (details && typeof details === 'object' && args && typeof args === 'object' && !Array.isArray(args)) {
    if (typeof args.description === 'string') lines.push(`*Tujuan:* ${args.description.replace(/\s+/g, ' ').trim()}`)
    if (typeof details.cwd === 'string') lines.push(`*Folder kerja:* ${details.cwd}`)
    if (typeof args.command === 'string') {
      lines.push('', '*Perintah yang akan dijalankan:*', monospace(args.command))
      const additional = Object.fromEntries(Object.entries(args)
        .filter(([key]) => key !== 'description' && key !== 'command'))
      if (Object.keys(additional).length) lines.push('', '*Opsi lain:*', monospace(JSON.stringify(additional, null, 2)))
    } else {
      lines.push('', '*Argumen yang akan digunakan:*', monospace(JSON.stringify(args, null, 2)))
    }
  } else {
    lines.push('', '*Rincian:*', monospace(view.details))
  }
  lines.push('', '*Balas keputusan:*',
    '✅ Izinkan sekali  ·  ❌ Tolak',
    'Tahan pesan ini lalu beri reaksi, atau balas pesan ini dengan .approve / .reject.')
  return lines.join('\n')
}

export function approvalButtonContent(view: PendingApproval): object {
  return {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: {
          header: { title: 'Persetujuan ELARA', hasMediaAttachment: false },
          body: { text: `Periksa rincian ${view.toolName} pada pesan sebelumnya, lalu pilih.` },
          footer: { text: 'Berlaku 2 menit • sekali pakai' },
          nativeFlowMessage: {
            buttons: [
              { name: 'quick_reply', buttonParamsJson: JSON.stringify({
                display_text: 'Izinkan sekali', id: approvalButtonId(view.id, true),
              }) },
              { name: 'quick_reply', buttonParamsJson: JSON.stringify({
                display_text: 'Tolak', id: approvalButtonId(view.id, false),
              }) },
            ],
            messageParamsJson: '',
          },
        },
      },
    },
  }
}
