import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

export const POLICY = {
  get workspaceRoots() { return [path.resolve(process.env.ELARA_ROOT || process.cwd())] },
  maxReadBytes: 1024 * 1024,       // 1MB
  maxWriteBytes: 10 * 1024 * 1024, // 10MB
  maxOutputBytes: 1024 * 1024,     // 1MB
  processTimeoutMs: 30000,         // 30s
  executableRules: {
    git: {
      validator: (args: string[]) => {
        const blockedFlags = ['-c', '-C', '--config', '--git-dir', '--work-tree', '-d', '-D'];
        for (const arg of args) {
          if (blockedFlags.some(flag => arg === flag || arg.startsWith(flag + '='))) return false;
        }
        const allowedSubcommands = ['status', 'diff', 'log', 'show', 'branch'];
        const subcmd = args.find(a => !a.startsWith('-'));
        if (!subcmd) return false;
        if (!allowedSubcommands.includes(subcmd)) return false;
        return true;
      }
    },
    node: {
      validator: (args: string[]) => {
        const blockedFlags = ['-e', '--eval', '-p', '--print', '--require'];
        for (const arg of args) {
          if (blockedFlags.some(flag => arg === flag || arg.startsWith(flag + '='))) return false;
        }
        return true;
      }
    },
    tsc: {
      validator: (args: string[]) => {
        return true;
      }
    },
    npm: {
      validator: (args: string[]) => false
    },
    pnpm: {
      validator: (args: string[]) => false
    }
  }
}

async function resolveSafePath(targetPath: string): Promise<string> {
  for (const root of POLICY.workspaceRoots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await fsPromises.realpath(root);
    } catch { continue; }

    let current = path.resolve(targetPath);
    let nonExistentSuffix = '';

    while (true) {
      try {
        const resolvedCurrent = await fsPromises.realpath(current);
        const finalPath = nonExistentSuffix ? path.join(resolvedCurrent, nonExistentSuffix) : resolvedCurrent;
        const rel = path.relative(resolvedRoot, finalPath);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          return finalPath;
        }
        break;
      } catch (e: any) {
        if (e.code === 'ENOENT') {
          const parent = path.dirname(current);
          if (parent === current) break;
          nonExistentSuffix = nonExistentSuffix ? path.join(path.basename(current), nonExistentSuffix) : path.basename(current);
          current = parent;
        } else {
          break;
        }
      }
    }
  }
  throw new Error(`Path ${targetPath} is outside allowed workspaces or invalid.`);
}

interface ProcessRow { ProcessId: number; ParentProcessId: number; CreationDate: string }
async function windowsProcessRows(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
  const rows = JSON.parse(stdout)
  return Array.isArray(rows) ? rows : rows ? [rows] : []
}
function ownedProcessTree(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const ids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) if (!ids.has(row.ProcessId) && ids.has(row.ParentProcessId)) {
      ids.add(row.ProcessId); changed = true
    }
  }
  return rows.filter(row => ids.has(row.ProcessId))
}

export function createTerminationGate(terminate: () => Promise<void>) {
  let operation: Promise<void> | undefined
  return {
    request: () => (operation ??= Promise.resolve().then(terminate)),
    wait: () => operation ?? Promise.resolve(),
    verified: async () => {
      try { await operation; return true } catch { return false }
    },
  }
}

export function waitForProcessSettlement(child: Pick<ChildProcess, 'on' | 'once' | 'off'>,
  termination: ReturnType<typeof createTerminationGate>): Promise<{
    code: number | null; error?: Error; verified: boolean
  }> {
  return new Promise(resolve => {
    let failure: Error | undefined
    const onError = (error: Error) => { failure = error }
    child.on('error', onError)
    child.once('close', (code: number | null) => {
      child.off('error', onError)
      void termination.verified().then(verified => resolve({ code, error: failure, verified }))
    })
  })
}

