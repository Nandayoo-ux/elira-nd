import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elara windows local '))
const previousRoot = process.env.ELARA_ROOT
const previousNpmCli = process.env.ELARA_NPM_CLI
process.env.ELARA_ROOT = fixtureRoot
delete process.env.ELARA_NPM_CLI
const { executeLocalTool, resolveNpmCliEntry, createTerminationGate, waitForProcessSettlement } =
  await import('../plugins/windows-tools-local.ts')

after(() => {
  if (previousRoot === undefined) delete process.env.ELARA_ROOT
  else process.env.ELARA_ROOT = previousRoot
  if (previousNpmCli === undefined) delete process.env.ELARA_NPM_CLI
  else process.env.ELARA_NPM_CLI = previousNpmCli
  const resolved = path.resolve(fixtureRoot)
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})

function project(name, scripts, source) {
  const root = path.join(fixtureRoot, name)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts }, null, 2))
  fs.writeFileSync(path.join(root, 'fixture.mjs'), source)
  return root
}

const successProject = project('project with spaces', {
  test: 'node ./fixture.mjs test',
  build: 'node ./fixture.mjs build',
  typecheck: 'node ./fixture.mjs typecheck',
}, "console.log(`fixture:${process.argv[2]}`)\n")

const failureProject = project('nonzero project', {
  test: 'node ./fixture.mjs',
}, "console.error('controlled failure')\nprocess.exit(7)\n")

