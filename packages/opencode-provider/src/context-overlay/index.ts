import { Plugin } from '@opencode/plugin'
import { raiseLegacyCoSContext } from './overlay.mjs'

// Additive fallback for an older managed CoS provider whose configuration
// cannot be modified until its multi-generation rollback journal is repaired.
export default Plugin.define({
  id: 'chat-on-opencode-context-overlay',
  async setup(ctx) {
    const registration = await ctx.model.transform(raiseLegacyCoSContext)
    return () => registration.dispose()
  },
})
