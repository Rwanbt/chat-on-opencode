#!/usr/bin/env node
/** Read-only activation audit. Always NO_GO until personal drafts verified. */
import { inspectActivation } from '../src/context-overlay/activation-preflight.mjs'
const raw = process.argv.slice(2)
// A test-only/offline inventory never asserts process quiescence: unknown is
// explicitly NO_GO. It does not need to spawn the Windows process observer.
const offline = raw[0] === '--offline'
const args = offline ? raw.slice(1) : raw
const input = {}
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1]
  if (!['--config', '--bundle'].includes(key) || typeof value !== 'string' ||
    value.startsWith('--') || input[key]) throw Error('preflight_args_invalid')
  input[key] = value
}
if (args.length !== 4 || !input['--config'] || !input['--bundle']) {
  throw Error('preflight_exact_config_and_bundle_required')
}
const report = inspectActivation({
  config: input['--config'],
  bundle: input['--bundle'],
  ...(offline ? { observe: () => ({ state: 'unknown' }) } : {}),
})
process.stdout.write(JSON.stringify(report) + '\n')
// Never signal GO from metadata-only evidence.
process.exitCode = 3
