import { CoSRuntime } from './runtime.mjs'
import { startService } from './service.mjs'

const executable = process.env.CHAT_ON_OPENCODE_RUNTIME_EXE
const profile = process.env.CHAT_ON_OPENCODE_RUNTIME_DATA
const key = process.env.CHAT_ON_OPENCODE_GATEWAY_KEY
const port = Number(process.env.CHAT_ON_OPENCODE_PORT ?? '45861')
const owned = process.argv.includes('--owned-ipc')
if (owned && (!process.channel || process.connected !== true)) {
  console.error('Chat On OpenCode gateway requires its OpenCode parent IPC')
  process.exitCode = 1
} else if (!executable || !profile || !key || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Missing fork runtime executable, isolated profile, gateway key, or valid port')
  process.exitCode = 1
} else {
  const runtime = new CoSRuntime({ executable, profile, personalProfile: process.env.CHAT_ON_OPENCODE_PERSONAL_COS_DATA })
  try {
    await startService({ runtime, key, port, owned,
      nativeTools: process.env.CHAT_ON_OPENCODE_NATIVE_TOOLS === 'read' ? 'read' : 'off' })
  } catch (error) {
    console.error('Chat On OpenCode cannot connect to its CoS runtime:', error.code ?? 'invalid_configuration')
    runtime.stop()
    process.exitCode = 1
  }
}
