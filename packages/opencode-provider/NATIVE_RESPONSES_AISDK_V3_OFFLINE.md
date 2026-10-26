# Native OpenCode V2 AI SDK → SIWC Responses: bounded text-only bridge

This stacked **Draft** increment is based on PR #34 exact head
`b1c99674dd6485f3629258f37309bbbf4784cfce`, which depends on
PR #33. The separately verified PR #36 concerns refresh-token rotation and
is **not** imported or modified by this work. Everything was developed in a
new worktree, with no existing OpenCode profile, Desktop or account access.

`plugin/native-responses.mjs` supplies a v3 `LanguageModel` and an actual
`ctx.aisdk.language` registration hook for a **separately authorized host**.
It converts the entire supplied native V3 text-only prompt/history into the
strict PR #18 Responses format, then invokes PR #34's connected-native OAuth
transport. An explicit account-bound catalog must contain the selected exact
model slug, and an active native OAuth connection must still pass all issuer,
client-ID, subject, scope and expiry checks before a token is used.

- POST is only to the official Responses endpoint (or explicit `127.0.0.1`
  test endpoint), with `store:false`, `stream:true`, no redirect/cookies,
  and full explicit conversation history. AI SDK `temperature`, token limits,
  `top_p`, metadata, caching options and previous response IDs are **never
  forwarded** to the restricted SIWC endpoint.
- Functions/tools, unsupported media/JSON modes, unapproved model slugs,
  invalid native identity, truncated/failed/mismatched SSE and abort all fail
  closed. Neither native tool execution nor approval is bypassed.
- AI SDK V3 output is emitted **after** verification of `response.completed`.
  `doStream` presents a single verified text delta, not live speculative
  token-by-token streaming. `doGenerate` has the same terminal verification.
- Secrets are obtained only from OpenCode's injected native integration
  connection and are not copied to plugin config, process env, logs, or UI.

## Why this cannot yet be activated in production

The public V2 `ctx.aisdk.language` event has `model`, `sdk`, and `options`,
not an authenticated `sessionID` plus `messageID`. The native V3 `doStream`
call receives a prompt, generation options and abort signal, but no
verified OpenCode message ID. OpenCode's runner currently supplies an OpenAI
`promptCacheKey` derived from the session ID; guessing a message ID or
hashing a prompt would be incorrect, particularly for retries and concurrent
turns. Therefore **`identity` is a mandatory separately verified host
capability**, not a configurable string or generated fallback. The account's
live model catalog likewise needs an authenticated host-owned lifecycle.

The shipped default CoS plugin **does not import** this module or register
the hook; callers cannot enable it by merely adding an option. This is
functional wiring between qualified components, **not** a completed live
OpenCode Desktop/account ChatGPT provider. A subsequent increment must
prove native message provenance and account/catalog lifecycle through the
actual official SDK before enabling the hook and performing a real CLI
synthetic turn. No token refresh or live login is claimed.

Offline proof: `node --test test/native-responses.test.mjs` uses a real local
HTTP server, synthetic OAuth connection and model catalog, and a separately
supplied synthetic native identity. The test asserts exact HTTP and a verified
AI SDK V3 stream, including terminal-only failure and tool refusals.

Reference implementation inspected: OpenCode V2
`packages/core/src/aisdk.ts`, `packages/core/src/session/runner/llm.ts`, and
`packages/plugin/src/v2/{effect,promise}/aisdk.ts` (2026-10-26).
