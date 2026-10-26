import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { inspectInstalledProvider, payloadDigest, validateBundle } from './official-install.mjs'
import { candidateDigest } from './official-upgrade.mjs'

const NAME = 'chat-on-opencode-oauth-bootstrap'
const META = 'bootstrap-manifest.json'
const hash = data => createHash('sha256').update(data).digest('hex')
const SHA = /^[a-f0-9]{64}$/
const stat = name => {
  try { return lstatSync(name) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function safePath(name, kind) {
  if (!path.isAbsolute(name)) throw Error('oauth_bootstrap_absolute_path_required')
  const target = path.resolve(name)
  let part = path.parse(target).root
  for (const section of target.slice(part.length).split(path.sep).filter(Boolean)) {
    part = path.join(part, section)
    const info = stat(part)
    if (!info || info.isSymbolicLink()) throw Error('oauth_bootstrap_unsafe_path')
  }
  const info = stat(target)
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw Error('oauth_bootstrap_unsafe_path')
  return realpathSync(target)
}
function safeTree(dir) {
  safePath(dir, 'directory')
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name), info = stat(file)
    if (!info || info.isSymbolicLink()) throw Error('oauth_bootstrap_unsafe_content')
    if (info.isDirectory()) safeTree(file)
    else if (!info.isFile()) throw Error('oauth_bootstrap_unsafe_content')
  }
}
function copyTree(source, target) {
  mkdirSync(target)
  for (const name of readdirSync(source)) {
    const from = path.join(source, name), to = path.join(target, name), info = stat(from)
    if (!info || info.isSymbolicLink()) throw Error('oauth_bootstrap_unsafe_content')
    if (info.isDirectory()) copyTree(from, to)
    else if (info.isFile()) copyFileSync(from, to)
    else throw Error('oauth_bootstrap_unsafe_content')
  }
}
function writeExclusive(file, contents) {
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, contents); fsyncSync(fd) } finally { closeSync(fd) }
}
function idle({ probe = spawnSync } = {}) {
  if (process.platform !== 'win32') throw Error('oauth_bootstrap_windows_only')
  const result = probe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; @([Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -in @("OpenCode","opencode-cli") }).Count'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 7000,
  })
  if (result.status !== 0 || !/^0\s*$/.test(result.stdout ?? '')) {
    throw Error('oauth_bootstrap_official_processes_active_or_unknown')
  }
}
function context(config) {
  safePath(config, 'file')
  const info = inspectInstalledProvider(config)
  safeTree(info.managed)
  safePath(info.manifest.backup, 'file')
  const folder = path.dirname(info.config)
  const plugins = path.join(folder, 'plugins')
  const target = path.join(plugins, NAME)
  return { info, plugins, target,
    pin: { configSha: hash(readFileSync(info.config)),
      managedSha: payloadDigest(info.managed),
      manifestSha: hash(readFileSync(path.join(info.managed, 'install-manifest.json'))) } }
}
const SHIM = [
  "import { Plugin } from '@opencode/plugin'",
  "import { registerNativeSIWC } from './payload/plugin/native-siwc.mjs'",
  "export default Plugin.define({",
  "  id: 'chat-on-opencode-oauth-bootstrap',",
  "  async setup(ctx) { await registerNativeSIWC(ctx) },",
  "})",
  '',
].join('\n')
function verify(ctx) {
  safeTree(ctx.target)
  const meta = JSON.parse(readFileSync(path.join(ctx.target, META), 'utf8'))
  const data = { version: 1, config: ctx.info.config, ...ctx.pin, payloadSha: meta.payloadSha }
  if (Object.keys(meta).sort().join() !== [...Object.keys(data), 'checksum'].sort().join() ||
    meta.checksum !== hash(JSON.stringify(data)) || JSON.stringify(ctx.pin) !== JSON.stringify({
      configSha: meta.configSha, managedSha: meta.managedSha, manifestSha: meta.manifestSha,
    }) || !SHA.test(meta.payloadSha)) throw Error('oauth_bootstrap_config_changed_or_manifest_invalid')
  if (hash(readFileSync(path.join(ctx.target, 'index.ts'))) !== hash(SHIM) ||
    payloadDigest(path.join(ctx.target, 'payload')) !== meta.payloadSha) {
    throw Error('oauth_bootstrap_payload_changed')
  }
  return meta
}
/** Immutable, single-directory publication alongside the existing format-1 plugin. */
export function stageOAuthBootstrap(config, bundle, options) {
  idle(options)
  const ctx = context(config)
  if (stat(ctx.target)) throw Error('oauth_bootstrap_exists')
  if (!SHA.test(options?.expectedSha256 ?? '')) throw Error('oauth_bootstrap_expected_sha_required')
  // If the active provider already registers the same integration method,
  // a second independent plugin would compete for its OAuth handler.
  if (/\bregisterNativeSIWC\s*\(\s*ctx\s*\)/.test(
    readFileSync(path.join(ctx.info.managed, 'plugin', 'index.ts'), 'utf8'))) {
    throw Error('oauth_bootstrap_native_oauth_already_available')
  }
  const source = safePath(validateBundle(bundle), 'directory')
  safeTree(source)
  if (source === ctx.info.managed || source.startsWith(ctx.info.managed + path.sep) ||
    ctx.info.managed.startsWith(source + path.sep) ||
    source === ctx.plugins || source.startsWith(ctx.plugins + path.sep)) {
    throw Error('oauth_bootstrap_source_overlaps_installation')
  }
  const expected = candidateDigest(source)
  if (expected !== options.expectedSha256) throw Error('oauth_bootstrap_candidate_untrusted')
  if (stat(ctx.plugins)) safePath(ctx.plugins, 'directory')
  else mkdirSync(ctx.plugins)
  // An incomplete directory inside plugins/ could be auto-discovered by another
  // OpenCode process; build beside plugins/ and publish by same-volume rename.
  const staging = path.join(path.dirname(ctx.plugins), '.' + NAME + '.' + randomUUID() + '.stage')
  mkdirSync(staging)
  let published = false
  try {
    const payload = path.join(staging, 'payload')
    mkdirSync(payload)
    for (const dir of ['bin', 'plugin', 'src']) copyTree(path.join(source, dir), path.join(payload, dir))
    for (const name of ['package.json', 'README.md', 'opencode.example.jsonc']) {
      if (existsSync(path.join(source, name))) copyFileSync(path.join(source, name), path.join(payload, name))
    }
    if (payloadDigest(payload) !== expected || candidateDigest(source) !== expected) {
      throw Error('oauth_bootstrap_source_changed')
    }
    writeExclusive(path.join(staging, 'index.ts'), SHIM)
    const data = { version: 1, config: ctx.info.config, ...ctx.pin, payloadSha: expected }
    writeExclusive(path.join(staging, META), JSON.stringify({ ...data, checksum: hash(JSON.stringify(data)) }))
    // A checked directory rename publishes exactly one auto-discovered plugin.
    if (stat(ctx.target)) throw Error('oauth_bootstrap_exists')
    if (JSON.stringify(context(config).pin) !== JSON.stringify(ctx.pin)) throw Error('oauth_bootstrap_config_changed')
    renameSync(staging, ctx.target)
    published = true
    verify(context(config))
    return { staged: true, configUnchanged: true, reversible: true, payloadSha256: expected }
  } finally {
    if (!published && stat(staging)) {
      safeTree(staging)
      rmSync(staging, { recursive: true })
    }
  }
}
export function oauthBootstrapStatus(config) {
  const ctx = context(config)
  if (!stat(ctx.target)) return { present: false }
  verify(ctx)
  return { present: true, configUnchanged: true }
}
export function removeOAuthBootstrap(config, options) {
  idle(options)
  const ctx = context(config)
  if (!stat(ctx.target)) throw Error('oauth_bootstrap_missing')
  verify(ctx)
  // Remove from discovery with one rename; a crash during deletion cannot
  // expose a half-removed plugin to the next OpenCode startup.
  const retired = path.join(path.dirname(ctx.plugins), '.' + NAME + '.' + randomUUID() + '.retired')
  renameSync(ctx.target, retired)
  safeTree(retired)
  rmSync(retired, { recursive: true })
  return { removed: true, configUnchanged: true, originalProviderUnchanged: true }
}
