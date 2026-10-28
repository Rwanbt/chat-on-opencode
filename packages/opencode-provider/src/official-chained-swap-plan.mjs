import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { inspectInstalledProvider, payloadDigest, validateBundle } from './official-install.mjs'
import { candidateDigest } from './official-upgrade.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const SHA = /^[a-f0-9]{64}$/
const fields = ['config', 'configSha', 'newPayload', 'oldManifestSha', 'oldPayload', 'version']
const manifestFields = ['backup', 'config', 'format', 'installedSha256', 'originalSha256', 'payloadSha256', 'version']
const stat = file => {
  try { return lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function safePath(file, directory = false) {
  const full = path.resolve(file)
  let at = path.parse(full).root
  for (const part of full.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part)
    const item = stat(at)
    if (!item || item.isSymbolicLink() || !(item.isFile() || item.isDirectory())) {
      throw Error('chained_swap_unsafe_path')
    }
  }
  if (directory ? !stat(full)?.isDirectory() : !stat(full)?.isFile()) {
    throw Error('chained_swap_unsafe_path')
  }
  return full
}
function tree(folder) {
  safePath(folder, true)
  for (const name of readdirSync(folder)) {
    const location = path.join(folder, name), item = stat(location)
    if (!item || item.isSymbolicLink()) throw Error('chained_swap_unsafe_candidate')
    if (item.isDirectory()) tree(location)
    else if (!item.isFile()) throw Error('chained_swap_unsafe_candidate')
  }
}
function metadata(bytes, code) {
  let obj
  try { obj = JSON.parse(bytes.toString('utf8')) } catch { throw Error(code) }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw Error(code)
  return obj
}
function exactKeys(object, keys) {
  return Object.keys(object).sort().join() === keys.slice().sort().join()
}
const captured = file => readFileSync(safePath(file))
const within = (ancestor, target) => {
  const relative = path.relative(ancestor, target)
  return !relative || (!relative.startsWith('..' + path.sep) &&
    relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Read-only proof of the active/previous/new three-generation chain.
 * The existing format-1 journal cannot safely own a second transaction:
 * rollback currently deletes its active candidate; there is no durable
 * multi-generation rollback/CAS owner. Never expose a promotion action.
 */
export function planChainedManagedSwap(configFile, candidateDir, expectedDigest) {
  if (!SHA.test(expectedDigest ?? '')) throw Error('chained_swap_expected_digest_required')
  const info = inspectInstalledProvider(configFile)
  const folder = path.dirname(info.config)
  safePath(folder, true)
  for (const name of ['.chat-on-opencode-upgrade', '.chat-on-opencode-directory-next']) {
    if (stat(path.join(folder, name))) throw Error('chained_swap_pending_or_partial')
  }
  const journalPath = path.join(folder, '.chat-on-opencode-directory-switch.json')
  const previous = path.join(folder, '.chat-on-opencode-directory-previous')
  if (!stat(journalPath) || !stat(previous)) throw Error('chained_swap_active_history_required')
  const recordBytes = captured(journalPath)
  if (recordBytes.length > 4096) throw Error('chained_swap_journal_invalid')
  const record = metadata(recordBytes, 'chained_swap_journal_invalid')
  if (!exactKeys(record, fields) || record.version !== 1 ||
      record.config !== info.config || ![record.configSha, record.newPayload,
        record.oldManifestSha, record.oldPayload].every(value => SHA.test(value))) {
    throw Error('chained_swap_journal_invalid')
  }
  const configBytes = captured(info.config)
  if (hash(configBytes) !== record.configSha ||
      record.configSha !== info.manifest.installedSha256) {
    throw Error('chained_swap_config_changed')
  }
  tree(previous)
  tree(info.managed)
  const oldManifestBytes = captured(path.join(previous, 'install-manifest.json'))
  const oldManifest = metadata(oldManifestBytes, 'chained_swap_previous_manifest_invalid')
  if (!exactKeys(oldManifest, manifestFields) ||
      hash(oldManifestBytes) !== record.oldManifestSha ||
      oldManifest.format !== 1 || oldManifest.config !== info.config ||
      oldManifest.backup !== info.manifest.backup ||
      oldManifest.originalSha256 !== info.manifest.originalSha256 ||
      oldManifest.installedSha256 !== record.configSha ||
      oldManifest.payloadSha256 !== record.oldPayload ||
      oldManifest.version !== info.manifest.version) {
    throw Error('chained_swap_previous_manifest_invalid')
  }
  if (payloadDigest(previous) !== record.oldPayload) throw Error('chained_swap_previous_payload_mismatch')
  if (payloadDigest(info.managed) !== record.newPayload ||
      info.manifest.payloadSha256 !== record.newPayload) throw Error('chained_swap_active_payload_mismatch')
  const candidate = safePath(candidateDir, true)
  if (within(folder, candidate) || within(candidate, folder)) throw Error('chained_swap_candidate_overlaps_install')
  tree(candidate)
  validateBundle(candidate)
  const next = candidateDigest(candidate)
  if (next !== expectedDigest) throw Error('chained_swap_candidate_digest_mismatch')
  if ([record.oldPayload, record.newPayload].includes(next)) throw Error('chained_swap_no_new_generation')
  const entry = captured(path.join(candidate, 'plugin', 'index.ts')).toString('utf8')
  if (!entry.includes("ctx.options.nativeOAuth !== 'off'") ||
      !entry.includes('registerNativeSIWC(ctx)')) throw Error('chained_swap_candidate_missing_oauth')
  // Catch an ordinary edit during inspection; no claim of future CAS ownership.
  if (hash(captured(info.config)) !== record.configSha ||
      hash(captured(journalPath)) !== hash(recordBytes) ||
      hash(captured(path.join(previous, 'install-manifest.json'))) !== record.oldManifestSha) {
    throw Error('chained_swap_changed_during_inspection')
  }
  return { status: 'NO_GO_CHAINED_SWAP_NOT_ATOMIC', promotionAllowed: false,
    preparedInUserProfile: false, priorRollbackIntact: true, requiresOfflineTransition: true,
    configSha256: record.configSha, previousPayloadSha256: record.oldPayload,
    activePayloadSha256: record.newPayload, newCandidateSha256: next,
    previousManifestSha256: record.oldManifestSha,
    activeManifestSha256: hash(captured(path.join(info.managed, 'install-manifest.json'))),
    backupSha256: info.manifest.originalSha256 }
}
