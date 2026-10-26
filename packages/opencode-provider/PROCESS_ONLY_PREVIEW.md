# Process-only OpenCode 2.1.4 candidate preview (no installation switch)

This is a **new, functional, isolated model-listing path** for the published
immutable sibling created by PR21. It is deliberately unrelated to OAuth,
browser scraping and the already-running OpenCode Desktop.

`src/process-only-preview.mjs` exposes `createProcessOnlyPreview` and
`smokeProcessOnlyPreview`; `bin/official-process-preview.mjs` is an opt-in CLI:

```powershell
# Only a synthetic, previously staged/published test profile under $env:TEMP.
# Its directory basename MUST start with coo-process-preview-.
$isolated = Join-Path $env:TEMP 'coo-process-preview-EXAMPLE'
node packages/opencode-provider/bin/official-process-preview.mjs `
  --root $isolated `
  --cli 'C:\PATH\TO\installed\opencode-cli.exe' `
  --sha '<exact 64-hex published payload digest>'
```

The root must already contain `config/opencode.jsonc` with a validated format-1
test installation plus `.chat-on-opencode-managed` and a verified
`.chat-on-opencode-version-<sha256>` sibling, and empty isolated subfolders
`home`, `data`, `cache`, `appdata`, `localappdata`, `tmp`, `workspace`,
`runtime-data` with explicit runtime opt-in, as well as a **synthetic**
`runtime.exe` (never executed). The CLI only accepts these three named arguments.

At startup, the adapter validates the original format-1 backup, manifest,
config and old payload; rejects paths outside the temporary root, junctions
and symbolic links; rehashes the published version; and verifies the actual
official CLI reports **2.1.4**. It creates a fresh OpenCode provider config
**in memory** with one text-only model and no tools, then sends it only through
`OPENCODE_CONFIG_CONTENT` in the child process environment. It copies no
existing Goal/Loop/Daemon keys or API-key settings into the child. The original
JSONC, including those unrelated entries, remains byte-for-byte unchanged.

The child receives isolated HOME/APPDATA/XDG/TEMP and a minimal OS environment.
Updates, model fetches, project config and default plugins are disabled.
Only `models --standalone` is allowed; it returns a bounded boolean proof of
the exact `chat-on-opencode/chatgpt-default` model and terminates only its own
CLI child. The result contains no credentials, paths or raw CLI output. The
installed Desktop and any active profiles are not accessed or restarted.

### Validation and limits

- `node --test test/process-only-preview.test.mjs`: synthetic byte-preservation,
  path/junction rejection, env credential exclusion, published-payload tampering,
  JSONC drift after launch, missing model and child close conditions.
- With `CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI` explicitly set to the installed CLI,
  the same test additionally executes one official **2.1.4** `models` child.
  It prepares and removes a disposable profile inside the test. No inference.
- `npm test` from `packages/opencode-provider` runs the package contract suite.

This path **does not resolve live CAS**. Windows native `renameSync` is not a
compare-and-swap operation and can overwrite another editor's intervening
change. No live `--promote`, auth flow, Desktop test, read-tool model call or
system power-loss recovery is implemented. It cannot prove the absence of
all network activity inside a third-party CLI; the request mode has no AI
prompt, with model fetching disabled. There is no copy of account credentials.

### Native OAuth finding — read-only

The existing `plugin/index.ts` only registers the scoped session/context,
prompt, model-request and HTTP hooks. It **does not** register an OAuth method
through the V2 integration domain. The published V2 plugin contract registers
authentication methods through `ctx.integration.transform(editor =>
editor.method.update(...))`; `ctx.integration.oauth.connect/status/complete`
are host APIs for managing those methods. Consequently, a custom compatible
provider with no registered OAuth method may fall back to a key-entry UI. A
plugin option such as `nativeOAuth: 'preview'` is not by itself a method.

Do not mistake an OAuth label or mock callback for actual SIWC authorization.
Before the installed provider can authenticate, the exact SDK must support the
registered method, the approved SIWC consent/PKCE/refresh contract must be
implemented and tested with synthetic accounts, and account-scoped inference
and native permissions must be separately verified. No OAuth, credential
storage, user login or key-input behavior is modified by this PR.

Documentation references (API surface only, not proof of authenticated success):

- https://opencode.ai/v2/docs/build/plugins/
- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://dev.opencode.ai/v2/docs/cli/providers
