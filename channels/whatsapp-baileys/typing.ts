import type { EmotionCategory } from './emotion.ts'

export type TypingSpeed = 'instant' | 'fast' | 'natural' | 'slow'

export function parseTypingSpeed(value: string | undefined): TypingSpeed {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'instant' || normalized === 'fast' || normalized === 'slow'
    ? normalized : 'natural'
}

export function typingDelayMs(
  text: string,
  options: {
    firstBubble?: boolean
    emotionLevel?: number
    category?: EmotionCategory
    speed?: TypingSpeed
  } = {},
): number {
  const speed = options.speed ?? 'natural'
  if (speed === 'instant') return 0

  const visibleLength = [...text.trim()].length
  const firstBase = options.firstBubble ? 140 : 280
  const perCharacter = options.firstBubble ? 3 : 8
  let delay = firstBase + Math.min(visibleLength, 220) * perCharacter

  if ((options.emotionLevel ?? 2) >= 4) delay *= 0.78
  if (options.category === 'sad' || options.category === 'sensitive') delay *= 1.15
  if (options.category === 'panicked') delay *= 0.72
  if (speed === 'fast') delay *= 0.55
  if (speed === 'slow') delay *= 1.45

  const maximum = options.firstBubble ? 700 : 2_200
  return Math.round(Math.max(120, Math.min(maximum, delay)))
}
