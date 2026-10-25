import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync,
  readFileSync, realpathSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync, fsyncSync,
} from 'node:fs'
import path from 'node:path'
import { createOpenCodeConfig } from './config.mjs'
import { addScopedProvider, readJSONC } from './jsonc-scoped.mjs'

const hash = input => createHash('sha256').update(input).digest('hex')
const MANAGED = '.chat-on-opencode-managed'
// Each version requires a real official CLI offline E2E with this plugin.
const SUPPORTED = new Set(['2.0.29', '2.0.32', '2.1.4'])

function regular(location, kind = 'path') {
  if (!path.isAbsolute(location) || !existsSync(location)) throw new Error(kind + '_absolute_existing_required')
  const details = lstatSync(location)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(kind + '_unsafe_file')
  return realpathSync(location)
}

function directory(location, kind = 'directory') {
  if (!path.isAbsolute(location) || !existsSync(location)) throw new Error(kind + '_absolute_existing_required')
  const details = lstatSync(location)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(kind + '_unsafe_directory')
  return realpathSync(location)
}

function officialVersion(binary, { runner = spawnSync } = {}) {
  const call = runner(binary, ['--version'], {
    windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' },
  })
  if (call.status !== 0 || typeof call.stdout !== 'string') throw new Error('official_cli_version_unverified')
  const version = /^opencode v?(\d+\.\d+\.\d+)\s*$/i.exec(call.stdout.trim())?.[1]
  if (!version || !SUPPORTED.has(version)) throw new Error('official_cli_plugin_api_unqualified')
  return version
}

export function validateBundle(folder) {
  const source = directory(folder, 'bundle')
  for (const folder of ['bin', 'plugin', 'src']) directory(path.join(source, folder), 'bundle_subfolder')
  for (const file of ['package.json', 'bin/generate-config.mjs', 'plugin/index.ts',
    'src/server.mjs', 'src/lifecycle.mjs', 'src/service.mjs']) regular(path.join(source, file), 'bundle_file')
  const pkg = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'))
  if (pkg.name !== 'chat-on-opencode-provider') throw new Error('provider_bundle_identity_invalid')
  const visit = dir => {
    for (const file of readdirSync(dir)) {
      const child = path.join(dir, file)
      const info = lstatSync(child)
      if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) throw new Error('provider_bundle_unsafe_entry')
      if (info.isDirectory()) visit(child)
    }
  }
  visit(source)
  return source
}

export function payloadDigest(folder) {
  const digest = createHash('sha256')
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      if (prefix === '' && name === 'install-manifest.json') continue
      const location = path.join(dir, name)
      const info = lstatSync(location)
      if (info.isSymbolicLink()) throw new Error('managed_payload_symlink')
      const relative = prefix + name
      if (info.isDirectory()) { digest.update('dir:' + relative + '\0'); walk(location, relative + '/') }
      else if (info.isFile()) { digest.update('file:' + relative + '\0'); digest.update(hash(readFileSync(location))) }
      else throw new Error('managed_payload_invalid_entry')
    }
  }
  walk(folder)
  return digest.digest('hex')
}

function atomicReplace(location, data, mode) {
  const tmp = location + '.chat-on-opencode-' + randomUUID() + '.tmp'
  let fd
  try {
    fd = openSync(tmp, 'wx', mode)
    writeFileSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, location)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(tmp)) rmSync(tmp, { force: true })
  }
}

const pathsFor = config => ({ managed: path.join(path.dirname(config), MANAGED) })

/** Inspect without changing the official app, existing config or running services. */
export function checkInstall(options, { runner } = {}) {
  const config = regular(options.configFile, 'opencode_config')
  const configDir = directory(path.dirname(config), 'opencode_config_directory')
  if (path.dirname(config) !== configDir || path.basename(config) !== 'opencode.jsonc') {
    throw new Error('unexpected_opencode_config_location')
  }
  const cli = regular(options.officialCli, 'official_cli')
  const version = officialVersion(cli, { runner })
  const source = validateBundle(options.bundleDir)
  const { managed } = pathsFor(config)
  if (existsSync(managed)) throw new Error('provider_previous_install_or_backup_present')
  // Never overwrite a previous backup, including one retained after rollback.
  const backup = config + '.chat-on-opencode.' + randomUUID() + '.bak'
  // The isolated fork runtime must be a different executable from OpenCode itself,
  // and MUST be explicitly consented before the provider touches a personal profile.
  if (realpathSync(options.runtimeExecutable) === cli) throw new Error('provider_runtime_cannot_be_opencode')
  const generated = createOpenCodeConfig({
    runtimeExecutable: options.runtimeExecutable, runtimeData: options.runtimeData,
    nodeExecutable: options.nodeExecutable, pluginDir: source,
    personalCoSData: options.personalCoSData, port: options.port,
  })
  const original = readFileSync(config)
  const content = original.toString('utf8')
  if (content.startsWith('\uFEFF')) throw new Error('opencode_config_bom_requires_manual_review')
  readJSONC(content)
  const relocated = JSON.parse(JSON.stringify(generated))
  relocated.plugins[0].package = path.join(managed, 'plugin')
  const proposed = addScopedProvider(content, relocated)
  return { config, source, managed, backup, version, original, proposed,
    originalSha256: hash(original), installedSha256: hash(Buffer.from(proposed)) }
}

