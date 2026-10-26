// OFFLINE TEST FIXTURE ONLY. Contains no real OAuth client, user account or key.
import { Plugin } from '@opencode/plugin'
import { registerNativeHTTPText } from '../../../plugin/native-text-http.mjs'
import { enforceTextOnlyContext } from '../../../plugin/text-only.mjs'
import { provideLocalTitle } from '../../../plugin/auxiliary.mjs'
import { appendFileSync } from 'node:fs'

export default Plugin.define({
  id: 'synthetic-siwc-text-test-only',
  async setup(ctx) {
    const mark = value => {
      if (typeof ctx.options.testMarker === 'string') appendFileSync(ctx.options.testMarker, value + '\n')
    }
    mark('setup')
    const token = 'synthetic-native-cli-token-12345'
    const subject = 'synthetic-native-subject'
    const integration = { connection: {
      active: async () => ({ type: 'credential', id: 'synthetic-test-only-credential' }),
      resolve: async () => ({ type: 'oauth', methodID: 'chatgpt', access: token,
        expires: Date.now() + 120000,
        metadata: { issuer: 'https://auth.openai.com', subject,
          clientID: 'oaiapp_synthetic_cli_test',
          scopes: 'resource.invoke chatgpt.tokens.use.direct' } }),
    } }
    const host = { ...ctx, integration,
      options: { ...ctx.options, nativeOAuth: 'preview', nativeInference: 'text' } }
    const base = ctx.options.testEndpoint
    if (typeof base !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
      throw Error('test_only_loopback_required')
    }
    await registerNativeHTTPText(host, { modelsEndpoint: base + '/v1/models',
      baseURL: base + '/v1', allowLoopbackTest: true })
    await ctx.session.hook('context', event => enforceTextOnlyContext(event, false),
      { providerID: 'chat-on-opencode' })
    await ctx.session.hook('title', event => provideLocalTitle(event),
      { providerID: 'chat-on-opencode' })
    mark('registered')
  },
})
