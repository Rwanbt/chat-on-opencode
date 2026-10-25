# SIWC model catalog — verified offline contract, not account sign-in

OpenAI's official Sign in with ChatGPT **Models and inference** documentation
requires listing the selected account's available models using the **same OAuth
access token** that will authorize inference: GET
`https://api.openai.com/v1/models`. Display only entries with
`visibility: "list"`, preserve response order, and submit the selected
`slug` as the exact Responses `model` value.

`src/siwc-models.mjs` implements this catalog boundary without obtaining,
storing, logging or refreshing tokens. An external trusted token custodian
**must** verify the OAuth ID token, account identity, issuer, dynamic client
registration and scopes beforehand, and must supply
`{accountID, token, scopes, expiresAt}` on request. A returned object is an
attestation by the caller, **not** cryptographic verification by this module.
Call `requireSIWCModel(catalog, accountID, selectedSlug)` before any request
to prevent using a hidden or unlisted model or a previous account's model.

Safety boundaries:

- The production destination is fixed to the public API HTTPS URL, never
  ChatGPT's web/backend API. A special opt-in 127.0.0.1 URL is test-only.
- Refuse absent/mismatched account identity, expired tokens, missing
  `resource.invoke` or `chatgpt.tokens.use.direct` scopes, malformed bearer,
  redirects, credentials/cookies, wrong content type, malformed UTF-8/JSON,
  ambiguous duplicate slugs, oversized JSON or non-list-only catalogs.
- Strict 1 MiB response limit; timeouts and cancellation are bounded. Errors
  expose only fixed codes, not upstream response bodies or secret-bearing
  exceptions. No automatic retry, no saved user data, no UI or provider change.
- Catalog must be discarded whenever the ChatGPT account, authorized token,
  scope or grant changes. The module does **not** establish this lifecycle.

Validation: `node --test test/siwc-models.test.mjs` uses a real local
loopback HTTP server and injected synthetic account/credentials for success,
redirection, negative auth, cancellation and payload cases. No real ChatGPT
account, token, personal OpenCode profile, Desktop or inference is accessed.

**NO-GO:** This increment cannot be enabled as a complete native provider
until independently implemented SIWC PKCE, signed ID token validation, secure
OS-bound secret storage/refresh, explicit account/model selection and full
OpenCode Desktop/CLI authorized inference/tool custody have been qualified.

Reference: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
