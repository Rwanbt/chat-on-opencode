/** Scoped ownership of the OpenCode config, for the format-2 install manifest.
 *
 * Format 1 pinned the digest of the **whole** config file, so the first
 * legitimate publication made the installation refuse its own verifier, its own
 * rollback, the doctor and the upgrade path. Format 2 replaces that pin with
 * scoped ownership: the provider owns exactly two entries in the config, and it
 * recognises them structurally instead of by a byte digest of someone else's
 * file.
 *
 * Two rules define what the provider owns, and both must hold:
 *
 *  1. the plugin registration whose `options` object declares our own option
 *     keys — those keys are ours, and no foreign plugin declares them;
 *  2. that registration's `package` must point **directly** at a child of the
 *     config directory named `.chat-on-opencode-*`. Every publication target the
 *     provider owns lives there: the managed install, the managed-swap
 *     generations and the digest-addressed versioned candidates.
 *
 * Rule 2 is deliberately a namespace and not an exact path: the package path is
 * precisely what a publication rewrites, so pinning it in the manifest would
 * re-create the very invalidation format 2 exists to remove, and would demand a
 * second manifest write after every publication.
 */
import path from 'node:path'
import { readJSONC } from './jsonc-scoped.mjs'

export const PACKAGE_NAMESPACE = '.chat-on-opencode-'

/** The scope is fixed for manifest format 2. A future shape gets a new format. */
export const SCOPE = Object.freeze({
  providerKey: 'chat-on-opencode',
  modelKey: 'chatgpt-default',
  pluginOptionKeys: Object.freeze(['runtimeExecutable', 'runtimeData', 'nodeExecutable', 'port']),
})

const SHA = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MANIFEST_FIELDS = ['backup', 'config', 'format', 'installedSha256', 'originalSha256',
  'payloadSha256', 'version']
const LINEAGE_FIELDS = ['at', 'authorisation', 'configSha256', 'generation']

const member = (node, key) => node?.type === 'object'
  ? node.members.find(item => item.key === key)?.node
  : undefined

/** Decode strictly. Never turn a malformed foreign byte into U+FFFD. */
export function configText(bytes) {
  let source
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw Error('provider_config_unreadable') }
  if (source.startsWith('\uFEFF')) throw Error('provider_config_bom_requires_manual_review')
  return source
}

export function validateScope(scope) {
  if (!scope || typeof scope !== 'object' ||
      scope.providerKey !== SCOPE.providerKey ||
      scope.modelKey !== SCOPE.modelKey ||
      !Array.isArray(scope.pluginOptionKeys) ||
      scope.pluginOptionKeys.length !== SCOPE.pluginOptionKeys.length ||
      scope.pluginOptionKeys.some((key, index) => key !== SCOPE.pluginOptionKeys[index])) {
    throw Error('provider_rollback_manifest_mismatch')
  }
  return scope
}

function lineageEntryValid(entry) {
  return entry && typeof entry === 'object' &&
    Object.keys(entry).sort().join() === [...LINEAGE_FIELDS].sort().join() &&
    typeof entry.at === 'string' && entry.at.length > 0 &&
    SHA.test(entry.configSha256) && SHA.test(entry.generation) && UUID.test(entry.authorisation)
}

function lineageValid(lineage) {
  return Array.isArray(lineage) && lineage.every(lineageEntryValid)
}

/** Accept format 1 and format 2 only. Anything else fails closed. */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw Error('provider_rollback_manifest_mismatch')
  if (manifest.format !== 1 && manifest.format !== 2) throw Error('provider_manifest_shape_unknown')
  const fields = manifest.format === 1 ? MANIFEST_FIELDS : [...MANIFEST_FIELDS, 'scope', 'lineage']
  if (Object.keys(manifest).sort().join() !== [...fields].sort().join()) {
    throw Error('provider_rollback_manifest_mismatch')
  }
  if (![manifest.installedSha256, manifest.originalSha256, manifest.payloadSha256].every(s => SHA.test(s))) {
    throw Error('provider_rollback_manifest_mismatch')
  }
  if (manifest.format === 2) {
    validateScope(manifest.scope)
    if (!lineageValid(manifest.lineage)) throw Error('provider_rollback_manifest_mismatch')
  }
  return manifest
}

