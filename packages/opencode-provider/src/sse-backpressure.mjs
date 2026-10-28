import { BridgeError } from './control.mjs'

// A slow or disconnected native renderer must not make the gateway buffer an
// unbounded number of CoS deltas in ServerResponse. Signal cancellation owns
// the pending write; a late drain cannot revive an abandoned native turn.
export async function writeSSE(response, frame, signal) {
  if (signal?.aborted || response.destroyed || response.writableEnded) {
    throw new BridgeError('opencode_turn_cancelled', 499)
  }
  if (response.write(frame)) return
  await new Promise((resolve, reject) => {
    const clean = () => {
      response.off('drain', drained)
      response.off('error', failed)
      response.off('close', closed)
      signal?.removeEventListener('abort', aborted)
    }
    const finish = (error) => { clean(); error ? reject(error) : resolve() }
    const drained = () => finish()
    const failed = () => finish(new BridgeError('native_sse_write_failed', 502))
    const closed = () => finish(new BridgeError('opencode_turn_cancelled', 499))
    const aborted = () => finish(new BridgeError('opencode_turn_cancelled', 499))
    response.once('drain', drained)
    response.once('error', failed)
    response.once('close', closed)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted || response.destroyed || response.writableEnded) aborted()
  })
}
