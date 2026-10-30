// An owned gateway keeps its parent IPC channel open, and an open IPC channel
// holds the Node event loop alive. After a fatal startup error the process
// would therefore stay alive with no listener: the parent would wait for its
// whole health timeout and report a timeout instead of the real cause.
//
// The cause is reported on the channel the process already owns, then the
// process terminates. Nothing else is sent: the category is a fixed token, no
// path, no message and no credential crosses the channel.

export const GATEWAY_FAILURE_MESSAGE = 'chat_on_opencode_gateway_error'

/**
 * Tell the parent why an owned gateway could not start, then terminate it.
 *
 * Returns false when the process is not owned: an unowned service must keep
 * its own exit policy.
 */
export function reportOwnedFailure(code, { owned, send, exit, timeoutMs = 500 } = {}) {
  if (!owned) return false
  const category = typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'invalid_configuration'
  const finish = () => { try { exit(1) } catch { /* the process is already gone */ } }
  try {
    if (typeof send !== 'function') {
      finish()
      return true
    }
    // The send callback runs after the message is flushed. The timer is a
    // backstop for a parent that never answers: the child must still die.
    const timer = setTimeout(finish, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    send({ type: GATEWAY_FAILURE_MESSAGE, code: category }, finish)
    return true
  } catch {
    finish()
    return true
  }
}
