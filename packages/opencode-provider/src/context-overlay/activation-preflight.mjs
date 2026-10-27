import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { additiveSourceDigest, additiveStatus } from './additive-install.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const knownPlugins = ['Goal', 'Loop', 'Daemon', 'Scheduler']
const priorSwap = [
  '.chat-on-opencode-directory-switch.json',
  '.chat-on-opencode-directory-previous',
  '.chat-on-opencode-directory-candidate',
]
function safeExisting(input, type) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw Error('preflight_absolute_path_required')
  const p = path.resolve(input)
  let cursor = path.parse(p).root
  for (const segment of p.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const info = lstatSync(cursor)
    if (info.isSymbolicLink()) throw Error('preflight_symlink_disallowed')
  }
  const info = lstatSync(p)
  if (type === 'file' ? !info.isFile() : !info.isDirectory()) {
    throw Error('preflight_path_type_invalid')
  }
  return p
}
const present = p => {
  try {
    lstatSync(p)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
function namedFileHash(file) {
  if (!present(file)) return { state: 'absent' }
  try {
    safeExisting(file, 'file')
    return { state: 'file', sha256: digest(readFileSync(file)) }
  } catch {
    return { state: 'unsafe_or_unreadable' }
  }
}
/**
 * Observes process names and the two known TCP listener ports; NEVER connects
 * to either listener or reads command lines, user texts or credentials.
 * Non-Windows invocation and ANY failed probe are unknown, not idle.
 */
export function observeWindows() {
  if (process.platform !== 'win32') return { state: 'unknown' }
  const code = [
    '$ErrorActionPreference = "Stop"',
    '$names = @("OpenCode", "opencode-cli", "Chat On OpenCode Provider")',
    '$list = @([Diagnostics.Process]::GetProcesses() | Where-Object { $names -contains $_.ProcessName })',
    '$ports = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in @(8765,8766) })',
    '@{ activeOpenCode = $list.Count; port8765 = @($ports | Where-Object { $_.LocalPort -eq 8765 }).Count; port8766 = @($ports | Where-Object { $_.LocalPort -eq 8766 }).Count } | ConvertTo-Json -Compress',
  ].join('; ')
  const probe = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', code], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 12000,
    })
  if (probe.status !== 0) return { state: 'unknown' }
  try {
    const value = JSON.parse(probe.stdout.trim())
    if (![value.activeOpenCode, value.port8765, value.port8766]
      .every(v => Number.isSafeInteger(v) && v >= 0)) return { state: 'unknown' }
    return { state: 'observed', ...value }
  } catch {
    return { state: 'unknown' }
  }
}
/**
 * Read-only state audit for the *actual* additive target. A filesystem/process
 * snapshot NEVER proves that all unsent GUI composers are saved. No activation
 * is authorized by this function, even when a runner test appears quiescent.
 */
export function inspectActivation({ config, bundle, observe = observeWindows }) {
  const configPath = safeExisting(config, 'file')
  if (path.basename(configPath).toLowerCase() !== 'opencode.jsonc') {
    throw Error('preflight_config_name_invalid')
  }
  const bundlePath = safeExisting(bundle, 'dir')
  const root = safeExisting(path.dirname(configPath), 'dir')
  const configSha256 = digest(readFileSync(configPath))
  const model = observe()
  const reasons = []
  if (model?.state !== 'observed') reasons.push('process_and_port_state_unknown')
  else if (model.activeOpenCode !== 0) reasons.push('opencode_processes_running')
  const swap = Object.fromEntries(priorSwap.map(name => [
    name === '.chat-on-opencode-directory-switch.json' ? 'journal' :
      name.endsWith('previous') ? 'previousGeneration' : 'stagedCandidate',
    present(path.join(root, name)),
  ]))
  if (Object.values(swap).some(Boolean)) reasons.push('existing_swap_requires_reconciliation')
  const preserved = Object.fromEntries(knownPlugins.map(name => [
    name, namedFileHash(path.join(root, 'plugins', name, 'index.ts')),
  ]))
  if (Object.values(preserved).some(value => value.state === 'unsafe_or_unreadable')) {
    reasons.push('foreign_plugin_unreadable')
  }
  const safetyFiles = {
    config: { state: 'file', sha256: configSha256 },
    additiveJournal: present(path.join(root, '.chat-on-opencode-context-overlay.pending.json')),
    additiveReceipt: present(path.join(root, '.chat-on-opencode-context-overlay.receipt.json')),
  }
  if (safetyFiles.additiveJournal) reasons.push('additive_transaction_pending')
  let overlayState = 'unknown'
  let sourceSha256 = null
  try {
    sourceSha256 = additiveSourceDigest(bundlePath)
    overlayState = additiveStatus(configPath, bundlePath).state
  } catch {
    reasons.push('additive_status_unverifiable')
  }
  if (overlayState === 'partial_removal' || overlayState === 'unmanaged_collision') {
    reasons.push('additive_integrity_conflict')
  }
  if (overlayState === 'installed') reasons.push('additive_already_installed')
  // This scope cannot see all unsent GUI composers and does not inspect them.
  reasons.push('unsent_gui_drafts_not_proven_durable')
  return {
    status: 'NO_GO',
    activationAuthorized: false,
    configSha256, sourceSha256,
    processAndPorts: model, swap, preservedPlugins: preserved,
    safetyFiles, overlayState,
    reasons: [...new Set(reasons)],
  }
}
