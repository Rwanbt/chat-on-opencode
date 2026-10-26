// Minimal native AI SDK V3 text-only bridge: no direct SDK OpenAI defaults, no
// scraped credentials and no automatic/native tool execution. Identity and
// catalog must come from separately proven OpenCode host capabilities.
import { sendConnectedResponses } from '../src/connected-responses.mjs'
import { listSIWCModels, requireSIWCModel } from '../src/siwc-models.mjs'
import { randomBytes } from 'node:crypto'

export class NativeResponsesError extends Error {
  constructor(code) { super(code); this.name = 'NativeResponsesError'; this.code = code }
}
const fail = code => { throw new NativeResponsesError(code) }
const PROVIDER = 'chat-on-opencode'

function textRequest(options) {
  if (!options || !Array.isArray(options.prompt) || !options.prompt.length ||
      options.prompt.length > 1024 || (options.tools?.length ?? 0) !== 0 ||
      (options.toolChoice && options.toolChoice.type !== 'none') ||
      (options.responseFormat && options.responseFormat.type !== 'text')) fail('native_text_only_required')
  const messages = options.prompt.map(item => {
    if (item?.role === 'system' && typeof item.content === 'string') {
      return { role: 'system', content: item.content }
    }
    if (!['user', 'assistant'].includes(item?.role) || !Array.isArray(item.content) ||
        !item.content.length || item.content.some(part => part?.type !== 'text' ||
          typeof part.text !== 'string')) fail('native_unsupported_context')
    return { role: item.role, content: item.content.map(part => part.text).join('\n') }
  })
  return { model: 'chatgpt-default', stream: true, messages }
}

const usage = () => ({ inputTokens: { total: undefined }, outputTokens: { total: undefined } })
const finishReason = { unified: 'stop', raw: 'stop' }

/** The caller must attest a real native session/message pair, active OAuth
 * identity, and a verified account-bound visible-model catalog. Never infer
 * provenance from prompt text or create an unverified synthetic message ID. */
export function nativeResponsesLanguage({ modelID, accountID, catalog, integration,
  identity, accountContext, fetchImpl, endpoint, allowLoopbackTest = false, timeoutMs } = {}) {
  if (typeof identity !== 'function' || !integration?.connection ||
      (!accountContext && (!accountID || !catalog))) fail('native_host_authority_missing')
  if (!accountContext) {
    try { requireSIWCModel(catalog, accountID, modelID) }
    catch { fail('native_model_not_authorized') }
  }

  async function execute(options) {
    const request = textRequest(options) // refuse tools before touching OAuth
    let turn, account
    try { turn = await identity({ options, modelID }) }
    catch { fail('native_turn_identity_unavailable') }
    if (typeof turn?.sessionID !== 'string' || typeof turn?.messageID !== 'string') {
      fail('native_turn_identity_unavailable')
    }
    if (accountContext) {
      try { account = await accountContext({ modelID, signal: options.abortSignal }) }
      catch { fail('native_account_authorization_unavailable') }
      if (!account || typeof account.accountID !== 'string' || !account.catalog) {
        fail('native_account_authorization_unavailable')
      }
    }
    // sendConnectedResponses independently verifies model/catalog/subject,
    // scoped OAuth, issued client, expiration, no-store POST and SSE completion.
    return sendConnectedResponses(request, {
      integration, accountID: account?.accountID ?? accountID,
      catalog: account?.catalog ?? catalog, model: modelID,
      sessionID: turn.sessionID, messageID: turn.messageID,
      signal: options.abortSignal, fetchImpl, endpoint,
      allowLoopbackTest, timeoutMs,
    })
  }

  return {
    specificationVersion: 'v3', provider: PROVIDER, modelId: modelID,
    supportedUrls: {},
    async doGenerate(options) {
      const result = await execute(options)
      if (result.tool_calls?.length) fail('native_tool_approval_unavailable')
      return { content: [{ type: 'text', text: result.content }],
        finishReason, usage: usage(), warnings: [] }
    },
    async doStream(options) {
      // Deliberately buffer SSE until response.completed was verified. No
      // speculative text-delta enters OpenCode before terminal approval.
      const result = await execute(options)
      if (result.tool_calls?.length) fail('native_tool_approval_unavailable')
      return { stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          if (result.content) {
            controller.enqueue({ type: 'text-start', id: 'siwc-text' })
            controller.enqueue({ type: 'text-delta', id: 'siwc-text', delta: result.content })
            controller.enqueue({ type: 'text-end', id: 'siwc-text' })
          }
          controller.enqueue({ type: 'finish', finishReason, usage: usage() })
          controller.close()
        },
      }) }
    },
  }
}

