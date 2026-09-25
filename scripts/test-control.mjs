import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccessStore } from '../packages/policy/store.ts'
import { ApprovalInbox } from '../packages/policy/approvals.ts'
import { projectAudit } from '../packages/policy/audit.ts'
import { apply as applyControl } from '../plugins/elara-control.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-control-test-'))
const dbPath = path.join(tmp, 'control.db')
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const owner = { principalId: 'owner-a', originChannel: 'dashboard' }
const other = { principalId: 'owner-b', originChannel: 'dashboard' }
const wrongChannel = { principalId: 'owner-a', originChannel: 'whatsapp' }

function record(operationId, sessionId, eventType, outcome, extras = {}) {
  return { schemaVersion: 1, operationId, principalId: 'owner-a', sessionId,
    originChannel: 'dashboard', eventType, reasonCode: 'FIXTURE_EVENT', outcome,
    createdAt: Date.now(), ...extras }
}

test('audit projection rejects payloads and paginates within the exact owner scope', () => {
  const store = new AccessStore(dbPath)
  store.bindSession('dashboard:a', 'owner-a', 'dashboard')
  for (let i = 0; i < 5; i++) store.recordAudit(record(`op-${i}`, 'dashboard:a', 'policy_decision', 'allowed'))
  const page = store.listAudit('owner-a', 'dashboard', 'dashboard:a', undefined, 2)
  assert.equal(page.length, 2)
  assert.equal(store.listAudit('owner-a', 'dashboard', 'dashboard:a', page.at(-1).id, 2).length, 2)
  assert.equal(store.listAudit('owner-b', 'dashboard', 'dashboard:a').length, 0)
  assert.equal(store.listAudit('owner-a', 'whatsapp', 'dashboard:a').length, 0)
  assert.throws(() => projectAudit({ ...record('op-secret', 'dashboard:a', 'policy_decision', 'allowed'),
    reasonCode: 'synthetic secret marker' }), /AUDIT_FIELD_INVALID/)
  const leaked = { ...record('op-safe', 'dashboard:a', 'policy_decision', 'allowed'),
    arguments: 'SYNTHETIC_SECRET', stdout: 'SYNTHETIC_SECRET', rawPath: 'SYNTHETIC_SECRET',
    toolName: 'SYNTHETIC_SECRET', capabilityId: 'SYNTHETIC_SECRET' }
  store.recordAudit(leaked)
  assert.doesNotMatch(JSON.stringify(store.listAudit('owner-a', 'dashboard', 'dashboard:a')), /SYNTHETIC_SECRET/)
  store.close()
})

test('restart marks only unfinished observations unknown and never restores approvals', () => {
  let store = new AccessStore(dbPath)
  store.bindSession('dashboard:restart', 'owner-a', 'dashboard')
  store.recordAudit(record('running', 'dashboard:a', 'dispatch_started', 'requested', { executionId: 'exec-running' }))
  store.recordAudit(record('done', 'dashboard:a', 'dispatch_started', 'requested', { executionId: 'exec-done' }))
  store.recordAudit(record('done', 'dashboard:a', 'execution_settled', 'completed', { executionId: 'exec-done' }))
  store.recordAudit(record('approval', 'dashboard:a', 'approval_requested', 'requested', { approvalId: 'approval-a' }))
  const stopId = '12345678-1234-1234-1234-123456789abc'
  store.recordAudit(record(stopId, 'dashboard:restart', 'stop_requested', 'stopping', { stopRequestId: stopId }))
  store.close()
  store = new AccessStore(dbPath)
  const rows = store.listAudit('owner-a', 'dashboard', 'dashboard:a')
  assert.equal(rows.find(row => row.executionId === 'exec-running').outcome, 'unknown')
  assert.equal(rows.find(row => row.eventType === 'dispatch_started' && row.executionId === 'exec-done').outcome, 'requested')
  assert.equal(rows.find(row => row.approvalId === 'approval-a').outcome, 'unknown')
  assert.equal(store.stopStatus(stopId).status.outcome, 'unconfirmed')
  assert.equal(store.latestStopStatus('dashboard:restart').outcome, 'unconfirmed')
  store.close()
})

