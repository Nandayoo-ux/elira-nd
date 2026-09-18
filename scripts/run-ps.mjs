import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

// Attempt pwsh first (PowerShell Core, cross-platform)
let result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], { stdio: 'inherit' });

// Fallback to powershell (Windows PowerShell) if pwsh is missing
if (result.error && result.error.code === 'ENOENT') {
  result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], { stdio: 'inherit' });
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
