const PROVIDER = 'chat-on-opencode'
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])
const TOOL_PARTS = new Set(['tool-call', 'tool-result'])

function literalMessage(message) {
  if (!message || !ROLES.has(message.role)) throw new Error('chat_on_opencode_compaction_unsupported_content')
  let text
  if (typeof message.content === 'string') text = message.content
  else if (Array.isArray(message.content) && message.content.every(part =>
    part && (part.type === 'text' && typeof part.text === 'string' || TOOL_PARTS.has(part.type)))) {
    text = message.content.map(part => part.type === 'text' ? part.text : `[${part.type}] ${JSON.stringify(part)}`).join('\n')
  } else throw new Error('chat_on_opencode_compaction_unsupported_content')
  return `[${message.role}]\n${text}\n[/${message.role}]`
}

/** Local checkpoint for OpenCode's auxiliary compaction hook: no inference,
 * credential, tool grant, or reuse of an unrelated primary message identity.
 * The output is explicitly extractive; never claim an LLM wrote a summary. */
export function provideExtractiveCompaction(event, { maxChars = 24_000 } = {}) {
  if (event?.model?.providerID !== PROVIDER) return false
  if (event.result !== undefined) return true
  if (!Array.isArray(event.messages) || event.messages.length > 1024 ||
    !Number.isInteger(maxChars) || maxChars < 256 || maxChars > 64_000) {
    throw new Error('chat_on_opencode_compaction_unsupported_content')
  }
  if (event.messages.length === 0) {
    event.result = { summary: 'No prior conversation messages to compact.' }
    return true
  }
  const parts = []
  let used = 0
  let omitted = 0
  const budget = maxChars - 200
  for (let i = event.messages.length - 1; i >= 0; i--) {
    const text = literalMessage(event.messages[i])
    if (used + text.length > budget) {
      omitted = i + 1
      if (parts.length === 0) {
        const suffix = text.slice(-Math.max(1, budget - 48))
        parts.push('[Earlier content from this message omitted]\n' + suffix)
      }
      break
    }
    parts.unshift(text)
    used += text.length + 2
  }
  const header = `Extractive checkpoint, not a model-generated summary. Earlier messages omitted: ${omitted}. ` +
    'The following recent text is quoted verbatim; do not infer missing details.\n'
  event.result = { summary: header + parts.join('\n\n') }
  return true
}