test('approval cancellation prevents a racing answer from issuing a grant', async () => {
  const inbox = new ApprovalInbox()
  let pending
  inbox.subscribe(view => { pending = view })
  const abort = new AbortController()
  const answer = inbox.ask({ principalId: 'owner-a', originChannel: 'dashboard', sessionId: 'dashboard:a',
    targetDeviceId: 'host', toolName: 'write', details: 'synthetic preview' }, abort.signal)
  await Promise.resolve()
  assert.ok(pending)
  inbox.cancelSession('dashboard:a')
  assert.equal(inbox.answer(pending.id, 'owner-a', 'dashboard', true), false)
  assert.equal(await answer, 'cancelled')
  inbox.close()
})

test('expired approvals are audited distinctly from cancellation', async () => {
  const inbox = new ApprovalInbox(120_000)
  let pending
  let settlement
  inbox.subscribe(view => { pending = view })
  inbox.onSettled((_view, answer) => { settlement = answer })
  const answer = inbox.ask({ principalId: 'owner-a', originChannel: 'dashboard', sessionId: 'dashboard:a',
    targetDeviceId: 'host', toolName: 'write', details: 'synthetic preview' }, new AbortController().signal)
  await Promise.resolve()
  const now = Date.now
  Date.now = () => pending.expiresAt + 1
  try { assert.equal(inbox.answer(pending.id, 'owner-a', 'dashboard', true), false) }
  finally { Date.now = now }
  assert.equal(await answer, 'cancelled')
  assert.equal(settlement, 'expired')
  inbox.close()
})

test('session stop fences prior admissions, cancels live descendants, and leaves other sessions alone', async () => {
  const store = new AccessStore(dbPath)
  store.bindSession('dashboard:b', 'owner-b', 'dashboard')
  let release
  const idle = new Promise(resolve => { release = resolve })
  const cancelled = []
  const root = { id: 'dashboard:a', cancel: cause => cancelled.push(['root', cause]), whenIdle: () => idle }
  const child = { id: 'child-a', cancel: cause => cancelled.push(['child', cause]), whenIdle: () => idle }
  const peer = { id: 'dashboard:b', cancel: cause => cancelled.push(['peer', cause]), whenIdle: () => Promise.resolve() }
  const agents = [root, child, peer]
  let guard
  let control
  const ctx = {
    agents: { list: () => agents, get: id => agents.find(agent => agent.id === id),
      isOwnedBy: (id, candidate) => id === 'child-a' && candidate === root },
    access: { bindingForSession: id => store.bindingFor(id),
      cancelSessionApprovals: () => undefined, revokeSessionGrants: () => undefined,
      recordAudit: entry => store.recordAudit(entry),
      listAudit: (...args) => store.listAudit(...args), auditHealthy: () => true,
      latestStopStatus: id => store.latestStopStatus(id), stopStatus: id => store.stopStatus(id),
      setStopGuard: value => { guard = value }, setScopeResolver: () => undefined },
    provide: (_name, value) => { control = value }, on: () => undefined,
    effect: () => undefined,
  }
  applyControl(ctx)
  assert.throws(() => control.admit(owner, 'dashboard:restart'), /SESSION_UNCONFIRMED/)
  assert.throws(() => control.requestStop(other, 'dashboard:a'), /SESSION_NOT_FOUND/)
  assert.throws(() => control.requestStop(wrongChannel, 'dashboard:a'), /SESSION_NOT_FOUND/)
  const old = control.admit(owner, 'dashboard:a')
  const peerAdmission = control.admit(other, 'dashboard:b')
  const stop = control.requestStop(owner, 'dashboard:a')
  assert.equal(stop.outcome, 'stopping')
  assert.equal(control.requestStop(owner, 'dashboard:a').id, stop.id)
  assert.deepEqual(cancelled.map(([name]) => name), ['root', 'child'])
  assert.deepEqual(cancelled.map(([, cause]) => cause), [{ kind: 'user' }, { kind: 'user' }])
  assert.throws(() => control.assertCurrent(old), /SESSION_STOPPED/)
  assert.throws(() => control.admit(owner, 'dashboard:a'), /SESSION_STOPPING/)
  assert.throws(() => guard(child), /SESSION_STOPPING/)
  assert.doesNotThrow(() => control.assertCurrent(peerAdmission))
  assert.throws(() => control.getStopStatus(other, stop.id), /SESSION_NOT_FOUND/)
  release()
  await idle
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(control.getStopStatus(owner, stop.id).outcome, 'stopped')
  assert.equal(control.requestStop(owner, 'dashboard:a').id, stop.id)
  assert.doesNotThrow(() => control.admit(owner, 'dashboard:a'))
  let releaseLocal
  const local = new Promise(resolve => { releaseLocal = resolve })
  void control.trackLocal(root, local)
  const second = control.requestStop(owner, 'dashboard:a')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(control.getStopStatus(owner, second.id).outcome, 'stopping')
  releaseLocal()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(control.getStopStatus(owner, second.id).outcome, 'stopped')
  control.admit(owner, 'dashboard:a')
  control.markUnconfirmed(root)
  const third = control.requestStop(owner, 'dashboard:a')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(control.getStopStatus(owner, third.id).outcome, 'unconfirmed')
  assert.throws(() => control.admit(owner, 'dashboard:a'), /SESSION_UNCONFIRMED/)
  assert.equal(control.listAudit(owner, 'dashboard:a').filter(row => row.stopRequestId === stop.id).length, 2)
  store.close()
})

