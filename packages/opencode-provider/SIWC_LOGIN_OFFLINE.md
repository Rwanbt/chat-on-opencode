# Sign in with ChatGPT — local OAuth request/callback foundation

This unconnected increment follows OpenAI's documented open-source SIWC
authorization request. `startSIWCLogin({hostID,...})` binds a new listener to
**127.0.0.1** on an OS-assigned port, then constructs a system-browser URL for
`https://auth.openai.com/api/accounts/authorize`. It generates independent
32-byte CSPRNG `state`, OIDC `nonce`, PKCE verifier and S256 challenge.
`hostID` is a stable `urn:uuid:...` that a future host credential custodian
must persist separately. The caller, not this module, must show an explicit
user-facing sign-in action and open the system browser only with consent.

For first-time registration, the request uses `dynamic_agent_client` and
`agent_name_hint=Chat On OpenCode`. The callback must return an issued
`oaiapp_...` client ID, which must replace the dynamic sentinel for token
exchange. For returning sign-in, the request uses the chosen issued client
ID and rejects a different returned client ID. `id_token_hint` and
`login_hint` are optional returning-account hints, **not validation**.

The listener enforces the exact `/auth/callback` path, loopback Host header,
GET, one authorization callback, a constant-time state check, valid code,
no duplicate/unexpected query keys, cancellation and bounded timeout. Invalid
unsolicited callbacks are rejected without consuming the authorized attempt.
The callback returns HTTP 204 with no cookies, no UI strings, no redirects and
no secrets in the response. The result contains sensitive in-memory
`{code,clientID,verifier,nonce,redirectURI,resource}` solely for a later
trusted verifier; do not log or persist it.

**NO-GO until later work:** This module performs **NO** actual browser sign-in,
authorization-code exchange, access-token receipt, ID-token signature/JWKS
verification, scope/subject/issuer/audience validation, secure credentials
storage or token refresh. Its callback result **MUST NOT** be considered a
signed-in account or authorize any Responses request. The complete flow
requires explicit user authorization and careful account identity custody.

Run `node --test test/siwc-login.test.mjs` for a genuine local HTTP listener
with synthetic codes/states, PKCE correctness, replay/wrong-host/malformed
callback rejection, returning client affinity, denial, abort and deadline.
No browser, real ChatGPT account, user profile, executable or Desktop process
is accessed.

Reference: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
