import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { verifyThenCleanup } from '../tests/fixtures/runtime/cleanup.mjs'
import { capabilityForTool } from '../packages/policy/evaluate.ts'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const dshRoot = path.join(repositoryRoot, '.runtime', 'deepseek-harness')
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-runtime-test-'))
const dshHome = path.join(fixtureRoot, 'dsh-home')
const requestLog = path.join(fixtureRoot, 'provider-requests.jsonl')
const disposeMarker = path.join(fixtureRoot, 'provider-disposed.txt')
const dashboardToken = 'fixture-dashboard-token-00000001'
const managedEnvironment = [
  'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'ELARA_ROOT', 'ELARA_MEMORY_DB',
  'ELARA_ACCESS_CONFIG', 'ELARA_CONTROL_DB',
  'ELARA_MODE',
  'ELARA_MOCK_WA', 'ELARA_DASHBOARD_PORT', 'ELARA_DASHBOARD_TOKEN',
  'ELARA_RUNTIME_REQUEST_LOG', 'ELARA_RUNTIME_DISPOSE_MARKER',
]
const previousEnvironment = Object.fromEntries(managedEnvironment.map(name => [name, process.env[name]]))

let ctx
let dashboardPort
let dashboardUrl
let applyWhatsAppPlugin
let ToolCallId
let RuntimeSessionId
const sent = []
let stopSentListener = () => {}

class FixturePluginContext {
  events = new EventEmitter()
  disposers = []
  readySockets = []

  constructor(resolvePreset) {
    this.agentPresets = { resolve: resolvePreset }
    this.on('elara/test-whatsapp-ready', ({ socket }) => this.readySockets.push(socket))
  }

  on(event, listener) {
    this.events.on(event, listener)
    return () => this.events.off(event, listener)
  }

  emit(event, ...args) {
    this.events.emit(event, ...args)
  }

  effect(setup) {
    const dispose = setup()
    if (dispose) this.disposers.push(dispose)
  }

