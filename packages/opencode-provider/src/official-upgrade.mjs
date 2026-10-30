import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { inspectInstalledProvider, validateBundle, payloadDigest } from './official-install.mjs'
import { validateManifest } from './official-scoped-config.mjs'
import { readJSONC } from './jsonc-scoped.mjs'

const SHA = /^[a-f0-9]{64}$/
const SUPPORTED = new Set(['2.0.29', '2.0.32', '2.1.4'])
const sha = data => createHash('sha256').update(data).digest('hex')
const JOB = '.chat-on-opencode-upgrade'
const PAYLOAD = new Set(['bin', 'plugin', 'src', 'package.json', 'README.md', 'opencode.example.jsonc'])
const safeStat = name => {
  try { return lstatSync(name) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
function noLinks(location, type) {
  if (typeof location !== 'string' || !path.isAbsolute(location)) throw new Error('upgrade_absolute_path_required')
  const absolute = path.resolve(location)
  let at = path.parse(absolute).root
  for (const part of absolute.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part)
    const info = safeStat(at)
    if (!info || info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) {
      throw new Error('upgrade_unsafe_path')
    }
  }
  const info = lstatSync(absolute)
  if (type === 'directory' ? !info.isDirectory() : !info.isFile()) throw new Error('upgrade_wrong_path_type')
  return realpathSync(absolute)
}
function walkSafe(dir) {
  noLinks(dir, 'directory')
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name)
    const info = safeStat(child)
    if (!info || info.isSymbolicLink()) throw new Error('upgrade_unsafe_entry')
    if (info.isDirectory()) walkSafe(child)
    else if (!info.isFile()) throw new Error('upgrade_unsafe_entry')
  }
}
function configurationOwnsPlugin(config, managed) {
  const text = readFileSync(config, 'utf8')
  const tree = readJSONC(text)
  const part = name => tree.members.find(m => m.key === name)?.node
  const plugins = part('plugins'), providers = part('providers')
  if (plugins?.type !== 'array' || providers?.type !== 'object' ||
      providers.members.filter(m => m.key === 'chat-on-opencode').length !== 1) {
    throw new Error('upgrade_provider_registration_invalid')
  }
  const entries = plugins.members.map(({ node }) => {
    try { return JSON.parse(text.slice(node.start, node.end)) } catch { return null }
  })
  if (entries.filter(v => v?.package === path.join(managed, 'plugin')).length !== 1) {
    throw new Error('upgrade_plugin_registration_invalid')
  }
}
function installed(config) {
  const file = noLinks(config, 'file')
  noLinks(path.dirname(file), 'directory')
  let info
  try { info = inspectInstalledProvider(file) }
  catch (error) {
    // The upgrade keeps its own manifest vocabulary; the shape is still refused.
    if (error?.message === 'provider_manifest_shape_unknown' ||
        error?.message === 'provider_rollback_manifest_mismatch') {
      throw new Error('upgrade_manifest_unqualified')
    }
    throw error
  }
  noLinks(info.managed, 'directory')
  noLinks(path.join(info.managed, 'install-manifest.json'), 'file')
  noLinks(info.manifest.backup, 'file')
  walkSafe(info.managed)
  try { validateManifest(info.manifest) } catch { throw new Error('upgrade_manifest_unqualified') }
  if (!SUPPORTED.has(info.manifest.version)) throw new Error('upgrade_manifest_unqualified')
  configurationOwnsPlugin(file, info.managed)
  return info
}
function versionOf(cli, runner) {
  const file = noLinks(cli, 'file')
  const result = runner(file, ['--version'], { shell: false, windowsHide: true,
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' } })
  const version = /^opencode v?(\d+\.\d+\.\d+)\s*$/i.exec(result?.stdout?.trim() ?? '')?.[1]
  if (result?.status !== 0 || !SUPPORTED.has(version)) throw new Error('upgrade_official_cli_unqualified')
  return version
}
const journalFor = info => path.join(path.dirname(info.config), JOB)
const safeDigest = dir => { walkSafe(dir); return payloadDigest(dir) }
export function candidateDigest(source) {
  const digest = createHash('sha256')
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      if (!prefix && !PAYLOAD.has(name)) continue
      const at = path.join(dir, name), relative = prefix + name
      const info = safeStat(at)
      if (!info || info.isSymbolicLink()) throw new Error('upgrade_candidate_unsafe')
      if (info.isDirectory()) { digest.update('dir:' + relative + '\0'); walk(at, relative + '/') }
      else if (info.isFile()) { digest.update('file:' + relative + '\0'); digest.update(sha(readFileSync(at))) }
      else throw new Error('upgrade_candidate_unsafe')
    }
  }
  walk(source)
  return digest.digest('hex')
}

