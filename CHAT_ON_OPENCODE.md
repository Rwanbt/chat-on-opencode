# Chat On OpenCode

An independent MIT fork of [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids)
aiming to expose ChatGPT web-backed inference as a **native selectable provider in OpenCode 2**.
OpenCode remains the sole user-facing application and owns sessions, agents, Goal, Loop, Daemon,
Git, and provider switching. This fork must not replace any of those working components.

Development is on `feat/opencode-v2-provider-bridge`. The first reviewed slice lives in
[`packages/opencode-provider`](packages/opencode-provider/README.md): a local authenticated
Chat Completions adapter for CoS's existing control API and an OpenCode V2 session hook.

**Not yet end-to-end:** The initial slice requires an existing CoS engine process, rejects
native tool calls, and does not perform headless ChatGPT sign-in. It is a testable integration
foundation, not a promised working provider. A full release requires an independently packaged
background engine plus demonstrated streaming, tool execution and session restoration.

The separate `feat/provider-v2-registration` worktree adds an experimental
`--chat-on-opencode-provider-service` entry mode to the existing Electron main process.
It requires a separately provisioned **existing** directory in
`CHAT_ON_OPENCODE_USERDATA_DIR`, checks real paths before acquiring the instance lock,
refuses personal-profile overlap, and does not display the main window, tray, pet or
update UI. It also refuses to run if the isolated profile has not explicitly enabled
CoS's built-in browser and local-control actions. This is service **admission**, not
proof of successful sign-in or native provider usage; it must not copy cookies or
silently enable permissions.

The message-identity worktree binds provider input IDs to OpenCode V2's actual
`session.prompt.messageID` events, not to prompt text hashes. This is essential for two
consecutive prompts with the same words and for safe replay of an identical request.
Unexpected absence of that identity fails closed instead of guessing an attribution.

The V2 plugin also has a first-request-only launcher for the gateway, which in turn owns
the standalone fork helper. The helper must be built and explicitly configured with a
dedicated profile; neither executable packaging nor real ChatGPT session E2E has been
verified. It refuses unsupported tool calls and incomplete stream messages rather than
silently simulating tool execution. `opencode models --standalone` did not finish an
isolated smoke attempt, so model-picker activation remains unverified.

The following isolated stream/cancellation slice adds `full=1` to the CoS session SSE
projection **only when the dedicated provider-service flag is present**. Regular CoS API
replies retain their 4k bound and reject this opt-in; provider replies remain redacted and
bounded to 64k. It also maps OpenCode request cancellation onto CoS's exact `turnId`
stop operation or its conservative input-outbox cancellation, and reconnects after a
normal 30-minute SSE expiry by sequence number, without re-sending a prompt. This is not
evidence of full tool-call parity or a live ChatGPT inference test.

No installation or replacement of the user's main OpenCode configuration is performed.
