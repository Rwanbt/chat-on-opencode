// Experimental restart-only config pointer. NOT a live Desktop activation API.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { readJSONC } from './jsonc-scoped.mjs'
import { candidateDigest } from './official-upgrade.mjs'

const sha = b => createHash('sha256').update(b).digest('hex')
const hex = /^[a-f0-9]{64}$/
const refuse = reason => { throw Error('versioned_pointer_' + reason) }
const PUBLISH_METHOD = 'win32_MoveFileExW_REPLACE_EXISTING_WRITE_THROUGH'
// This invokes the actual Windows kernel32 operation rather than libuv's
// ordinary rename. The two paths are ALWAYS siblings, and COPY_ALLOWED is
// intentionally absent; a cross-volume copy/delete must never be substituted
// for the single rename. The compiler/PowerShell process may fail or be
// restricted by policy: that is a refusal, not a fallback to renameSync.
const win32Move = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class ChatOnOpenCodePointerWin32 {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "MoveFileExW", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool Move(string source, string destination, uint flags);
  public static int Publish(string source, string destination, string expectedSha) {
    try {
      // FileShare deliberately omits WRITE: no new uncooperative writer can
      // open the destination while we hash its exact handle. Windows
      // MoveFileExW cannot replace this file while even this own handle is
      // open (ERROR_ACCESS_DENIED), so release it IMMEDIATELY before rename.
      // An uncooperative process can still race that final small interval.
      using (var locked = new FileStream(destination, FileMode.Open, FileAccess.Read,
                                        FileShare.Read | FileShare.Delete)) {
        using (var sha = SHA256.Create()) {
          var actual = BitConverter.ToString(sha.ComputeHash(locked)).Replace("-", "").ToLowerInvariant();
          if (!String.Equals(actual, expectedSha, StringComparison.Ordinal)) return 42;
        }
      }
      if (!Move(source, destination, 9)) return 43;
      return 0;
    } catch { return 44; }
  }
}
'@
  $result = [ChatOnOpenCodePointerWin32]::Publish($env:COO_POINTER_NATIVE_FROM, $env:COO_POINTER_NATIVE_TO, $env:COO_POINTER_NATIVE_SHA)
  if ($result -eq 42) { exit 42 }
  if ($result -ne 0) { exit 23 }
  [Console]::Out.WriteLine('WIN32_MOVEFILEEX_WRITETHROUGH_OK')
} catch {
  [Console]::Error.WriteLine('WIN32_MOVE_HELPER_UNAVAILABLE')
  exit 24
}
`
function publishNativeWin32(tmp, file, expectedSha) {
  if (process.platform !== 'win32' || path.dirname(tmp) !== path.dirname(file)) refuse('unsafe_native_publish')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', win32Move], {
    env: { ...process.env, COO_POINTER_NATIVE_FROM: tmp, COO_POINTER_NATIVE_TO: file,
      COO_POINTER_NATIVE_SHA: expectedSha },
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000, maxBuffer: 4096,
  })
  // A timeout/abrupt helper death could have happened on either side of the
  // kernel call. Report UNKNOWN; inspectRestartOnlyPointer can classify
  // either complete content without guessing or automatically replaying.
  if (result.status === null || result.error) refuse('native_publish_unknown')
  if (result.status === 42) refuse('native_cas_changed')
  if (result.status !== 0 || result.stdout.trim() !== 'WIN32_MOVEFILEEX_WRITETHROUGH_OK') {
    refuse('native_publish_refused')
  }
}
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
// The directory-swap and chained-swap protocols retain journals with an
// exact *original config* digest. Repointing that config would invalidate
// their CAS rollback and leave active/parked generations stranded. A pointer
// publisher cannot safely join either protocol, even when no process runs.
const managedMarkers = [
  '.chat-on-opencode-directory-switch.json', '.chat-on-opencode-directory-next',
  '.chat-on-opencode-directory-previous', '.chat-on-opencode-chain-prepare.json',
  '.chat-on-opencode-chain-next', '.chat-on-opencode-chain-active-previous',
  '.chat-on-opencode-chain-transition.lock',
  '.chat-on-opencode-chain-transition.lock.recover',
]
function noManagedTransition(config) {
  const dir = path.dirname(config)
  if (managedMarkers.some(name => existsSync(path.join(dir, name)))) refuse('managed_transition_pending')
}
function pointer(bytes, expectedPackage) {
  // Buffer.toString() silently replaces invalid UTF-8. Never turn a foreign
  // user's malformed byte into U+FFFD while rewriting our one package path.
  let source
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { refuse('invalid_utf8') }
  const root = readJSONC(source)
  const plugins = root.members.find(item => item.key === 'plugins')?.node
  if (plugins?.type !== 'array') refuse('config_shape')
  const matches = []
  for (const item of plugins.members) {
    if (item.node.type !== 'object') continue // other installed plugins may be strings
    const pkg = item.node.members.find(member => member.key === 'package')?.node
    if (!pkg) continue
    if (pkg.type !== 'scalar') refuse('config_shape')
    let value
    try { value = JSON.parse(source.slice(pkg.start, pkg.end)) }
    catch { refuse('config_shape') }
    if (value === expectedPackage) matches.push(pkg)
  }
  if (matches.length !== 1) refuse(matches.length ? 'ambiguous_config_reference' : 'pointer_mismatch')
  return { source, package: expectedPackage, offset: matches[0] }
}
function replaced(found, nextPath) {
  // The JSONC parser captures scalar start/end offsets. Preserve every other
  // byte, including comments, trailing commas, CRLF and foreign plugin values.
  const { source, offset } = found
  return source.slice(0, offset.start) + JSON.stringify(nextPath) + source.slice(offset.end)
}
// A PID alone is not a lock identity: Windows can reuse it after the writer
// crashes. Bind abandoned-lock recovery to the OS process creation timestamp.
// Retry only the *same* kernel creation-time query. Never infer process identity
// from a PID, missing timestamp, or a different clock. All failures fail closed.
export function probeWindowsProcessStart(pid, runner = spawnSync) {
  if (!Number.isSafeInteger(pid) || pid < 1) refuse('lock_owner_unverifiable')
  const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'MISSING' } else { $p.StartTime.ToUniversalTime().Ticks.ToString() }`
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', shell: false, windowsHide: true, timeout: 7000 })
    if (result.status === 0 && /^(?:MISSING|\\d+)\\s*$/.test(result.stdout ?? '')) return result.stdout.trim()
  }
  refuse('lock_owner_unverifiable')
}
function processStart(pid) { return probeWindowsProcessStart(pid) }
function lockOwner() {
  const start = processStart(process.pid)
  if (start === 'MISSING') refuse('lock_owner_unverifiable')
  return { version: 1, pid: process.pid, start, nonce: randomUUID() }
}
// Materialize the complete owner record before publishing its name. The old
// O_EXCL -> write window left an empty, permanently unverifiable lock when the
// process died in between. Hard-link creation fails if another owner won.
function createLock(file, owner) {
  const tmp = file + '.' + randomUUID() + '.tmp'
  let fd
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(owner))
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    linkSync(tmp, file)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(tmp)) rmSync(tmp)
  }
}
function releaseOwned(file, owner) {
  if (existsSync(file) && readFileSync(file).equals(Buffer.from(JSON.stringify(owner)))) rmSync(file)
}
function abandonedLock(config, lock, recoverLock, configSha, from, to, fromSha, toSha, probe) {
  // The recovery marker keeps compliant publishers from acquiring the path
  // during the one stale-lock removal. It is never evidence that a writer died.
  const recoveryOwner = lockOwner()
  try {
    createLock(recoverLock, recoveryOwner)
    idle(probe)
    if (!existsSync(lock) || !lstatSync(lock).isFile() || lstatSync(lock).isSymbolicLink()) refuse('lock_unverifiable')
    const original = readFileSync(lock)
    let owner
    try { owner = JSON.parse(original.toString('utf8')) } catch { refuse('lock_unverifiable') }
    if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      !/^\d+$/.test(owner.start ?? '') ||
      typeof owner.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(owner.nonce)) refuse('lock_unverifiable')
    const currentStart = processStart(owner.pid)
    if (currentStart === owner.start) refuse('lock_owner_active')
    // A different creation timestamp proves PID reuse; MISSING proves exit.
    idle(probe)
    if (sha(readFileSync(config)) !== configSha || candidateDigest(from) !== fromSha ||
      candidateDigest(to) !== toSha || !readFileSync(lock).equals(original)) refuse('cas_changed')
    rmSync(lock)
  } finally {
    releaseOwned(recoverLock, recoveryOwner)
  }
}
function atomic(file, bytes, expectedSha, probe, fault) {
  const tmp = file + '.versioned-' + randomUUID() + '.tmp'
  let fd
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined
    fault?.('before_publish')
    // Last possible pre-rename CAS checkpoint: a competing writer may have
    // changed the existing config after validation while we fsynced the temp.
    // This does not constitute a cross-process atomic compare-and-swap:
    // uncooperative writers can still race the final read and rename.
    if (sha(readFileSync(file)) !== expectedSha) refuse('cas_changed')
    noManagedTransition(file)
    // Close the precommit gap introduced by fault injection, temp fsync, and
    // CAS recheck. Never publish if an official reader appears meanwhile.
    // This is not an OS-wide atomic reader/writer lock: a new reader starting
    // *after* this check is outside the protection of this restart-only API.
    idle(probe)
    // This is a single-filesystem rename, not a multi-file transaction.
    // fsync on the temporary file protects its contents against process death,
    // but Windows does not guarantee that the rename itself survives sudden
    // power loss without an independently proven directory flush.
    fault?.('after_preflight_before_native')
    publishNativeWin32(tmp, file, expectedSha) // one same-volume publication point
    fault?.('after_publish')
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(tmp)) rmSync(tmp) }
}
/** Caller supplies versioned immutable directories and an exact config CAS.
 * Both generations remain on disk. No active reload/activation is authorized.
 */