/** Stateless text-only turns carry random transport deduplication keys, NOT
 * OpenCode message provenance or permission/session authority. Never use for
 * tools, file disclosure, write grants, or context-trust decisions. */
const ephemeralTurn = () => ({
  sessionID: `transport-${randomBytes(16).toString('hex')}`,
  messageID: `request-${randomBytes(16).toString('hex')}`,
})

/** Resolve live OAuth and visible model entitlement on every text turn.
 * No credential file, cookie, API key, saved catalog or implicit refresh. */
export function nativeSIWCTextAccount(integration, { fetchImpl, modelsEndpoint,
  allowLoopbackTest = false } = {}) {
  return async ({ modelID, signal }) => {
    let credential
    try {
      const active = await integration?.connection?.active('chat-on-opencode')
      if (active?.type !== 'credential') fail('native_oauth_not_connected')
      credential = await integration.connection.resolve(active)
    } catch { fail('native_oauth_not_connected') }
    const metadata = credential?.metadata
    const scopes = typeof metadata?.scopes === 'string' ? metadata.scopes.split(/\s+/) : []
    if (credential?.type !== 'oauth' || credential.methodID !== 'chatgpt' ||
        metadata?.issuer !== 'https://auth.openai.com' ||
        !/^oaiapp_[A-Za-z0-9_-]{5,256}$/.test(metadata?.clientID ?? '') ||
        !/^[A-Za-z0-9._:@-]{3,256}$/.test(metadata?.subject ?? '') ||
        !['resource.invoke', 'chatgpt.tokens.use.direct'].every(s => scopes.includes(s)) ||
        !Number.isSafeInteger(credential.expires) || credential.expires <= Date.now() + 5000 ||
        typeof credential.access !== 'string' || credential.access.length < 8 ||
        credential.access.length > 4096 || /[\s\x00-\x1f\x7f]/.test(credential.access)) {
      fail('native_oauth_credential_unverified')
    }
    const accountID = metadata.subject
    const catalog = await listSIWCModels({ accountID,
      getToken: async () => ({ accountID, token: credential.access, scopes, expiresAt: credential.expires }),
      fetchImpl, ...(modelsEndpoint ? { endpoint: modelsEndpoint, allowLoopbackTest } : {}), signal,
    })
    try { requireSIWCModel(catalog, accountID, modelID) }
    catch { fail('native_model_not_authorized') }
    return { accountID, catalog, token: credential.access }
  }
}

/** Explicit consent required: native OAuth preview + text-only inference flag.
 * This bypasses the CoS browser gateway only for this chosen provider/model. */
export async function registerLiveNativeText(ctx, options = {}) {
  if (ctx?.options?.nativeOAuth !== 'preview' || ctx?.options?.nativeInference !== 'text') {
    fail('native_text_consent_required')
  }
  const accountContext = nativeSIWCTextAccount(ctx.integration, options)
  const hook = event => {
    if (event?.model?.providerID !== PROVIDER) return
    event.language = nativeResponsesLanguage({ modelID: event.model.api?.id,
      integration: ctx.integration, identity: ephemeralTurn, accountContext,
      fetchImpl: options.fetchImpl, endpoint: options.endpoint,
      allowLoopbackTest: options.allowLoopbackTest, timeoutMs: options.timeoutMs })
  }
  if (typeof ctx?.aisdk?.language === 'function') return ctx.aisdk.language(hook)
  // Official OpenCode 2.1.4 runtime exposes a consolidated hook registrar.
  if (typeof ctx?.aisdk?.hook === 'function') return ctx.aisdk.hook('language', hook)
  fail('native_aisdk_hook_unavailable')
}

/** This only registers a real V2 language hook if a separately verified host
 * supplied its full identity and catalog boundaries. Never use config/env
 * strings as authority and never change the default CoS provider. */
export async function registerNativeResponses(ctx, { accountID, catalog, identity,
  integration = ctx?.integration, fetchImpl, endpoint, allowLoopbackTest, timeoutMs } = {}) {
  if (!ctx?.aisdk?.language || typeof identity !== 'function' || !accountID || !catalog) {
    fail('native_host_authority_missing')
  }
  return ctx.aisdk.language(event => {
    if (event?.model?.providerID !== PROVIDER) return
    const modelID = event.model.api?.id
    event.language = nativeResponsesLanguage({ modelID, accountID, catalog, identity,
      integration, fetchImpl, endpoint, allowLoopbackTest, timeoutMs })
  })
}
