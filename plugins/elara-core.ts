import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'elara-core'
export const inject = ['tools', 'memory', 'access']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'elara_about',
    description: 'Return the identity and architecture role of ELARA.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return [
        'ELARA — Personal AI Computer Assistant',
        'Developed by TanDjendra',
        'Foundation: DeepSeek Harness (upstream)',
        'Mode: local-first / cloud-ready',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'elara_test_echo',
    description: 'A simple deterministic test tool that returns the exact input string.',
    parameters: {
      testString: { type: 'string', required: true }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: `Test Echo: ${value}` }],
    },
    async execute(args) {
      const payload = args as { testString: string };
      console.log(`[ELARA-TOOL-DIAG] elara_test_echo executed with args:`, JSON.stringify(payload));
      return `SUCCESS-${payload.testString}-END`;
    },
  }))

  ctx.tools.register(defineTool({
    name: 'elara_store_memory',
    description: 'Store a persistent memory about the user or project. Use this for stable preferences or facts (e.g. user prefers Indonesian). Do NOT use for secrets or casual conversation.',
    parameters: {
      content: { type: 'string', required: true },
      type: { type: 'string', enum: ['personal', 'project'], required: true },
      importance: { type: 'number' }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const payload = args as { content: string; type: 'personal' | 'project'; importance?: number };
      const execution = ctx.access.contextForAgent(exec.agent, 'tool:elara_store_memory', exec.signal)
      if (!execution) throw new Error('SESSION_OWNER_UNTRUSTED')
      const id = ctx.memory.remember(execution.principalId, payload.type, payload.content, 'llm', payload.importance || 1);
      return `Memory stored with ID ${id}`;
    },
  }))

  console.log('[ELARA] core plugin loaded')
}
