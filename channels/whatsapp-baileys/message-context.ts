export interface QuotedSummary {
  kind: string
  text?: string
}

function clean(value: unknown, maxLength = 2_000): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}

export function summarizeQuotedContent(content: any): QuotedSummary | undefined {
  if (!content) return undefined
  const conversation = clean(content.conversation)
  if (conversation) return { kind: 'teks', text: conversation }

  const extended = clean(content.extendedTextMessage?.text)
  if (extended) return { kind: 'teks', text: extended }

  if (content.imageMessage) return { kind: 'gambar', text: clean(content.imageMessage.caption) }
  if (content.videoMessage) return { kind: 'video', text: clean(content.videoMessage.caption) }
  if (content.documentMessage) {
    const caption = clean(content.documentMessage.caption)
    const name = clean(content.documentMessage.fileName, 240)
    return { kind: name ? `dokumen ${name}` : 'dokumen', text: caption }
  }
  if (content.audioMessage) return { kind: content.audioMessage.ptt ? 'voice note' : 'audio' }
  if (content.stickerMessage) return { kind: 'stiker' }
  if (content.locationMessage || content.liveLocationMessage) return { kind: 'lokasi' }
  if (content.contactMessage || content.contactsArrayMessage) return { kind: 'kontak' }
  return { kind: 'pesan media' }
}

export function combineQuotedContext(quote: QuotedSummary | undefined, currentText: string): string {
  if (!quote) return currentText.trim()
  const parts = [
    '[Konteks pesan yang dibalas]',
    `Jenis ${quote.kind}`,
    quote.text ? `Isi\n${quote.text}` : undefined,
    currentText.trim() ? `[Pesan sekarang]\n${currentText.trim()}` : undefined,
  ].filter((part): part is string => Boolean(part))
  return parts.join('\n')
}
