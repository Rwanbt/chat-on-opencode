import { requireSIWCModel } from './siwc-models.mjs'
import { sendResponses } from './responses-transport.mjs'

const INTEGRATION = 'chat-on-opencode'
const METHOD = 'chatgpt'
const ISSUER = 'https://auth.openai.com'
const REQUIRED = new Set(['resource.invoke', 'chatgpt.tokens.use.direct'])
const SUBJECT = /^[A-Za-z0-9._:@-]{3,256}$/
const CLIENT = /^oaiapp_[A-Za-z0-9_-]{5,256}$/

export class ConnectedResponsesError extends Error {
  constructor(code) { super(code); this.name = 'ConnectedResponsesError'; this.code = code }
}
const fail = code => { throw new ConnectedResponsesError(code) }

/** Resolve only the active, previously validated native SIWC OAuth credential.
 * No auth.json, env, CLI cache, Chromium cookies, or user files are inspected. */
export async function connectedSIWCGrant(integration, { accountID, model, catalog, signal } = {}) {
  if (!SUBJECT.test(accountID ?? '') || !integration?.connection ||
    typeof integration.connection.active !== 'function' ||
    typeof integration.connection.resolve !== 'function') fail('siwc_connection_unavailable')
  try { requireSIWCModel(catalog, accountID, model) }
  catch { fail('siwc_model_not_authorized') }
  if (signal?.aborted) fail('siwc_connection_cancelled')
  let connection, credential
  try {
    connection = await integration.connection.active(INTEGRATION)
    if (!connection || connection.type !== 'credential') fail('siwc_oauth_not_connected')
    if (signal?.aborted) fail('siwc_connection_cancelled')
    credential = await integration.connection.resolve(connection)
  } catch (error) {
    if (error instanceof ConnectedResponsesError) throw error
    fail('siwc_connection_unavailable')
  }
  if (signal?.aborted) fail('siwc_connection_cancelled')
  const metadata = credential?.metadata
  const scopes = typeof metadata?.scopes === 'string' && metadata.scopes.length < 2048
    ? metadata.scopes.split(/\s+/).filter(Boolean) : []
  if (credential?.type !== 'oauth' || credential.methodID !== METHOD ||
    metadata?.issuer !== ISSUER || metadata.subject !== accountID ||
    !CLIENT.test(metadata?.clientID ?? '') ||
    ![...REQUIRED].every(scope => scopes.includes(scope)) ||
    !Number.isSafeInteger(credential.expires) || credential.expires <= Date.now() + 5000 ||
    typeof credential.access !== 'string' || credential.access.length < 8 ||
    credential.access.length > 4096 || /[\s\x00-\x1f\x7f]/.test(credential.access)) {
    fail('siwc_credential_invalid')
  }
  return { token: credential.access, model }
}

/** Native connection -> tested Responses transport. Tool execution remains off
 * until an OpenCode approval-provenance bridge has been qualified. */
export function sendConnectedResponses(request, {
  integration, accountID, catalog, model, signal, fetchImpl,
  endpoint, allowLoopbackTest = false, timeoutMs,
  sessionID, messageID,
} = {}) {
  return sendResponses(request, {
    sessionID, messageID, model, signal, fetchImpl,
    endpoint, allowLoopbackTest, timeoutMs,
    getToken: ({ signal: tokenSignal }) => connectedSIWCGrant(integration, {
      accountID, catalog, model, signal: tokenSignal,
    }),
  })
}