test('audit write failure does not block cancellation and reports degraded health', async () => {
  const store = new AccessStore(dbPath)
  store.bindSession('dashboard:auditfailure', 'owner-a', 'dashboard')
  let cancelled = false
  const agent = { id: 'dashboard:auditfailure', cancel: () => { cancelled = true }, whenIdle: () => Promise.resolve() }
  let control
  const ctx = {
    agents: { list: () => [agent], get: () => agent, isOwnedBy: () => false },
    access: { bindingForSession: id => store.bindingFor(id),
      cancelSessionApprovals: () => undefined, revokeSessionGrants: () => undefined,
      recordAudit: () => { throw new Error('synthetic write failure') },
      listAudit: () => [], auditHealthy: () => false,
      latestStopStatus: () => undefined, stopStatus: () => undefined, setStopGuard: () => undefined,
      setScopeResolver: () => undefined },
    provide: (_name, value) => { control = value }, on: () => undefined, effect: () => undefined,
  }
  applyControl(ctx)
  const stop = control.requestStop(owner, 'dashboard:auditfailure')
  assert.equal(cancelled, true)
  assert.equal(control.health().audit, 'degraded')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(control.getStopStatus(owner, stop.id).outcome, 'stopped')
  store.close()
})

test('direct work without an agent keeps stop pending until the owned operation settles', async () => {
  const store = new AccessStore(dbPath)
  store.bindSession('dashboard:direct-only', 'owner-a', 'dashboard')
  store.bindSession('dashboard:direct-peer', 'owner-b', 'dashboard')
  let control
  applyControl({
    agents: { list: () => [], isOwnedBy: () => false },
    access: { bindingForSession: id => store.bindingFor(id),
      cancelSessionApprovals: () => undefined, revokeSessionGrants: () => undefined,
      recordAudit: entry => store.recordAudit(entry), listAudit: (...args) => store.listAudit(...args),
      auditHealthy: () => true, latestStopStatus: id => store.latestStopStatus(id),
      stopStatus: id => store.stopStatus(id), setStopGuard: () => undefined, setScopeResolver: () => undefined },
    provide: (_name, value) => { control = value }, on: () => undefined, effect: () => undefined,
  })
  const admission = control.admit(owner, 'dashboard:direct-only')
  const peer = control.admit(other, 'dashboard:direct-peer')
  let release
  const gate = new Promise(resolve => { release = resolve })
  let signal
  const operation = control.runDirect(admission, async currentSignal => {
    signal = currentSignal
    await gate // This synthetic operation deliberately ignores cancellation.
    return 'late result'
  })
  const stop = control.requestStop(owner, 'dashboard:direct-only')
  assert.equal(stop.outcome, 'stopping')
  assert.equal(signal.aborted, true)
  assert.equal(control.getStopStatus(owner, stop.id).outcome, 'stopping')
  assert.throws(() => control.admit(owner, 'dashboard:direct-only'), /SESSION_STOPPING/)
  assert.throws(() => control.assertCurrent(admission), /SESSION_STOPPED/)
  assert.doesNotThrow(() => control.assertCurrent(peer))
  release()
  assert.equal(await operation, 'late result')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(control.getStopStatus(owner, stop.id).outcome, 'stopped')
  store.close()
})