async function safeExec(cmd: string, args: string[], cwdStr?: string, signal?: AbortSignal): Promise<{ ok: boolean, exitCode: number | null, stdout: string, stderr: string, durationMs: number }> {
  const cwd = await resolveSafePath(cwdStr || POLICY.workspaceRoots[0]);
  if (signal?.aborted) throw new Error('CANCELLED_BEFORE_SPAWN')
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let closed = false
    let cancelling = false
    let unconfirmed = false
    const started = Date.now()
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true })
    const terminate = async () => {
      if (!child.pid) { if (!child.kill()) unconfirmed = true; return }
      if (process.platform === 'win32') {
        let owned: ProcessRow[] = []
        try { owned = ownedProcessTree(await windowsProcessRows(), child.pid) }
        catch { unconfirmed = true }
        try {
          await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 5000, maxBuffer: 8192 })
        } catch { unconfirmed = true; child.kill() }
        try {
          const remaining = await windowsProcessRows()
          if (owned.some(original => remaining.some(row => row.ProcessId === original.ProcessId
            && row.CreationDate === original.CreationDate))) unconfirmed = true
          if (ownedProcessTree(remaining, child.pid).length > 0) unconfirmed = true
        } catch { unconfirmed = true }
      } else if (!child.kill()) unconfirmed = true
    }
    const termination = createTerminationGate(terminate)
    const onAbort = () => {
      if (settled || closed) return
      cancelling = true
      void termination.request().catch(() => { unconfirmed = true })
    }
    const timer = setTimeout(onAbort, POLICY.processTimeoutMs)
    timer.unref()
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.stdout.on('data', data => {
      stdout += data.toString()
      if (stdout.length > POLICY.maxOutputBytes) stdout = stdout.slice(0, POLICY.maxOutputBytes) + '\n[TRUNCATED]'
    })
    child.stderr.on('data', data => {
      stderr += data.toString()
      if (stderr.length > POLICY.maxOutputBytes) stderr = stderr.slice(0, POLICY.maxOutputBytes) + '\n[TRUNCATED]'
    })
    child.once('close', () => { closed = true })
    void waitForProcessSettlement(child, termination).then(({ code, error, verified }) => {
      if (!verified) unconfirmed = true
      settled = true
      cleanup()
      resolve({ ok: !cancelling && !error && code === 0, exitCode: error ? -1 : code, stdout,
        stderr: unconfirmed ? 'PROCESS_TERMINATION_UNCONFIRMED'
          : cancelling ? 'PROCESS_CANCELLED' : error ? stderr + '\n' + error.message : stderr,
        durationMs: Date.now() - started })
    })
  })
}

export async function resolveNpmCliEntry(): Promise<string> {
  const explicit = process.env.ELARA_NPM_CLI
  const candidates = explicit ? [explicit] : [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate): candidate is string => !!candidate)
  for (const candidate of candidates) {
    if (path.basename(candidate).toLowerCase() !== 'npm-cli.js') continue
    try {
      if ((await fsPromises.stat(candidate)).isFile()) return candidate
    } catch { /* Try the next location. */ }
  }
  throw new Error(`Configured npm CLI does not point to a readable file.`)
}

async function runPowerShell(script: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('CANCELLED_BEFORE_SPAWN')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, signal },
  )
  return stdout.trim()
}