  async dispose() {
    for (const dispose of this.disposers.reverse()) await dispose()
    this.events.removeAllListeners()
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('No TCP fixture port was assigned'))
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

function waitFor(predicate, label, timeoutMs = 15_000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const value = await predicate()
      if (value) return resolve(value)
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for ${label}`))
      setTimeout(() => void poll(), 20)
    }
    void poll()
  })
}

function emitMessage(jid, id, text) {
  ctx.emit('elara/test-whatsapp-upsert', {
    type: 'notify',
    messages: [{ key: { remoteJid: jid, id, fromMe: false }, message: { conversation: text } }],
  })
}

function requestRows() {
  if (!fs.existsSync(requestLog)) return []
  return fs.readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function createLocalAgent(sessionId, cwd = fixtureRoot) {
  ctx.access.bindRootSession(sessionId, 'fixture-operator', 'dashboard')
  const selection = ctx.agentDefaultModel.currentSelection()
  return ctx.agents.create({
    sessionId: RuntimeSessionId(sessionId),
    meta: { cwd, agentPreset: 'elara' },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'elara') },
  })
}

before(async () => {
  assert.equal(fs.existsSync(path.join(dshRoot, 'package.json')), true, 'Audited DSH checkout is required')
  dashboardPort = await freePort()
  dashboardUrl = `http://127.0.0.1:${dashboardPort}`
  fs.mkdirSync(dshHome, { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), '{}\n')
  const accessConfigPath = path.join(fixtureRoot, 'access.json')
  fs.writeFileSync(accessConfigPath, JSON.stringify({
    schemaVersion: 1,
    policyVersion: 'runtime-test-p2a-v1',
    devices: [
      { id: 'fixture-local', kind: 'local', enabled: true },
      { id: 'fixture-companion', kind: 'companion', enabled: true },
    ],
    principals: [
      {
        id: 'fixture-user-a', role: 'user', enabled: true,
        channelAliases: { whatsapp: ['user-a@s.whatsapp.net'] },
        allowedDeviceIds: ['fixture-companion'],
      },
      {
        id: 'fixture-user-b', role: 'user', enabled: true,
        channelAliases: { whatsapp: ['user-b@s.whatsapp.net'] },
        allowedDeviceIds: ['fixture-companion'],
      },
      {
        id: 'fixture-operator', role: 'operator', enabled: true,
        channelAliases: { dashboard: ['local-dashboard'] },
        allowedDeviceIds: ['fixture-local'],
      },
    ],
    authorities: {
      dashboardPrincipalId: 'fixture-operator',
      hostDeviceId: 'fixture-local',
      channelDefaultDeviceIds: { whatsapp: 'fixture-companion', dashboard: 'fixture-local' },
    },
  }, null, 2))
  Object.assign(process.env, {
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    ELARA_ROOT: fixtureRoot,
    ELARA_MEMORY_DB: path.join(fixtureRoot, 'memory', 'elara.db'),
    ELARA_ACCESS_CONFIG: accessConfigPath,
    ELARA_CONTROL_DB: path.join(fixtureRoot, 'control', 'elara-control.db'),
    ELARA_MODE: 'local',
    ELARA_MOCK_WA: '1',
    ELARA_DASHBOARD_PORT: String(dashboardPort),
    ELARA_DASHBOARD_TOKEN: dashboardToken,
    ELARA_RUNTIME_REQUEST_LOG: requestLog,
    ELARA_RUNTIME_DISPOSE_MARKER: disposeMarker,
  })

  const dshRequire = createRequire(path.join(dshRoot, 'apps', 'cli', 'package.json'))
  const {
    boot, createProfileResolutionGeneration, initProfile, loadProfile, PluginPackages,
  } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
  ;({ ToolCallId } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-llm')).href))
  ;({ SessionId: RuntimeSessionId } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-session')).href))
  const installAnchor = path.join(dshRoot, 'apps', 'cli', 'package.json')
  const profileDir = path.join(dshHome, 'profiles', 'runtime-test')
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const profile = loadProfile('elara-runtime-test', 'runtime-test', installAnchor, dshHome, { userLayer: false })
  const resolution = await createProfileResolutionGeneration({ installAnchor, home: dshHome, profile })
  const configPath = path.join(profileDir, 'cordis.yml')
  fs.writeFileSync(configPath, fs.readFileSync(path.join(repositoryRoot, 'tests', 'fixtures', 'runtime', 'cordis.yml')))

  // External TypeScript plugins normally resolve from an installed plugin
  // package. Mirror that layout inside this disposable fixture without
  // modifying the repository's junction or the audited DSH checkout.
  const fixtureSource = path.join(fixtureRoot, 'source')
  const copiedSources = [
    'plugins/elara-access.ts',
    'plugins/elara-core.ts', 'plugins/elara-memory.ts', 'plugins/windows-tools.ts',
    'plugins/windows-tools-local.ts', 'plugins/dashboard-api.ts', 'plugins/companion-api.ts',
    'channels/whatsapp-baileys/plugin.ts', 'channels/whatsapp-baileys/emotion.ts',
    'channels/whatsapp-baileys/format.ts', 'channels/whatsapp-baileys/message-context.ts',
    'channels/whatsapp-baileys/transcription.ts', 'channels/whatsapp-baileys/typing.ts',
    'tests/fixtures/runtime/fake-provider.ts',
    'packages/policy/contracts.ts', 'packages/policy/config.ts',
    'packages/policy/store.ts', 'packages/policy/evaluate.ts', 'packages/policy/approvals.ts',
  ]
  for (const relative of copiedSources) {
    const target = path.join(fixtureSource, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(repositoryRoot, relative), target)
  }
  fs.symlinkSync(
    path.join(dshRoot, 'node_modules', '.pnpm', 'node_modules'),
    path.join(fixtureSource, 'node_modules'),
    'junction',
  )
  fs.symlinkSync(
    path.join(repositoryRoot, 'channels', 'whatsapp-baileys', 'node_modules'),
    path.join(fixtureSource, 'channels', 'whatsapp-baileys', 'node_modules'),
    'junction',
  )
  const pluginUrl = relative => pathToFileURL(path.join(fixtureSource, relative)).href
  applyWhatsAppPlugin = (await import(pluginUrl('channels/whatsapp-baileys/plugin.ts'))).apply
  const overrides = [
    { id: 'settings', config: { path: path.join(dshHome, 'settings.yaml'), watch: false } },
    { id: 'storage-json', config: { root: path.join(dshHome, 'storages') } },
    { id: 'session-persistence-jsonl', config: { root: path.join(dshHome, 'sessions') } },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'hmr', disabled: true },
    { id: 'plugin-manager', disabled: true },
    { id: 'agent-default-model', config: { provider: 'elara-fixture', model: 'fixture-model' } },
    { insert: [
      { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
      { id: 'fixture-provider', name: pluginUrl('tests/fixtures/runtime/fake-provider.ts') },
      { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: {
        default: 'elara',
        roots: [{ path: path.join(repositoryRoot, 'profiles', 'local', '.agent-presets'), trust: 'system' }],
        includeShippedRoot: false,
        includeUserRoot: false,
      } },
      { id: 'elara-access', name: pluginUrl('plugins/elara-access.ts') },
      { id: 'elara-memory', name: pluginUrl('plugins/elara-memory.ts') },
      { id: 'elara-core', name: pluginUrl('plugins/elara-core.ts') },
      { id: 'elara-windows-tools', name: pluginUrl('plugins/windows-tools.ts') },
      { id: 'whatsapp-baileys', name: pluginUrl('channels/whatsapp-baileys/plugin.ts') },
      { id: 'dashboard-api', name: pluginUrl('plugins/dashboard-api.ts') },
      { id: 'companion-api', name: pluginUrl('plugins/companion-api.ts'), disabled: true },
    ] },
  ]
  ctx = await boot(
    'elara-runtime-test',
    configPath,
    [...profile.layers.filter(layer => layer.packageName === '@deepseek-ai/dsh-base').flatMap(layer => layer.patches), ...overrides],
    async bootCtx => {
      bootCtx.provide('profileContext', {
        name: 'runtime-test', dir: profileDir, patchPath: profile.patchPath,
        installAnchor, home: dshHome, cwd: fixtureRoot,
        startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        overlays: overrides, telemetryDisabledEnv: '1',
      })
      await bootCtx.plugin(PluginPackages, { generation: resolution })
    },
  )
  stopSentListener = ctx.on('elara/test-whatsapp-sent', payload => { sent.push(payload) })
  await waitFor(async () => {
    try {
      const response = await fetch(`${dashboardUrl}/api/status`, {
        headers: { Authorization: `Bearer ${dashboardToken}` },
      })
      return response.status === 200
    } catch {
      return false
    }
  }, 'dashboard startup')
})

after(async () => {
  await verifyThenCleanup({
    verify: async () => {
      stopSentListener()
      await ctx?.fiber.dispose()
      if (ctx) {
        assert.equal(fs.readFileSync(disposeMarker, 'utf8').trim(), 'disposed')
        await assert.rejects(fetch(`${dashboardUrl}/api/status?disposed=1`, { headers: { Connection: 'close' } }))
      }
    },
    cleanup: [
      () => {
        for (const name of managedEnvironment) {
          const previous = previousEnvironment[name]
          if (previous === undefined) delete process.env[name]
          else process.env[name] = previous
        }
      },
      async () => {
        const resolved = path.resolve(fixtureRoot)
        assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
        await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      },
    ],
  })
})

describe('offline DSH-loader composition', () => {
  test('disposal waits for delayed startup and prevents late socket creation', async () => {
    const gate = deferred()
    const lifecycleCtx = new FixturePluginContext(() => gate.promise)
    applyWhatsAppPlugin(lifecycleCtx)

    let disposalFinished = false
    const disposal = lifecycleCtx.dispose().then(() => { disposalFinished = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposalFinished, false, 'disposal must account for the pending startup')

    gate.resolve()
    await disposal
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(lifecycleCtx.readySockets.length, 0, 'a disposed instance must not create a socket')
  })

  test('parallel plugin instances own independent mutable transport state', async () => {
    const first = new FixturePluginContext(async () => ({}))
    const second = new FixturePluginContext(async () => ({}))
    applyWhatsAppPlugin(first)
    applyWhatsAppPlugin(second)

    await waitFor(
      () => first.readySockets.length === 1 && second.readySockets.length === 1,
      'independent fixture sockets',
    )
    const firstSocket = first.readySockets[0]
    const secondSocket = second.readySockets[0]
    assert.notEqual(firstSocket, secondSocket)
    assert.notEqual(firstSocket.ev, secondSocket.ev)
    assert.equal(firstSocket.ev.listenerCount('messages.upsert'), 1)
    assert.equal(secondSocket.ev.listenerCount('messages.upsert'), 1)

    firstSocket.ev.removeAllListeners('messages.upsert')
    assert.equal(firstSocket.ev.listenerCount('messages.upsert'), 0)
    assert.equal(secondSocket.ev.listenerCount('messages.upsert'), 1)
    await Promise.all([first.dispose(), second.dispose()])
  })

  test('fixture cleanup still completes and preserves a verification failure', async () => {
    const failureRoot = fs.mkdtempSync(path.join(fixtureRoot, 'forced-cleanup-failure-'))
    const marker = path.join(failureRoot, 'marker.txt')
    const variable = 'ELARA_RUNTIME_CLEANUP_PROBE'
    const previous = process.env[variable]
    const originalFailure = new Error('forced fixture verification failure')
    fs.writeFileSync(marker, 'temporary fixture\n')
    process.env[variable] = 'temporary-value'

    let observedFailure
    try {
      await verifyThenCleanup({
        verify: async () => { throw originalFailure },
        cleanup: [
          () => {
            if (previous === undefined) delete process.env[variable]
            else process.env[variable] = previous
          },
          () => fs.rmSync(failureRoot, { recursive: true, force: true }),
        ],
      })
    } catch (error) {
      observedFailure = error
    }

    assert.equal(observedFailure, originalFailure)
    assert.equal(process.env[variable], previous)
    assert.equal(fs.existsSync(failureRoot), false)
  })

  test('mounts the real ELARA preset through the DSH roster', async () => {
    const preset = await ctx.agentPresets.resolve('elara')
    assert.equal(preset.id, 'elara')
    const key = await ctx.agentPresets.standingKeyFor('elara')
    assert.equal(key.agentPreset, 'elara')
  })

  test('the enabled tool inventory has an explicit P2A classification', () => {
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    const unknown = names.filter(toolName => capabilityForTool(toolName, {}).risk === 'unknown')
    assert.deepEqual(unknown, [], `unclassified enabled tools: ${unknown.join(', ')}`)
  })

  test('dashboard authentication accepts only the fixture token', async () => {
    const unauthorized = await fetch(`${dashboardUrl}/api/status`)
    assert.equal(unauthorized.status, 401)
    const authorized = await fetch(`${dashboardUrl}/api/status`, {
      headers: { Authorization: `Bearer ${dashboardToken}` },
    })
    assert.equal(authorized.status, 200)
    assert.equal((await authorized.json()).status, 'running')
    assert.equal(fs.existsSync(path.join(fixtureRoot, '.runtime', 'dashboard-token.txt')), false)
  })

  test('fake WhatsApp transport rejects groups and deduplicates delivery', async () => {
    const initialRequests = requestRows().length
    emitMessage('group@g.us', 'group-message', 'ignored group')
    emitMessage('user-a@s.whatsapp.net', 'duplicate-message', 'first hello')
    emitMessage('user-a@s.whatsapp.net', 'duplicate-message', 'first hello')
    await waitFor(() => sent.find(item => item.remoteJid === 'user-a@s.whatsapp.net'), 'first WhatsApp response')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(sent.filter(item => item.remoteJid === 'group@g.us').length, 0)
    assert.equal(sent.filter(item => item.remoteJid === 'user-a@s.whatsapp.net').length, 1)
    assert.equal(requestRows().length, initialRequests + 1)
  })

  test('unknown WhatsApp senders cannot trigger a reply, model request, or session', async () => {
    const requestCount = requestRows().length
    const sentCount = sent.length
    emitMessage('unknown@s.whatsapp.net', 'unknown-user-1', 'should be ignored')
    ctx.emit('elara/test-whatsapp-upsert', {
      type: 'notify',
      messages: [{
        key: { remoteJid: 'unknown@s.whatsapp.net', id: 'unknown-media-1', fromMe: false },
        message: { imageMessage: { caption: 'unknown media', fileLength: 128, mimetype: 'image/png' } },
      }],
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(requestRows().length, requestCount)
    assert.equal(sent.length, sentCount)
    assert.equal(ctx.agents.get('whatsapp:unknown@s.whatsapp.net'), undefined)
  })

  test('two users receive separate sessions and one user reuses its session', async () => {
    const userAId = 'whatsapp:user-a@s.whatsapp.net'
    const userBId = 'whatsapp:user-b@s.whatsapp.net'
    const firstAgent = ctx.agents.get(userAId)
    assert.ok(firstAgent)

    emitMessage('user-b@s.whatsapp.net', 'user-b-1', 'hello from b')
    await waitFor(() => sent.find(item => item.remoteJid === 'user-b@s.whatsapp.net'), 'second user response')
    const secondAgent = ctx.agents.get(userBId)
    assert.ok(secondAgent)
    assert.notEqual(firstAgent, secondAgent)

    const before = requestRows().at(-1).messageCount
    emitMessage('user-a@s.whatsapp.net', 'user-a-2', 'second hello')
    await waitFor(() => sent.filter(item => item.remoteJid === 'user-a@s.whatsapp.net').length === 2, 'reused-session response')
    assert.equal(ctx.agents.get(userAId), firstAgent)
    assert.ok(requestRows().at(-1).messageCount > before)
  })

  test('a later pre-execute listener cannot override the final sensitive-operation denial', async () => {
    const agent = ctx.agents.get(RuntimeSessionId('whatsapp:user-a@s.whatsapp.net'))
    assert.ok(agent)
    const stopOverride = ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('fixture-sensitive-override'),
        name: 'elara_project_test',
        arguments: { cwd: fixtureRoot },
        agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, true)
      assert.match(result.error.message, /P2A_APPROVAL_REQUIRED/)
    } finally {
      stopOverride()
    }
  })

  test('a local runtime-owned child inherits host authority while an unbound root fails closed', async () => {
    const parentHandle = await createLocalAgent('fixture-local-parent')
    const parent = parentHandle.agent
    const selection = ctx.agentDefaultModel.currentSelection()
    const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'elara') }
    const childHandle = await ctx.agents.create({
      sessionId: RuntimeSessionId('fixture-owned-child'),
      parentAgent: parent,
      meta: { cwd: fixtureRoot, parentSession: parent.id, origin: 'subagent', agentPreset: 'elara' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
    const rootHandle = await ctx.agents.create({
      sessionId: RuntimeSessionId('fixture-unbound-root'),
      meta: { cwd: fixtureRoot, agentPreset: 'elara' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
    assert.equal(ctx.access.bindingForSession('fixture-owned-child')?.principalId, 'fixture-operator')
    assert.equal(ctx.access.bindingForSession('fixture-unbound-root'), undefined)
    const notePath = path.join(fixtureRoot, 'read-only-note.txt')
    fs.writeFileSync(notePath, 'reviewed read only fixture\n')
    try {
      const childResult = await ctx.tools.execute({
        callId: ToolCallId('fixture-child-read'), name: 'read',
        arguments: { file_path: notePath, limit: 5 }, agent: childHandle.agent,
        signal: new AbortController().signal,
      })
      assert.equal(childResult.isError, false)
      const rootResult = await ctx.tools.execute({
        callId: ToolCallId('fixture-unbound-read'), name: 'read',
        arguments: { file_path: notePath, limit: 5 }, agent: rootHandle.agent,
        signal: new AbortController().signal,
      })
      assert.equal(rootResult.isError, true)
      assert.match(rootResult.error.message, /PRINCIPAL_DISABLED_OR_UNKNOWN/)
    } finally {
      await Promise.all([childHandle.dispose(), rootHandle.dispose(), parentHandle.dispose()])
    }
  })

  test('companion-selected authority cannot execute a native host read', async () => {
    const agent = ctx.agents.get(RuntimeSessionId('whatsapp:user-a@s.whatsapp.net'))
    assert.ok(agent)
    const notePath = path.join(fixtureRoot, 'companion-host-note.txt')
    fs.writeFileSync(notePath, 'must stay on host\n')
    let resolveCalls = 0
    const originalResolve = ctx.fs.resolve
    ctx.fs.resolve = (...args) => {
      resolveCalls++
      return originalResolve.call(ctx.fs, ...args)
    }
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('fixture-companion-host-read'), name: 'read',
        arguments: { file_path: notePath, limit: 5 }, agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, true)
      assert.match(result.error.message, /EXECUTION_TARGET_MISMATCH/)
      const nonexistent = await ctx.tools.execute({
        callId: ToolCallId('fixture-companion-host-read-nonexistent'), name: 'read',
        arguments: { file_path: path.join(fixtureRoot, 'definitely-not-present.txt'), limit: 5 }, agent,
        signal: new AbortController().signal,
      })
      assert.equal(nonexistent.isError, true)
      assert.match(nonexistent.error.message, /EXECUTION_TARGET_MISMATCH/)
      assert.equal(resolveCalls, 0, 'the native filesystem resolver must not run')
    } finally {
      ctx.fs.resolve = originalResolve
    }
  })

  test('canonical private reads are denied before the normal loader invokes the filesystem tool', async () => {
    const privateDir = path.join(fixtureRoot, '.runtime')
    const privateFile = path.join(privateDir, 'synthetic-secret.txt')
    const safeDir = path.join(fixtureRoot, 'safe')
    fs.mkdirSync(privateDir, { recursive: true })
    fs.mkdirSync(safeDir, { recursive: true })
    fs.writeFileSync(privateFile, 'synthetic fixture secret only\n')
    const handle = await createLocalAgent('fixture-private-read-root')
    const cwdHandle = await createLocalAgent('fixture-private-cwd-root', privateDir)
    const cases = [
      { agent: handle.agent, path: path.join('.runtime', 'synthetic-secret.txt') },
      { agent: handle.agent, path: path.join('safe', '..', '.runtime', 'synthetic-secret.txt') },
      { agent: handle.agent, path: privateFile },
      { agent: cwdHandle.agent, path: 'synthetic-secret.txt' },
    ]
    if (process.platform === 'win32') {
      cases.push({ agent: handle.agent, path: '.runtime/synthetic-secret.txt' })
      const envFile = path.join(fixtureRoot, '.env')
      fs.writeFileSync(envFile, 'synthetic fixture only\n')
      fs.writeFileSync(`${envFile}:fixture`, 'synthetic stream only\n')
      cases.push({ agent: handle.agent, path: '.env:fixture' })
      cases.push({ agent: handle.agent, path: `${envFile}:fixture:$DATA` })
    }
    let resolveCalls = 0
    const originalResolve = ctx.fs.resolve
    ctx.fs.resolve = (...args) => {
      resolveCalls++
      return originalResolve.call(ctx.fs, ...args)
    }
    try {
      for (const [index, entry] of cases.entries()) {
        const result = await ctx.tools.execute({
          callId: ToolCallId(`fixture-private-read-${index}`), name: 'read',
          arguments: { file_path: entry.path, limit: 5 }, agent: entry.agent,
          signal: new AbortController().signal,
        })
        assert.equal(result.isError, true, entry.path)
        assert.match(result.error.message, /P2A_APPROVAL_REQUIRED/, entry.path)
      }
      assert.equal(resolveCalls, 0, 'protected reads must not reach the filesystem resolver')
    } finally {
      ctx.fs.resolve = originalResolve
      await Promise.all([handle.dispose(), cwdHandle.dispose()])
    }
  })

  test('link traversal to a protected target is denied before filesystem resolution', async t => {
    const privateDir = path.join(fixtureRoot, '.runtime')
    const linkDir = path.join(fixtureRoot, 'synthetic-private-link')
    fs.mkdirSync(privateDir, { recursive: true })
    fs.writeFileSync(path.join(privateDir, 'linked-secret.txt'), 'synthetic fixture secret only\n')
    try {
      fs.symlinkSync(privateDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`link creation unavailable: ${error.code || error.message}`)
      return
    }
    const handle = await createLocalAgent('fixture-linked-read-root')
    let resolveCalls = 0
    const originalResolve = ctx.fs.resolve
    ctx.fs.resolve = (...args) => {
      resolveCalls++
      return originalResolve.call(ctx.fs, ...args)
    }
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('fixture-linked-private-read'), name: 'read',
        arguments: { file_path: path.join(linkDir, 'linked-secret.txt'), limit: 5 }, agent: handle.agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, true)
      assert.match(result.error.message, /P2A_APPROVAL_REQUIRED|FILESYSTEM_LINK_SCOPE_DISABLED/)
      assert.equal(resolveCalls, 0)
    } finally {
      ctx.fs.resolve = originalResolve
      await handle.dispose()
    }
  })

  test('broad glob and grep fail closed before ripgrep is spawned', async () => {
    const handle = await createLocalAgent('fixture-search-root')
    let spawnCalls = 0
    const originalSpawn = ctx.subprocess.spawn
    ctx.subprocess.spawn = (...args) => {
      spawnCalls++
      return originalSpawn.call(ctx.subprocess, ...args)
    }
    try {
      for (const request of [
        { name: 'glob', arguments: { pattern: '**/*', path: fixtureRoot } },
        { name: 'grep', arguments: { pattern: 'synthetic', path: fixtureRoot } },
      ]) {
        const result = await ctx.tools.execute({
          callId: ToolCallId(`fixture-disabled-${request.name}`), ...request, agent: handle.agent,
          signal: new AbortController().signal,
        })
        assert.equal(result.isError, true)
        assert.match(result.error.message, /SEARCH_SCOPE_UNENFORCEABLE/)
      }
      assert.equal(spawnCalls, 0, 'ripgrep must not spawn for a denied search')
    } finally {
      ctx.subprocess.spawn = originalSpawn
      await handle.dispose()
    }
  })

  test('cloud mode denies native host reads before filesystem resolution', async () => {
    const handle = await createLocalAgent('fixture-cloud-host-root')
    const notePath = path.join(fixtureRoot, 'cloud-host-note.txt')
    fs.writeFileSync(notePath, 'local-only fixture\n')
    let resolveCalls = 0
    const originalResolve = ctx.fs.resolve
    const previousMode = process.env.ELARA_MODE
    ctx.fs.resolve = (...args) => {
      resolveCalls++
      return originalResolve.call(ctx.fs, ...args)
    }
    process.env.ELARA_MODE = 'cloud'
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('fixture-cloud-host-read'), name: 'read',
        arguments: { file_path: notePath, limit: 5 }, agent: handle.agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, true)
      assert.match(result.error.message, /HOST_EXECUTION_DISABLED_IN_CLOUD/)
      assert.equal(resolveCalls, 0)
    } finally {
      process.env.ELARA_MODE = previousMode
      ctx.fs.resolve = originalResolve
      await handle.dispose()
    }
  })

  test('dashboard token cannot take over a WhatsApp-owned session', async () => {
    const response = await fetch(`${dashboardUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${dashboardToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'whatsapp:user-a@s.whatsapp.net', message: 'dashboard ping',
        principalId: 'fixture-user-a', role: 'operator',
      }),
    })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'SESSION_OWNER_CONFLICT')
  })

  test('dashboard project execution stops at approval-required before dispatch', async () => {
    const response = await fetch(`${dashboardUrl}/api/project/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${dashboardToken}` },
    })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.decision, 'approval_required')
    assert.equal(body.reasonCode, 'P2A_APPROVAL_REQUIRED')
  })
})
