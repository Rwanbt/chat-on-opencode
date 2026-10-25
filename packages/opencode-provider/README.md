# Chat On OpenCode — provider bridge (first integration slice)

This directory is the beginning of a **provider**, not an additional multi-agent/Goal/Loop/Daemon system.
It follows the OpenCode 2 `providers` convention and uses its native session identity hook.

**Current status: NOT installable for unattended ChatGPT inference.** The Node gateway can
translate a subset of Chat Completions into CoS's local control API and now owns a separately
launched fork process via a service-only flag. The user must still provision that fork binary,
an independent control-enabled profile and login; no automated login is available. CoS tool-call
parity and outputs exceeding its provider-only redacted 64,000-character limit are not supported.
Do not install this in a real OpenCode profile.

## Portable installation layout / isolated configuration

Running `npm run dist:provider:win:x64` produces both the separate portable Electron service
(`release/provider/win-unpacked/Chat On OpenCode Provider.exe`) and the standalone plugin
(`release/provider/opencode-plugin/`). Move **the complete plugin directory**, with its `src/`,
`plugin/`, and `bin/` folders together, to a stable location of your choice. The plugin does
not depend on the fork repository checkout; its entry point imports only sibling packaged files.
If the helper executable is moved during an update, regenerate the config with the new path;
keep the independent runtime profile in a separate, persistent location.

The generator only reads an **already existing** isolated provider profile with its explicit
`config.json` settings. It prints OpenCode V2 configuration to stdout and never touches
OpenCode's installed profile or creates credentials. For example, in PowerShell:

```powershell
node .\release\provider\opencode-plugin\bin\generate-config.mjs `
  --runtime 'D:\Apps\Chat On OpenCode Provider\Chat On OpenCode Provider.exe' `
  --data 'D:\Apps\provider-profile' `
  --node 'C:\Program Files\nodejs\node.exe'
```

The generated JSON uses the tested OpenCode 2 `plugins`/`providers` shape, a filesystem plugin
entry, and `chat-on-opencode/chatgpt-default` model selection. Place that configuration into
the intended **isolated** OpenCode configuration via OpenCode's normal configuration mechanism.
Set `CHAT_ON_OPENCODE_GATEWAY_KEY` to a strong random token (32+ characters) in that OpenCode
process environment. The generator deliberately does not put the token or `apiKey` into JSON.
Any existing personal CoS profile can be explicitly guarded with `--personal-cos-data` pointing
to its existing directory. The provider service rechecks isolation when launched.

This standalone layout is packaging/configuration evidence, not proof of real ChatGPT login,
tool calls, multimodal parity, or unattended inference. Those milestones remain open.

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
The dedicated profile must contain an existing regular `config.json` that explicitly selects
`ui.chatBrowser = "cos"` and `controlApi.enabled = controlApi.allowActions = true`.
Invalid or missing settings refuse startup before Chromium is spawned. The personal CoS
profile may be absent entirely; the provider neither creates nor copies one.
The plugin option `nodeExecutable` must be an absolute path to a real Node.js binary (Node 20+),
because OpenCode V2 may itself be a compiled Bun executable and must not be spawned as a Node interpreter.
Never commit either token or copy them into the OpenCode project config. The listener binds only
to 127.0.0.1, checks Host, rejects browser Origin, and requires the local bearer token.

Run the contract tests without any browser, login or global profile modifications:

```sh
cd packages/opencode-provider
npm test

# Optional OS-process integration with compiled Bun test-only service:
node --test test/native-process.e2e.mjs
```

## Implemented boundaries

- Stable CoS conversation IDs derived from exact OpenCode session IDs; no prompt-based identity.
- Every model request requires the native OpenCode prompt **message ID**. Identical text in
  successive messages produces distinct input IDs; retries of the same message reuse its ID.
  If the native ID cannot be proven (e.g. a plugin restart mid-turn), the bridge fails closed.
- OpenAI Chat Completions string and text-part content are supported. Image/audio/tool parts
  remain unsupported and are rejected without dropping context.
- In text-only mode, the provider-scoped OpenCode V2 `session.context` hook removes native
  tool definitions before model generation. This is required because OpenCode 2.0.29 still
  supplies its default agent tools even when the model declares `tools:false`. It affects
  **only** `chat-on-opencode`, never other models/providers; full native tool parity remains open.
- A real OpenCode V2.0.29 CLI executable has produced a streamed **assistant text part** using
  the plugin, its owned Node gateway and an independently compiled offline CoS fixture.
  It is still not evidence of real ChatGPT login or inference.
- CoS outbox admission and event-journal consumption with exact input correlation.
- Provider-only redacted assistant stream up to 64,000 characters instead of CoS's public
  4,000-character projection; timed-out SSE streams reopen from their sequence cursor.
- An aborted OpenCode request only asks CoS to stop an exact observed turn; if the turn was
  never proven, it asks the existing outbox for a safe cancellation rather than resending.
- Launches and terminates a separately configured fork runtime without opening its main window;
  never adopts an endpoint owned by another PID.
- Private Chromium tabs are never revealed by extension-driven focus or popup requests;
  a gateway-owner watchdog stops them if OpenCode dies on Windows.
- The gateway health response must prove the exact spawned process PID, and the gateway
  bearer secret is never passed into its child Chromium environment.
- Text-only request adapter, progressive Chat Completions SSE, per-session concurrency guard.
- Fail-closed unknown model, tool calls, auxiliary requests, non-monotonic output,
  clipped content, unknown delivery or premature completion.

## Next integration milestones

The **fork-only** portable Electron distribution is built with
`npm run dist:provider:win:x64` on Windows. Its output is under
`release/provider/win-unpacked/Chat On OpenCode Provider.exe`, and the separately
named product ID does not install/replace CoS. The packaging step runs the inherited
native-runtime/license smoke gate against the provider payload. A Windows CI job then
boots this actual Electron executable in provider-service mode using a generated isolated
profile with all local tool permissions off, with no real ChatGPT login, to verify the
private control API and absence of a visible CoS window. **This is not yet ChatGPT inference.**


1. Package the fork's Electron runtime as a noninteractive helper, prove true UI-free launch,
   connect on provider selection, and implement a consent-based initial ChatGPT login.
2. Map actual CoS model IDs/efforts, tool results and long-form assistant content without the
   external control API's intentionally clipped/redacted projection.
3. Verify `/models`, streaming, tools, cancellation and session continuity with packaged
   OpenCode 2.0 under an **isolated** Windows profile, including restart and provider switch.

The original project is [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids),
MIT licensed. This fork preserves upstream attribution and licenses.
