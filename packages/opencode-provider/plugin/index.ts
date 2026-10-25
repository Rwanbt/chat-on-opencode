import { Plugin } from '@opencode/plugin'

// OpenCode 2 native hook. Never affect other providers' requests or their sessions.
export default Plugin.define({
  id: 'chat-on-opencode',
  async setup(ctx) {
    await ctx.session.hook('http.request', event => {
      if (event.model.providerID !== 'chat-on-opencode') return
      event.request.headers.set('x-opencode-session-id', event.sessionID)
    }, { providerID: 'chat-on-opencode' })
  },
})
