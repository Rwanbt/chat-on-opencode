import { randomUUID } from 'node:crypto'
import { startSIWCLogin } from '../src/siwc-login.mjs'
import { exchangeSIWCCode } from '../src/siwc-exchange.mjs'

const ID = 'chat-on-opencode'
const METHOD = 'chatgpt'
const HOST = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** One stable opaque host ID per plugin installation; no account credentials here. */
export async function stableSIWCHost(storage) {
  if (typeof storage?.get !== 'function' || typeof storage?.set !== 'function') {
    throw Error('siwc_host_storage_unavailable')
  }
  const current = await storage.get('siwc.host-id')
  if (current !== undefined && current !== null) {
    if (!HOST.test(current)) throw Error('siwc_host_id_invalid')
    return current
  }
  const candidate = 'urn:uuid:' + randomUUID()
  await storage.set('siwc.host-id', candidate)
  const persisted = await storage.get('siwc.host-id')
  if (!HOST.test(persisted ?? '')) throw Error('siwc_host_id_not_persisted')
  return persisted
}

/** Native OpenCode V2 OAuth method, not a synthetic API key.
 * All real side effects wait for a user's explicit authorization action.
 * No CoS browser cookies or personal OpenCode token files are touched.
 * Refresh/native Responses parity must qualify before production enablement. */
export function nativeSIWCMethod(hostID, {
  start = startSIWCLogin, exchange = exchangeSIWCCode,
} = {}) {
  if (!HOST.test(hostID)) throw Error('siwc_host_id_invalid')
  return {
    integrationID: ID,
    method: { id: METHOD, type: 'oauth', label: 'Continue with ChatGPT' },
    authorize: async () => {
      const request = await start({ hostID })
      if (!request || typeof request.authorizeURL !== 'string' ||
        typeof request.result?.then !== 'function' || typeof request.cancel !== 'function') {
        throw Error('siwc_authorization_unavailable')
      }
      return {
        mode: 'auto',
        url: request.authorizeURL,
        instructions: 'Complete ChatGPT authorization in your browser.',
        // V2 OAuth auto mode expects a pending Promise, NOT a function.
        // The function form is reserved for mode: code.
        callback: (async () => {
          try {
            const grant = await exchange({ callback: await request.result })
            if (!grant?.canUsePlan) throw Error('siwc_plan_permission_missing')
            if (typeof grant.clientID !== 'string' || !grant.clientID.startsWith('oaiapp_') ||
              typeof grant.subject !== 'string' || !grant.subject ||
              !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() ||
              typeof grant.accessToken !== 'string' || !grant.accessToken ||
              typeof grant.refreshToken !== 'string' || !grant.refreshToken) {
              throw Error('siwc_authorization_grant_invalid')
            }
            return {
              type: 'oauth', methodID: METHOD,
              access: grant.accessToken, refresh: grant.refreshToken,
              expires: grant.expiresAt,
              metadata: {
                clientID: grant.clientID, subject: grant.subject,
                issuer: grant.issuer, scopes: grant.scopes.join(' '),
              },
            }
          } finally { request.cancel() }
        })(),
      }
    },
  }
}

/** Register only when the caller explicitly opted into native OAuth preview.
 * The active CoS browser transport is not yet a native Responses transport;
 * this registration alone must never be described as working inference. */
export async function registerNativeSIWC(ctx, options = {}) {
  const hostID = await stableSIWCHost(ctx.storage)
  const registration = nativeSIWCMethod(hostID, options)
  await ctx.integration.transform(editor => {
    // At plugin setup time integration source reconstruction may not have
    // committed this provider yet; method registrations bind to its ID.
    editor.method.update(registration)
    // A key-based credential is not an acceptable fallback for ChatGPT plan use.
    for (const method of editor.method.list(ID)) {
      if (method.type === 'key') editor.method.remove(ID, method)
    }
  })
  return true
}
