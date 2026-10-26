import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const NAME = 'chat-on-opencode-context-overlay'
const AGENT = 'chat-on-opencode-text.md'
const JOURNAL = '.chat-on-opencode-context-overlay.pending.json'
const RECEIPT = '.chat-on-opencode-context-overlay.receipt.json'
const SHA = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9-]{36}$/
const hash = data => createHash('sha256').update(data).digest('hex')
const stat = p => { try { return lstatSync(p) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }

function regular(p, expected = 'file') {
  if (!path.isAbsolute(p)) throw Error('additive_absolute_path_required')
  let cursor = path.parse(p).root
  for (const part of p.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const s = stat(cursor)
    if (!s || s.isSymbolicLink()) throw Error('additive_unsafe_path')
  }
  const info = stat(p)
  if (!info || (expected === 'file' ? !info.isFile() : !info.isDirectory())) {
    throw Error('additive_unsafe_path')
  }
  return p
}

function directory(p) {
  const parent = path.dirname(p)
  regular(parent, 'dir')
  if (!stat(p)) mkdirSync(p)
  return regular(p, 'dir')
}

function sourceFiles(bundle) {
  if (typeof bundle !== 'string' || !path.isAbsolute(bundle)) throw Error('additive_absolute_path_required')
  const root = regular(path.resolve(bundle), 'dir')
  const dir = regular(path.join(root, 'src', 'context-overlay'), 'dir')
  const files = ['index.ts', 'overlay.mjs', 'chat-on-opencode-browser-text.md']
  const found = new Map(files.map(name => [name, readFileSync(regular(path.join(dir, name)))]))
  const digest = createHash('sha256')
  for (const name of files) digest.update(name + '\0').update(found.get(name)).update('\0')
  return { found, digest: digest.digest('hex') }
}

function profile(config) {
  if (typeof config !== 'string' || !path.isAbsolute(config)) throw Error('additive_absolute_path_required')
  const file = regular(path.resolve(config))
  if (path.basename(file) !== 'opencode.jsonc') throw Error('additive_opencode_config_required')
  const root = regular(path.dirname(file), 'dir')
  return { root, configSha: hash(readFileSync(file)),
    plugins: path.join(root, 'plugins'), agents: path.join(root, 'agents'),
    target: path.join(root, 'plugins', NAME), agent: path.join(root, 'agents', AGENT),
    journal: path.join(root, JOURNAL), receipt: path.join(root, RECEIPT) }
}

function writeNew(file, bytes) {
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
}

function exactDir(dir, expected, allowPartial = false) {
  if (!stat(dir)) return false
  regular(dir, 'dir')
  const names = readdirSync(dir).sort()
  if (allowPartial ? names.some(name => !['index.ts', 'overlay.mjs'].includes(name))
    : names.join('\0') !== ['index.ts', 'overlay.mjs'].join('\0')) {
    throw Error('additive_unexpected_plugin_content')
  }
  for (const name of names) {
    if (hash(readFileSync(regular(path.join(dir, name)))) !== hash(expected.get(name))) {
      throw Error('additive_plugin_modified')
    }
  }
  return true
}

function exactAgent(file, expected) {
  if (!stat(file)) return false
  if (hash(readFileSync(regular(file))) !== hash(expected.get('chat-on-opencode-browser-text.md'))) {
    throw Error('additive_agent_modified')
  }
  return true
}

function loadRecord(file) {
  regular(file)
  const raw = readFileSync(file, 'utf8')
  let record
  try { record = JSON.parse(raw) } catch { throw Error('additive_manifest_invalid') }
  const { checksum, ...data } = record ?? {}
  if (data?.version !== 1 || !SHA.test(data?.configSha ?? '') || !SHA.test(data?.sourceSha ?? '') ||
    !UUID.test(data?.nonce ?? '') || checksum !== hash(JSON.stringify(data))) {
    throw Error('additive_manifest_invalid')
  }
  return data
}

function entry(root, data) {
  const { plugins, agents, target, agent } = root
  return { target, agent,
    pluginStage: path.join(plugins, '.' + NAME + '.' + data.nonce + '.stage'),
    agentStage: path.join(agents, '.' + AGENT + '.' + data.nonce + '.stage'),
    pluginRetired: path.join(plugins, '.' + NAME + '.' + data.nonce + '.retired'),
    agentRetired: path.join(agents, '.' + AGENT + '.' + data.nonce + '.retired') }
}

function assertIdle(probe) {
  if (probe) { probe(); return }
  if (process.platform !== 'win32') throw Error('additive_windows_only')
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
    '$ErrorActionPreference="Stop"; @([Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -in @("OpenCode","opencode-cli","Chat On OpenCode Provider") }).Count'], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 7000 })
  if (result.status !== 0 || !/^0\s*$/.test(result.stdout ?? '')) {
    throw Error('additive_opencode_processes_active_or_unknown')
  }
}

function ensurePinned(cfg, data, expectedDigest) {
  if (cfg.configSha !== data.configSha || (expectedDigest && expectedDigest !== data.sourceSha)) {
    throw Error('additive_source_or_configuration_changed')
  }
}

