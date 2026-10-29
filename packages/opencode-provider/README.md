# Chat On OpenCode — provider bridge (first integration slice)

The guarded **official OpenCode** installation/rollback procedure is documented
in [OFFICIAL_INSTALL.md](./OFFICIAL_INSTALL.md). The actual official CLI 2.1.4
has now passed the synthetic provider-streaming E2E; this does **not** prove
Desktop UI selection, credential readiness or actual ChatGPT inference.

This directory is the beginning of a **provider**, not an additional multi-agent/Goal/Loop/Daemon system.
It follows the OpenCode 2 `providers` convention and uses its native session identity hook.

**Current status: NOT qualified for unattended ChatGPT inference.** The Node gateway can
translate a subset of Chat Completions into CoS's local control API and now owns a separately
launched fork process via a service-only flag. The user must still provision that fork binary,
an independent control-enabled profile and login; no automated login is available. CoS tool-call
parity beyond the specifically opted-in native read preview and outputs exceeding its
provider-only redacted 64,000-character limit are not supported.
Do not install this in a real OpenCode profile.

### Experimental native read tool (OpenCode 2.0.32, offline qualification)

The default remains **text-only**: the gateway refuses every native tool definition,
and the plugin removes all tool definitions only for this provider. To test the
**single native \`read\` tool**, regenerate the *isolated* OpenCode configuration with
\`--native-tools read\`. This sets the provider-specific model's tool capability
and the plugin's narrow allowlist. The generated OpenCode \`permissions\` rules
require **\`read: ask\`**, not \`allow\`, by default. Inspect and approve each
requested path in OpenCode's native permission UI before execution. Only a
deliberate override by the user changes that approval policy.

The fork translates an **exact complete** \`<opencode-read>…</opencode-read>\`
JSON envelope in CoS's finished browser answer into an OpenAI-compatible native
tool call. It does **not** run local tools itself. Only the native OpenCode
\`read({path})\` call is accepted; shell, writing, task delegation, unknown schemas,
malformed tool instructions and mismatched tool results are refused. On a successful
native read, the tool result is sent back to the CoS browser for the answer; **that
transmits approved file contents to the external provider**, so explicitly opting
in is a data-disclosure decision as well as an execution-permission decision.
Do not enable for private files without understanding this boundary.

An isolated **actual OpenCode 2.0.32** process E2E verifies that native read
gets the marker from a real temporary disk file only when its test-only policy
is explicitly \`allow\`, and a \`deny\` policy blocks native execution. The model
side in this test is a deterministic offline fixture, not a real ChatGPT login or
model; no production inference, authenticated ChatGPT tool decision, arbitrary
native tools, agent delegation or user-approved sign-in has been qualified.

## Portable installation layout / isolated configuration

Running `npm run dist:provider:win:x64` produces both the separate portable Electron service
(`release/provider/win-unpacked/Chat On OpenCode Provider.exe`) and the standalone plugin
(`release/provider/opencode-plugin/`). Move **the complete plugin directory**, with its `src/`,
`plugin/`, and `bin/` folders together, to a stable location of your choice. The plugin does
not depend on the fork repository checkout; its entry point imports only sibling packaged files.
The Windows provider CI job also publishes these two directories together as a short-lived
`chat-on-opencode-provider-win-x64-<commit SHA>` GitHub Actions artifact **only after** its
packaged runtime smoke succeeds; this is a testable portable bundle, not a signed installer,
approved ChatGPT integration or a production release.
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
The actual OpenCode 2.1.4 CLI offline E2E loads the provider, launches its owned gateway,
and streams a native answer without `CHAT_ON_OPENCODE_GATEWAY_KEY` in the launching
environment. The plugin generates a fresh 256-bit bearer in memory on setup and passes
it only to its owned gateway process and the provider-scoped native request hooks.
The generator deliberately stores neither an `env` credential dependency nor an `apiKey`
or bearer token in OpenCode configuration. Desktop GUI selection has been exercised on official
OpenCode Desktop 2.1.4 against an isolated synthetic profile (no ChatGPT account): first turn,
same-session follow-up, cold and hot restart, and gateway-to-renderer correlation all passed.
Authentic ChatGPT credentials have **not** been exercised through the Desktop GUI.
Any existing personal CoS profile can be explicitly guarded with `--personal-cos-data` pointing
to its existing directory. The provider service rechecks isolation when launched.

This standalone layout is packaging/configuration evidence, not proof of real ChatGPT login,
tool calls, multimodal parity, or unattended inference. Those milestones remain open.

### Additive installation / rollback (Windows, candidate only)

The standalone `bin/additive-context.mjs` CLI can add **only** the reviewed
`src/context-overlay/index.ts`, `overlay.mjs` and text-only Markdown agent
to OpenCode's global plugin/agent discovery directories. It **does not** edit
`opencode.jsonc`, replace OpenCode, alter the old managed plugin or use any
ChatGPT credentials. Installation/removal refuses while OpenCode CLI/Desktop or
the isolated provider process runs, and refuses existing files of the same
names. A second process check immediately before publication catches a process
started during file staging, although no check can eliminate every race with a
simultaneous program launch.

The input pins are mandatory. `--digest --bundle ...` can report the file
digest, but **must not** be treated as independent authenticity evidence:
compare it with a separately reviewed, exact-commit artifact hash before
passing it as `--source-sha256`. Use the SHA256 of the existing
`opencode.jsonc` as `--config-sha256`. Never use someone else's SHA for
your own config. With OpenCode and the isolated helper **fully closed**, use:

```powershell
$bundle = 'D:\\reviewed\\opencode-plugin'
$config = Join-Path $HOME '.config\\opencode\\opencode.jsonc'
node "$bundle\\bin\\additive-context.mjs" --digest --bundle $bundle
node "$bundle\\bin\\additive-context.mjs" --status --config $config --bundle $bundle
# After independent source digest verification and process quiescence:
node "$bundle\\bin\\additive-context.mjs" --install --config $config --bundle $bundle `
  --config-sha256 '<SHA256-of-this-config>' --source-sha256 '<reviewed-source-SHA256>'
# The same source bundle must remain available for rollback:
node "$bundle\\bin\\additive-context.mjs" --remove --config $config --bundle $bundle
```

