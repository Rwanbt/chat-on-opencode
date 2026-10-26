const PROVIDER = 'chat-on-opencode'
const MODEL = 'chatgpt-default'
const LEGACY_CONTEXT = 16_384
const MODEL_OUTPUT = 2_048
const CONTEXT = 65_536

/** In-memory model transform; never alters user configuration or other providers. */
export function raiseLegacyCoSContext(editor) {
  const current = editor.get(PROVIDER, MODEL)
  if (current?.limit?.context !== LEGACY_CONTEXT ||
      current?.limit?.output !== MODEL_OUTPUT) return false
  editor.update(PROVIDER, MODEL, model => {
    if (model.limit?.context === LEGACY_CONTEXT &&
        model.limit?.output === MODEL_OUTPUT) model.limit.context = CONTEXT
  })
  return true
}
