# Read-only official OpenCode provider preview

Use this after the [installed bundle diagnostic](OFFICIAL_DIAGNOSTIC.md)
reports `installed_plugin_legacy_gateway_key` or
`installed_bundle_outdated`. It lets the **actual official OpenCode 2.1.4
CLI** load a new candidate plugin and list its registered model in an
entirely disposable process environment, without changing the installed
OpenCode binary, current Desktop session, personal configuration or managed
plugin folder.

```powershell
node packages/opencode-provider/bin/official-preview.mjs `
  --config "$HOME\.config\opencode\opencode.jsonc" `
  --cli "$env:LOCALAPPDATA\Programs\OpenCode\resources\opencode-cli.exe" `
  --bundle "D:\App\chat-on-opencode-v2-ephemeral-preview\packages\opencode-provider"
```

Use an existing, trusted local candidate path for `--bundle`; no package
downloads are performed. The preview verifies the active config/backup
manifest and candidate payload, reads only the provider-owned registration
and required local runtime paths, then constructs a **minimal** OpenCode
configuration containing exactly one provider and one plugin, mirrored to a
new temporary opencode.jsonc as well as OPENCODE_CONFIG_CONTENT. Before
launch, the candidate's production files are copied into the disposable
directory and verified against the original payload digest; a development
worktree is never loaded directly by the official CLI. Other
configured providers, Goal, Loop, Daemon, account settings and chat history
are **not copied** into the process. It sets `OPENCODE_CONFIG_CONTENT` with
new `HOME`, `APPDATA`, `LOCALAPPDATA` and `XDG_*` directories, disables
project config/model fetch/update/default plugins, and invokes only:
`opencode-cli.exe models --standalone`.
It refuses an observed machine-wide OpenCode configuration or plugin directory,
which OpenCode can load regardless of profile environment overrides.

Results are machine-readable: `PREVIEW_MODEL_AVAILABLE` means the selected
OpenCode CLI listed `chat-on-opencode/chatgpt-default` and the original
config and managed package hashes did not change. It **does not** mean the
ChatGPT account is signed in, that Chrome is paired, that any model is
accessible to the account, that an inference prompt succeeded, or that a
live Desktop upgrade has been performed. A faulty candidate or unavailable
runtime fails closed with a fixed error code. The child is bounded in
duration and output; cleanup is permitted only after the child exits,
otherwise termination is reported as unconfirmed and the synthetic files
are retained instead of being deleted under a running process. No
auto-promotion, runtime helper launch, OAuth, login or account access.

The original installed `.chat-on-opencode-managed`, backup and
`opencode.jsonc` remain the only active installation, untouched. The
Windows transactional compare-and-swap barrier for a live plugin upgrade
is still unresolved; do not use plain file rename or attempt an in-place
replacement while another editor or Desktop process may be using it.

Validation:
- `node --test test/official-preview.test.mjs`: synthetic install,
  provider isolation, source/config drift and version rejection.
- Set `CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI` to the exact installed official
  2.1.4 executable to run the optional real CLI standalone models test
  within an entirely synthetic temporary profile.
- `node --test test/official-cli-bare-model.e2e.mjs` with that variable
  checks whether the **same official CLI** can discover a static offline
  model using **no CoS plugin**, any account or remote model call.

Current local Windows qualification: isolated synthetic process/manifest tests
pass. The real official CLI 2.1.4 subprocess still failed the provider
discovery with a 30-second timeout. More importantly, the **preexisting**
immutable-bundle reference E2E also timed out at 45 seconds, and the
standalone CLI check without CoS did not complete within its bound on
this PC. This demonstrates a broader local CLI model-discovery problem,
but does not establish its underlying OS/network/resource cause.
An attempted provider selector after `models` was explicitly rejected by
the installed CLI 2.1.4, so the final preview deliberately keeps the
tested `models --standalone` command. The same offline native path passes
in GitHub CI. This is a **NO-GO for
actual on-machine activation**. A passed fake process test or a CI
test on another machine is not proof of local Desktop readiness.
Only sacrificial CLI process trees are eligible for shutdown; never
an existing OpenCode instance. An unsuccessful child termination is
explicitly refused rather than called successful.
