# Reversible in-place plugin payload upgrade for an existing official OpenCode install

The existing format-1 installer registers a stable, scoped path:
`.chat-on-opencode-managed/plugin` in the user's OpenCode JSONC.
This upgrade deliberately **never writes that JSONC**. All unrelated plugins,
Goal, Loop, Daemon, model configuration, provider options, and original backups
remain byte-for-byte unchanged.

## Transaction boundaries

1. `--stage CONFIG ABSOLUTE_CANDIDATE`: verify the original format-1
   manifest, exact active/backup/config hashes, and the candidate's complete
   layout. Copy to `.chat-on-opencode-directory-next`, verify its hash, write a
   candidate-specific manifest with the *unchanged* config hash and backup
   reference. Commit a same-directory, fsync'd journal. Does not affect the
   running plugin. Reject existing staging or recovery state.
2. Quit **only the official OpenCode Desktop and its bundled CLI**, letting
   the UI close normally. This operation never closes an application process
   itself. Explicitly check no OpenCode or opencode-cli process is running.
3. `--activate CONFIG`: enforce that check again, pin the exact config, old
   payload and original manifest hashes, and perform two same-directory
   renames: old managed folder → `-previous`, prepared candidate → managed.
   Revalidate the new manifest and payload. The original managed folder remains
   complete and untouched in `-previous`. A crash between renames leaves the
   old folder and journal intact for recovery.
4. After validation/restart, `--status CONFIG` reports categorical switch
   state without reading account sessions, prompts, cookies or credentials.
5. If the official Desktop has been closed normally again,
   `--rollback CONFIG` validates the saved old bytes, renames the new folder
   back to staging and restores the previous folder. It verifies the original
   manifest/config and only then deletes its own next-folder and journal.
   A crash after the first rename is also recoverable this way.

Both `--activate` and `--rollback` **fail closed** when any official OpenCode
Desktop or bundled CLI process is present, including a failed/unknown process
enumeration. The verification of the original config hash protects its bytes;
no config compare-and-swap is needed because this operation never writes the
config at all. It is still **not an OS power-loss/NTFS directory fsync proof**,
not a defense against a malicious concurrent filesystem writer, and not proof
that a real ChatGPT account will respond. Do not treat two directory renames
as one atomic operation: an interruption is handled by the retained journal.

Test with `node --test test/official-managed-swap.test.mjs`.
Use only on an existing, hash-verified format-1 provider installation, with
an independently qualified and trusted candidate. Keep the journal/old folder
until an explicit offline rollback or a separately implemented clean-up policy.
Do not modify files inside the retained previous-folder or clear a pending
journal by hand.
