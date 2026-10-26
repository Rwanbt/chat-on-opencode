# Official native OAuth registration and isolated refresh qualification

This stacked Draft increment starts in a **new worktree** from native SIWC
branch SHA `d44422eeaa6ea38849483384c7c1ad28ead58078`, which includes
`b5c70fb` and the merged changes through PR #30. No active Desktop, provider
installation, authentication profile, account, or browser was touched.

## Native OpenCode 2.1.4 proof

`CHAT_ON_OPENCODE_TEST_CLI=<absolute-official-cli> node --test
test/official-native-siwc.e2e.mjs` passed on Windows using **only** a randomly
generated Basic password in one test child, synthetic HOME/APPDATA, and an
isolated `127.0.0.1` server. The test fetched the official
`/api/integration/chat-on-opencode` method list and observed the `chatgpt`
OAuth method with **no key-method fallback**. The native OAuth-connect route
returned a disposable authorization attempt, which the test cancelled without
opening its URL. Earlier reports of unavailable integration metadata were
not reproduced with the corrected BasicAuth probe. This proves **server-side
registration**, not a running Desktop GUI selector or authenticated inference.

## Refresh proof (test-only)

`src/siwc-exchange.mjs` now exports the standalone `refreshSIWCGrant`, with
injected fetch, clock, and abort signal. It requires a previously verified
issued client ID, issuer, subject, refresh token and approved scopes before
sending an exact form POST to OpenAI's token endpoint (`grant_type=refresh_token`,
`client_id`, `refresh_token`, and `resource`; never `scope` or a client secret).
The response must include a rotated refresh token, expected plan permissions,
a fresh signed ID token, and an unchanged verified account identity. JWKS is
fetched and signature/issuer/audience/expiry are revalidated. Missing tokens,
lost permissions, invalid signatures, changed accounts, and HTTP errors all
fail closed, with generic errors that cannot contain credential bodies.

This standalone proof serializes duplicate refreshes per issued client and
subject **in one process**. It deliberately does **not** register an automatic
native `refresh` callback because multi-process atomic token replacement is
not yet established. The real rotating refresh credential must not be used by
two separate OpenCode processes simultaneously without such coordination.
No OAuth credential or ID token is written to app configuration or disk here.

## Remaining NO-GO

User-visible desktop login, live OAuth callback and signed ID-token exchange,
host identity persistence across installations, secure native credential
rotation across processes, account switching, and the direct Responses model
path are not demonstrated by these tests. Existing CoS transport remains the
default; native OAuth remains an explicit preview, not production-ready.

Documentation checked 2026-10-26:

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference
