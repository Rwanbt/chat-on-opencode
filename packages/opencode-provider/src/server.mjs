import { CoSControl } from './control.mjs'
import { createGateway } from './gateway.mjs'

const directory = process.env.CHAT_ON_OPENCODE_COS_CONTROL_DIR
const key = process.env.CHAT_ON_OPENCODE_GATEWAY_KEY
const port = Number(process.env.CHAT_ON_OPENCODE_PORT ?? '45861')
if (!directory || !key || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Missing control directory, gateway key, or valid listen port')
  process.exitCode = 1
} else {
  const control = new CoSControl({ directory })
  try {
    await control.connect()
    const server = createGateway({ control, key })
    server.listen(port, '127.0.0.1', () => console.log(`Chat On OpenCode gateway: 127.0.0.1:${port}`))
    process.once('SIGINT', () => server.close())
    process.once('SIGTERM', () => server.close())
  } catch (error) {
    console.error('Chat On OpenCode cannot connect to its CoS runtime:', error.code ?? 'invalid_configuration')
    process.exitCode = 1
  }
}
