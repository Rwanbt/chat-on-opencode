import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { inspectInstalledProvider } from './official-install.mjs'
import { readJSONC } from './jsonc-scoped.mjs'
import { requireSIWCModel } from './siwc-models.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const get = (node, key) => node?.type === 'object' ? node.members.find(m => m.key === key)?.node : undefined
const value = (text, node) => {
  if (node?.type !== 'scalar') throw Error('native_activation_unexpected_jsonc_shape')
  return JSON.parse(text.slice(node.start, node.end))
}
const attr = (text, node, key) => value(text, get(node, key))

/** Propose tightly scoped JSONC edits without any writes or credential reads.
 * Native fs.rename on Windows is not conditional, so no config mutation API is
 * exposed until an actual cross-process compare-and-swap owner exists.
 */
export function previewNativeActivation(configFile, { mode = 'oauth', accountID, modelID, catalog } = {}) {
  if (!['oauth', 'text'].includes(mode)) throw Error('native_activation_unknown_mode')
  const info = inspectInstalledProvider(configFile)
  for (const name of ['.chat-on-opencode-directory-switch.json',
    '.chat-on-opencode-directory-next', '.chat-on-opencode-directory-previous',
    '.chat-on-opencode-upgrade']) {
    if (existsSync(path.join(path.dirname(info.config), name))) {
      throw Error('native_activation_managed_transaction_pending')
    }
  }
  const file = path.join(info.managed, 'plugin', 'index.ts')
  const source = lstatSync(file)
  if (!source.isFile() || source.isSymbolicLink()) throw Error('native_activation_installed_bundle_untrusted')
  const plugin = readFileSync(file, 'utf8')
  if (!plugin.includes("registerNativeSIWC(ctx)") ||
      !plugin.includes("registerNativeHTTPText(ctx)")) {
    throw Error('native_activation_installed_bundle_lacks_siwc')
  }
  const before = readFileSync(info.config)
  if (before.byteLength > 1024 * 1024) throw Error('native_activation_config_requires_manual_review')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before) }
  catch { throw Error('native_activation_config_requires_manual_review') }
  if (text.startsWith('\uFEFF')) throw Error('native_activation_config_requires_manual_review')
  const root = readJSONC(text)
  const plugins = get(root, 'plugins'), providers = get(root, 'providers')
  if (plugins?.type !== 'array' || providers?.type !== 'object') {
    throw Error('native_activation_unexpected_jsonc_shape')
  }
  const matches = plugins.members.filter(({ node }) => {
    const member = get(node, 'package')
    return member && value(text, member) === path.join(info.managed, 'plugin')
  })
  const own = get(providers, 'chat-on-opencode')
  const opts = get(matches[0]?.node, 'options'), settings = get(own, 'settings')
  const models = get(own, 'models')
  if (matches.length !== 1 || opts?.type !== 'object' || own?.type !== 'object' ||
      settings?.type !== 'object' || models?.type !== 'object' ||
      models.members.length !== 1 || models.members[0].key !== 'chatgpt-default') {
    throw Error('native_activation_unexpected_jsonc_shape')
  }
  const edits = []
  const replace = (node, item) => {
    if (!node) throw Error('native_activation_unexpected_jsonc_shape')
    edits.push({ at: node.start, end: node.end, data: JSON.stringify(item) })
  }
  const add = (node, key, item) => {
    if (get(node, key)) throw Error('native_activation_option_already_present')
    edits.push({ at: node.closeAt, end: node.closeAt,
      data: (node.members.length && !node.trailingComma ? ',' : '') +
        JSON.stringify(key) + ':' + JSON.stringify(item) })
  }
  if (mode === 'oauth') {
    if (get(opts, 'nativeOAuth') || get(opts, 'nativeInference')) {
      throw Error('native_activation_oauth_already_present')
    }
    add(opts, 'nativeOAuth', 'preview')
  } else {
    if (!get(opts, 'nativeOAuth') ||
        attr(text, opts, 'nativeOAuth') !== 'preview' || get(opts, 'nativeInference')) {
      throw Error('native_activation_oauth_bootstrap_required')
    }
    requireSIWCModel(catalog, accountID, modelID)
    if (attr(text, opts, 'nativeTools') !== 'off' ||
        attr(text, own, 'package') !== '@opencode/ai/providers/openai-compatible' ||
        !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/v1$/.test(attr(text, settings, 'baseURL')) ||
        attr(text, get(models.members[0].node, 'capabilities'), 'tools') !== false) {
      throw Error('native_activation_text_requires_tool_free_gateway')
    }
    add(opts, 'nativeInference', 'text')
    replace(get(own, 'package'), '@opencode/ai/providers/openai')
    replace(get(settings, 'baseURL'), 'https://api.openai.com/v1')
    const model = models.members[0]
    edits.push({ at: model.keyStart, end: model.keyEnd, data: JSON.stringify(modelID) })
  }
  let proposed = text
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    proposed = proposed.slice(0, edit.at) + edit.data + proposed.slice(edit.end)
  }
  readJSONC(proposed)
  return { mode, currentSha256: sha(before), proposedSha256: sha(Buffer.from(proposed)),
    proposed, modifiedFields: mode === 'oauth'
      ? ['plugins[chat-on-opencode].options.nativeOAuth']
      : ['plugins[chat-on-opencode].options.nativeInference', 'providers.chat-on-opencode.package',
        'providers.chat-on-opencode.settings.baseURL', 'providers.chat-on-opencode.models'],
    promotionAllowed: false, status: 'NO_GO_ATOMIC_CONFIG_CAS_UNPROVEN' }
}
