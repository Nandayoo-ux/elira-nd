import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elara windows local '))
const previousRoot = process.env.ELARA_ROOT
const previousNpmCli = process.env.ELARA_NPM_CLI
process.env.ELARA_ROOT = fixtureRoot
delete process.env.ELARA_NPM_CLI
const { executeLocalTool, resolveNpmCliEntry } = await import('../plugins/windows-tools-local.ts')

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

  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(scripts, 'bootstrap-local.ps1'),
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ELARA_STUB_MODE: mode, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` },
  })
}

describe('bootstrap native-command failure handling', () => {
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