export function publishRestartOnlyPointer(config, from, to, { configSha, fromSha, toSha,
  probe = spawnSync, fault } = {}) {
  if (process.platform !== 'win32') refuse('windows_only')
  safeFile(config); safeDir(from); safeDir(to)
  if (![configSha,fromSha,toSha].every(v => hex.test(v ?? ''))) refuse('cas_missing')
  noManagedTransition(config)
  const lock = path.join(path.dirname(config), '.chat-on-opencode-versioned-pointer.lock')
  const recoverLock = lock + '.recover'
  const owner = lockOwner()
  try {
    if (existsSync(recoverLock)) refuse('recovery_active')
    try { createLock(lock, owner) }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error
      abandonedLock(config, lock, recoverLock, configSha, from, to, fromSha, toSha, probe)
      createLock(lock, owner)
    }
    if (existsSync(recoverLock)) refuse('recovery_active')
    idle(probe)
    noManagedTransition(config)
    const old = readFileSync(config)
    if (sha(old) !== configSha || candidateDigest(from) !== fromSha || candidateDigest(to) !== toSha) refuse('cas_changed')
    const fromPath = path.join(from, 'plugin'), toPath = path.join(to, 'plugin')
    const next = Buffer.from(replaced(pointer(old, fromPath), toPath))
    pointer(next, toPath)
    idle(probe)
    if (sha(readFileSync(config)) !== configSha || candidateDigest(from) !== fromSha || candidateDigest(to) !== toSha) refuse('cas_changed')
    atomic(config, next, configSha, probe, fault)
    return { status: 'RESTART_REQUIRED_ONLY', promotionAllowed: false, activationAuthorized: false,
      previousConfigSha256: configSha, publishedConfigSha256: sha(next), publishMethod: PUBLISH_METHOD }
  } finally { releaseOwned(lock, owner) }
}
/** Crash recovery is read-only: old or new config, never intermediate bytes. */
export function inspectRestartOnlyPointer(config, oldSha, newSha) {
  safeFile(config)
  const current = sha(readFileSync(config))
  if (current !== oldSha && current !== newSha) refuse('unknown_config')
  return { state: current === oldSha ? 'OLD' : 'NEW', activationAuthorized: false, restartRequired: true }
}