test('cancelling a direct remote wait leaves the stop unconfirmed after the wait settles', async () => {
  const store = new AccessStore(dbPath)
  store.bindSession('dashboard:remote-wait', 'owner-a', 'dashboard')
  let control
  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const access = { bindingForSession: id => store.bindingFor(id),
    cancelSessionApprovals: () => undefined, revokeSessionGrants: () => undefined,
    recordAudit: entry => store.recordAudit(entry), listAudit: (...args) => store.listAudit(...args),
    auditHealthy: () => true, latestStopStatus: id => store.latestStopStatus(id),
    stopStatus: id => store.stopStatus(id), setStopGuard: () => undefined, setScopeResolver: () => undefined }
  const ctx = {
    agents: { list: () => [], isOwnedBy: () => false }, access,
    provide: (_name, value) => { control = value; ctx.control = value },
    on: () => undefined, effect: () => undefined,
  }
  applyControl(ctx)
  const admission = control.admit(owner, 'dashboard:remote-wait')
  const operation = control.runDirect(admission, async signal => {
    signal.addEventListener('abort', () => control.markDirectUnconfirmed(admission), { once: true })
    started()
    await gate // The synthetic remote adapter only ends the wait; it cannot prove remote termination.
    return 'remote reply'
  })
  await entered
  const stop = control.requestStop(owner, 'dashboard:remote-wait')
  assert.equal(stop.outcome, 'stopping')
  release()
  await operation
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(control.getStopStatus(owner, stop.id).outcome, 'unconfirmed')
  store.close()
})

test('disposal leaves an unresolved stop unconfirmed', async () => {
  const store = new AccessStore(dbPath)
  store.bindSession('dashboard:disposal', 'owner-a', 'dashboard')
  let release
  const idle = new Promise(resolve => { release = resolve })
  const agent = { id: 'dashboard:disposal', cancel: () => undefined, whenIdle: () => idle }
  let control
  let dispose
  applyControl({
    agents: { list: () => [agent], get: () => agent, isOwnedBy: () => false },
    access: { bindingForSession: id => store.bindingFor(id),
      cancelSessionApprovals: () => undefined, revokeSessionGrants: () => undefined,
      recordAudit: entry => store.recordAudit(entry), listAudit: (...args) => store.listAudit(...args),
      auditHealthy: () => true, latestStopStatus: id => store.latestStopStatus(id),
      stopStatus: id => store.stopStatus(id), setStopGuard: () => undefined, setScopeResolver: () => undefined },
    provide: (_name, value) => { control = value }, on: () => undefined,
    effect: callback => { dispose = callback() },
  })
  const stop = control.requestStop(owner, 'dashboard:disposal')
  assert.equal(stop.outcome, 'stopping')
  dispose()
  assert.equal(control.getStopStatus(owner, stop.id).outcome, 'unconfirmed')
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(control.getStopStatus(owner, stop.id).outcome, 'unconfirmed')
  store.close()
})
