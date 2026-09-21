export interface TranscriptionConfig {
  baseUrl: string
  apiKey?: string
  model: string
  language?: string
  timeoutMs: number
}

export interface TranscriptionInput {
  data: Uint8Array
  mimeType: string
  fileName: string
}

export function transcriptionConfig(env: NodeJS.ProcessEnv = process.env): TranscriptionConfig | undefined {
  const baseUrl = env.ELARA_TRANSCRIPTION_BASE_URL?.trim()
  if (!baseUrl) return undefined
  const parsedTimeout = Number(env.ELARA_TRANSCRIPTION_TIMEOUT_MS || 60_000)
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: env.ELARA_TRANSCRIPTION_API_KEY?.trim() || undefined,
    model: env.ELARA_TRANSCRIPTION_MODEL?.trim() || 'whisper-1',
    language: env.ELARA_TRANSCRIPTION_LANGUAGE?.trim() || 'id',
    timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout >= 1_000 && parsedTimeout <= 300_000
      ? parsedTimeout : 60_000,
  }
}

export async function transcribeAudio(
  input: TranscriptionInput,
  config: TranscriptionConfig,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData()
  const audioBuffer = new ArrayBuffer(input.data.byteLength)
  new Uint8Array(audioBuffer).set(input.data)
  form.append('file', new Blob([audioBuffer], { type: input.mimeType }), input.fileName)
  form.append('model', config.model)
  form.append('response_format', 'json')
  if (config.language) form.append('language', config.language)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetcher(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
      body: form,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Transcription provider returned HTTP ${response.status}`)
    const payload: unknown = await response.json()
    const text = typeof payload === 'object' && payload !== null && 'text' in payload
      ? String((payload as { text: unknown }).text).trim()
      : ''
    if (!text) throw new Error('Transcription provider returned no text')
    return text.slice(0, 64_000)
  } finally {
    clearTimeout(timeout)
  }
}
