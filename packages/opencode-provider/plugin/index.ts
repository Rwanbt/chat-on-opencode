import { Plugin } from '@opencode/plugin'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { GatewayLifecycle } from '../src/lifecycle.mjs'
import { normalizeLocation } from '../src/bridge-context.mjs'
import { traceStage } from '../src/stage-trace.mjs'
import { MessageIdentity, pinProviderMessage, bindProviderMessage } from './message-identity.mjs'
import { enforceTextOnlyContext } from './text-only.mjs'
import { admitRequest, provideLocalTitle, requirePrimaryKind } from './auxiliary.mjs'
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
    // The bridge cannot reconstruct where OpenCode runs: relative tool
    // arguments resolve against the project directory. The plugin is the
    // OpenCode-side owner of that fact, so it carries it explicitly.
    const projectDirectory = (): string | undefined => {
      const scoped = ctx as unknown as {
        location?: { directory?: string }, worktree?: { directory?: string },
      }
      return normalizeLocation(scoped.location?.directory ?? scoped.worktree?.directory) ?? undefined
    }
    // One unpredictable bearer per plugin instance. Neither Desktop startup nor
    // OpenCode's persisted provider configuration needs an external credential.
    const key = randomBytes(32).toString('hex')
    const requestedTools = option('nativeTools')
    const toolMode = nativeText ? 'off'
      : requestedTools === 'coding' ? 'coding'
      : requestedTools === 'read' ? 'read' : 'off'
    const port = Number(option('port') ?? '45861')
    const service = new GatewayLifecycle({
      entry: fileURLToPath(new URL('../src/server.mjs', import.meta.url)),
      runtimeExecutable: option('runtimeExecutable'),
      runtimeData: option('runtimeData'),
      node: option('nodeExecutable') ?? '',
      key,
      port,
      nativeTools: toolMode,
    })
    // A CoS 503 means the isolated browser is absent, unpaired or unavailable.
    // Repeated model steps cannot sign the user in; fail this provider turn explicitly.
    // Other providers and the independently consented native OAuth route are unchanged.
    if (!nativeText) await ctx.session.hook('retry', event => {
      stopUnavailableGatewayRetry(event)
    }, { providerID: 'chat-on-opencode' })
    // Only the opted-in tool contract reaches this provider. Neither CoS nor the
    // gateway may execute tools; OpenCode's native permissions own execution.
    await ctx.session.hook('context', event => enforceTextOnlyContext(event, toolMode), { providerID: 'chat-on-opencode' })
    await ctx.session.hook('prompt', event => {
      identities.remember(event.sessionID, event.messageID)
    })
    // The V2 title hook accepts a string result. No gateway request should be
    // made for a title: it lacks a primary message ID and approval context.
    await ctx.session.hook('title', event => { provideLocalTitle(event) }, { providerID: 'chat-on-opencode' })
    // A local extractive result is offered where OpenCode honours one. OpenCode
    // 2.2.4 ignores it and sends compaction as a model request (admitted below),
    // so the local attempt must never be what fails a compaction.
    await ctx.session.hook('compaction', event => {
      try { provideExtractiveCompaction(event) } catch { /* the model request compacts */ }
    }, { providerID: 'chat-on-opencode' })
    await ctx.session.hook('model.request', async event => {
      if (event.model.providerID !== 'chat-on-opencode') return
      traceStage('model_request')
      if (nativeText) return // Native V3 Responses, never CoS gateway
      if (admitRequest(event, identities) === 'primary') pinProviderMessage(event, identities)
      await service.ensure()
      event.baseURL = `http://127.0.0.1:${port}/v1`
      event.headers.Authorization = `Bearer ${key}`
      const directory = projectDirectory()
      if (directory) event.headers['x-opencode-location'] = directory
    }, { providerID: 'chat-on-opencode' })
    await ctx.session.hook('http.request', event => {
      if (event.model.providerID !== 'chat-on-opencode') return
      if (nativeText) return
      if (event.kind === 'compaction') {
        // The derived identity pinned at model.request is mandatory: a
        // compaction never falls back to the user message's own identity.
        if (!/\.compaction\.\d+$/.test(event.request.headers.get('x-opencode-message-id') ?? '')) {
          throw new Error('chat_on_opencode_compaction_identity_missing')
        }
      } else requirePrimaryKind(event.kind)
      bindProviderMessage(event, identities)
      event.request.headers.set('Authorization', `Bearer ${key}`)
      const directory = projectDirectory()
      if (directory) event.request.headers.set('x-opencode-location', directory)
    }, { providerID: 'chat-on-opencode' })
    return () => service.stop()
  },
})
