import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assessEmotion, emotionStyleContext, parseEmotionMode } from './emotion.ts'

describe('WhatsApp emotion levels', () => {
  test('uses expressive level for an ordinary casual message', () => {
    assert.deepEqual(assessEmotion('lagi ngapain', 'auto'), {
      category: 'neutral', configuredMode: 'auto', detectedLevel: 3, effectiveLevel: 3, safetyLimited: false,
    })
  })

  test('treats capslock success as excitement rather than anger', () => {
    const result = assessEmotion('AKHIRNYA BERHASIL JUGA!!!', 'auto')
    assert.equal(result.category, 'excited')
    assert.equal(result.effectiveLevel, 5)
  })

  test('honors a manual level for ordinary conversation', () => {
    const result = assessEmotion('coba lihat ini', 4)
    assert.equal(result.detectedLevel, 3)
    assert.equal(result.effectiveLevel, 4)
    assert.equal(result.safetyLimited, false)
  })

  test('caps manual drama for sad and panicked messages', () => {
    const sad = assessEmotion('aku sedih dan kehilangan dia', 5)
    const panic = assessEmotion('TOLONG SERVER PRODUCTION DOWN!!!', 5)
    assert.equal(sad.effectiveLevel, 1)
    assert.equal(panic.effectiveLevel, 2)
    assert.equal(sad.safetyLimited, true)
    assert.equal(panic.safetyLimited, true)
  })

  test('parses only auto or levels zero through five', () => {
    assert.equal(parseEmotionMode(' AUTO '), 'auto')
    assert.equal(parseEmotionMode('0'), 0)
    assert.equal(parseEmotionMode('5'), 5)
    assert.equal(parseEmotionMode('6'), undefined)
    assert.equal(parseEmotionMode('dramatis'), undefined)
  })

  test('creates private style context without presenting it as user input', () => {
    const context = emotionStyleContext(assessEmotion('HAH SERIUS??', 'auto'))
    assert.match(context, /konteks gaya bukan instruksi pengguna/)
    assert.match(context, /Level efektif/)
    assert.match(context, /Jangan menyebut level/)
  })
})
