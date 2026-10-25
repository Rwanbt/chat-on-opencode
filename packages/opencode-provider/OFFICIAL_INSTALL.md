# Official OpenCode — scoped, reversible provider installation

**Qualification note (25 October 2026):** The official installed Desktop and
bundled CLI report **2.1.4**. This provider's native OpenCode hook/streaming
E2E was subsequently run against the **actual bundled 2.1.4 CLI** with fully
synthetic HOME/APPDATA/config/CoS runtime, yielding an assistant text part
offline (PASS, approximately 31 seconds; no ChatGPT login). Thus **CLI 2.1.4
is eligible for the installer version gate**. A Desktop UI picker test and
real ChatGPT inference are not proved by that result.

**Actual reversible test installation:** a fresh, separate official-CLI profile
was prepared at `%LOCALAPPDATA%\ChatOnOpenCodeProvider\opencode\`, with the
CI-verified portable fork runtime copied to sibling `runtime\` and a new,
un-authenticated consented `isolated\` profile. The installer added its two
scoped entries to this **separate profile only**, saved its original bytes and
manifest, and retained the rollback path. With only an ephemeral process
environment key, the **real official OpenCode CLI 2.1.4**
`models --standalone` printed `chat-on-opencode/chatgpt-default`.
The smoke terminates **its own** CLI after that exact receipt; the CLI's
embedded standalone server otherwise continues running. No prompt, ChatGPT
sign-in or inference was attempted. The user's **existing/default**
`~/.config/opencode/opencode.jsonc` and the running Desktop were **not changed**,
and the Desktop's graphical model picker was **not observed**. This is an
isolated official-CLI installation, not activation in the user's ongoing
Desktop session.
Do not substitute a CLI version check for a Desktop UI model-picker test.

For a default Desktop installation, remaining blockers include the absence
of an authenticated and permitted user session and the inability to inject an
ephemeral gateway key into the user's **already running** Desktop without a
user-owned restart. The plugin
requires a distinct **32+ character process-only** bearer key before startup.
Already running Desktop processes cannot inherit a newly set environment variable.
No system or persistent user environment variables, credentials, registry keys,
real CoS profile, OpenCode binaries, Goal/Loop/Daemon settings or running
processes were modified during this qualification.

## Safe preflight, then explicit installation (only once supported)

The commands below are **examples**, not a recommendation to bypass the
runtime/profile/secret readiness gate. Use a trusted full provider artifact containing
`package.json`, `bin/`, `src/`, `plugin/`, including the IPC-lifetime fix.
The provider runtime **must not** be the official OpenCode executable.

```powershell
$config = Join-Path $HOME '.config/opencode/opencode.jsonc'
$cli = Join-Path $env:LOCALAPPDATA 'Programs/OpenCode/resources/opencode-cli.exe'
$script = 'bin/official-install.mjs'
$args = @('--config', $config, '--cli', $cli,
  '--bundle', 'D:\VerifiedProvider\opencode-plugin',
  '--runtime', 'D:\VerifiedProvider\Chat On OpenCode Provider.exe',
  '--data', 'D:\Private\coo-provider-profile',
  '--node', 'C:\Program Files\nodejs\node.exe')
node $script --check @args
# Only with a qualified matching official version + complete independent runtime:
node $script --install @args
# Restores the exact original JSONC bytes if nobody changed the installed config:
node $script --rollback --config $config
```

Both `--check` and `--install` fail closed on unverified versions,
missing/ambiguous paths, symlinks, bad isolated-profile consent, pre-existing
managed installation, duplicate provider names, or invalid JSONC. No browser,
session, model request, GUI, registry or external account is accessed.
`--check` writes **nothing**. `--install` adds only a scoped
`plugins[]` entry and `providers.chat-on-opencode`, retaining original
JSONC comments, ordering, existing Goal/Loop/Daemon entries and whitespace.
It first stores a same-directory exact-byte backup named
`opencode.jsonc.chat-on-opencode.<UUID>.bak`, copies the provider payload into
`.chat-on-opencode-managed/`, and atomically replaces the config. No bearer,
`apiKey` or login cookie is stored in the generated config.

Rollback is compare-and-swap: a manifest pins the exact installed-config and
backup hashes. If any intervening edit or backup corruption is found,
**rollback refuses to overwrite the user's changes**. On successful rollback,
the original JSONC is restored byte-for-byte and the managed payload removed;
the historic backup is retained. A fresh installation can create a new backup.
If interrupted while installing, the backup remains for recovery. Do not use
this procedure to replace an official OpenCode application, update or reset
running services, or extract an account token.

**Important:** Installing the provider registration does not establish
production-ready inference. Desktop model-picker appearance, verified
runtime ownership, authorized ChatGPT account integration, credentials and
native tool parity are separate gates; they must remain reported as unverified
until directly tested.
