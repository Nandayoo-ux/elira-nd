import { Context } from '@deepseek-ai/cordis'

export const name = 'test-presets'
export const inject = ['agentPresets']

export function apply(ctx: Context) {
  ctx.on('ready', async () => {
    try {
      const presets = await ctx.agentPresets.list()
      console.log('--- PRESETS LIST ---')
      for (const p of presets) {
        console.log(`- ${p.id} (broken: ${p.broken})`)
      }
      console.log('--------------------')
      process.exit(0)
    } catch (err) {
      console.error(err)
      process.exit(1)
    }
  })
}
