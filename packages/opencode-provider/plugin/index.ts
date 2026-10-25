import { Plugin } from '@opencode/plugin'
import { fileURLToPath } from 'node:url'
import { GatewayLifecycle } from '../src/lifecycle.mjs'
import { MessageIdentity } from './message-identity.mjs'
import { enforceTextOnlyContext } from './text-only.mjs'

// OpenCode V2 is the only frontend/session owner. The helper starts on the first *selected*
// model request, not on plugin import, so other providers remain completely unaffected.
export default Plugin.define({
  id: 'chat-on-opencode',
  async setup(ctx) {
    const identities = new MessageIdentity()
    const option = (key: string) => typeof ctx.options[key] === 'string' ? ctx.options[key] as string : undefined
    const key = process.env.CHAT_ON_OPENCODE_GATEWAY_KEY ?? ''
    const readEnabled = option('nativeTools') === 'read'
    const port = Number(option('port') ?? '45861')
    const service = new GatewayLifecycle({
      entry: fileURLToPath(new URL('../src/server.mjs', import.meta.url)),
      runtimeExecutable: option('runtimeExecutable'),
      runtimeData: option('runtimeData'),
      node: option('nodeExecutable') ?? '',
      key,
      port,
      nativeTools: readEnabled ? 'read' : 'off',
    })
    // Only the opted-in native read definition reaches this provider. Neither CoS
    // nor the gateway may execute tools; OpenCode's native permissions own execution.
    await ctx.session.hook('context', event => enforceTextOnlyContext(event, readEnabled), { providerID: 'chat-on-opencode' })
    await ctx.session.hook('prompt', event => {
      identities.remember(event.sessionID, event.messageID)
    })
    await ctx.session.hook('model.request', async event => {
      if (event.model.providerID !== 'chat-on-opencode') return
      if (event.kind !== 'primary') throw new Error('chat_on_opencode_auxiliary_requests_not_supported')
      identities.require(event.sessionID)
      await service.ensure()
      event.baseURL = `http://127.0.0.1:${port}/v1`
      event.headers.Authorization = `Bearer ${key}`
    }, { providerID: 'chat-on-opencode' })
    await ctx.session.hook('http.request', event => {
      if (event.model.providerID !== 'chat-on-opencode') return
      if (event.kind !== 'primary') throw new Error('chat_on_opencode_auxiliary_requests_not_supported')
      event.request.headers.set('x-opencode-session-id', event.sessionID)
      event.request.headers.set('x-opencode-message-id', identities.require(event.sessionID))
      event.request.headers.set('Authorization', `Bearer ${key}`)
    }, { providerID: 'chat-on-opencode' })
    return () => service.stop()
  },
})
