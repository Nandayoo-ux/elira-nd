const MAX_WHATSAPP_TEXT = 4000
const MIN_NATURAL_CHUNK = 70

function hardWrap(text: string, maxLength = MAX_WHATSAPP_TEXT): string[] {
  const parts: string[] = []
  let remaining = text.trim()
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf('\n', maxLength)
    if (cut < Math.floor(maxLength * 0.5)) cut = remaining.lastIndexOf(' ', maxLength)
    if (cut < Math.floor(maxLength * 0.5)) cut = maxLength
    parts.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining) parts.push(remaining)
  return parts
}

function boundaryCandidates(text: string, maximum: number): Array<{ index: number; weight: number }> {
  const candidates: Array<{ index: number; weight: number }> = []
  const patterns: Array<[RegExp, number]> = [
    [/\n+/g, 0],
    [/[.!?]+\s+/g, 15],
    [/,\s+/g, 35],
    [/\s+/g, 80],
  ]
  for (const [pattern, weight] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = (match.index ?? 0) + match[0].length
      if (index >= MIN_NATURAL_CHUNK && index <= maximum) candidates.push({ index, weight })
    }
  }
  return candidates
}

function splitNaturalText(text: string, target: number, maximum = 720): string[] {
  const chunks: string[] = []
  let remaining = text.trim()
  const naturalMaximum = Math.min(maximum, Math.round(target * 1.35))
  while (remaining.length > naturalMaximum) {
    const candidates = boundaryCandidates(remaining, maximum)
    const selected = candidates.sort((left, right) =>
      (Math.abs(left.index - target) + left.weight) - (Math.abs(right.index - target) + right.weight))[0]
    const cut = selected?.index ?? Math.min(maximum, remaining.length)
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function naturalChunks(text: string): string[] {
  const target = text.length < 360 ? 190 : text.length < 1_000 ? 340 : 520
  const chunks: string[] = []
  const codePattern = /```[\s\S]*?```/g
  let cursor = 0
  for (const match of text.matchAll(codePattern)) {
    const index = match.index ?? 0
    const prose = text.slice(cursor, index)
    for (const paragraph of prose.split(/\n\s*\n+/).map(value => value.trim()).filter(Boolean)) {
      chunks.push(...splitNaturalText(paragraph, target))
    }
    chunks.push(match[0].trim())
    cursor = index + match[0].length
  }
  const tail = text.slice(cursor)
  for (const paragraph of tail.split(/\n\s*\n+/).map(value => value.trim()).filter(Boolean)) {
    chunks.push(...splitNaturalText(paragraph, target))
  }
  return chunks
}

function mergeNaturalChunks(chunks: string[], maximumCount: number): string[] {
  const merged = [...chunks]
  while (merged.length > maximumCount) {
    let bestIndex = 0
    let bestLength = Number.POSITIVE_INFINITY
    for (let index = 0; index < merged.length - 1; index++) {
      const length = merged[index].length + merged[index + 1].length
      if (length < bestLength) { bestLength = length; bestIndex = index }
    }
    merged.splice(bestIndex, 2, `${merged[bestIndex]}\n\n${merged[bestIndex + 1]}`)
  }
  return merged
}

export function splitIntoBubbles(text: string, maxBubbles = 4, hardMax = 6): string[] {
  if (!text.trim()) return []
  if (text.length < 120 && !text.includes('\n\n')) return [text.trim()]

  let bubbles = mergeNaturalChunks(naturalChunks(text), maxBubbles)
  bubbles = bubbles.flatMap(bubble => hardWrap(bubble))
  if (bubbles.length <= hardMax) return bubbles

  // Keep normal replies conversational without ever violating WhatsApp's
  // per-message limit. Extremely long output may exceed hardMax because data
  // integrity is preferable to truncating the answer.
  return [...bubbles.slice(0, hardMax - 1), ...hardWrap(bubbles.slice(hardMax - 1).join('\n\n'))]
}
