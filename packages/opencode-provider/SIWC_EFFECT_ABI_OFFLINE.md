# OpenCode V2 SIWC native OAuth Effect boundary (offline, Draft)

This incremental implementation was created from exact merged `main`
`7d2fcaa3353e3f35e864ee247e3c5901b511b56c` in a new independent
worktree. It **does not** edit or vendor PR #23 / PR #30 or install anything.

OpenCode V2's Effect-native integration registration requires `Effect.Effect`
callbacks, including `integration.transform`, `authorize`, and the OAuth
callback. A `Promise`-based registration is not a compatible native Effect
method. `plugin/siwc-effect-bridge.mjs` provides a narrowly scoped adapter:

- It registers the `chatgpt` OAuth method only on an explicit preview flag,
  and removes only `chat-on-opencode`'s key fallback. Other integrations and
  the default CoS provider are untouched.
- It accepts **injected, separately qualified** `startSIWCLogin` and
  `exchangeSIWCCode` functions, checks the resulting verified grant's issuer,
  client ID, subject, expiry and both plan-usage scopes before returning a
  credential to OpenCode's native OAuth flow. It does not independently
  verify a JWT signature; the injected exchange owns that requirement.
- The host's native `Effect.acquireRelease` scope closes its owned localhost
  callback attempt on cancellation. The callback is single-use; no secret is
  written to config, a browser is not opened, and no account is touched.
- A stable host ID must be provisioned by an authorized caller. The adapter
  can also use Effect-backed `ctx.storage` if available; **actual OpenCode V2
  does not guarantee that storage field**, so the optional direct host-ID
  input is required when it is absent. The host ID is not an OAuth token.

No default plugin imports this module. It intentionally does **not** claim
that OpenCode Desktop displays an OAuth method, that the existing API-key
field has disappeared, or that credentials can be saved or used for inference.
The real 2.1.4 SDK ABI/runtime registration, safe persistent host identity,
OAuth token rotation and protected native credential storage still need
qualifying together with PR #30. Do not enable production login.

Run `node --test test/siwc-effect-bridge.test.mjs`; synthetic Effect contract
and fake grants exercise the fail-closed adapter without actual OAuth,
browser login, profile access, or token persistence. This is not a real
official CLI or account E2E test.

Sources checked 2026-10-26:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://opencode.ai/v2/docs/build/plugins/effect
