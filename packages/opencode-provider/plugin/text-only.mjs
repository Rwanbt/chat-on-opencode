/**
 * OpenCode V2 can pass its default tool registry even if the selected model advertises
 * capabilities.tools=false. An experimental text-only model must not forward native tool
 * definitions to a backend that cannot execute them, or encourage the model to call them.
 * This is a scoped temporary compatibility gate, NOT tool-call parity.
 */
export function enforceTextOnlyContext(event) {
  if (event.model.providerID !== 'chat-on-opencode') return false
  for (const name of Object.keys(event.tools)) delete event.tools[name]
  return true
}