function ownedState(cfg, record, expected) {
  const p = entry(cfg, record)
  return { installedPlugin: exactDir(p.target, expected), installedAgent: exactAgent(p.agent, expected),
    stagedPlugin: exactDir(p.pluginStage, expected, true), stagedAgent: exactAgent(p.agentStage, expected),
    retiredPlugin: exactDir(p.pluginRetired, expected, true), retiredAgent: exactAgent(p.agentRetired, expected) }
}

/** Files are pinned and published separately; durable receipt is the commit marker. */
export function installAdditive(config, bundle, expectedConfigSha, expectedSourceSha,
  { idle, phase = () => {} } = {}) {
  assertIdle(idle)
  const cfg = profile(config), source = sourceFiles(bundle)
  if (!SHA.test(expectedConfigSha) || !SHA.test(expectedSourceSha) ||
    cfg.configSha !== expectedConfigSha || source.digest !== expectedSourceSha) {
    throw Error('additive_pin_mismatch')
  }
  if ([cfg.target, cfg.agent, cfg.journal, cfg.receipt].some(stat)) throw Error('additive_existing_install_or_journal')
  directory(cfg.plugins)
  directory(cfg.agents)
  const data = { version: 1, configSha: cfg.configSha, sourceSha: source.digest, nonce: randomUUID() }
  const locations = entry(cfg, data)
  const manifest = { ...data, checksum: hash(JSON.stringify(data)) }
  writeNew(cfg.journal, JSON.stringify(manifest))
  phase('journal-written')
  // On crash, leave the journal for explicit integrity-checked recovery.
  mkdirSync(locations.pluginStage)
  phase('plugin-stage-created')
  writeNew(path.join(locations.pluginStage, 'index.ts'), source.found.get('index.ts'))
  phase('index-staged')
  writeNew(path.join(locations.pluginStage, 'overlay.mjs'), source.found.get('overlay.mjs'))
  phase('overlay-staged')
  writeNew(locations.agentStage, source.found.get('chat-on-opencode-browser-text.md'))
  phase('agent-staged')
  ensurePinned(profile(config), data, expectedSourceSha)
  ownedState(cfg, data, source.found)
  // Recheck quiescence immediately before either global file becomes visible.
  // If another OpenCode instance appeared during staging, leave a journal for
  // explicit recovery rather than publishing into a running official app.
  assertIdle(idle)
  renameSync(locations.agentStage, cfg.agent)
  phase('agent-published')
  renameSync(locations.pluginStage, cfg.target)
  phase('plugin-published')
  renameSync(cfg.journal, cfg.receipt)
  phase('receipt-published')
  return { installed: true, configUnchanged: true, sourceSha256: source.digest }
}

/** Never treat a partial two-path publication as a complete install. */
export function additiveStatus(config, bundle) {
  const cfg = profile(config), source = sourceFiles(bundle)
  if (stat(cfg.journal)) return { state: 'pending_recovery' }
  if (!stat(cfg.receipt)) return { state: stat(cfg.target) || stat(cfg.agent) ? 'unmanaged_collision' : 'absent' }
  const data = loadRecord(cfg.receipt)
  ensurePinned(cfg, data, source.digest)
  const found = ownedState(cfg, data, source.found)
  return { state: found.installedPlugin && found.installedAgent ? 'installed' : 'partial_removal',
    configUnchanged: true }
}

function removeOwned(cfg, record, expected, phase) {
  const p = entry(cfg, record)
  // Validate all live, staged and retired paths before changing anything.
  const present = ownedState(cfg, record, expected)
  if ((present.installedPlugin && present.retiredPlugin) ||
      (present.installedAgent && present.retiredAgent)) {
    throw Error('additive_conflicting_recovery_paths')
  }
  // Stop auto-discovery with same-volume renames before recursive deletion.
  // On a crash halfway through deletion, the receipt/journal remains; retry
  // can safely remove a subset of these verified, retired files.
  if (present.installedPlugin) { renameSync(p.target, p.pluginRetired); phase('plugin-retired') }
  if (present.installedAgent) { renameSync(p.agent, p.agentRetired); phase('agent-retired') }
  if (stat(p.pluginRetired)) {
    exactDir(p.pluginRetired, expected, true)
    rmSync(p.pluginRetired, { recursive: true })
    phase('plugin-deleted')
  }
  if (stat(p.agentRetired)) {
    exactAgent(p.agentRetired, expected)
    unlinkSync(p.agentRetired)
    phase('agent-deleted')
  }
  if (present.stagedPlugin) rmSync(p.pluginStage, { recursive: true })
  if (present.stagedAgent) unlinkSync(p.agentStage)
}

/** Refuse foreign files and all changed source/configuration bytes. */
export function removeAdditive(config, bundle, { idle, phase = () => {} } = {}) {
  assertIdle(idle)
  const cfg = profile(config), source = sourceFiles(bundle)
  const pending = Boolean(stat(cfg.journal))
  const recordFile = pending ? cfg.journal : cfg.receipt
  if (!stat(recordFile)) throw Error('additive_not_installed')
  const data = loadRecord(recordFile)
  ensurePinned(cfg, data, source.digest)
  // A restart during the integrity scan invalidates a removal attempt.
  assertIdle(idle)
  removeOwned(cfg, data, source.found, phase)
  unlinkSync(recordFile)
  phase('receipt-deleted')
  return { removed: true, recoveredPending: pending, configUnchanged: true }
}

export function additiveSourceDigest(bundle) { return sourceFiles(bundle).digest }
