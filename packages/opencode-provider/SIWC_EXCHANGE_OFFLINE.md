# Sign in with ChatGPT — verified OAuth exchange increment

This isolated module follows [the open-source SIWC public-client flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and must be used **after** `startSIWCLogin()` has accepted the exact loopback OAuth callback and returned its in-memory `{ code, clientID, verifier, nonce, redirectURI, resource }`.

`exchangeSIWCCode()` POSTs only to `https://auth.openai.com/api/accounts/oauth/token` (authorization_code, issued `oaiapp_...` client ID, PKCE verifier, exact loopback URI and `https://api.openai.com/v1` resource). It obtains the public signing key only from `https://auth.openai.com/.well-known/jwks.json`, rejects redirects, caps JSON responses at 128 KiB, verifies the ID token's RS256 or ES256 signature, issuer, exact audience, nonce, validity period and subject, and checks returning-account subject affinity. Unverified claims cannot be used as identity. The returned scope set explicitly distinguishes `canUsePlan=false` if direct ChatGPT plan permissions were not granted.

There are **no real credentials in tests**. `node --test test/siwc-exchange.test.mjs` uses generated RSA keys, a fake in-memory HTTPS transport and synthetic responses, checking valid grants plus scope refusal, wrong issuer, audience, nonce, expiration and returning identity, malformed callback and failed token exchange.

## Still intentionally disconnected (NO-GO)

This module **does not** create an OpenCode V2 integration auth method, open a browser, persist tokens, register a credential, refresh rotated refresh tokens or send model requests. Calling it alone does not authorize a ChatGPT account or replace the provider's API-key UI.

The remaining native wiring should use OpenCode V2's documented `ctx.integration.transform` and an actual OAuth registration/authorization handler, then secure credential custody (multi-account, protected storage, refresh serialization), and a separately tested `POST /v1/responses` path. Do **not** implement a cosmetic OAuth button that pretends success or treats the callback code as proof of login. Do not import cookies or access an existing personal OpenCode/ChatGPT profile. Until those contracts pass on actual official OpenCode 2.1.4 Desktop, the active provider's authentication status remains NO-GO.