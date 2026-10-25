import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { inspectInstalledProvider, validateBundle, payloadDigest } from './official-install.mjs'
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
  const info = inspectInstalledProvider(file)
  noLinks(info.managed, 'directory')
  noLinks(path.join(info.managed, 'install-manifest.json'), 'file')
  noLinks(info.manifest.backup, 'file')
  walkSafe(info.managed)
  if (Object.keys(info.manifest).sort().join() !==
      ['backup', 'config', 'format', 'installedSha256', 'originalSha256', 'payloadSha256', 'version'].sort().join() ||
      ![info.manifest.installedSha256, info.manifest.originalSha256, info.manifest.payloadSha256].every(s => SHA.test(s)) ||
      !SUPPORTED.has(info.manifest.version)) throw new Error('upgrade_manifest_unqualified')
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
function candidateDigest(source) {
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
    job, source, sourceDigest: candidateDigest(source), cliVersion: actualVersion,
    candidateVersion: pack.version, status: 'NO_GO_ATOMIC_PROMOTION_UNPROVEN' }
}

function ensurePinned(plan) {
  const now = installed(plan.config)
  if (now.managed !== plan.managed ||
      sha(readFileSync(path.join(now.managed, 'install-manifest.json'))) !== plan.manifestDigest ||
      now.manifest.installedSha256 !== plan.configDigest ||
      now.manifest.payloadSha256 !== plan.oldDigest) throw new Error('upgrade_installed_changed')
}
function writeJournal(location, content) {
  const fd = openSync(location, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(content)); fsyncSync(fd) }
  finally { closeSync(fd) }
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
    configDigest: plan.oldManifest.installedSha256, oldDigest: plan.oldManifest.payloadSha256,
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
  noLinks(file, 'file')
  const entry = JSON.parse(readFileSync(file, 'utf8'))
  if (entry.format !== 1 || typeof entry.id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(entry.id) || entry.config !== info.config || entry.managed !== info.managed ||
      ![entry.manifestDigest, entry.configDigest, entry.oldDigest, entry.sourceDigest].every(s => SHA.test(s)) ||
      !SUPPORTED.has(entry.cliVersion) || typeof entry.candidateVersion !== 'string') {
    throw new Error('upgrade_recovery_journal_invalid')
  }
  ensurePinned(entry)
  const files = readdirSync(job).sort()
  if (files.some(x => !['journal.json', 'validated.json', 'candidate'].includes(x))) {
    throw new Error('upgrade_recovery_unknown_files')
  }
  if (files.includes('candidate')) walkSafe(path.join(job, 'candidate'))
  if (files.includes('validated.json')) {
    noLinks(path.join(job, 'validated.json'), 'file')
    const validated = JSON.parse(readFileSync(path.join(job, 'validated.json'), 'utf8'))
    if (validated.journalSha256 !== sha(readFileSync(file)) || !SHA.test(validated.stagedSha256)) {
      throw new Error('upgrade_recovery_validation_invalid')
    }
    if (!files.includes('candidate') || safeDigest(path.join(job, 'candidate')) !== validated.stagedSha256) {
      throw new Error('upgrade_recovery_staged_modified')
    }
  }
  rmSync(job, { recursive: true })
  ensurePinned(entry)
  return { recovered: true, originalInstallUnchanged: true, promotionAllowed: false }
}
