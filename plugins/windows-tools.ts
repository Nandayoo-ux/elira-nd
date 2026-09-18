import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executeLocalTool, POLICY } from './windows-tools-local.ts'

export const name = 'elara-windows-tools'
export const inject = { required: ['tools'], optional: ['companion'] }

export { POLICY }

export function apply(ctx: Context) {
  const isCloud = !!(ctx as any).companion;

  async function executeToolInternal(name: string, argsObj: any): Promise<string> {
    try {
      let res;
      if (isCloud) {
        res = await (ctx as any).companion.executeTool(name, argsObj);
      } else {
        res = await executeLocalTool(name, argsObj);
      }
      return typeof res === 'string' ? res : JSON.stringify(res, null, 2);
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  ctx.tools.register(defineTool({
    name: 'elara_windows_status',
    description: 'Read-only Windows laptop status: CPU load, memory usage, battery state, and disk usage, plus hostname, username and working directory.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (argsObj) => executeToolInternal('elara_windows_status', argsObj)
  }));

  ctx.tools.register(defineTool({
    name: 'elara_fs_list',
    description: 'Lists contents of a directory. Path must be inside approved workspace.',
    parameters: {
      path: { type: 'string', required: true }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (argsObj) => executeToolInternal('elara_fs_list', argsObj)
  }));

  ctx.tools.register(defineTool({
    name: 'elara_fs_read',
    description: 'Reads text file contents (max 1MB). Path must be inside approved workspace.',
    parameters: {
      path: { type: 'string', required: true }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (argsObj) => executeToolInternal('elara_fs_read', argsObj)
  }));

  ctx.tools.register(defineTool({
    name: 'elara_fs_write',
    description: 'Writes/updates a text file. Path must be inside approved workspace.',
    parameters: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (argsObj) => executeToolInternal('elara_fs_write', argsObj)
  }));

  ctx.tools.register(defineTool({
    name: 'elara_process_exec',
    description: 'Execute approved command (e.g. git, node).',
    parameters: {
      executable: { type: 'string', required: true },
      args: {
        type: 'array',
        items: { type: 'string' },
        required: true
      },
      cwd: { type: 'string' }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (argsObj) => executeToolInternal('elara_process_exec', argsObj)
  }));

  function createProjectTool(name: string, desc: string) {
    ctx.tools.register(defineTool({
      name,
      description: desc,
      parameters: { cwd: { type: 'string' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: (argsObj) => executeToolInternal(name, argsObj)
    }));
  }
  
  createProjectTool('elara_project_test', 'Run project tests (npm test)');
  createProjectTool('elara_project_build', 'Run project build (npm run build)');
  createProjectTool('elara_project_typecheck', 'Run project typecheck (npm run typecheck)');
}