const cancellableProject = project('cancellable project', {
  test: 'node ./fixture.mjs',
}, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['./descendant.mjs'], { stdio: 'ignore', windowsHide: true });
writeFileSync('parent.pid', String(process.pid));
writeFileSync('child.pid', String(child.pid));
setInterval(() => {}, 1000);
`)
fs.writeFileSync(path.join(cancellableProject, 'descendant.mjs'), "setInterval(() => {}, 1000)\n")

async function waitForFile(file) {
  const started = Date.now()
  while (!fs.existsSync(file)) {
    if (Date.now() - started > 10_000) throw new Error('Synthetic process did not start')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('resolves npm to a JavaScript CLI entry point', async () => {
  const npmCli = await resolveNpmCliEntry()
  assert.equal(path.basename(npmCli).toLowerCase(), 'npm-cli.js')
  assert.equal(fs.statSync(npmCli).isFile(), true)
})

test('project test, build, and typecheck run through Node in a path containing spaces', async () => {
  for (const [tool, expected] of [
    ['elara_project_test', 'fixture:test'],
    ['elara_project_build', 'fixture:build'],
    ['elara_project_typecheck', 'fixture:typecheck'],
  ]) {
    const result = await executeLocalTool(tool, { cwd: successProject })
    assert.equal(result.ok, true, result.stderr)
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, new RegExp(expected))
  }
})

test('a nonzero npm script remains a failed command result', async () => {
  const result = await executeLocalTool('elara_project_test', { cwd: failureProject })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 7)
  assert.match(result.stderr, /controlled failure/)
})

test('an explicitly configured missing npm CLI fails before spawning', async () => {
  process.env.ELARA_NPM_CLI = path.join(fixtureRoot, 'missing', 'npm-cli.js')
  try {
    await assert.rejects(
      executeLocalTool('elara_project_test', { cwd: successProject }),
      /does not point to a readable file/,
    )
  } finally {
    delete process.env.ELARA_NPM_CLI
  }
})

test('a cwd outside the configured workspace is rejected', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-outside-'))
  try {
    await assert.rejects(
      executeLocalTool('elara_project_test', { cwd: outside }),
      /outside allowed workspaces or invalid/,
    )
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('cancellation before spawn creates no project process', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(executeLocalTool('elara_project_test', { cwd: cancellableProject }, controller.signal),
    /CANCELLED_BEFORE/)
  assert.equal(fs.existsSync(path.join(cancellableProject, 'parent.pid')), false)
})

test('cancellation terminates the owned project process tree', async () => {
  const controller = new AbortController()
  const operation = executeLocalTool('elara_project_test', { cwd: cancellableProject }, controller.signal)
  await waitForFile(path.join(cancellableProject, 'child.pid'))
  const parentPid = Number(fs.readFileSync(path.join(cancellableProject, 'parent.pid'), 'utf8'))
  const childPid = Number(fs.readFileSync(path.join(cancellableProject, 'child.pid'), 'utf8'))
  controller.abort()
  const result = await operation
  assert.equal(result.ok, false)
  assert.match(result.stderr, /PROCESS_CANCELLED|PROCESS_TERMINATION_UNCONFIRMED/)
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  assert.equal(alive(parentPid), false)
  assert.equal(alive(childPid), false)
})

test('timeout and abort share one termination verification in either order', async () => {
  for (const triggers of [['timeout', 'abort'], ['abort', 'timeout']]) {
    let release
    const verifying = new Promise(resolve => { release = resolve })
    let calls = 0
    const gate = createTerminationGate(async () => { calls++; await verifying })
    const child = new EventEmitter()
    const settlement = waitForProcessSettlement(child, gate)
    const trigger = { timeout: () => gate.request(), abort: () => gate.request() }
    const first = trigger[triggers[0]]()
    const second = trigger[triggers[1]]()
    assert.strictEqual(first, second, triggers.join(' then '))
    assert.strictEqual(gate.wait(), first)
    let settled = false
    void settlement.then(() => { settled = true })
    child.emit('error', new Error('synthetic process error'))
    child.emit('close', null)
    await Promise.resolve()
    assert.equal(calls, 1)
    assert.equal(settled, false)
    release()
    const result = await settlement
    assert.equal(settled, true)
    assert.equal(result.verified, true)
    assert.match(result.error.message, /synthetic process error/)
  }
})

test('uncertain termination verification cannot resolve as confirmed', async () => {
  const gate = createTerminationGate(async () => { throw new Error('synthetic verification failure') })
  const child = new EventEmitter()
  const settlement = waitForProcessSettlement(child, gate)
  const operation = gate.request()
  assert.strictEqual(gate.request(), operation)
  child.emit('close', null)
  assert.equal((await settlement).verified, false)
})

test('environment diagnostics report presence without credential values', () => {
  const secretValue = 'fixture-secret-must-not-appear'
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'test-env.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ELARA_TEST_API_KEY: secretValue },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ELARA_TEST_API_KEY=<present>/)
  assert.equal(result.stdout.includes(secretValue), false)
})

function writeCommand(pathname, body) {
  fs.writeFileSync(pathname, `@echo off\r\n${body}\r\n`)
}

test('local launcher supplies the repository root to access and WhatsApp plugins', () => {
  const root = path.join(fixtureRoot, 'launcher root with spaces')
  const scripts = path.join(root, 'scripts')
  const runtimeBin = path.join(root, '.runtime', 'bin')
  fs.mkdirSync(scripts, { recursive: true })
  fs.mkdirSync(runtimeBin, { recursive: true })
  fs.mkdirSync(path.join(root, '.runtime', 'deepseek-harness'), { recursive: true })
  fs.mkdirSync(path.join(root, 'profiles', 'local'), { recursive: true })
  fs.copyFileSync(path.join(repositoryRoot, 'scripts', 'run-local.ps1'), path.join(scripts, 'run-local.ps1'))
  fs.writeFileSync(path.join(root, 'profiles', 'local', 'cordis.patch.yml'), '- insert: []\n')
  writeCommand(path.join(runtimeBin, 'pnpm.cmd'), 'echo ELARA_ROOT=%ELARA_ROOT%')
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'run-local.ps1'),
  ], { cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ELARA_ROOT: path.join(root, 'wrong-root') } })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`ELARA_ROOT=${root}`), result.stdout)
})

function bootstrapCase(mode) {
  const root = path.join(fixtureRoot, `bootstrap-${mode}`)
  const scripts = path.join(root, 'scripts')
  const bin = path.join(root, 'stub-bin')
  fs.mkdirSync(scripts, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(root, 'integrations', 'deepseek-harness'), { recursive: true })
  fs.copyFileSync(path.join(repositoryRoot, 'scripts', 'bootstrap-local.ps1'), path.join(scripts, 'bootstrap-local.ps1'))
  fs.copyFileSync(
    path.join(repositoryRoot, 'integrations', 'deepseek-harness', 'upstream.json'),
    path.join(root, 'integrations', 'deepseek-harness', 'upstream.json'),
  )
  if (mode !== 'clone') fs.mkdirSync(path.join(root, '.runtime', 'deepseek-harness'), { recursive: true })
  if (mode === 'upgrade') {
    fs.mkdirSync(path.join(root, '.runtime', 'deepseek-harness', 'node_modules'), { recursive: true })
    fs.mkdirSync(path.join(root, 'profiles', 'local', '.agent-presets', 'elara'), { recursive: true })
    fs.writeFileSync(path.join(root, 'profiles', 'local', '.agent-presets', 'elara', 'preset.yml'), 'name: Fixture\n')
    fs.copyFileSync(path.join(repositoryRoot, 'profiles', 'cordis.patch.template.yml'),
      path.join(root, 'profiles', 'cordis.patch.template.yml'))
    fs.writeFileSync(path.join(root, 'profiles', 'local', 'cordis.patch.yml'),
      "- insert:\n    - id: elara-core\n      name: 'fixture-core'\n    - id: custom-entry\n      name: 'fixture-custom'\n")
    for (const name of ['elara-core', 'elara-access', 'elara-control', 'elara-memory',
      'windows-tools', 'dashboard-api', 'companion-api']) {
      fs.mkdirSync(path.join(root, 'plugins'), { recursive: true })
      fs.writeFileSync(path.join(root, 'plugins', `${name}.ts`), '')
    }
    fs.mkdirSync(path.join(root, 'channels', 'whatsapp-baileys'), { recursive: true })
    fs.writeFileSync(path.join(root, 'channels', 'whatsapp-baileys', 'plugin.ts'), '')
  }

  const pin = JSON.parse(fs.readFileSync(path.join(root, 'integrations', 'deepseek-harness', 'upstream.json'))).commit
  writeCommand(path.join(bin, 'corepack.cmd'), 'exit /b 0')
  writeCommand(path.join(bin, 'git.cmd'), [
    'if "%ELARA_STUB_MODE%"=="clone" if "%1"=="clone" exit /b 9',
    `if "%1"=="-C" if "%3"=="rev-parse" echo ${mode === 'mismatch' ? '0'.repeat(40) : pin}`,
    'exit /b 0',
  ].join('\r\n'))
  writeCommand(path.join(bin, 'pnpm.cmd'), [
    'if "%ELARA_STUB_MODE%"=="install" if "%1"=="install" exit /b 8',
    'if "%ELARA_STUB_MODE%"=="build" if "%1"=="run" if "%2"=="build" exit /b 7',
    'exit /b 0',
  ].join('\r\n'))

  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(scripts, 'bootstrap-local.ps1'),
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ELARA_STUB_MODE: mode, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` },
  })
  result.fixtureRoot = root
  result.stubBin = bin
  return result
}

