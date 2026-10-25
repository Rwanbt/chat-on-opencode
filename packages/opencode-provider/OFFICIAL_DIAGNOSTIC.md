# Diagnose an installed official OpenCode plugin without profile changes

For a failed prompt in the official OpenCode Desktop, begin with the installed
bundle **actually loaded by that app**, not the latest GitHub branch or the
package in a development worktree.

```powershell
node packages/opencode-provider/bin/official-doctor.mjs `
  --config "$HOME\.config\opencode\opencode.jsonc" `
  --bundle "D:\App\chat-on-opencode-v2-installed-doctor\packages\opencode-provider" `
  --check-socket
```

Use the current checked-out bundle path for `--bundle`; it is optional.
`--check-socket` makes at most one short TCP connection to the configured
**127.0.0.1** port and does not send HTTP requests or bearer tokens. Without
this flag the doctor makes no network request. Both modes are **read only**.
They do not start, stop or restart an OpenCode/Chromium process.

The doctor checks the original format-1 manifest, exact installation config
hash, exact backup hash, managed payload integrity, scoped plugin/provider
registration and configured runtime preconditions. It reports only safe
categorical codes, booleans and the installed official CLI version; no paths,
prompts, personal tokens, settings or user account identifiers are printed.
It returns exit code 2 if a blocker is present. Examples:

| Code | Meaning |
| --- | --- |
| `installed_plugin_legacy_gateway_key` | Loaded installed plugin still requires an external startup bearer; the merged ephemeral-key fix is not installed |
| `installed_bundle_outdated` | Installed plugin bytes differ from the candidate plugin's entrypoint |
| `configured_gateway_not_listening` | Nothing accepted a TCP connection on the configured local port at inspection time |
| `isolated_runtime_missing` | Required fork runtime executable, Node executable or isolated profile is unavailable |
| `isolated_runtime_consent_missing` | Opt-in isolated runtime control flags are absent |
| `configured_gateway_port_invalid` | Provider port is not a valid TCP port |

`PREFLIGHT_ONLY` is **not** a successful prompt, an authenticated ChatGPT
account, a paired browser companion, or proof of working OpenCode tools.
An open port may belong to an unrelated process; the doctor never adopts it.
Existing session history remains protected. This does not read the companion
token or probe ChatGPT APIs, and cannot prove real inference readiness.

The installed format-1 bundle is covered by the existing hash-protected
rollback mechanism. Do **not** replace `.chat-on-opencode-managed`, patch
`opencode.jsonc` by hand, overwrite its manifest, or reset OpenCode/Chromium
processes as a workaround. The published staged immutable upgrade machinery
does **not** yet implement a proven atomic CAS for switching the active
config under concurrent editor writes. It intentionally refuses live
promotion, especially while Desktop is open. A safe upgrade and real
authenticated inference require separate qualifications.

Run `node --test test/official-doctor.test.mjs` for synthetic integrity,
tamper, gateway and privacy contracts. No personal accounts or browser
logins are used.