Publication stages both resources under hidden names and writes a durable
`*.pending.json` before renaming into the auto-discovered destinations. A
receipt marks a fully published pair. If interrupted, `--status` returns
`pending_recovery`, and `--remove` can undo **only matching owned files**
after rechecking that OpenCode is stopped; altered or foreign files are never
deleted. Removal renames published files into private, same-volume
`.retired` tombstones before deleting them; if recursive deletion stops
midway, re-running `--remove` can recover only the verified remaining files.
The source bundle must stay unchanged for verification/removal.
This is a Draft candidate until CI, Windows packaging and real Desktop
rollback qualification are all green; **do not install it on the user's
active profile as a shortcut**.

### Additive legacy model context overlay (isolated qualification)

The `src/context-overlay/` plugin demonstrates OpenCode V2's global plugin
auto-discovery and **in-memory** model transform. It applies only to the exact
old `chat-on-opencode/chatgpt-default` model with `context=16384` and
`output=2048`, raising its advertised context to 65536; other providers,
model defaults, session state, and persisted JSONC bytes are untouched.
The true CoS action text ceiling remains 64000 characters, so the scoped
text-only agent below is still needed for its first-turn payload.

The companion files `index.ts` and `overlay.mjs` must remain together in a
single immediate directory inside OpenCode's global `plugins/` discovery
directory. A separate global agent Markdown file, shipped as
`chat-on-opencode-browser-text.md`, can be placed under the global `agents/`
directory as `chat-on-opencode-text.md`; this keeps the smaller text-only
agent available without writing any JSONC. Neither addon changes defaults.
The real OpenCode 2.1.4 CLI is tested with a disposable 16k legacy model,
the global model overlay and the global Markdown text agent. This is **not an unattended installer or a
verified real-account response**. Do not copy it to an active real profile
until process quiescence, rollback, and integrated Desktop are qualified.