/** Read-only validation. It is intentionally not authorization for live replacement. */
export function inspectUpgrade(options, { runner = spawnSync } = {}) {
  const info = installed(options.configFile)
  const job = journalFor(info)
  if (safeStat(job)) throw new Error('upgrade_pending_recovery_required')
  const actualVersion = versionOf(options.officialCli, runner)
  if (actualVersion !== info.manifest.version) throw new Error('upgrade_official_cli_version_mismatch')
  const source = noLinks(options.bundleDir, 'directory')
  validateBundle(source)
  walkSafe(source)
  if (source === info.managed || source.startsWith(info.managed + path.sep) ||
      info.managed.startsWith(source + path.sep)) throw new Error('upgrade_bundle_overlaps_managed')
  const configFolder = path.dirname(info.config)
  if (source === configFolder || source.startsWith(configFolder + path.sep) ||
      configFolder.startsWith(source + path.sep)) throw new Error('upgrade_bundle_overlaps_config')
  const pack = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'))
  if (pack.name !== 'chat-on-opencode-provider' || typeof pack.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(pack.version)) throw new Error('upgrade_bundle_version_invalid')
  return { config: info.config, managed: info.managed, oldManifest: info.manifest,
    // The upgrade pins the config bytes it actually observed. It never relies
    // on the install manifest's whole-file pin, which format 2 deliberately
    // replaced by scoped ownership.
    configDigest: info.configSha256,
    job, source, sourceDigest: candidateDigest(source), cliVersion: actualVersion,
    candidateVersion: pack.version, status: 'NO_GO_ATOMIC_PROMOTION_UNPROVEN' }
}

