import { resolve } from 'path'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'

async function main() {
  const ctx = new Context({
    baseUrl: 'file:///' + resolve('.runtime/deepseek-harness').replace(/\\/g, '/')
  })
  ctx.plugin(Loader)
  ctx.loader.builtins.include = require('@deepseek-ai/cordis-plugin-include')
  ctx.loader.builtins['agent-presets'] = AgentPresets
  
  await ctx.loader.readConfig('.runtime/deepseek-harness/profiles/default/base.cordis.yml')
  // We don't have base.cordis.yml, wait... DSH uses custom loader
}
main()
