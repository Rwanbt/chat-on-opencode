/**
 * OpenCode V2 can pass its default tool registry even if the selected model advertises
 * capabilities.tools=false. A text-only model must not forward native tool definitions
 * to a backend that cannot execute them, or encourage the model to call them.
 *
 * Three consent levels exist:
 *   'off'    - every declared tool is removed (text-only answer).
 *   'read'   - exactly the single `read` tool survives.
 *   'coding' - every declared tool survives; OpenCode alone executes it under
 *              its own permission policy. The gateway never runs a tool.
 *
 * `true`/`false` are still accepted for the earlier read/off call sites.
 */
export function enforceTextOnlyContext(event, mode = false) {
  if (event.model.providerID !== 'chat-on-opencode') return false
  const level = mode === true ? 'read' : (mode === 'read' || mode === 'coding' ? mode : 'off')
  if (level === 'coding') return true
  for (const name of Object.keys(event.tools)) {
    if (name !== 'read' || level !== 'read') delete event.tools[name]
  }
  return true
}
