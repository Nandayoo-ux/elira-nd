import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { splitIntoBubbles } from './format.ts'

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
