#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { additiveSourceDigest, additiveStatus, installAdditive, removeAdditive } from '../src/context-overlay/additive-install.mjs'

const opts = Object.create(null)
const actionNames = new Set(['--install', '--status', '--remove', '--digest'])
const actions = []
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (actionNames.has(key)) { actions.push(key); continue }
  if (!['--config', '--bundle', '--config-sha256', '--source-sha256'].includes(key) ||
      !process.argv[i + 1] || process.argv[i + 1].startsWith('--') || opts[key]) {
    throw Error('additive_cli_arguments_invalid')
  }
  opts[key] = process.argv[++i]
}
if (actions.length !== 1) throw Error('additive_cli_action_required')
const action = actions[0]
const bundle = opts['--bundle'] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = opts['--config']
if (action !== '--digest' && !config) throw Error('additive_cli_config_required')
if (action === '--install' && (!opts['--config-sha256'] || !opts['--source-sha256'])) {
  throw Error('additive_cli_pinned_shas_required')
}
const value = action === '--digest' ? { sourceSha256: additiveSourceDigest(bundle) }
  : action === '--status' ? additiveStatus(config, bundle)
  : action === '--install' ? installAdditive(config, bundle, opts['--config-sha256'], opts['--source-sha256'])
  : removeAdditive(config, bundle)
process.stdout.write(JSON.stringify(value) + '\n')
