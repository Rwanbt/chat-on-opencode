#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { createOpenCodeConfig } from '../src/config.mjs'

const args = process.argv.slice(2)
const known = new Set(['--runtime', '--data', '--node', '--plugin-dir', '--personal-cos-data', '--port', '--native-tools', '--native-inference', '--native-model'])
const values = new Map()
try {
  for (let i = 0; i < args.length; i += 2) {
    if (!known.has(args[i]) || !args[i + 1] || values.has(args[i])) throw new Error('unexpected_or_missing_config_argument')
    values.set(args[i], args[i + 1])
  }
  const result = createOpenCodeConfig({
    runtimeExecutable: values.get('--runtime'),
    runtimeData: values.get('--data'),
    nodeExecutable: values.get('--node'),
    pluginDir: values.get('--plugin-dir') ?? fileURLToPath(new URL('..', import.meta.url)),
    personalCoSData: values.get('--personal-cos-data'),
    port: values.has('--port') ? Number(values.get('--port')) : undefined,
    nativeTools: values.get('--native-tools') ?? 'off',
    nativeInference: values.get('--native-inference') ?? 'off',
    nativeModelID: values.get('--native-model'),
  })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  process.stderr.write('Cannot generate isolated OpenCode config: ' + error.message + '\n')
  process.exitCode = 1
}
