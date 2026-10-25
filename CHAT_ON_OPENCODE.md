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

No installation or replacement of the user's main OpenCode configuration is performed.
