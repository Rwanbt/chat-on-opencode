import { Plugin } from '@opencode/plugin'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { GatewayLifecycle } from '../src/lifecycle.mjs'
import { traceStage } from '../src/stage-trace.mjs'
import { MessageIdentity } from './message-identity.mjs'
import { enforceTextOnlyContext } from './text-only.mjs'
import { provideLocalTitle, requirePrimaryKind } from './auxiliary.mjs'
import { provideExtractiveCompaction } from './compaction.mjs'
import { registerNativeSIWC } from './native-siwc.mjs'
import { registerNativeHTTPText } from './native-text-http.mjs'
import { stopUnavailableGatewayRetry } from './retry-policy.mjs'

// OpenCode V2 is the only frontend/session owner. The helper starts on the first *selected*
// model request, not on plugin import, so other providers remain completely unaffected.
export default Plugin.define({
  id: 'chat-on-opencode',
  async setup(ctx) {
    traceStage('plugin_setup')
    // An explicitly activated managed bundle can offer native sign-in before
    // the user knows their account's model slug. OAuth is inert until Connect;
    // explicit 'off' disables it, and inference still requires 'preview'+'text'.
    if (ctx.options.nativeOAuth !== 'off') await registerNativeSIWC(ctx)
    const nativeText = ctx.options.nativeOAuth === 'preview' && ctx.options.nativeInference === 'text'
    if (nativeText) await registerNativeHTTPText(ctx)
    const identities = new MessageIdentity()
    const option = (key: string) => typeof ctx.options[key] === 'string' ? ctx.options[key] as string : undefined
    // One unpredictable bearer per plugin instance. Neither Desktop startup nor
    // OpenCode's persisted provider configuration needs an external credential.
    const key = randomBytes(32).toString('hex')
    const readEnabled = !nativeText && option('nativeTools') === 'read'
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
    // A CoS 503 means the isolated browser is absent, unpaired or unavailable.
    // Repeated model steps cannot sign the user in; fail this provider turn explicitly.
    // Other providers and the independently consented native OAuth route are unchanged.
    if (!nativeText) await ctx.session.hook('retry', event => {
      stopUnavailableGatewayRetry(event)
    }, { providerID: 'chat-on-opencode' })
    // Only the opted-in native read definition reaches this provider. Neither CoS
    // nor the gateway may execute tools; OpenCode's native permissions own execution.
    await ctx.session.hook('context', event => enforceTextOnlyContext(event, readEnabled), { providerID: 'chat-on-opencode' })
    await ctx.session.hook('prompt', event => {
      identities.remember(event.sessionID, event.messageID)
    })
    // The V2 title hook accepts a string result. No gateway request should be
    // made for a title: it lacks a primary message ID and approval context.
    await ctx.session.hook('title', event => { provideLocalTitle(event) }, { providerID: 'chat-on-opencode' })
    // Compaction may precede even the first primary turn with a small model
    // context. It has no primary message identity, so handle it via V2's typed
    // local result rather than the ChatGPT gateway/outbox.
    await ctx.session.hook('compaction', event => { provideExtractiveCompaction(event) },
      { providerID: 'chat-on-opencode' })
    await ctx.session.hook('model.request', async event => {
      if (event.model.providerID !== 'chat-on-opencode') return
      traceStage('model_request')
      if (nativeText) return // Native V3 Responses, never CoS gateway
      requirePrimaryKind(event.kind)
      identities.require(event.sessionID)
      await service.ensure()
      event.baseURL = `http://127.0.0.1:${port}/v1`
      event.headers.Authorization = `Bearer ${key}`
    }, { providerID: 'chat-on-opencode' })
    await ctx.session.hook('http.request', event => {
      if (event.model.providerID !== 'chat-on-opencode') return
      if (nativeText) return
      requirePrimaryKind(event.kind)
      event.request.headers.set('x-opencode-session-id', event.sessionID)
      event.request.headers.set('x-opencode-message-id', identities.require(event.sessionID))
      event.request.headers.set('Authorization', `Bearer ${key}`)
    }, { providerID: 'chat-on-opencode' })
    return () => service.stop()
  },
})
