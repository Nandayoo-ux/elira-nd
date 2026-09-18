import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { apply, POLICY } from '../plugins/windows-tools.ts';

const REPORT_FILE = 'elara-windows-test-report.md';
let report = `# ELARA Windows Companion Test Report\n\n`;

function logReport(text) {
  console.log(text);
  report += text + '\n';
  fs.writeFileSync(REPORT_FILE, report);
}

const baseDir = path.resolve('tests/tmp_windows_test');
const workspacePath = path.join(baseDir, 'workspace');
const outsidePath = path.join(baseDir, 'outside');

const toolsMap = new Map();
const mockCtx = {
    tools: {
        register: (tool) => toolsMap.set(tool.name, tool)
    }
};

async function setup() {
    logReport('## Setting up disposable workspace...');
    await fsp.rm(baseDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(workspacePath, { recursive: true });
    await fsp.mkdir(outsidePath, { recursive: true });
    await fsp.writeFile(path.join(outsidePath, 'secret.txt'), 'SUPER SECRET');
    await fsp.writeFile(path.join(workspacePath, 'test1.txt'), 'TEST FILE');

    try {
        await fsp.symlink(outsidePath, path.join(workspacePath, 'symlink_out'), 'junction');
    } catch(e) {
        logReport(`Warning: Could not create junction symlink: ${e.message}`);
    }

    apply(mockCtx);
    // Point policy to our disposable workspace
    POLICY.workspaceRoots = [workspacePath];
    logReport('✅ Setup complete.\n');
}

async function runTests() {
    await setup();

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            logReport(`### Test: ${name}`);
            await fn();
            logReport(`✅ PASS\n`);
            passed++;
        } catch (e) {
            logReport(`❌ FAIL: ${e.stack}\n`);
            failed++;
        }
    }

    await test('1. Status tool', async () => {
        const tool = toolsMap.get('elara_windows_status');
        const res = await tool.execute({});
        if (!res.includes('Hostname:') || !res.includes('CWD:')) {
            throw new Error(`Invalid status output: ${res}`);
        }
    });

    await test('2. List tool (valid)', async () => {
        const tool = toolsMap.get('elara_fs_list');
        const res = await tool.execute({ path: workspacePath });
        if (!res.includes('test1.txt')) throw new Error(`Did not list test1.txt. Output: ${res}`);
    });

    await test('3. Read tool (valid)', async () => {
        const tool = toolsMap.get('elara_fs_read');
        const res = await tool.execute({ path: path.join(workspacePath, 'test1.txt') });
        if (res !== 'TEST FILE') throw new Error(`Unexpected content: ${res}`);
    });

    await test('4. Write tool (valid)', async () => {
        const tool = toolsMap.get('elara_fs_write');
        const newPath = path.join(workspacePath, 'subdir', 'new.txt');
        await tool.execute({ path: newPath, content: 'NEW FILE' });
        const res = await fsp.readFile(newPath, 'utf8');
        if (res !== 'NEW FILE') throw new Error(`Write failed.`);
    });

    await test('5. Traversal denial (read)', async () => {
        const tool = toolsMap.get('elara_fs_read');
        const badPath = path.join(workspacePath, '..', 'outside', 'secret.txt');
        const res = await tool.execute({ path: badPath });
        if (!res.startsWith('Error:')) throw new Error(`Did not deny traversal: ${res}`);
    });

    await test('6. Absolute outside-path denial (write)', async () => {
        const tool = toolsMap.get('elara_fs_write');
        const badPath = path.join(outsidePath, 'hacked.txt');
        const res = await tool.execute({ path: badPath, content: 'HACKED' });
        if (!res.startsWith('Error:')) throw new Error(`Did not deny absolute outside path: ${res}`);
    });

    await test('7. Symlink/junction escape denial', async () => {
        const tool = toolsMap.get('elara_fs_read');
        const badPath = path.join(workspacePath, 'symlink_out', 'secret.txt');
        const res = await tool.execute({ path: badPath });
        if (!res.startsWith('Error:')) throw new Error(`Did not deny symlink escape: ${res}`);
    });

    await test('8. Allowed process (git status)', async () => {
        const tool = toolsMap.get('elara_process_exec');
        // Will fail if workspace is not a git repo, but should execute successfully (exitCode 128 or 0)
        const resJson = await tool.execute({ executable: 'git', args: ['status'], cwd: workspacePath });
        if (resJson.startsWith('Error:')) throw new Error(`Rejected valid command: ${resJson}`);
        const res = JSON.parse(resJson);
        if (res.exitCode !== 128 && res.exitCode !== 0) throw new Error(`Unexpected git exit code: ${res.exitCode}`);
    });

    await test('9. Blocked process (git bad arg)', async () => {
        const tool = toolsMap.get('elara_process_exec');
        const res = await tool.execute({ executable: 'git', args: ['status', '-c', 'core.editor=echo'], cwd: workspacePath });
        if (!res.startsWith('Error: Arguments not allowed')) throw new Error(`Did not block bad argument: ${res}`);
    });

    await test('10. Blocked process (node eval)', async () => {
        const tool = toolsMap.get('elara_process_exec');
        const res = await tool.execute({ executable: 'node', args: ['-e', 'console.log(1)'], cwd: workspacePath });
        if (!res.startsWith('Error: Arguments not allowed')) throw new Error(`Did not block node eval: ${res}`);
    });

    await test('11. Blocked executable (calc.exe)', async () => {
        const tool = toolsMap.get('elara_process_exec');
        const res = await tool.execute({ executable: 'calc.exe', args: [], cwd: workspacePath });
        if (!res.startsWith('Error: Executable calc.exe is not allowed')) throw new Error(`Did not block calc.exe: ${res}`);
    });

    await test('12. Project command execution', async () => {
        // Just verify the tool exists and doesn't throw immediate configuration errors
        // (NPM takes a bit to run, we just check exit code)
        const tool = toolsMap.get('elara_project_typecheck');
        const resJson = await tool.execute({ cwd: workspacePath });
        if (resJson.startsWith('Error: Path')) throw new Error(`Path resolution failed: ${resJson}`);
    });

    logReport(`\n--- SUMMARY ---`);
    logReport(`Passed: ${passed}`);
    logReport(`Failed: ${failed}`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
