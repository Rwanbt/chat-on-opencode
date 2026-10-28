/** One OpenCode user message is one provider input, independent of text or model retry. */
export class MessageIdentity {
  constructor(limit = 1024) {
    this.ids = new Map()
    this.limit = limit
  }

  remember(sessionID, messageID) {
    if (!validID(sessionID) || !validID(messageID)) throw new Error('invalid_opencode_message_identity')
    this.ids.delete(sessionID)
    this.ids.set(sessionID, messageID)
    while (this.ids.size > this.limit) this.ids.delete(this.ids.keys().next().value)
  }

  require(sessionID) {
    if (!validID(sessionID)) throw new Error('invalid_opencode_session_identity')
    const id = this.ids.get(sessionID)
    if (!id) throw new Error('opencode_message_identity_unavailable')
    return id
  }
}

export const validID = id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{6,256}$/.test(id)

/** Pin a primary request's message before the asynchronous gateway startup.
 * A prompt in the same native session may switch to another provider meanwhile. */
export function pinProviderMessage(event, identities) {
  if (event.model?.providerID !== 'chat-on-opencode') return false
  event.headers['x-opencode-session-id'] = event.sessionID
  event.headers['x-opencode-message-id'] = identities.require(event.sessionID)
  return true
}

export function bindProviderMessage(event, identities) {
  if (event.model?.providerID !== 'chat-on-opencode') return false
  const pinned = event.request.headers.get('x-opencode-message-id')
  const pinnedSession = event.request.headers.get('x-opencode-session-id')
  if ((pinned && !validID(pinned)) || (pinnedSession && pinnedSession !== event.sessionID)) {
    throw new Error('opencode_request_identity_mismatch')
  }
  event.request.headers.set('x-opencode-session-id', event.sessionID)
  event.request.headers.set('x-opencode-message-id', pinned || identities.require(event.sessionID))
  return true
}
