import { existsSync, lstatSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { inspectInstalledProvider, payloadDigest, validateBundle } from './official-install.mjs'
import { candidateDigest } from './official-upgrade.mjs'
import { readJSONC } from './jsonc-scoped.mjs'

const child = (node, key) => node?.type === 'object' ? node.members.find(m => m.key === key)?.node : undefined
const scalar = (source, node) => {
  if (node?.type !== 'scalar') return undefined
  try { return JSON.parse(source.slice(node.start, node.end)) } catch { return undefined }
}
const file = name => typeof name === 'string' && path.isAbsolute(name) &&
  existsSync(name) && lstatSync(name).isFile() && !lstatSync(name).isSymbolicLink()
const folder = name => typeof name === 'string' && path.isAbsolute(name) &&
  existsSync(name) && lstatSync(name).isDirectory() && !lstatSync(name).isSymbolicLink()
const equalPath = (a, b) => process.platform === 'win32'
  ? a?.toLowerCase() === b?.toLowerCase() : a === b

// Reads no account data and never prints the source text, profile path or secrets.
export function classifyGatewayPlugin(source) {
  if (typeof source !== 'string') return 'unknown'
  if (source.includes('randomBytes(32)') && source.includes('const key = randomBytes(32)')) {
    return 'ephemeral'
  }
  if (source.includes('CHAT_ON_OPENCODE_GATEWAY_KEY') &&
      !source.includes('const key = randomBytes(32)')) return 'legacy_environment'
  return 'unknown'
}

function extractOwnedEntry(text, managed) {
  const root = readJSONC(text)
  const plugins = child(root, 'plugins'), providers = child(root, 'providers')
  if (plugins?.type !== 'array' || providers?.type !== 'object' ||
      !child(providers, 'chat-on-opencode')) throw Error('doctor_provider_not_registered')
  const candidates = plugins.members.map(({ node }) => {
    if (node.type !== 'object') return null
    const packageName = scalar(text, child(node, 'package'))
    if (!equalPath(packageName, path.join(managed, 'plugin'))) return null
    const options = child(node, 'options')
    return options?.type === 'object' ? {
      runtimeExecutable: scalar(text, child(options, 'runtimeExecutable')),
      runtimeData: scalar(text, child(options, 'runtimeData')),
      nodeExecutable: scalar(text, child(options, 'nodeExecutable')),
      port: scalar(text, child(options, 'port')),
      nativeTools: scalar(text, child(options, 'nativeTools')),
    } : null
  }).filter(Boolean)
  const model = child(child(child(providers, 'chat-on-opencode'), 'models'), 'chatgpt-default')
  if (candidates.length !== 1 || !model) throw Error('doctor_provider_registration_invalid')
  return candidates[0]
}

function listener(port, timeout = 750) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = value => { socket.destroy(); resolve(value) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeout, () => finish(false))
  })
}

/** Read-only state inspection, never an upgrade or a credential probe. */
export async function diagnoseInstalledProvider(configFile, {
  bundleDir, checkSocket = false, socketProbe = listener,
} = {}) {
  const { config, managed, manifest } = inspectInstalledProvider(configFile)
  const own = extractOwnedEntry(readFileSync(config, 'utf8'), managed)
  const source = readFileSync(path.join(managed, 'plugin', 'index.ts'), 'utf8')
  const keyMode = classifyGatewayPlugin(source)
  // Compare the exact payload inventory (bin/plugin/src plus packaged root files),
  // not just index.ts: a fixed entrypoint with stale gateway code also fails.
  const candidateMatches = bundleDir ? candidateDigest(validateBundle(bundleDir)) ===
    payloadDigest(managed) : null
  const runtimeAvailable = file(own.runtimeExecutable) && file(own.nodeExecutable) && folder(own.runtimeData)
  let isolatedConsent = false
  if (runtimeAvailable && file(path.join(own.runtimeData, 'config.json'))) {
    try {
      const settings = JSON.parse(readFileSync(path.join(own.runtimeData, 'config.json'), 'utf8'))
      isolatedConsent = settings?.ui?.chatBrowser === 'cos' &&
        settings?.controlApi?.enabled === true && settings?.controlApi?.allowActions === true
    } catch { /* no raw config, paths or secrets leave this boundary */ }
  }
  const port = Number(own.port)
  const portValid = /^\d{1,5}$/.test(own.port ?? '') && port > 0 && port <= 65535
  const gatewayListening = checkSocket && portValid ? await socketProbe(port) : null
  const blockers = []
  if (keyMode !== 'ephemeral') blockers.push(keyMode === 'legacy_environment'
    ? 'installed_plugin_legacy_gateway_key' : 'installed_plugin_key_unverified')
  if (candidateMatches === false) blockers.push('installed_bundle_outdated')
  if (!runtimeAvailable) blockers.push('isolated_runtime_missing')
  else if (!isolatedConsent) blockers.push('isolated_runtime_consent_missing')
  if (!portValid) blockers.push('configured_gateway_port_invalid')
  else if (gatewayListening === false) blockers.push('configured_gateway_not_listening')
  // Runtime session readiness and real ChatGPT inference cannot be proven by TCP or file checks.
  return {
    status: blockers.length ? 'NO_GO_PROVIDER_NOT_READY' : 'PREFLIGHT_ONLY',
    cliVersionAtInstall: manifest.version,
    providerRegistered: true,
    configAndBackupHashesVerified: true,
    keyMode, candidateMatches, runtimeAvailable, isolatedConsent,
    nativeReadRequested: own.nativeTools === 'read',
    gatewayListening, blockers,
    inferenceAuthenticated: false, activeUpgradePerformed: false,
  }
}
