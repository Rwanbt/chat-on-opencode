import { createGateway } from './gateway.mjs'
import { CoSRuntime } from './runtime.mjs'

const executable = process.env.CHAT_ON_OPENCODE_RUNTIME_EXE
const profile = process.env.CHAT_ON_OPENCODE_RUNTIME_DATA
const key = process.env.CHAT_ON_OPENCODE_GATEWAY_KEY
const port = Number(process.env.CHAT_ON_OPENCODE_PORT ?? '45861')
if (!executable || !profile || !key || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Missing fork runtime executable, isolated profile, gateway key, or valid port')
  process.exitCode = 1
} else {
  const runtime = new CoSRuntime({ executable, profile, personalProfile: process.env.CHAT_ON_OPENCODE_PERSONAL_COS_DATA })
  try {
    const control = await runtime.start()
    const server = createGateway({ control, key })
    server.once('error', () => {
      console.error('Chat On OpenCode gateway refused to listen on its private port')
      runtime.stop()
      process.exitCode = 1
    })
    server.listen(port, '127.0.0.1', () => console.log(`Chat On OpenCode gateway: 127.0.0.1:${port}`))
    const shutdown = () => server.close(() => runtime.stop())
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    runtime.child?.once('exit', () => server.close())
  } catch (error) {
    console.error('Chat On OpenCode cannot connect to its CoS runtime:', error.code ?? 'invalid_configuration')
    runtime.stop()
    process.exitCode = 1
  }
}
