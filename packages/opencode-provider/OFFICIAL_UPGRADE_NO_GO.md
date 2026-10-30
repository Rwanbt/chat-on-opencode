# Installed provider upgrade — immutable candidate, recoverable NO-GO

This proof addresses an **existing format-1** installation of
`packages/opencode-provider/src/official-install.mjs`. It does not upgrade the live plugin.
On Windows, replacing `.chat-on-opencode-managed` and an unrelated `opencode.jsonc`
file cannot be made one portable atomic operation; in-place file and directory
renames can also fail when OpenCode holds files open. A crash between two renames
can leave the provider pointing at an unavailable directory. **Promotion is NO-GO.**

The standalone `bin/official-upgrade.mjs` implements four bounded operations:

* `--check --config ABS --cli ABS --bundle ABS`: read-only. Validates the original
  format-1 manifest fields, all three SHA-256 values (installed config, exact
  original backup, managed payload), the actual official CLI version against
  the installed version (2.0.29, 2.0.32 or 2.1.4), single matching provider
  registration, and the proposed bundle layout/identity/version.
* `--stage` with the same three arguments: holds the active config and payload
  unchanged, writes a journal **first**, copies only `bin/`, `plugin/`, `src/`,
  `package.json` and selected public documentation to a separate sibling staging
  folder, then independently rehashes both source and staged bytes. A second
  digest receipt records completion. It always returns `promotionAllowed:false`.
* `--publish-candidate --config ABS`: with an existing validated stage, first
  writes a digest-pinned publication intent, then renames its candidate directory
  within the **same volume** to a sibling named
  `.chat-on-opencode-version-<sha256>`. This is a publication of **files only**;
  the active JSONC still points to the untouched old managed plugin. It rejects
  pre-existing targets, changed source/staged hashes and unfinished stages. The
  version directory is retained across recovery and is never modified by this
  command. Its name pins its content hash; absolute filesystem immutability is
  not proven against another actor with write permissions.
* `--recover --config ABS`: rejects any changed original config/backup/payload,
  unexpected journal schema, unknown files, symlinks/reparse entries, edited
  candidate or changed versioned published files. Deletes **only** its own
  staging journal/folder after these checks, then revalidates the original
  installation byte-for-byte. A successfully published immutable versioned
  sibling is retained; it is never mistaken for a temporary folder.

`--check` and `--stage` refuse pending recovery, so a crash cannot silently
start a second plan. Recovery can discard an exact **empty** reservation after
a crash preceding the journal; an unexpected nonempty unjournaled folder is
left untouched for manual investigation. Recovery tolerates incomplete candidate copies made
before the validated receipt, and is idempotent in the sense that a second
attempt refuses because no recovery is pending. No profile, account, cookie,
token, secret, system registry, running service or official executable is
imported or modified. The tool does not copy the original user configuration
or any credential store into the stage. Its manifest pins only paths,
hashes and package/version identifiers, **never** config contents.

The proposed **single-file config switch** is separately blocked. On Windows,
`renameSync(tmp, opencode.jsonc)` can replace the original JSONC in one rename,
but it is **not atomic compare-and-swap**: another editor can change the JSONC
after our read/check and before our rename. A synthetic native Windows test
reproduces that lost update. An advisory lock used only by this updater would
not protect edits by other writers or the active Desktop. A versioned plugin
also needs a qualified upgrade-aware manifest reader: the existing format-1
`inspectInstalledProvider()` correctly refuses a changed installed-config hash.
Until these separate contracts are implemented and proven, there is **no
`--promote` or `--rollback-live`** command. Publishing a candidate is not an
activation, and no active-config bytes are copied into this tool's journal.

This is a conservative recovery contract, **not** a claim of a durable OS-level
rename after sudden power failure, fsync of containing directories, or protection
against malicious concurrent mutation/Windows file handles. The tool must only be applied to a
quiescent, authorized, isolated test profile; there is intentionally **no
`--promote` operation**. The existing active installation remains authoritative.

The separate Windows chained-transition and restart-only pointer experiments
publish their complete process-owner records before making a lock visible,
using exclusive same-volume NTFS hard links. A later process can automatically
retire a dead chained-transition owner only after checking the Windows PID and
process creation time, the original journal/config digests, the retained
original payload and the exact staged/active/parked generation digests.
Malformed legacy locks, unverifiable process identities, changed receipts and
an orphaned `.recover` marker remain fail-closed for explicit reconciliation.
These protections cover ordinary process crashes; they do not prove safety
against sudden power loss or a new official reader that starts between the
last offline process scan and a rename.

Testing (from `packages/opencode-provider`):

```sh
node --test test/official-upgrade.test.mjs
npm test
# Optional: real official 2.1.4 with a child-only synthetic profile and no inference
$env:CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI = '<absolute installed CLI>'
node --test test/official-immutable-cli.e2e.mjs
```

Tests create disposable Windows temp configurations retaining Goal/Loop/Daemon
JSONC comments/bytes; inject faults at journal, directory creation, each copied
component, and validation receipt. They assert exact original config, backup,
manifest and payload bytes before and after recovery. They also cover modified
originals, modified source/stage/published artifact and symlink/junction refusal.
The optional official CLI probe uses disposable HOME/APPDATA/config and lists
the model provided by a versioned bundle, without a request to a model.
On Windows, the **installed official OpenCode 2.1.4 CLI** passed this isolated
model-listing probe on 25 October 2026; the synthetic active format-1 JSONC
was verified unchanged before and after explicit staging recovery. This proves
discovery of a selected immutable candidate in a disposable configuration,
not a live application update or account session.
Desktop runtime, concurrent editor coordination, and OS power-loss consistency
remain separate gates before any future live promotion design.
