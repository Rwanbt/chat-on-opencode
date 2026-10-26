# OpenCode 2.1.4 native OAuth alongside an existing format-1 plugin

When the active managed provider has an earlier plugin without native OAuth,
OpenCode V2 can load a second **global** plugin from
`<config-folder>/plugins/chat-on-opencode-oauth-bootstrap/index.ts`.
This shim only registers the existing `chat-on-opencode` integration's
`Continue with ChatGPT` OAuth method. It adds no provider, model, inference
route, tools, browser connection or API-key fallback. The format-1 managed
payload, `opencode.jsonc`, original backup, and retained first-swap history
remain intact.

On 26 October 2026, the **actual installed official opencode-cli.exe 2.1.4**
was exercised using synthetic Windows HOME/APPDATA/CONFIG/CoS data. The old
format-1 provider alone had no OAuth method; after publishing this separate
plugin, the real API returned `chatgpt` (OAuth), label
`Continue with ChatGPT`, with no API-key method. A real native OAuth attempt
was started on the CLI loopback service and canceled without opening a browser
or using an account. All original installation bytes remained equal. This
does not prove account authorization, credentials, provider inference or Desktop
UI; these require their own user-approved checks.

Run only with an independently qualified candidate and its **exact**
`candidateDigest()` SHA-256, after closing OpenCode normally. Stage and remove
refuse all active or unidentifiable OpenCode/opencode-cli processes. Use
absolute paths for config and candidate. The installer also refuses an active
provider that already registers native OAuth, to avoid duplicate methods.

```powershell
$config = Join-Path $HOME '.config/opencode/opencode.jsonc'
$script = 'packages/opencode-provider/bin/official-oauth-bootstrap.mjs'
$candidate = 'D:\ReviewedCandidate\packages\opencode-provider'
$sha = '<64-hex-character reviewed candidate digest>'
node $script --status --config $config
node $script --stage --config $config --bundle $candidate --expected-sha256 $sha
# To undo after closing OpenCode normally:
node $script --remove --config $config
```

The candidate is copied to one self-contained plugin directory including the
SIWC dependencies. The stage directory lives outside `plugins/` and is
atomically renamed into it only after checksum verification; an interruption
during copying therefore cannot expose an incomplete autodiscovered plugin.
The manifest pins the exact original configuration, installed managed payload
and original manifest, plus SHA-256 of the copied candidate. Tampering,
symlinks or drift refuse removal. The installer cannot prove NTFS metadata
durability after sudden power loss, defend against a concurrently privileged
writer or repair arbitrary corrupt files. Keep unexpected orphan directories
for inspection.

Regression and real official CLI qualification:

```powershell
$env:CHAT_ON_OPENCODE_TEST_CLI = Join-Path $env:LOCALAPPDATA 'Programs/OpenCode/resources/opencode-cli.exe'
node --test packages/opencode-provider/test/official-oauth-bootstrap.test.mjs
```
