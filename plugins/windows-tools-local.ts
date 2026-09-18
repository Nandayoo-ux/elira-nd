import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

export const POLICY = {
  workspaceRoots: [process.cwd()],
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

async function safeExec(cmd: string, args: string[], cwdStr?: string): Promise<{ ok: boolean, exitCode: number | null, stdout: string, stderr: string, durationMs: number }> {
    let cwd = process.cwd();
    if (cwdStr) {
      cwd = await resolveSafePath(cwdStr);
    }
    
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        
        const child = spawn(cmd, args, {
            cwd,
            shell: false,
            windowsHide: true,
            timeout: POLICY.processTimeoutMs
        });
        
        const startTime = Date.now();
        
        child.stdout.on('data', (data) => {
            stdout += data.toString();
            if (stdout.length > POLICY.maxOutputBytes) stdout = stdout.slice(0, POLICY.maxOutputBytes) + '\n[TRUNCATED]';
        });
        
        child.stderr.on('data', (data) => {
            stderr += data.toString();
            if (stderr.length > POLICY.maxOutputBytes) stderr = stderr.slice(0, POLICY.maxOutputBytes) + '\n[TRUNCATED]';
        });
        
        child.on('error', (err) => {
            resolve({ ok: false, exitCode: -1, stdout, stderr: stderr + '\n' + err.message, durationMs: Date.now() - startTime });
        });
        
        child.on('close', (code) => {
            resolve({ ok: code === 0, exitCode: code, stdout, stderr, durationMs: Date.now() - startTime });
        });
    });
}

async function runPowerShell(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
  )
  return stdout.trim()
}

export async function executeLocalTool(name: string, argsObj: any): Promise<any> {
  const start = Date.now();
  console.log(`[ELARA-COMPANION] ${name} request start`);
  try {
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
        const raw = await runPowerShell(script)
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
        return await safeExec(payload.executable, payload.args, payload.cwd);
      }

      case 'elara_project_test': {
        return await safeExec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], argsObj.cwd);
      }

      case 'elara_project_build': {
        return await safeExec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], argsObj.cwd);
      }

      case 'elara_project_typecheck': {
        return await safeExec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'typecheck'], argsObj.cwd);
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