### Opt-in scoped text-only agent (CoS gateway)

Generated CoS-gateway configurations also expose the **`chat-on-opencode-text`**
agent. Select it explicitly with `--agent chat-on-opencode-text` or in OpenCode's
agent picker, together with model `chat-on-opencode/chatgpt-default`. It uses a
short text-only system prompt and deny-all native tool permissions, rather than
shipping the default coding agent's tool workflows into a browser-only model.
It **does not** change the default agent, other providers, OAuth-native inference,
or the experimental native read mode. It never clips user, developer, or system
instructions. The CoS action endpoint still rejects messages above 64,000
characters; this is a bounded text-only compatibility path, not native tools or
proof of an authenticated answer. Keep the existing managed profile unchanged
until separately reviewed and installed via a reversible update.

## Wiring / isolated test only

The example `opencode.example.jsonc` shows the OpenCode **V2** `providers` object and local
`@opencode/plugin` hook. The plugin launches its own gateway on the **first provider model request**,
and `x-opencode-session-id` is injected only for this provider; without it,
requests are rejected rather than guessed or incorrectly attached to another conversation.

The gateway reads `CHAT_ON_OPENCODE_RUNTIME_EXE` (a packaged **fork** executable),
`CHAT_ON_OPENCODE_RUNTIME_DATA` (an **existing isolated** `userData` folder),
`CHAT_ON_OPENCODE_GATEWAY_KEY` (a distinct process-local random bearer passed by the plugin
only to its owned gateway subprocess),
and optional `CHAT_ON_OPENCODE_PORT` (default 45861). The optional
`CHAT_ON_OPENCODE_PERSONAL_COS_DATA` identifies a personal CoS folder the launcher must never
reuse. The fork process checks this boundary independently against its actual personal profile.
The dedicated profile must contain an existing regular `config.json` that explicitly selects
`ui.chatBrowser = "cos"` and `controlApi.enabled = controlApi.allowActions = true`.
Invalid or missing settings refuse startup before Chromium is spawned. The personal CoS
profile may be absent entirely; the provider neither creates nor copies one.

### Explicit one-time ChatGPT sign-in

Close the dedicated provider gateway before starting sign-in: the service and sign-in
processes use **the same isolated Electron profile**, which must not be opened by two
Chromium instances simultaneously. With the fork-only packaged binary and a pre-created
profile configured as above, start an **interactive**, separate sign-in process:

```powershell
$env:CHAT_ON_OPENCODE_USERDATA_DIR = 'D:\Private\chat-on-opencode-provider'
& 'D:\Apps\Chat On OpenCode Provider.exe' --chat-on-opencode-provider-sign-in
```

The user signs in on ChatGPT's own page. The embedded browser may offer the existing
Google sign-in handoff into a supported installed browser; that path requires the user
to choose and approve the companion's transfer. Close the dedicated sign-in window to
terminate this process, then start the normal provider through OpenCode. No real user
profile, password, cookies or Chrome debugging port are imported automatically.

The locally authenticated `GET /health` now includes a `provider` object containing
only `sessionCookie` (`present`, `absent`, `unknown`), `extension` (`connected`,
`disconnected`), `paired`, and `canAttempt`. A missing cookie, unpaired bridge
or disconnected companion **refuses the prompt before adding an outbox entry**, with
`chatgpt_sign_in_required`, `chatgpt_session_unobserved`,
`cos_companion_unpaired` or `cos_companion_not_connected` respectively.
`canAttempt` is an *operational preflight*, **not** proof ChatGPT accepted the
cookie, the account can use the selected model or inference succeeded. A stale
session, expired entitlement or changed ChatGPT UI can still fail later. In particular,
do not present a green `/health` as verified real-account inference.

