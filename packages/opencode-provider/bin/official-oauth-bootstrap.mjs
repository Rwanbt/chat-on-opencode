#!/usr/bin/env node
import { stageOAuthBootstrap, removeOAuthBootstrap, oauthBootstrapStatus } from '../src/official-oauth-bootstrap.mjs'

const args = process.argv.slice(2)
const actions = new Set(['--stage', '--remove', '--status'])
const fields = new Set(['--config', '--bundle', '--expected-sha256'])
try {
  const action = args.filter(value => actions.has(value))
  if (action.length !== 1) throw Error('oauth_bootstrap_exactly_one_action_required')
  const options = new Map()
  for (let i = 0; i < args.length; i++) {
    if (actions.has(args[i])) continue
    if (!fields.has(args[i]) || options.has(args[i]) || !args[i + 1] ||
      args[i + 1].startsWith('--')) throw Error('oauth_bootstrap_bad_argument')
    options.set(args[i++], args[i])
  }
  const config = options.get('--config')
  if (!config) throw Error('oauth_bootstrap_config_required')
  if (action[0] !== '--stage' && (options.has('--bundle') || options.has('--expected-sha256'))) {
    throw Error('oauth_bootstrap_extra_arguments')
  }
  const result = action[0] === '--stage'
    ? stageOAuthBootstrap(config, options.get('--bundle'), { expectedSha256: options.get('--expected-sha256') })
    : action[0] === '--remove' ? removeOAuthBootstrap(config) : oauthBootstrapStatus(config)
  process.stdout.write(JSON.stringify(result) + '\n')
} catch (error) {
  process.stderr.write('oauth_bootstrap_refused: ' +
    String(error.message ?? 'unknown').replace(/[^a-zA-Z0-9_]/g, '_') + '\n')
  process.exitCode = 2
}