describe('bootstrap native-command failure handling', () => {
  test('upgrades a legacy local patch with access, control, and the existing ELARA preset', () => {
    const result = bootstrapCase('upgrade')
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const patchPath = path.join(result.fixtureRoot, 'profiles', 'local', 'cordis.patch.yml')
    const upgraded = fs.readFileSync(patchPath, 'utf8')
    for (const id of ['elara-access', 'elara-control', 'agent-presets', 'custom-entry']) {
      assert.equal((upgraded.match(new RegExp(`^\\s*- id: ${id}\\r?$`, 'gm')) || []).length, 1, id)
    }
    assert.match(upgraded, /\.agent-presets/)
    const again = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(result.fixtureRoot, 'scripts', 'bootstrap-local.ps1'),
    ], { cwd: result.fixtureRoot, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, ELARA_STUB_MODE: 'upgrade', PATH: `${result.stubBin}${path.delimiter}${process.env.PATH || ''}` } })
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`)
    assert.equal(fs.readFileSync(patchPath, 'utf8').trimEnd(), upgraded.trimEnd())
  })
  test('stops on clone failure', () => {
    const result = bootstrapCase('clone')
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /Native command failed with exit code 9: git clone/)
  })

  test('refuses an existing checkout at the wrong revision', () => {
    const result = bootstrapCase('mismatch')
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /bootstrap will\s+not reset, pull, or checkout over it/)
  })

  test('stops on dependency installation failure', () => {
    const result = bootstrapCase('install')
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /Native command failed with exit code 8: pnpm install/)
  })

  test('stops on build failure', () => {
    const result = bootstrapCase('build')
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /Native command failed with exit code 7: pnpm run build/)
  })
})
