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
configuration containing exactly one provider and one plugin. Before
launch, the candidate's production files are copied into the disposable
directory and verified against the original payload digest; a development
worktree is never loaded directly by the official CLI. Other
configured providers, Goal, Loop, Daemon, account settings and chat history
are **not copied** into the process. It sets `OPENCODE_CONFIG_CONTENT` with
new `HOME`, `APPDATA`, `LOCALAPPDATA` and `XDG_*` directories, disables
project config/model fetch/update/default plugins, and invokes only:
`opencode-cli.exe models --standalone`.

Results are machine-readable: `PREVIEW_MODEL_AVAILABLE` means the selected
OpenCode CLI listed `chat-on-opencode/chatgpt-default` and the original
config and managed package hashes did not change. It **does not** mean the
ChatGPT account is signed in, that Chrome is paired, that any model is
accessible to the account, that an inference prompt succeeded, or that a
live Desktop upgrade has been performed. A faulty candidate or unavailable
runtime fails closed with a fixed error code. The child is bounded in
duration and output, then its temporary profile is discarded. No
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

Current local Windows qualification: isolated synthetic process/manifest tests
pass; the real official CLI 2.1.4 subprocess timed out twice during model
discovery (bounded 30 seconds plus Windows child cleanup). This is a **NO-GO
for actual on-machine activation**. Do not treat a passed fake process result,
or a CI test without the official binary, as proof that the Desktop can load
the candidate. The timer stops only the spawned sacrificial CLI process tree,
never an existing OpenCode instance. Further diagnosis must establish why
the native child did not produce the registered model before enabling any
upgrade or user session inference.
