import net from 'node:net'

// The CoS app writes `control-api/endpoint.json` only after its control API is
// listening, and removes the file when the app quits
// (`src/main/control-api.ts:164`, `:180`, `:141`). The recorded port is
// therefore the authority on whether an owner is still alive.
//
// The recorded pid is not. On Windows the helper is terminated rather than
// asked to quit, so its endpoint file survives; the pid it names is later
// reused by an unrelated process. A pid-only liveness test then refuses a
// profile that is in fact free, and the isolated profile can never be used
// again. The port check keeps the same refusal whenever a real owner answers.

/**
 * Does anything accept a TCP connection on this loopback port?
 *
 * `true` a listener answered, `false` nothing is listening, `null` unknown.
 * No payload is ever sent: this must not talk to a foreign listener.
 */
export function probeLoopbackPort(port, { timeoutMs = 500, connect = net.connect } = {}) {
  return new Promise(resolve => {
    let settled = false
    let socket
    try {
      socket = connect({ host: '127.0.0.1', port })
    } catch {
      resolve(null)
      return
    }
    const settle = value => {
      if (settled) return
      settled = true
      socket.removeAllListeners('connect')
      socket.removeAllListeners('timeout')
      // A late error after the verdict must never become an uncaught event.
      socket.on('error', () => {})
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => settle(null))
    socket.once('connect', () => settle(true))
    socket.once('error', error => settle(error?.code === 'ECONNREFUSED' ? false : null))
  })
}

/**
 * Is a recorded CoS endpoint still backed by a live owner?
 *
 * A refused connection proves that nothing is serving that control API, so the
 * file is stale. An answer, an unknown outcome or an unusable port all mean
 * "possibly occupied": the caller must refuse rather than adopt.
 */
export async function endpointHasLiveOwner(endpoint, { probe = probeLoopbackPort } = {}) {
  const port = endpoint?.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) return true
  const accepted = await probe(port)
  return accepted !== false
}
