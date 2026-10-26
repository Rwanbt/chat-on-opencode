import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

function absoluteExisting(location, kind) {
  if (typeof location !== 'string' || !path.isAbsolute(location)) {
    throw new Error(kind + '_absolute_path_required')
  }
  const resolved = realpathSync(location)
  const stats = statSync(resolved)
  if (kind === 'runtime_data' || kind === 'plugin_dir' ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(kind + '_invalid_type')
  }
  return resolved
}

function contains(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

/** Generate OpenCode V2 config without touching a real OpenCode profile or serializing secrets. */
export function createOpenCodeConfig({ runtimeExecutable, runtimeData, nodeExecutable, pluginDir, personalCoSData, port = 45861, nativeTools = 'off', nativeInference = 'off', nativeModelID }) {
  const executable = absoluteExisting(runtimeExecutable, 'runtime_executable')
  const data = absoluteExisting(runtimeData, 'runtime_data')
  const node = absoluteExisting(nodeExecutable, 'node_executable')
  const plugin = absoluteExisting(pluginDir, 'plugin_dir')
  const pluginIndex = path.join(plugin, 'plugin', 'index.ts')
  if (!statSync(pluginIndex).isFile() || !statSync(path.join(plugin, 'src', 'server.mjs')).isFile()) {
    throw new Error('standalone_plugin_layout_incomplete')
  }
  if (personalCoSData) {
    if (typeof personalCoSData !== 'string' || !path.isAbsolute(personalCoSData)) {
      throw new Error('personal_cos_data_absolute_path_required')
    }
    const personal = realpathSync(personalCoSData)
    if (contains(personal, data) || contains(data, personal)) throw new Error('profile_overlaps_personal_userdata')
  }
  let config
  try { config = JSON.parse(readFileSync(path.join(data, 'config.json'), 'utf8')) }
  catch { throw new Error('isolated_profile_config_missing_or_invalid') }
  if (config?.ui?.chatBrowser !== 'cos' || config?.controlApi?.enabled !== true ||
      config?.controlApi?.allowActions !== true) throw new Error('isolated_profile_service_opt_in_required')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('provider_port_invalid')
  if (!['off', 'read'].includes(nativeTools)) throw new Error('native_tools_mode_invalid')
  if (!['off','text'].includes(nativeInference) || (nativeInference === 'text' &&
    (nativeTools !== 'off' || typeof nativeModelID !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(nativeModelID))) ||
    (nativeInference === 'off' && nativeModelID !== undefined)) {
    throw new Error('native_inference_requires_verified_text_model')
  }

  return {
    ...(nativeTools === 'read' ? { permissions: [{ action: 'read', resource: '*', effect: 'ask' }] } : {}),
    plugins: [{ package: path.join(plugin, 'plugin'), options: {
      runtimeExecutable: executable, runtimeData: data, nodeExecutable: node, port: String(port),
      nativeTools,
      ...(nativeInference === 'text' ? { nativeOAuth:'preview', nativeInference:'text' } : {}),
    } }],
    providers: { 'chat-on-opencode': {
      name: 'Chat On OpenCode',
      package: nativeInference === 'text' ? '@opencode/ai/providers/openai' : '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: nativeInference === 'text' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:' + port + '/v1' },
      models: { [nativeInference === 'text' ? nativeModelID : 'chatgpt-default']: {
        name: nativeTools === 'read' ? 'ChatGPT via Chat On OpenCode (native read preview)' : 'ChatGPT via Chat On OpenCode (text only)',
        capabilities: { tools: nativeTools === 'read', input: ['text'], output: ['text'] },
        limit: { context: 16384, output: 2048 },
      } },
    } },
  }
}
