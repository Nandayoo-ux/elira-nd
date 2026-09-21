import * as fs from 'node:fs'

export const name = 'elara-runtime-fixture-provider'
export const inject = ['llm']

class FixtureAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'ELARA fixture provider' }
  }

  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: 'fixture-model', name: 'Fixture model' }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) }
  }

  async * stream(options) {
    const text = [...options.messages].reverse()
      .find(message => message.role === 'user' && message.source.kind === 'user')
      ?.content.filter(block => block.type === 'text').map(block => block.text).join('') || ''
    const response = `fixture:${text}`
    const logPath = process.env.ELARA_RUNTIME_REQUEST_LOG
    if (logPath) {
      fs.appendFileSync(logPath, `${JSON.stringify({ text, messageCount: options.messages.length })}\n`, 'utf8')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  const unregister = ctx.llm.registerAdapter(['elara-fixture'], new FixtureAdapter())
  ctx.effect(() => () => {
    unregister()
    const marker = process.env.ELARA_RUNTIME_DISPOSE_MARKER
    if (marker) fs.writeFileSync(marker, 'disposed\n', 'utf8')
  })
}
