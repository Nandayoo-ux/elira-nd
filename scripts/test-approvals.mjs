import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalInbox } from '../packages/policy/approvals.ts'

const input = {
  principalId: 'owner', originChannel: 'dashboard', sessionId: 'session-1',
  targetDeviceId: 'host', toolName: 'write', details: 'synthetic fixture only',
}

test('an approval is scoped, consumed once, and cannot cross channel or principal', async () => {
  const inbox = new ApprovalInbox()
  const controller = new AbortController()
  const pending = inbox.ask(input, controller.signal)
  const [view] = inbox.list('owner', 'dashboard')
  assert.ok(view.id)
  assert.deepEqual(inbox.list('owner', 'whatsapp'), [])
  assert.equal(inbox.answer(view.id, 'other', 'dashboard', true), false)
  assert.equal(inbox.answer(view.id, 'owner', 'whatsapp', true), false)
  assert.equal(inbox.answer(view.id, 'owner', 'dashboard', true), true)
  assert.equal(await pending, 'allowed-once')
  assert.equal(inbox.answer(view.id, 'owner', 'dashboard', true), false)
  inbox.close()
})

test('rejection, abort, expiry, and shutdown never leave a live grant', async () => {
  const inbox = new ApprovalInbox(10)
  const rejected = inbox.ask(input, new AbortController().signal)
  const rejection = inbox.list('owner', 'dashboard')[0]
  assert.equal(inbox.answer(rejection.id, 'owner', 'dashboard', false), true)
  assert.equal(await rejected, 'rejected')

  const abort = new AbortController()
  const cancelled = inbox.ask(input, abort.signal)
  abort.abort()
  assert.equal(await cancelled, 'cancelled')
  assert.deepEqual(inbox.list('owner', 'dashboard'), [])

  const expired = inbox.ask(input, new AbortController().signal)
  const expiredId = inbox.list('owner', 'dashboard')[0].id
  assert.equal(await expired, 'cancelled')
  assert.equal(inbox.answer(expiredId, 'owner', 'dashboard', true), false)

  const closing = inbox.ask(input, new AbortController().signal)
  inbox.close()
  assert.equal(await closing, 'cancelled')
  assert.equal(await inbox.ask(input, new AbortController().signal), 'cancelled')
})
