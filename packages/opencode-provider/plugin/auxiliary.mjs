/** OpenCode V2 title hooks can resolve locally without any model HTTP request.
 * No synthetic CoS input, primary message-id reuse, or browser permission is needed.
 */
export function provideLocalTitle(event) {
  if (event?.model?.providerID !== 'chat-on-opencode') return false
  if (event.result === undefined) event.result = 'Chat On OpenCode'
  return true
}

/** Auxiliary calls do not share the primary prompt's durable identity or approval. */
export function requirePrimaryKind(kind) {
  if (kind === 'primary') return
  if (['title', 'compaction', 'generate'].includes(kind)) {
    throw new Error(`chat_on_opencode_${kind}_requires_separate_contract`)
  }
  throw new Error('chat_on_opencode_unknown_request_kind')
}
