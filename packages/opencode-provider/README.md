# Chat On OpenCode — provider bridge (first integration slice)

This directory is the beginning of a **provider**, not an additional multi-agent/Goal/Loop/Daemon system.
It follows the OpenCode 2 `providers` convention and uses its native session identity hook.

**Current status: NOT installable for unattended ChatGPT inference.** The Node gateway can
translate a subset of Chat Completions into CoS's local control API and now owns a separately
launched fork process via a service-only flag. The user must still provision that fork binary,
an independent control-enabled profile and login; no automated login is available. CoS tool-call
parity and streaming of outputs longer than its redacted 4,000-character projection are not done.
Do not install this in a real OpenCode profile.

## Wiring / isolated test only

The example `opencode.example.jsonc` shows the OpenCode **V2** `providers` object and local
`@opencode/plugin` hook. The plugin launches its own gateway on the **first provider model request**,
and `x-opencode-session-id` is injected only for this provider; without it,
requests are rejected rather than guessed or incorrectly attached to another conversation.

The gateway reads `CHAT_ON_OPENCODE_RUNTIME_EXE` (a packaged **fork** executable),
`CHAT_ON_OPENCODE_RUNTIME_DATA` (an **existing isolated** `userData` folder),
`CHAT_ON_OPENCODE_GATEWAY_KEY` (a distinct strong local secret, at least 32 characters, set in
the OpenCode process environment before provider initialization),
and optional `CHAT_ON_OPENCODE_PORT` (default 45861). The optional
`CHAT_ON_OPENCODE_PERSONAL_COS_DATA` identifies a personal CoS folder the launcher must never
reuse. The fork process checks this boundary independently against its actual personal profile.
Never commit either token or copy them into the OpenCode project config. The listener binds only
to 127.0.0.1, checks Host, rejects browser Origin, and requires the local bearer token.

Run the contract tests without any browser, login or global profile modifications:

```sh
cd packages/opencode-provider
npm test
```

## Implemented boundaries

- Stable CoS conversation IDs derived from exact OpenCode session IDs; no prompt-based identity.
- CoS outbox admission and event-journal consumption with exact input correlation.
- Launches and terminates a separately configured fork runtime without opening its main window;
  never adopts an endpoint owned by another PID.
- Text-only request adapter, progressive Chat Completions SSE, per-session concurrency guard.
- Fail-closed unknown model, tool calls, auxiliary requests, non-monotonic output,
  clipped content, unknown delivery or premature completion.

## Next integration milestones

1. Package the fork's Electron runtime as a noninteractive helper, prove true UI-free launch,
   connect on provider selection, and implement a consent-based initial ChatGPT login.
2. Map actual CoS model IDs/efforts, tool results and long-form assistant content without the
   external control API's intentionally clipped/redacted projection.
3. Verify `/models`, streaming, tools, cancellation and session continuity with packaged
   OpenCode 2.0 under an **isolated** Windows profile, including restart and provider switch.

The original project is [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids),
MIT licensed. This fork preserves upstream attribution and licenses.