function ensurePinned(plan) {
  const now = installed(plan.config)
  if (now.managed !== plan.managed ||
      sha(readFileSync(path.join(now.managed, 'install-manifest.json'))) !== plan.manifestDigest ||
      now.configSha256 !== plan.configDigest ||
      now.manifest.payloadSha256 !== plan.oldDigest) throw new Error('upgrade_installed_changed')
}
function writeJournal(location, content) {
  const fd = openSync(location, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(content)); fsyncSync(fd) }
  finally { closeSync(fd) }
}
function readOwnedJob(configFile) {
  const info = installed(configFile)
  const job = journalFor(info)
  noLinks(job, 'directory')
  if (readdirSync(job).some(name => !['journal.json', 'validated.json', 'candidate', 'publication.json'].includes(name))) {
    throw new Error('upgrade_recovery_unknown_files')
  }
  const file = path.join(job, 'journal.json')
  noLinks(file, 'file')
  const entry = JSON.parse(readFileSync(file, 'utf8'))
  if (entry.format !== 1 || typeof entry.id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(entry.id) || entry.config !== info.config || entry.managed !== info.managed ||
      ![entry.manifestDigest, entry.configDigest, entry.oldDigest, entry.sourceDigest].every(s => SHA.test(s)) ||
      !SUPPORTED.has(entry.cliVersion) || typeof entry.candidateVersion !== 'string') {
    throw new Error('upgrade_recovery_journal_invalid')
  }
  ensurePinned(entry)
  const publishedPath = path.join(path.dirname(info.config), '.chat-on-opencode-version-' + entry.sourceDigest)
  const receiptPath = path.join(job, 'validated.json')
  const validated = safeStat(receiptPath)
  if (validated) {
    noLinks(receiptPath, 'file')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    if (Object.keys(receipt).sort().join() !== 'journalSha256,stagedSha256' ||
        receipt.journalSha256 !== sha(readFileSync(file)) || receipt.stagedSha256 !== entry.sourceDigest) {
      throw new Error('upgrade_recovery_validation_invalid')
    }
  }
  const publication = path.join(job, 'publication.json')
  if (safeStat(publication)) {
    noLinks(publication, 'file')
    const detail = JSON.parse(readFileSync(publication, 'utf8'))
    if (Object.keys(detail).sort().join() !== 'destination,journalSha256' ||
        detail.destination !== publishedPath || detail.journalSha256 !== sha(readFileSync(file)) ||
        !validated) throw new Error('upgrade_publication_journal_invalid')
  }
  const stage = path.join(job, 'candidate')
  if (safeStat(stage)) {
    if (safeDigest(stage) !== entry.sourceDigest) {
      if (validated) throw new Error('upgrade_recovery_staged_modified')
      walkSafe(stage)
    }
  }
  if (safeStat(publishedPath)) {
    if (!safeStat(publication) || safeDigest(publishedPath) !== entry.sourceDigest || safeStat(stage)) {
      throw new Error('upgrade_published_candidate_invalid')
    }
  } else if (safeStat(publication) && !safeStat(stage)) {
    throw new Error('upgrade_published_candidate_missing')
  }
  return { info, job, file, entry, stage, receiptPath, publication, publishedPath }
}
const copyTree = (src, dest) => {
  for (const name of readdirSync(src)) {
    const from = path.join(src, name), to = path.join(dest, name)
    const s = safeStat(from)
    if (!s || s.isSymbolicLink()) throw new Error('upgrade_bundle_changed')
    if (s.isDirectory()) { mkdirSync(to); copyTree(from, to) }
    else if (s.isFile()) copyFileSync(from, to)
    else throw new Error('upgrade_bundle_changed')
  }
}

/** Materialize only in a reserved sibling staging area; NEVER change active config/payload. */
export function stageUpgrade(options, { runner = spawnSync, checkpoint = () => {} } = {}) {
  const plan = inspectUpgrade(options, { runner })
  const entry = { format: 1, id: randomUUID(), config: plan.config, managed: plan.managed,
    manifestDigest: sha(readFileSync(path.join(plan.managed, 'install-manifest.json'))),
    configDigest: plan.configDigest, oldDigest: plan.oldManifest.payloadSha256,
    sourceDigest: plan.sourceDigest, cliVersion: plan.cliVersion, candidateVersion: plan.candidateVersion }
  mkdirSync(plan.job)
  checkpoint('reservation_created')
  // A marker exists before copying. A crash always requires explicit recovery.
  writeJournal(path.join(plan.job, 'journal.json'), entry)
  checkpoint('journal_durable')
  ensurePinned(entry)
  const stage = path.join(plan.job, 'candidate')
  mkdirSync(stage)
  checkpoint('candidate_created')
  for (const folder of ['bin', 'plugin', 'src']) {
    mkdirSync(path.join(stage, folder))
    copyTree(path.join(plan.source, folder), path.join(stage, folder))
    checkpoint('copied_' + folder)
  }
  for (const file of ['package.json', 'README.md', 'opencode.example.jsonc']) {
    if (existsSync(path.join(plan.source, file))) copyFileSync(path.join(plan.source, file), path.join(stage, file))
  }
  checkpoint('candidate_copied')
  if (safeDigest(stage) !== plan.sourceDigest || candidateDigest(plan.source) !== plan.sourceDigest) {
    throw new Error('upgrade_staged_payload_mismatch')
  }
  validateBundle(stage)
  ensurePinned(entry)
  writeJournal(path.join(plan.job, 'validated.json'), { journalSha256: sha(readFileSync(path.join(plan.job, 'journal.json'))),
    stagedSha256: safeDigest(stage) })
  checkpoint('validated_durable')
  return { readyForOfflineReview: true, promotionAllowed: false, status: plan.status,
    stagedDigest: plan.sourceDigest, cliVersion: plan.cliVersion, candidateVersion: plan.candidateVersion }
}

