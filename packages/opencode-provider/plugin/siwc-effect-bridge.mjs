// OpenCode V2 Effect ABI bridge only. Login, exchange, tokens and OAuth permissions
// belong to separately verified SIWC modules; no browser, profile or network here.
import { randomUUID } from 'node:crypto'

const INTEGRATION = 'chat-on-opencode'
const METHOD = 'chatgpt'
const HOST = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CLIENT = /^oaiapp_[A-Za-z0-9_-]{5,256}$/
const REQUIRED = ['resource.invoke', 'chatgpt.tokens.use.direct']
const fail = code => { throw new Error(code) }

/** Returns a host-native Effect, never a Promise. Exactly one SIWC method is
 * registered, and only with an explicit preview opt-in and verified dependencies. */
export function registerEffectSIWC({ Effect, ctx, start, exchange, preview, hostID }) {
  if (!Effect?.gen || !Effect?.tryPromise || !Effect?.acquireRelease || !Effect?.sync ||
      typeof start !== 'function' || typeof exchange !== 'function' ||
      !ctx?.integration?.transform || (hostID === undefined &&
        (!ctx?.storage?.get || !ctx?.storage?.set))) {
    fail('siwc_effect_capability_missing')
  }
  return Effect.gen(function* () {
    if (preview !== true) return false
    let host = hostID === undefined ? yield* ctx.storage.get('siwc.host-id') : hostID
    if ((host === undefined || host === null) && hostID === undefined) {
      const proposed = 'urn:uuid:' + randomUUID()
      yield* ctx.storage.set('siwc.host-id', proposed)
      host = yield* ctx.storage.get('siwc.host-id')
    }
    if (typeof host !== 'string' || !HOST.test(host)) fail('siwc_host_id_invalid')

    // Only this callback mutates OpenCode's own integration method registry.
    yield* ctx.integration.transform(editor => {
      if (!editor.get(INTEGRATION)) fail('siwc_integration_missing')
      editor.method.update({
        integrationID: INTEGRATION,
        method: { id: METHOD, type: 'oauth', label: 'Continue with ChatGPT' },
        authorize: () => Effect.gen(function* () {
          // Scope owns the loopback listener: interruption/exit revokes the attempt.
          const attempt = yield* Effect.acquireRelease(
            Effect.tryPromise({ try: () => start({ hostID: host }),
              catch: () => new Error('siwc_authorization_unavailable') }),
            value => Effect.sync(() => value?.cancel?.()),
          )
          if (!attempt || typeof attempt.authorizeURL !== 'string' ||
              !attempt.authorizeURL.startsWith('https://auth.openai.com/api/accounts/authorize?') ||
              typeof attempt.result?.then !== 'function' || typeof attempt.cancel !== 'function') {
            fail('siwc_authorization_invalid')
          }
          let consumed = false
          return {
            mode: 'auto', url: attempt.authorizeURL,
            instructions: 'Complete ChatGPT authorization in your browser.',
            callback: Effect.tryPromise({
              try: async () => {
                if (consumed) fail('siwc_callback_replayed')
                consumed = true
                const grant = await exchange({ callback: await attempt.result })
                if (!grant?.canUsePlan || !Array.isArray(grant.scopes) ||
                    !REQUIRED.every(scope => grant.scopes.includes(scope)) ||
                    !CLIENT.test(grant.clientID ?? '') || grant.issuer !== 'https://auth.openai.com' ||
                    typeof grant.subject !== 'string' || !grant.subject ||
                    typeof grant.accessToken !== 'string' || !grant.accessToken ||
                    typeof grant.refreshToken !== 'string' || !grant.refreshToken ||
                    !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) {
                  fail('siwc_grant_unverified')
                }
                // OpenCode alone owns native OAuth credential storage after this return.
                return { type: 'oauth', methodID: METHOD, access: grant.accessToken,
                  refresh: grant.refreshToken, expires: grant.expiresAt,
                  metadata: { clientID: grant.clientID, subject: grant.subject,
                    issuer: grant.issuer, scopes: grant.scopes.join(' ') } }
              },
              catch: () => new Error('siwc_callback_unverified'),
            }),
          }
        }),
      })
      // Never use an API-key prompt as a fallback for this provider.
      for (const method of editor.method.list(INTEGRATION)) {
        if (method.type === 'key') editor.method.remove(INTEGRATION, method)
      }
    })
    return true
  })
}
