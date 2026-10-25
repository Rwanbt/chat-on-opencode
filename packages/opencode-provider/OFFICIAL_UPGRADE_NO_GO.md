# Installed provider upgrade — staged, recoverable NO-GO

This proof addresses an **existing format-1** installation of
`packages/opencode-provider/src/official-install.mjs`. It does not upgrade the live plugin.
On Windows, replacing `.chat-on-opencode-managed` and an unrelated `opencode.jsonc`
file cannot be made one portable atomic operation; in-place file and directory
renames can also fail when OpenCode holds files open. A crash between two renames
can leave the provider pointing at an unavailable directory. **Promotion is NO-GO.**

The new standalone `bin/official-upgrade.mjs` implements three bounded operations:

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
* `--recover --config ABS`: rejects any changed original config/backup/payload,
  unexpected journal schema, unknown files, symlinks/reparse entries or edited
  validated candidate. Deletes **only** its own staging folder after these
  checks, then revalidates the original installation byte-for-byte.

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

This is a conservative recovery contract, **not** a claim of cross-object
atomicity, fsync of containing directories, or protection against malicious
concurrent mutation/Windows file handles. The tool must only be applied to a
quiescent, authorized, isolated test profile; there is intentionally **no
`--promote` operation**. The existing active installation remains authoritative.

Testing (from `packages/opencode-provider`):

```sh
node --test test/official-upgrade.test.mjs
npm test
```

Tests create disposable Windows temp configurations retaining Goal/Loop/Daemon
JSONC comments/bytes; inject faults at journal, directory creation, each copied
component, and validation receipt. They assert exact original config, backup,
manifest and payload bytes before and after recovery. They also cover modified
originals, modified source/stage and symlink/junction refusal. Actual official
CLI/model registration, Desktop runtime and OS crash-consistency qualification
remain separate gates before any future live promotion design.