/** Publish only verified candidate files under a digest-addressed sibling path.
 * This does NOT update opencode.jsonc or grant permission to switch the live plugin. */
export function publishVersionedCandidate(configFile, { checkpoint = () => {} } = {}) {
  const state = readOwnedJob(configFile)
  if (!safeStat(state.receiptPath) || !safeStat(state.stage) ||
      safeStat(state.publication) || safeStat(state.publishedPath)) {
    throw new Error('upgrade_candidate_not_ready_to_publish')
  }
  validateBundle(state.stage)
  ensurePinned(state.entry)
  writeJournal(state.publication, { journalSha256: sha(readFileSync(state.file)),
    destination: state.publishedPath })
  checkpoint('publication_intent_durable')
  if (safeDigest(state.stage) !== state.entry.sourceDigest || safeStat(state.publishedPath)) {
    throw new Error('upgrade_publication_precondition_changed')
  }
  ensurePinned(state.entry)
  checkpoint('before_publish_rename')
  // Single directory rename in the SAME config directory. Old managed bytes remain intact.
  renameSync(state.stage, state.publishedPath)
  checkpoint('published_directory')
  readOwnedJob(configFile)
  checkpoint('published_verified')
  return { publishedForOfflineReview: true, promotionAllowed: false,
    status: 'NO_GO_CONFIG_CAS_UNPROVEN', publishedSha256: state.entry.sourceDigest }
}

/** Verify a retained content-addressed sibling even after its staging journal was recovered. */
export function inspectPublishedCandidate(configFile, publishedSha256) {
  if (typeof publishedSha256 !== 'string' || !SHA.test(publishedSha256)) {
    throw new Error('upgrade_published_digest_invalid')
  }
  const info = installed(configFile)
  const location = path.join(path.dirname(info.config), '.chat-on-opencode-version-' + publishedSha256)
  noLinks(location, 'directory')
  if (safeDigest(location) !== publishedSha256) throw new Error('upgrade_published_candidate_invalid')
  validateBundle(location)
  return { publishedSha256, candidateAvailable: true, promotionAllowed: false }
}

/** Safely discard a crashed/prepared plan; active install must still match exactly. */
export function recoverStagedUpgrade(configFile) {
  const info = installed(configFile)
  const job = journalFor(info)
  noLinks(job, 'directory')
  const file = path.join(job, 'journal.json')
  if (!safeStat(file)) {
    // Only the exact empty reservation can be discarded without an ownership journal.
    // An unknown nonempty directory is deliberately left for manual investigation.
    if (readdirSync(job).length) throw new Error('upgrade_recovery_journal_missing')
    rmdirSync(job)
    installed(info.config)
    return { recovered: true, originalInstallUnchanged: true, promotionAllowed: false }
  }
  const state = readOwnedJob(configFile)
  const { entry } = state
  const files = readdirSync(job).sort()
  if (files.some(x => !['journal.json', 'validated.json', 'candidate', 'publication.json'].includes(x))) {
    throw new Error('upgrade_recovery_unknown_files')
  }
  if (files.includes('validated.json') && !files.includes('candidate') && !safeStat(state.publishedPath))
    throw new Error('upgrade_recovery_staged_modified')
  rmSync(job, { recursive: true })
  ensurePinned(entry)
  return { recovered: true, originalInstallUnchanged: true, promotionAllowed: false }
}
