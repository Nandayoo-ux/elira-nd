import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { executeLocalTool, POLICY } from './windows-tools-local.ts'
import type { DirectExecutionRequest } from './elara-access.ts'
import { executionRoute } from '../packages/policy/evaluate.ts'

export const name = 'elara-windows-tools'
export const inject = ['tools', 'access']
export { POLICY }

async function route(ctx: Context, name: string, args: unknown, target: string): Promise<string> {
  const kind = ctx.access.deviceKind(target)
  const destination = executionRoute(process.env.ELARA_MODE, kind)
  let result: any
  if (destination === 'companion') {
    const companion = (ctx as any).companion
    if (!companion) throw new Error('COMPANION_UNAVAILABLE')
    result = await companion.executeTool(name, args, target)
  } else {
    result = await executeLocalTool(name, args)
  }
  if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
    throw new Error(result.stderr || `Command failed: ${String(result.exitCode)}`)
  }
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
}

export async function executeReviewedWindowsTool(
  ctx: Context, request: DirectExecutionRequest, name: string, args: unknown,
): Promise<string> {
  return ctx.access.executeDirect(request, () => route(ctx, name, args, request.targetDeviceId))
}

export function apply(ctx: Context) {
  const run = (name: string, args: unknown, exec: ToolRunContext) => {
    const execution = ctx.access.contextForAgent(exec.agent, `tool:${name}`, exec.signal)
    if (!execution) throw new Error('SESSION_OWNER_UNTRUSTED')
    return route(ctx, name, args, execution.targetDeviceId)
  }
  const register = (name: string, description: string, parameters: any) => {
    ctx.tools.register(defineTool({
      name, description, parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args, exec) => run(name, args, exec),
    }))
  }
  register('elara_windows_status', 'Read-only status of the selected Windows device.', {})
  for (const action of ['test', 'build', 'typecheck']) {
    register(`elara_project_${action}`, `Run project ${action} on the selected device.`, { cwd: { type: 'string' } })
  }
  if (process.env.ELARA_ENABLE_LEGACY_TOOLS === '1') {
    register('elara_fs_list', 'List workspace directory.', { path: { type: 'string', required: true } })
    register('elara_fs_read', 'Read workspace text file.', { path: { type: 'string', required: true } })
    register('elara_fs_write', 'Write workspace text file.', {
      path: { type: 'string', required: true }, content: { type: 'string', required: true },
    })
    register('elara_process_exec', 'Execute a selected process.', {
      executable: { type: 'string', required: true },
      args: { type: 'array', items: { type: 'string' }, required: true }, cwd: { type: 'string' },
    })
  }
}
