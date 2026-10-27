#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectInstalledProvider, payloadDigest, validateBundle } from '../src/official-install.mjs'
import { candidateDigest } from '../src/official-upgrade.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const MANIFEST = 'install-manifest.json'
const SIDECAR = '.chat-on-opencode-directory-switch.json'
const NEXT = '.chat-on-opencode-directory-next'
const PREVIOUS = '.chat-on-opencode-directory-previous'
const SAFE = /^[a-f0-9]{64}$/
const stat = name => { try { return lstatSync(name) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
const ensureAbsent = name => { if (stat(name)) throw Error('managed_switch_path_in_use') }
const shaFile = name => digest(readFileSync(name))

function safeTree(directory) {
  const info = stat(directory)
  if (!info?.isDirectory() || info.isSymbolicLink()) throw Error('managed_switch_unsafe_directory')
  for (const name of readdirSync(directory)) {
    const child = path.join(directory, name), item = stat(child)
    if (!item || item.isSymbolicLink()) throw Error('managed_switch_unsafe_content')
    if (item.isDirectory()) safeTree(child)
    else if (!item.isFile()) throw Error('managed_switch_unsafe_content')
  }
}
function copyTree(from, to) {
  mkdirSync(to)
  for (const name of readdirSync(from)) {
    const source = path.join(from, name), dest = path.join(to, name)
    const item = stat(source)
    if (!item || item.isSymbolicLink()) throw Error('managed_switch_unsafe_content')
    if (item.isDirectory()) copyTree(source, dest)
    else if (item.isFile()) copyFileSync(source, dest)
    else throw Error('managed_switch_unsafe_content')
  }
}
function durableJSON(file, value) {
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) }
  finally { closeSync(fd) }
}
function context(config) {
  const info = inspectInstalledProvider(config)
  const dir = path.dirname(info.config)
  return { info, config: info.config, managed: info.managed, journal: path.join(dir, SIDECAR),
    next: path.join(dir, NEXT), previous: path.join(dir, PREVIOUS) }
}
function quiescent({ probe = spawnSync } = {}) {
  if (process.platform !== 'win32') throw Error('managed_switch_windows_only')
  const call = probe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; @([Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -in @("OpenCode","opencode","opencode-cli","Chat On OpenCode Provider") }).Count'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 7000,
  })
  if (call.status !== 0 || !/^0\s*$/.test(call.stdout || '')) {
    throw Error('managed_switch_official_processes_active_or_unknown')
  }
}
function journalState(config) {
  const folder = path.dirname(path.resolve(config))
  const name = path.join(folder, SIDECAR), data = JSON.parse(readFileSync(name, 'utf8'))
  const keys = Object.keys(data).sort().join()
  if (keys !== ['config','configSha','newPayload','oldManifestSha','oldPayload','version'].sort().join() ||
    data.version !== 1 || data.config !== path.resolve(config) ||
    ![data.configSha, data.newPayload, data.oldPayload, data.oldManifestSha].every(v => SAFE.test(v)) ||
    shaFile(config) !== data.configSha) throw Error('managed_switch_journal_invalid')
  return { ...data, name, folder, managed: path.join(folder, '.chat-on-opencode-managed'),
    next: path.join(folder, NEXT), previous: path.join(folder, PREVIOUS) }
}
function confirmNew(state) {
  safeTree(state.managed)
  if (payloadDigest(state.managed) !== state.newPayload) throw Error('managed_switch_candidate_changed')
  inspectInstalledProvider(state.config)
}
export function stageManagedSwap(config, candidate) {
  const ctx = context(config)
  for (const name of [ctx.journal, ctx.next, ctx.previous]) ensureAbsent(name)
  const source = validateBundle(candidate)
  safeTree(source)
  if (path.resolve(source) === ctx.managed || source.startsWith(ctx.managed + path.sep) ||
    ctx.managed.startsWith(source + path.sep)) throw Error('managed_switch_overlapping_source')
  const oldManifest = readFileSync(path.join(ctx.managed, MANIFEST))
  const sourceDigest = candidateDigest(source)
  const oldDigest = payloadDigest(ctx.managed)
  const configSha = shaFile(ctx.config)
  try {
    mkdirSync(ctx.next)
    for (const directory of ['bin', 'plugin', 'src']) {
      copyTree(path.join(source, directory), path.join(ctx.next, directory))
    }
    for (const name of ['package.json', 'README.md', 'opencode.example.jsonc']) {
      if (existsSync(path.join(source, name))) copyFileSync(path.join(source, name), path.join(ctx.next, name))
    }
    const manifest = { ...ctx.info.manifest, payloadSha256: payloadDigest(ctx.next) }
    durableJSON(path.join(ctx.next, MANIFEST), manifest)
    if (manifest.payloadSha256 !== sourceDigest || candidateDigest(source) !== sourceDigest) {
      throw Error('managed_switch_candidate_changed')
    }
    durableJSON(ctx.journal, { version: 1, config: ctx.config, configSha,
      oldManifestSha: digest(oldManifest), oldPayload: oldDigest, newPayload: sourceDigest })
    return { prepared: true, activeUnchanged: shaFile(ctx.config) === configSha,
      candidateSha256: sourceDigest, needsOfflineActivation: true }
  } catch (error) {
    if (!stat(ctx.journal) && stat(ctx.next)) rmSync(ctx.next, { recursive: true })
    throw error
  }
}
export function activateManagedSwap(config, options) {
  const state = journalState(config)
  quiescent(options)
  ensureAbsent(state.previous)
  if (!stat(state.next)) throw Error('managed_switch_candidate_not_staged')
  safeTree(state.next)
  if (payloadDigest(state.next) !== state.newPayload) throw Error('managed_switch_candidate_changed')
  const current = context(config)
  if (payloadDigest(current.managed) !== state.oldPayload ||
    shaFile(path.join(current.managed, MANIFEST)) !== state.oldManifestSha) {
    throw Error('managed_switch_old_payload_changed')
  }
  renameSync(state.managed, state.previous)
  try { renameSync(state.next, state.managed) }
  catch (error) {
    if (!stat(state.managed) && stat(state.previous)) renameSync(state.previous, state.managed)
    throw error
  }
  confirmNew(state)
  return { activated: true, reversible: true, configUnchanged: shaFile(config) === state.configSha }
}
export function rollbackManagedSwap(config, options) {
  const state = journalState(config)
  quiescent(options)
  if (!stat(state.previous)) throw Error('managed_switch_previous_missing')
  safeTree(state.previous)
  if (payloadDigest(state.previous) !== state.oldPayload ||
    shaFile(path.join(state.previous, MANIFEST)) !== state.oldManifestSha) {
    throw Error('managed_switch_previous_changed')
  }
  if (stat(state.managed)) {
    confirmNew(state)
    ensureAbsent(state.next)
    renameSync(state.managed, state.next)
  }
  renameSync(state.previous, state.managed)
  inspectInstalledProvider(config)
  if (stat(state.next)) rmSync(state.next, { recursive: true })
  rmSync(state.name)
  return { rolledBack: true, originalConfigUnchanged: shaFile(config) === state.configSha }
}
export function managedSwapStatus(config) {
  const state = journalState(config)
  return { staged: Boolean(stat(state.next)), oldRetained: Boolean(stat(state.previous)),
    activeCandidate: Boolean(stat(state.previous) && stat(state.managed) &&
      payloadDigest(state.managed) === state.newPayload), configUnchanged: true }
}
const [, entry, command, config, bundle] = process.argv
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    if (!config || !path.isAbsolute(config)) throw Error('managed_switch_absolute_config_required')
    const result = command === '--stage' ? stageManagedSwap(config, bundle)
      : command === '--activate' ? activateManagedSwap(config)
      : command === '--rollback' ? rollbackManagedSwap(config)
      : command === '--status' ? managedSwapStatus(config)
      : (() => { throw Error('managed_switch_unknown_operation') })()
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) {
    process.stderr.write('managed_switch_refused: ' +
      String(error.message ?? 'unknown').replace(/[^a-zA-Z0-9_]/g, '_') + '\n')
    process.exitCode = 2
  }
}
