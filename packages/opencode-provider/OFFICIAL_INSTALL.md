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
sign-in or inference was attempted. At the time of that first isolated test,
the user's default config and running Desktop were untouched. A subsequent
**scoped, backed-up installation in the default config** also exposed the model
in the real official CLI 2.1.4. The existing Desktop process was not restarted,
and its graphical model picker was **not observed**. Neither test proves
activation in the user's ongoing Desktop session.
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

Rollback is guarded by precondition hashes: a manifest pins the exact installed-config and
backup hashes. If any intervening edit or backup corruption is found,
**rollback refuses to overwrite the user's changes**. On successful rollback,
the original JSONC is restored byte-for-byte and the managed payload removed;
the historic backup is retained. A fresh installation can create a new backup.
The hash check and following filesystem rename are separate operations, so
they are not a true atomic interprocess compare-and-swap.
If interrupted while installing, the backup remains for recovery. Do not use
this procedure to replace an official OpenCode application, update or reset
running services, or extract an account token.

## Read-only model registration check (no ChatGPT prompt)

Run the verifier from the checked-out provider package that contains
`bin/official-model-check.mjs`. It validates the immutable manifest, exact
managed payload and backup hashes, and the version of the **separately
specified** official CLI. It refuses modified installations and version drift.

```powershell
$config = Join-Path $HOME '.config/opencode/opencode.jsonc'
$cli = Join-Path $env:LOCALAPPDATA 'Programs/OpenCode/resources/opencode-cli.exe'
node packages/opencode-provider/bin/official-model-check.mjs --config $config --cli $cli
node packages/opencode-provider/bin/official-model-check.mjs --smoke --config $config --cli $cli
```

The second command starts only a new, bounded CLI child with a random 32-byte
process-only gateway key and executes `models --standalone`. It checks for
`chat-on-opencode/chatgpt-default`, then terminates only that child. On Windows,
intentional child-tree termination may report `processExit: 1`; the verifier
reports `terminatedAfterMatch: true` to distinguish this from an unsolicited
crash. A missing model, changed config, version mismatch, child error, timeout
or early crash returns nonzero. Neither command logs or persists the key.

These checks **do not** exercise a ChatGPT account, model inference, native
Desktop selection or any UI permission dialog. They do not restart a running
Desktop process or inject its previously missing environment key.

## Native OAuth bootstrap for a previously installed provider

An updated, user-approved managed plugin bundle offers OpenCode's native
`Continue with ChatGPT` method when the existing provider options omit
`nativeOAuth`. Registration only exposes the method; it does not begin sign-in
or obtain a credential. `nativeOAuth: "off"` explicitly disables the method.
The existing browser gateway and `chatgpt-default` model remain unchanged.
Native text inference still requires `nativeOAuth: "preview"`,
`nativeInference: "text"`, and a model slug independently verified from the
authorized account's visible catalog.

To stage a reviewed updated bundle, use the existing offline
`bin/official-managed-swap.mjs --stage <absolute-config> <absolute-bundle>`
operation. Its separate `--activate` and `--rollback` operations require a
quiescent Windows OpenCode process and retain the original managed bytes for
rollback. They do not modify `opencode.jsonc`, so the saved installation
manifest continues to verify the same config hash. Do not attempt activation
while the official Desktop is running.

The optional `bin/official-native-activation.mjs --plan --config
<absolute-config> --mode oauth` command previews a strictly scoped JSONC
change and returns only original/proposed SHA-256 digests and changed field
names. It does not emit the configuration's contents. The corresponding
programmatic `previewNativeActivation` supports a text proposal only with
an account-bound verified model catalog; a model slug supplied on the CLI
alone cannot establish that authority. **There is no write/approve command**:
native rename cannot atomically compare and replace a file, and updating both
the config and its installation manifest without an interprocess CAS would
risk overwriting a concurrent edit. Its output remains
`NO_GO_ATOMIC_CONFIG_CAS_UNPROVEN`.

### Already-active managed directory switch: preserve both generations

An existing `.chat-on-opencode-directory-switch.json` together with
`.chat-on-opencode-directory-previous` and an active candidate means the
original format-1 transaction still owns a rollback obligation. Its status
`staged:false, oldRetained:true, activeCandidate:true` is **not** an empty
staging slot. `--stage` correctly refuses another switch. The current
`--rollback` restores the old directory but deletes the candidate that had
been active, so invoking rollback just to free the slot would lose the direct
route back to that intermediate generation. Do not remove or rename the
journal or previous directory manually.

A read-only proof is available for that exact state:

```powershell
node packages/opencode-provider/bin/official-chained-swap-plan.mjs --inspect `
  --config 'D:\TEMP-FIXTURE\opencode\opencode.jsonc' `
  --candidate 'D:\REVIEWED-PR41\packages\opencode-provider' `
  --expected-sha256 '<independently-reviewed-64-character-digest>'
```

This command verifies the active format-1 manifest, original backup hash,
the journal and previous manifest, both retained payload hashes, the new
candidate's pinned digest, its OAuth-bootstrap entry point, and absence of
partial staging/upgrade. It rejects symlinks and unexpected layouts. Output
contains digests and categorical status only. It writes nothing and cannot
promote the candidate, even if the current OpenCode process has exited.
Tests use temporary synthetic profiles; the command above is illustrative.

Status `NO_GO_CHAINED_SWAP_NOT_ATOMIC` means that a separate chained
transaction remains necessary: persist ownership of **old, current and new**
generations before any rename, keep each original manifest/config backup
intact, exclude simultaneous upgrade/config editors, and support crash
recovery and independent rollback to each exact payload. Any future
offline activation must also verify zero running official OpenCode processes
and true interprocess compare-and-swap ownership. An inspection hash alone
is not permission for a later filesystem mutation.

**Important:** Installing the provider registration does not establish
production-ready inference. Desktop model-picker appearance, verified
runtime ownership, authorized ChatGPT account integration, credentials and
native tool parity are separate gates; they must remain reported as unverified
until directly tested.