/** The config digest this installation last published or installed. */
export function expectedConfigSha256(manifest) {
  if (manifest?.format === 1) return manifest.installedSha256
  const lineage = Array.isArray(manifest?.lineage) ? manifest.lineage : []
  return lineage.length ? lineage[lineage.length - 1].configSha256 : manifest.installedSha256
}

/** Append one publication record. The lineage is append-only and owned. */
export function appendManifestLineage(manifest, entry) {
  if (manifest?.format !== 2) throw Error('provider_manifest_lineage_unsupported')
  if (!lineageEntryValid(entry)) throw Error('provider_manifest_lineage_invalid')
  const lineage = Array.isArray(manifest.lineage) ? manifest.lineage : []
  return { ...manifest, lineage: [...lineage, entry] }
}

function ownedPlugin(node, scope) {
  if (node?.type !== 'object') return false
  const options = member(node, 'options')
  if (options?.type !== 'object') return false
  return scope.pluginOptionKeys.every(key => member(options, key))
}

function ownedPackage(value, configDir) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false
  // The package is <configDir>/<owned child>/plugin: its parent must be a direct
  // child of the config directory, and that child must carry our namespace.
  const parent = path.dirname(path.resolve(value))
  if (path.dirname(parent) !== path.resolve(configDir)) return false
  return path.basename(parent).startsWith(PACKAGE_NAMESPACE)
}

/** Prove that the config still carries exactly our two owned entries. */
export function verifyScopedConfig(source, scope, configDir) {
  validateScope(scope)
  let root
  try { root = readJSONC(source) }
  catch { throw Error('provider_config_unreadable') }
  const plugins = member(root, 'plugins')
  const providers = member(root, 'providers')
  if (plugins?.type !== 'array' || providers?.type !== 'object') throw Error('provider_scope_mismatch')
  const owned = plugins.members.filter(item => ownedPlugin(item.node, scope))
  if (owned.length !== 1) throw Error('provider_scope_mismatch')
  const plugin = owned[0]
  const pkg = member(plugin.node, 'package')
  if (pkg?.type !== 'scalar') throw Error('provider_scope_mismatch')
  let value
  try { value = JSON.parse(source.slice(pkg.start, pkg.end)) }
  catch { throw Error('provider_scope_mismatch') }
  if (!ownedPackage(value, configDir)) throw Error('provider_scope_mismatch')
  const provider = providers.members.find(item => item.key === scope.providerKey)
  if (!provider || provider.node.type !== 'object') throw Error('provider_scope_mismatch')
  const models = member(provider.node, 'models')
  if (models?.type !== 'object') throw Error('provider_scope_mismatch')
  const model = models.members.find(item => item.key === scope.modelKey)
  if (!model || model.node.type !== 'object') throw Error('provider_scope_mismatch')
  return { plugin, provider, model }
}

/** The bytes of one container member, plus exactly one adjacent separator. */
function removalSpan(item) {
  // An object member owns its key and its colon; an array member is its value.
  const start = item.keyStart >= 0 ? item.keyStart : item.node.start
  if (item.commaAt >= 0) return { at: start, end: item.commaAt + 1 }
  if (item.leadCommaAt >= 0) return { at: item.leadCommaAt, end: item.node.end }
  return { at: start, end: item.node.end }
}

/** Remove only the two owned entries. Every foreign byte survives untouched. */
export function removeScopedEntries(source, scope, configDir) {
  const { plugin, provider } = verifyScopedConfig(source, scope, configDir)
  const edits = [removalSpan(plugin), removalSpan(provider)].sort((a, b) => b.at - a.at)
  let cursor = source.length
  for (const edit of edits) {
    if (edit.at < 0 || edit.end > cursor || edit.end < edit.at) throw Error('provider_scope_mismatch')
    cursor = edit.at
  }
  let result = source
  for (const edit of edits) result = result.slice(0, edit.at) + result.slice(edit.end)
  return result
}
