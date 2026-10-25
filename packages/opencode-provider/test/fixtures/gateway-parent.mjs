import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewayLifecycle } from '../../src/lifecycle.mjs'

// Sacrificial OpenCode-like host: it owns the gateway IPC and emits only
// test PIDs, allowing the caller to terminate the host before normal cleanup.
const profile = process.env.CHAT_ON_OPENCODE_RUNTIME_DATA
const gateway = new GatewayLifecycle({
  entry: fileURLToPath(new URL('../../src/server.mjs', import.meta.url)),
  runtimeExecutable: process.env.CHAT_ON_OPENCODE_RUNTIME_EXE,
  runtimeData: profile,
  node: process.execPath,
  key: process.env.CHAT_ON_OPENCODE_GATEWAY_KEY,
  port: Number(process.env.CHAT_ON_OPENCODE_PORT),
})
await gateway.ensure()
const descriptor = JSON.parse(await readFile(path.join(profile, 'control-api', 'endpoint.json'), 'utf8'))
process.stdout.write(JSON.stringify({ gatewayPID: gateway.child.pid, servicePID: descriptor.pid }) + '\n')
setInterval(() => {}, 1000)
