# Native SIWC first text — official OpenCode 2.1.4 offline proof

This Draft increment starts from PR #37 `fbf2e19ab8bf971d67068e738be3bf23ce561fdb` in a NEW worktree. No active Desktop/config/profile/account was touched.

## Proven native text turn

`CHAT_ON_OPENCODE_TEST_CLI=<official-2.1.4-path> node --test test/official-native-text.e2e.mjs` runs the unmodified **official CLI 2.1.4** with its own temporary HOME/config/data and localhost mock server. A **synthetic test-only** OAuth credential is resolved, the eligible model slug is checked against `/v1/models`, and OpenCode sends a native OpenAI Responses POST to `/v1/responses`. The official CLI emits the real assistant text event `NATIVE_SIWC_TEXT_OK`. No personal OAuth, browser, token file or external inference is involved.

The original AI SDK V3 hook is not the active route for this provider. Official 2.1.4 materializes the configured model as native `@opencode/ai/providers/openai`; `ctx.aisdk.hook('language', ...)` does not execute for this route. The actual native `ctx.session.hook('model.request')`, `http.request`, and `http.response` hooks were exercised in the CLI.

## Guarded production path

Only `nativeOAuth:'preview'` **and** `nativeInference:'text'` opt in. The selected native provider/model must match the account's current OAuth connection and `/v1/models` visible catalog. Neither API keys nor another account's credential can substitute. The bearer remains in memory and is attached only to the selected native request.

The outgoing request is text-only and constrained to `POST https://api.openai.com/v1/responses`, `store:false`, `stream:true` with an explicit self-contained history. Unsupported SIWC fields and tool definitions are removed/refused, files/media are refused, and no local tools run. Response SSE is bounded to 4 MiB and held until a valid `response.completed` with the exact selected model, without tool calls. This deliberately buffers output instead of releasing speculative text tokens.

Existing provider CoS behavior is preserved by default; only the opted-in native text request bypasses its gateway. Local titles/compaction remain separate.

## Reversible candidate, NOT installed

`bin/generate-config.mjs` now takes `--native-inference text --native-model <AUTHORIZED_MODEL_SLUG>` in addition to its original isolated runtime/data/node arguments. It emits a candidate config using `@opencode/ai/providers/openai`, not the legacy chat-completions package. It never writes an API key, refresh token, OAuth bearer or environment credential, and it does not install the generated config. The slug must be obtained after successful SIWC login from the actual account's visible model catalog.

Production **NO-GO** until live SIWC sign-in, credential custody/rotation and installed packaged Desktop UI are separately proven. The synthetic CLI proof is real OpenCode inference, NOT a real ChatGPT subscriber inference or full CoS tools/agent parity. No installation or app replacement is authorized by this artifact.

Official preview limits: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
