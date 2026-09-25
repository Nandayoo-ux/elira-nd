import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { splitIntoBubbles } from './format.ts'
import { approvalButtonAnswer, approvalButtonContent, approvalButtonId, approvalPreviewText,
  approvalQuotedAnswer, approvalReactionAnswer } from './approval-buttons.ts'
import { isScreenshotRequest, prepareScreenshotTarget, readScreenshot } from './outbound-screenshot.ts'

// Adapter ingress, deduplication, session ownership, replies, and disposal are
// exercised through the real DSH loader in scripts/test-runtime.mjs.
describe('WhatsApp presentation', () => {
  test('short responses stay in one bubble', () => {
    assert.deepEqual(splitIntoBubbles('iya'), ['iya'])
  })

  test('paragraphs split and long content stays within WhatsApp limits', () => {
    assert.deepEqual(splitIntoBubbles('Bagian pertama.\n\nBagian kedua.'),
      ['Bagian pertama.', 'Bagian kedua.'])
    const bubbles = splitIntoBubbles('kata '.repeat(1_200))
    assert.ok(bubbles.length > 1)
    assert.ok(bubbles.every(bubble => bubble.length <= 4_000))
  })
})

test('approval quick replies serialize through the installed Baileys protocol and parse by exact ID', async () => {
  const baileys = await import('@whiskeysockets/baileys')
  const id = '12345678-1234-4234-8234-123456789abc'
  const view = {
    id, principalId: 'fixture-user', originChannel: 'whatsapp', sessionId: 'fixture-session',
    targetDeviceId: 'fixture-local', toolName: 'pwsh', details: 'synthetic fixture', expiresAt: Date.now() + 120_000,
  } as const
  const content = baileys.proto.Message.fromObject(approvalButtonContent(view))
  const message = baileys.generateWAMessageFromContent('user@s.whatsapp.net', content,
    { userJid: 'bot@s.whatsapp.net' })
  const buttons = message.message?.viewOnceMessage?.message?.interactiveMessage?.nativeFlowMessage?.buttons
  assert.equal(buttons?.length, 2)
  assert.deepEqual(buttons?.map(button => JSON.parse(button.buttonParamsJson!).display_text),
    ['Izinkan sekali', 'Tolak'])
  assert.equal(JSON.parse(buttons![0]!.buttonParamsJson!).id, approvalButtonId(id, true))

  const reply = (buttonId: string) => ({ interactiveResponseMessage: { nativeFlowResponseMessage: {
    name: 'quick_reply', paramsJson: JSON.stringify({ id: buttonId }),
  } } })
  assert.deepEqual(approvalButtonAnswer(reply(approvalButtonId(id, true)), value => value), { id, allow: true })
  assert.deepEqual(approvalButtonAnswer(reply(approvalButtonId(id, false)), value => value), { id, allow: false })
  assert.deepEqual(approvalButtonAnswer({ interactiveResponseMessage: { nativeFlowResponseMessage: {
    paramsJson: JSON.stringify({ id: approvalButtonId(id, true) }),
  } } }, value => value), { id, allow: true })
  assert.equal(approvalButtonAnswer(reply('elara:approval:invalid:allow'), value => value), undefined)
  assert.equal(approvalButtonAnswer({ interactiveResponseMessage: { nativeFlowResponseMessage: {
    name: 'quick_reply', paramsJson: '{bad',
  } } }, value => value), undefined)
  assert.deepEqual(approvalReactionAnswer({ reactionMessage: { key: { id: 'prompt-message' }, text: '✅' } },
    value => value), { messageId: 'prompt-message', allow: true })
  assert.deepEqual(approvalReactionAnswer({ reactionMessage: { key: { id: 'prompt-message' }, text: '❌' } },
    value => value), { messageId: 'prompt-message', allow: false })
  assert.equal(approvalReactionAnswer({ reactionMessage: { key: { id: 'prompt-message' }, text: '👍' } },
    value => value), undefined)
  assert.deepEqual(approvalQuotedAnswer({ extendedTextMessage: { text: '.approve',
    contextInfo: { stanzaId: 'prompt-message' } } }, value => value),
  { messageId: 'prompt-message', allow: true })
  assert.deepEqual(approvalQuotedAnswer({ extendedTextMessage: { text: ' .REJECT ',
    contextInfo: { stanzaId: 'prompt-message' } } }, value => value),
  { messageId: 'prompt-message', allow: false })
  assert.equal(approvalQuotedAnswer({ extendedTextMessage: { text: '.approve' } }, value => value), undefined)
})

test('approval preview shows exact PowerShell command without raw JSON or approval ID', () => {
  const id = '12345678-1234-4234-8234-123456789abc'
  const text = approvalPreviewText({
    id, principalId: 'fixture-user', originChannel: 'whatsapp', sessionId: 'fixture-session',
    targetDeviceId: 'fixture-local', toolName: 'pwsh', expiresAt: Date.now() + 120_000,
    details: JSON.stringify({ cwd: 'D:\\fixture', arguments: {
      description: 'Cek RAM', command: 'Get-Process | Select-Object -First 5 ProcessName',
    }, reason: 'ELARA sensitive operation requires one-time approval' }),
  })
  assert.match(text, /^🔐 \*Persetujuan ELARA\*/)
  assert.match(text, /_Sekali pakai · berlaku 2 menit_/)
  assert.match(text, /\*Tujuan:\* Cek RAM/)
  assert.match(text, /\*Perintah yang akan dijalankan:\*\n```Get-Process \| Select-Object -First 5 ProcessName```/)
  assert.match(text, /\*Folder kerja:\* D:\\fixture/)
  assert.match(text, /balas pesan ini dengan \.approve \/ \.reject/)
  assert.doesNotMatch(text, /"arguments"|"reason"|12345678-1234/)
})

test('screenshot output accepts only a fresh scoped PNG target', async () => {
  assert.equal(isScreenshotRequest('screenshot layar'), true)
  assert.equal(isScreenshotRequest('apa itu screenshot?'), false)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-screenshot-test-'))
  try {
    const target = prepareScreenshotTarget(root, '0123456789abcdef01234567',
      '12345678-1234-4234-8234-123456789abc')
    await assert.rejects(readScreenshot(target, root), /SCREENSHOT_NOT_AVAILABLE/)
    fs.writeFileSync(target, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8\/x8AAwMCAO+\/lXcAAAAASUVORK5CYII=', 'base64'))
    const image = await readScreenshot(target, root)
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.throws(() => prepareScreenshotTarget(root, '0123456789abcdef01234567',
      '12345678-1234-4234-8234-123456789abc'), /SCREENSHOT_TARGET_EXISTS/)
    fs.writeFileSync(target, 'not an image')
    await assert.rejects(readScreenshot(target, root), /SCREENSHOT_INVALID/)
  } finally {
    assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