Manual sign-in also does not establish that browser automation or programmatic
extraction is permitted by the provider's terms. Confirm an authorized integration
path before using this to route real account inference; the supported
`Sign in with ChatGPT` app/partner authorization is a separate program from
reusing cookies in a browser: https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites
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
- The plugin holds a dedicated Node IPC channel to its gateway. A closed parent channel
  immediately closes the gateway and stops its CoS child, even during runtime startup;
  a service launched with the ownership flag but without IPC refuses to start.
- Private Chromium tabs are never revealed by extension-driven focus or popup requests;
  a gateway-owner watchdog stops them if OpenCode dies on Windows.
- The gateway health response must prove the exact spawned process PID, and the gateway
  bearer secret is never passed into its child Chromium environment.
- Text-only request adapter, progressive Chat Completions SSE, per-session concurrency guard.
- Fail-closed unknown model, unapproved/unsupported tool calls, non-monotonic output,
  clipped content, unknown delivery or premature completion. OpenCode V2 `title` requests
  are answered locally with a fixed title. The separate V2 `compaction` hook creates a
  bounded, explicitly extractive checkpoint of recent **text-only** messages, without
  pretending a model summarized them or borrowing a primary message identity. Unsupported
  multimodal/tool-call checkpoint content and `generate` still fail closed. Extractive
  compaction can omit older conversation details; it is **not** a semantic summary and does
  not establish full long-context production parity.

### Fork runtime contract

Gateway startup now verifies that the actual CoS control API advertises provider
readiness, the session event stream, input admission, exact turn stop and outbox cancel.
An older protocol-1 executable missing any route fails as
`cos_provider_runtime_incompatible` **before** accepting a prompt. The private stream
still requires `full=1` and the fork's `--chat-on-opencode-provider-service` mode;
neither should be stripped for compatibility with an older personal CoS build.
This health check proves the declared interface, not an active ChatGPT login or a
complete assistant turn.

## Next integration milestones

The **fork-only** portable Electron distribution is built with
`npm run dist:provider:win:x64` on Windows. Its output is under
`release/provider/win-unpacked/Chat On OpenCode Provider.exe`, and the separately
named product ID does not install/replace CoS. The packaging step runs the inherited
native-runtime/license smoke gate against the provider payload. A Windows CI job then
boots this actual Electron executable in provider-service mode using a generated isolated
profile with all local tool permissions off, with no real ChatGPT login, to verify the
private control API and absence of a visible CoS window. **This is not yet ChatGPT inference.**

After packaging, `node scripts/verify-provider-packaged-sign-in.mjs` also tests the
explicit interactive mode on Windows. It uses a fresh temporary profile with every
local capability disabled, routes Chromium HTTPS to a rejecting loopback proxy,
observes exactly one browser HWND owned by the packaged process, and sends WM_CLOSE
only to that verified handle. It checks process exit, refuses an uninitialized
profile, preserves the separate ordinary application-data directory, and runs the
hidden-service gate. A failed/denied network request proves only that the browser
attempted the ChatGPT host; the exact login path is separately covered by the host
unit test. No real login, auth cookie or model inference is used.


1. Qualify the packaged sign-in window and its existing Google handoff with a user-controlled
   isolated browser profile, then prove the returning headless provider observes that login.
2. Map actual CoS model IDs/efforts, tool results and long-form assistant content without the
   external control API's intentionally clipped/redacted projection.
3. Verify `/models`, streaming, tools, cancellation and session continuity with packaged
   OpenCode 2.0 under an **isolated** Windows profile, including restart and provider switch.

The original project is [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids),
MIT licensed. This fork preserves upstream attribution and licenses.
