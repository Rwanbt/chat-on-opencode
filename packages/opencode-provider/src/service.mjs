import { createGateway } from './gateway.mjs'

/** One process owns both the gateway listener and its isolated CoS runtime. */
export async function startService({ runtime, key, port, owner = process, owned = false,
  gatewayFactory = createGateway, exit = code => owner.exit(code) }) {
  // Direct process fixtures keep working without the plugin's ownership lease.
  // A plugin-owned process must never fall back to an unowned listener.
  if (owned && (!owner.channel || owner.connected !== true)) {
    throw new Error('provider_parent_ipc_required')
  }
  let server
  let stopped = false
  const shutdown = code => {
    if (stopped) return
    stopped = true
    try {
      server?.closeAllConnections?.()
      server?.close?.()
    } catch { /* parent already gone; terminating remains mandatory */ }
    finally {
      try { runtime.stop() }
      finally { exit(code) } // Exit even if an in-flight runtime.start() never resolves.
    }
  }
  // Register before the first await: a disconnect during profile validation,
  // Chromium launch or control-api discovery must terminate the owned service.
  if (owned) owner.once('disconnect', () => shutdown(0))
  owner.once('SIGINT', () => shutdown(0))
  owner.once('SIGTERM', () => shutdown(0))
  try {
    const control = await runtime.start()
    if (stopped || (owned && owner.connected !== true)) {
      // Also cover a mocked exit (tests) or ownership change while awaiting.
      if (!stopped) shutdown(0)
      return
    }
    server = gatewayFactory({ control, key })
    server.once('error', () => {
      console.error('Chat On OpenCode gateway refused to listen on its private port')
      shutdown(1)
    })
    server.listen(port, '127.0.0.1')
    runtime.child?.once('exit', () => server.close())
  } catch (error) {
    runtime.stop()
    if (!stopped) throw error
  }
}
