# Native SIWC credential → Responses: bounded offline bridge

This incremental adapter ties together three existing independently qualified
contracts:

- The exact **active** `chat-on-opencode` credential resolved through native
  OpenCode V2 `ctx.integration.connection.active/resolve`.
- The selected account subject and its model slug, independently authorized by
  the account-bound SIWC model catalog.
- The Responses transport's streaming completion, identity, tool-denial,
  cancellation, and no-store request boundary.

`sendConnectedResponses` is not connected to the default Chat Completions/CoS
model hook yet. Only the native OpenCode OAuth **credential** type with method
`chatgpt`, issuer `https://auth.openai.com`, same verified subject, issued
`oaiapp_…` client ID, both direct ChatGPT plan usage scopes, and an unexpired
token is eligible. A generic provider API key, environment credential, pasted
ChatGPT cookie or another account can never be used as a substitute.

The helper never opens browsers, logs tokens, reads config files, refreshes a
token or accesses a personal account. It also never executes tools: unsupported
calls are denied before retrieving any credential.

Offline tests send the request to an explicitly opted-in 127.0.0.1 fake
Responses server and check the actual authorization header, strict request,
terminal SSE result and failed grants. Run:

`node --test test/connected-responses.test.mjs`

**Production NO-GO:** a valid OAuth connection must first be registered,
completed, subject-verified and securely stored through the official OpenCode
V2 integration; a model catalog must be associated with that same account.
The provider must then wire this helper into an SDK/provider response pathway
and implement refresh, streamed UI deltas, native tool execution and permission
provenance. Offline tests are not an authenticated ChatGPT answer.