export async function executeLocalTool(name: string, argsObj: any, signal?: AbortSignal): Promise<any> {
  const start = Date.now();
  console.log(`[ELARA-COMPANION] ${name} request start`);
  try {
    if (signal?.aborted) throw new Error('CANCELLED_BEFORE_DISPATCH')
    switch (name) {
      case 'elara_windows_status': {
        if (process.platform !== 'win32') {
          return 'ELARA Windows status is only available on Windows.'
        }
        const script = `
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os = Get-CimInstance Win32_OperatingSystem
$memTotal = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
$memFree = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
$memUsed = [math]::Round($memTotal - $memFree, 2)
$battery = Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining, BatteryStatus
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" | Select-Object -First 1 Size, FreeSpace
$result = [pscustomobject]@{
  cpuPercent = [math]::Round([double]$cpu, 1)
  memoryUsedGB = $memUsed
  memoryTotalGB = $memTotal
  batteryPercent = if ($battery) { $battery.EstimatedChargeRemaining } else { $null }
  diskUsedGB = if ($disk) { [math]::Round(($disk.Size - $disk.FreeSpace) / 1GB, 1) } else { $null }
  diskTotalGB = if ($disk) { [math]::Round($disk.Size / 1GB, 1) } else { $null }
}
$result | ConvertTo-Json -Compress
`
        const raw = await runPowerShell(script, signal)
        const status = JSON.parse(raw) as any
        
        const hostname = os.hostname();
        const username = os.userInfo().username;
        const cwd = process.cwd();

        return [
          `Hostname: ${hostname}`,
          `User: ${username}`,
          `CWD: ${cwd}`,
          `CPU: ${status.cpuPercent}%`,
          `RAM: ${status.memoryUsedGB}/${status.memoryTotalGB} GB`,
          `Battery: ${status.batteryPercent == null ? 'N/A' : `${status.batteryPercent}%`}`,
          `Disk C: ${status.diskUsedGB == null ? 'N/A' : `${status.diskUsedGB}/${status.diskTotalGB} GB`}`,
        ].join('\n');
      }

      case 'elara_fs_list': {
        const payload = argsObj as { path: string };
        const safePath = await resolveSafePath(payload.path);
        const stat = await fsPromises.stat(safePath);
        if (!stat.isDirectory()) throw new Error(`${payload.path} is not a directory.`);
        const files = await fsPromises.readdir(safePath, { withFileTypes: true });
        const list = files.map(f => `${f.isDirectory() ? '[DIR] ' : '[FILE]'} ${f.name}`).join('\n');
        return list || '(empty directory)';
      }

      case 'elara_fs_read': {
        const payload = argsObj as { path: string };
        const safePath = await resolveSafePath(payload.path);
        const stat = await fsPromises.stat(safePath);
        if (stat.isDirectory()) throw new Error(`${payload.path} is a directory.`);
        if (stat.size > POLICY.maxReadBytes) throw new Error(`File size ${stat.size} exceeds maxReadBytes ${POLICY.maxReadBytes}`);
        return await fsPromises.readFile(safePath, 'utf8');
      }

      case 'elara_fs_write': {
        const payload = argsObj as { path: string, content: string };
        if (Buffer.byteLength(payload.content, 'utf8') > POLICY.maxWriteBytes) {
           throw new Error(`Content exceeds maxWriteBytes ${POLICY.maxWriteBytes}`);
        }
        const safePath = await resolveSafePath(payload.path);
        await fsPromises.mkdir(path.dirname(safePath), { recursive: true });
        await fsPromises.writeFile(safePath, payload.content, 'utf8');
        return `Successfully wrote to ${payload.path}`;
      }

      case 'elara_process_exec': {
        const payload = argsObj as { executable: string, args: string[], cwd?: string };
        const rule = POLICY.executableRules[payload.executable as keyof typeof POLICY.executableRules];
        if (!rule) throw new Error(`Executable ${payload.executable} is not allowed.`);
        if (!rule.validator(payload.args)) {
          throw new Error(`Arguments not allowed for ${payload.executable}.`);
        }
        return await safeExec(payload.executable, payload.args, payload.cwd, signal);
      }

      case 'elara_project_test': {
        return await safeExec(process.execPath, [await resolveNpmCliEntry(), 'test'], argsObj.cwd, signal);
      }

      case 'elara_project_build': {
        return await safeExec(process.execPath, [await resolveNpmCliEntry(), 'run', 'build'], argsObj.cwd, signal);
      }

      case 'elara_project_typecheck': {
        return await safeExec(process.execPath, [await resolveNpmCliEntry(), 'run', 'typecheck'], argsObj.cwd, signal);
      }

      default:
        throw new Error(`Unknown local tool: ${name}`);
    }
  } catch (err: any) {
    throw new Error(err.message);
  } finally {
    console.log(`[ELARA-COMPANION] ${name} request completion, duration: ${Date.now() - start}ms`);
  }
}
