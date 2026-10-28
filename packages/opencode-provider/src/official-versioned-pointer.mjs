// Experimental restart-only config pointer. NOT a live Desktop activation API.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { readJSONC } from './jsonc-scoped.mjs'
import { candidateDigest } from './official-upgrade.mjs'

const sha = b => createHash('sha256').update(b).digest('hex')
const hex = /^[a-f0-9]{64}$/
const refuse = reason => { throw Error('versioned_pointer_' + reason) }
function idle(probe) {
  if (process.platform !== 'win32') refuse('windows_only')
  const r = probe('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
    '$ErrorActionPreference="Stop"; @([Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -in @("OpenCode","opencode","opencode-cli","Chat On OpenCode Provider") }).Count'],
  { encoding: 'utf8', shell: false, windowsHide: true, timeout: 7000 })
  if (r.status !== 0 || !/^0\s*$/.test(r.stdout ?? '')) refuse('busy_or_unknown')
}
function safeFile(file) {
  if (!path.isAbsolute(file) || !existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) refuse('unsafe_config')
}
function safeDir(dir) {
  if (!path.isAbsolute(dir) || !existsSync(dir) || !lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) refuse('unsafe_generation')
}
function pointer(bytes) {
  const source = bytes.toString('utf8')
  readJSONC(source)
  // Prototype deliberately supports strict JSON only; JSONC with comments
  // needs AST offset edits, never a lossy parse/stringify rewrite.
  let cfg
  try { cfg = JSON.parse(source) } catch { refuse('jsonc_requires_offset_editor') }
  const plugins = cfg.plugins
  if (!Array.isArray(plugins) || plugins.length !== 1 || typeof plugins[0]?.package !== 'string') refuse('config_shape')
  return { source, package: plugins[0].package }
}
function replaced(source, oldPath, nextPath) {
  const escaped = JSON.stringify(oldPath)
  if (source.split(escaped).length !== 2) refuse('ambiguous_config_reference')
  return source.replace(escaped, JSON.stringify(nextPath))
}
function atomic(file, bytes, fault) {
  const tmp = file + '.versioned-' + randomUUID() + '.tmp'
  let fd
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined
    fault?.('before_publish')
    renameSync(tmp, file) // the ONLY publication point: config bytes old OR new
    fault?.('after_publish')
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(tmp)) rmSync(tmp) }
}
/** Caller supplies versioned immutable directories and an exact config CAS.
 * Both generations remain on disk. No active reload/activation is authorized.
 */
export function publishRestartOnlyPointer(config, from, to, { configSha, fromSha, toSha,
  probe = spawnSync, fault } = {}) {
  safeFile(config); safeDir(from); safeDir(to)
  if (![configSha,fromSha,toSha].every(v => hex.test(v ?? ''))) refuse('cas_missing')
  const lock = path.join(path.dirname(config), '.chat-on-opencode-versioned-pointer.lock')
  let fd
  try {
    fd = openSync(lock, 'wx', 0o600)
    idle(probe)
    const old = readFileSync(config)
    if (sha(old) !== configSha || candidateDigest(from) !== fromSha || candidateDigest(to) !== toSha) refuse('cas_changed')
    const p = pointer(old), fromPath = path.join(from, 'plugin'), toPath = path.join(to, 'plugin')
    if (p.package !== fromPath) refuse('pointer_mismatch')
    const next = Buffer.from(replaced(p.source, fromPath, toPath))
    pointer(next)
    idle(probe)
    if (sha(readFileSync(config)) !== configSha || candidateDigest(from) !== fromSha || candidateDigest(to) !== toSha) refuse('cas_changed')
    atomic(config, next, fault)
    return { status: 'RESTART_REQUIRED_ONLY', promotionAllowed: false, activationAuthorized: false,
      previousConfigSha256: configSha, publishedConfigSha256: sha(next) }
  } finally { if (fd !== undefined) { closeSync(fd); rmSync(lock) } }
}
/** Crash recovery is read-only: old or new config, never intermediate bytes. */
export function inspectRestartOnlyPointer(config, oldSha, newSha) {
  safeFile(config)
  const current = sha(readFileSync(config))
  if (current !== oldSha && current !== newSha) refuse('unknown_config')
  return { state: current === oldSha ? 'OLD' : 'NEW', activationAuthorized: false, restartRequired: true }
}
