# Native OpenCode V2 sign-in preview — not enabled in official Desktop

The installed `chat-on-opencode` provider currently has an API-key method in
OpenCode's connection picker because its original plugin only registers a
local OpenAI-compatible model. That field **must not** receive ChatGPT session
tokens, cookies, passwords or an OpenAI API key as a workaround.

The opt-in `nativeOAuth: "preview"` plugin option registers a native
`Continue with ChatGPT` integration method via OpenCode V2's
`ctx.integration.transform()`. It removes the API-key method **only for this
integration**; no other providers, Goal, Loop or Daemon methods are changed.
All OAuth operations start only after the user chooses the sign-in method:

- an installation-stable random host UUID is stored in OpenCode's plugin
  storage (not in the user's personal ChatGPT browser);
- the SIWC browser URL uses PKCE, nonce, state and an isolated loopback
  callback on `127.0.0.1`;
- the returned issued `oaiapp_` client ID, authorization code and verifier
  are exchanged exclusively with OpenAI's documented authorization server;
- identity is accepted only after signature, issuer, audience, nonce and
  expiration verification against OpenAI's public JWKS, and the required
  plan scopes and previously selected subject are checked;
- a verified OAuth credential is returned to **OpenCode V2's own credential
  system**. The plugin does not write an `apiKey`, cookie or account token into
  `opencode.jsonc`.

## Current safety gate

`nativeOAuth` remains **off by default**. This increment does **not** implement
OAuth refresh/rotation, account-scoped native model catalog, or switching the
current **CoS browser-only gateway** to a native Responses transport using the
selected OpenCode account. It does not prove that an OpenAI/ChatGPT login was
completed, that the account grants subscription inference, or that the
official Desktop connection UI can complete the entire flow.

Do not enable this option on a personal installation until the native method
has passed the *actual* OpenCode 2.1.4 integration endpoint test and an E2E
with explicit user authorization. Only then qualify credential refresh and
Responses/tool permissions before claiming production readiness.

Offline tests:

```powershell
node --test test/native-siwc.test.mjs test/siwc-login.test.mjs test/siwc-exchange.test.mjs
$env:CHAT_ON_OPENCODE_TEST_CLI = 'D:\VerifiedOfficialCLI\opencode-cli.exe'
node --test test/official-native-siwc.e2e.mjs
```

The latter starts a separate official CLI server under synthetic HOME,
APPDATA, XDG folders and checks only read-only integration metadata on a
127.0.0.1 port. It does not open a sign-in browser or submit a model prompt.
Its result must be reported precisely; absence of the method is a failed
integration test, **not** a completed installation.
