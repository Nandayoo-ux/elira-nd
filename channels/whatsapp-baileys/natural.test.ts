import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { combineQuotedContext, summarizeQuotedContent } from './message-context.ts'
import { transcriptionConfig, transcribeAudio } from './transcription.ts'
import { parseTypingSpeed, typingDelayMs } from './typing.ts'

describe('WhatsApp quoted context', () => {
  test('keeps the quoted media kind and caption', () => {
    const quote = summarizeQuotedContent({ imageMessage: { caption: 'lihat bagian kiri' } })
    assert.deepEqual(quote, { kind: 'gambar', text: 'lihat bagian kiri' })
    assert.match(combineQuotedContext(quote, 'yang ini kenapa'), /Jenis gambar/)
    assert.match(combineQuotedContext(quote, 'yang ini kenapa'), /\[Pesan sekarang\]/)
  })

  test('describes a quoted voice note even without text', () => {
    const quote = summarizeQuotedContent({ audioMessage: { ptt: true } })
    assert.match(combineQuotedContext(quote, 'maksudnya apa'), /Jenis voice note/)
  })
})

describe('WhatsApp adaptive typing', () => {
  test('adapts to length, speed, and emotion', () => {
    const short = typingDelayMs('iya', { speed: 'natural' })
    const long = typingDelayMs('ini jawaban yang lebih panjang dan butuh waktu mengetik', { speed: 'natural' })
    const urgent = typingDelayMs('bentar jangan klik itu', { category: 'panicked', emotionLevel: 2 })
    assert.ok(long > short)
    assert.ok(urgent < long)
    assert.equal(typingDelayMs('apa pun', { speed: 'instant' }), 0)
    assert.equal(parseTypingSpeed('unknown'), 'natural')
  })
})

describe('WhatsApp voice note transcription', () => {
  test('stays disabled until an endpoint is explicitly configured', () => {
    assert.equal(transcriptionConfig({}), undefined)
  })

  test('sends OpenAI compatible multipart audio and returns text', async () => {
    let request: { url: string; init?: RequestInit } | undefined
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init }
      return new Response(JSON.stringify({ text: 'halo dari voice note' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    const text = await transcribeAudio({
      data: new Uint8Array([1, 2, 3]), mimeType: 'audio/ogg', fileName: 'voice.ogg',
    }, {
      baseUrl: 'http://127.0.0.1:8000/v1', apiKey: 'test-key', model: 'whisper-1', language: 'id', timeoutMs: 5_000,
    }, fetcher as typeof fetch)
    assert.equal(text, 'halo dari voice note')
    assert.equal(request?.url, 'http://127.0.0.1:8000/v1/audio/transcriptions')
    assert.equal((request?.init?.headers as Record<string, string>).Authorization, 'Bearer test-key')
    assert.ok(request?.init?.body instanceof FormData)
  })

  test('rejects unsuccessful or empty provider responses', async () => {
    const input = { data: new Uint8Array([1]), mimeType: 'audio/ogg', fileName: 'voice.ogg' }
    const config = { baseUrl: 'http://local/v1', model: 'whisper-1', timeoutMs: 5_000 }
    await assert.rejects(() => transcribeAudio(input, config,
      (async () => new Response('{}', { status: 503 })) as typeof fetch), /HTTP 503/)
    await assert.rejects(() => transcribeAudio(input, config,
      (async () => new Response('{}', { status: 200 })) as typeof fetch), /no text/)
  })
})