export function installProvider(options, dependencies = {}) {
  const plan = checkInstall(options, dependencies)
  const mode = statSync(plan.config).mode
  const staging = plan.managed + '.' + randomUUID() + '.staging'
  let published = false
  try {
    mkdirSync(staging, { recursive: false })
    for (const folder of ['bin', 'plugin', 'src']) {
      mkdirSync(path.join(staging, folder))
      const copy = (from, to) => {
        for (const file of readdirSync(from)) {
          const input = path.join(from, file), output = path.join(to, file)
          if (lstatSync(input).isDirectory()) { mkdirSync(output); copy(input, output) }
          else copyFileSync(input, output)
        }
      }
      copy(path.join(plan.source, folder), path.join(staging, folder))
    }
    for (const file of ['package.json', 'README.md', 'opencode.example.jsonc']) {
      if (existsSync(path.join(plan.source, file))) copyFileSync(path.join(plan.source, file), path.join(staging, file))
    }
    const manifest = { format: 1, config: plan.config, backup: plan.backup,
      originalSha256: plan.originalSha256, installedSha256: plan.installedSha256,
      payloadSha256: payloadDigest(staging), version: plan.version }
    writeFileSync(path.join(staging, 'install-manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
    // Exact-byte backup comes before any personal configuration change.
    writeFileSync(plan.backup, plan.original, { flag: 'wx', mode: mode & 0o777 })
    if (hash(readFileSync(plan.config)) !== plan.originalSha256) throw new Error('opencode_config_changed_during_install')
    renameSync(staging, plan.managed)
    published = true
    if (hash(readFileSync(plan.config)) !== plan.originalSha256) throw new Error('opencode_config_changed_during_install')
    atomicReplace(plan.config, Buffer.from(plan.proposed), mode & 0o777)
    return { installed: true, cliVersion: plan.version, backup: plan.backup,
      installedSha256: plan.installedSha256 }
  } catch (error) {
    // Never overwrite concurrent user edits. Retain immutable backup for manual recovery.
    if (published && existsSync(plan.managed)) rmSync(plan.managed, { recursive: true })
    throw error
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true })
  }
}

/** Read-only integrity gate, shared by rollback and the process-only smoke launcher. */
export function inspectInstalledProvider(configFile) {
  const config = regular(configFile, 'opencode_config')
  const { managed } = pathsFor(config)
  directory(managed, 'managed')
  const manifestPath = regular(path.join(managed, 'install-manifest.json'), 'install_manifest')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.format !== 1 || manifest.config !== config ||
    typeof manifest.backup !== 'string' ||
    !manifest.backup.startsWith(config + '.chat-on-opencode.') ||
    !/^[-a-f0-9]{36}\.bak$/.test(manifest.backup.slice((config + '.chat-on-opencode.').length))) {
    throw new Error('provider_rollback_manifest_mismatch')
  }
  const restored = readFileSync(regular(manifest.backup, 'backup'))
  if (hash(restored) !== manifest.originalSha256) throw new Error('provider_backup_modified')
  if (hash(readFileSync(config)) !== manifest.installedSha256) {
    throw new Error('provider_config_modified_refuse_rollback')
  }
  if (payloadDigest(managed) !== manifest.payloadSha256) {
    throw new Error('provider_payload_modified_refuse_delete')
  }
  return { config, managed, manifest }
}

/** Restore exactly the previously backed up bytes; refuse any intervening change. */
export function rollbackProvider(configFile) {
  const { config, managed, manifest } = inspectInstalledProvider(configFile)
  const restored = readFileSync(regular(manifest.backup, 'backup'))
  atomicReplace(config, restored, statSync(config).mode & 0o777)
  rmSync(managed, { recursive: true })
  return { rolledBack: true, restoredSha256: manifest.originalSha256, backupRetained: true }
}
