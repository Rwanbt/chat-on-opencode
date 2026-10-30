/** OpenCode V2 title hooks can resolve locally without any model HTTP request.
 * No synthetic CoS input, primary message-id reuse, or browser permission is needed.
 */
export function provideLocalTitle(event) {
  if (event?.model?.providerID !== 'chat-on-opencode') return false
  if (event.result === undefined) event.result = 'Chat On OpenCode'
  return true
}

let compactionSequence = 0

/** Admit a model request. OpenCode 2.2.4 sends compaction as a real model call
 * whose event carries neither messages nor a result, so it cannot be answered
 * locally. It is admitted under its own identity, derived from the current user
 * message, so the gateway never mistakes it for a replay of that message.
 * Returns the kind; the caller pins the primary identity itself.
 */
export function admitRequest(event, identities) {
  if (event.kind !== 'compaction') {
    requirePrimaryKind(event.kind)
    return 'primary'
  }
  const userMessage = identities.require(event.sessionID)
  compactionSequence += 1
  event.headers['x-opencode-session-id'] = event.sessionID
  event.headers['x-opencode-message-id'] = `${userMessage}.compaction.${compactionSequence}`
  return 'compaction'
}

/** Auxiliary calls do not share the primary prompt's durable identity or approval. */
export function requirePrimaryKind(kind) {
  if (kind === 'primary') return
  if (['title', 'compaction', 'generate'].includes(kind)) {
    throw new Error(`chat_on_opencode_${kind}_requires_separate_contract`)
  }
  throw new Error('chat_on_opencode_unknown_request_kind')
}
